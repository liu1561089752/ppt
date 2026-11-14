/**
 * 统一 API 响应工具 + 路由公共助手
 */
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from './db'
import type { SessionUser } from './session'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
  }
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status })
}

export function err(status: number, message: string, code?: string, headers?: Record<string, string>) {
  return NextResponse.json({ error: message, code }, { status, headers })
}

export function handleApiError(e: unknown) {
  if (e instanceof ApiError) return err(e.status, e.message, e.code)
  if (e instanceof Error) {
    // 常见错误码映射
    if (e.message === 'UNAUTHORIZED') return err(401, '请先登录', 'UNAUTHORIZED')
    if (e.message === 'FORBIDDEN') return err(403, '权限不足', 'FORBIDDEN')
    if (e.message === 'INSUFFICIENT_CREDITS') return err(403, '生成次数不足,请先兑换卡密', 'INSUFFICIENT_CREDITS')
    if (e.message === 'CARD_INVALID') return err(400, '卡密无效或已被使用', 'CARD_INVALID')
    if (e.message === 'CARD_EXPIRED') return err(400, '卡密已过期', 'CARD_EXPIRED')
    if (e.message === 'RATE_LIMITED') return err(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')
    if (e.message === 'TOKEN_INVALID') return err(401, '下载链接无效', 'TOKEN_INVALID')
    if (e.message === 'USER_EXISTS') return err(409, '用户名已存在', 'USER_EXISTS')
    if (e.message === 'USER_BANNED') return err(403, '账号已被封禁,请联系客服', 'USER_BANNED')
    if (e.message === 'INVALID_CREDENTIALS') return err(401, '用户名或密码错误', 'INVALID_CREDENTIALS')
    if (e.message === 'TASK_NOT_FOUND') return err(404, '任务不存在', 'TASK_NOT_FOUND')
    if (e.message === 'TASK_NOT_READY') return err(409, '任务尚未完成', 'TASK_NOT_READY')
    if (e.message === 'FILE_TOO_LARGE') return err(413, '文件大小超出限制', 'FILE_TOO_LARGE')
    if (e.message === 'FILE_TYPE_NOT_ALLOWED') return err(415, '文件类型不允许', 'FILE_TYPE_NOT_ALLOWED')
    if (e.message === 'DUPLICATE_REQUEST') return err(409, '请勿重复提交', 'DUPLICATE_REQUEST')
    // 未映射的错误:细节只进服务端日志,不回显给客户端(可能含 Prisma 报文/路径/上游响应)
    console.error('[API Error]', e)
    return err(500, '服务器内部错误,请稍后再试', 'INTERNAL')
  }
  return err(500, '服务器内部错误', 'INTERNAL')
}

// 获取客户端 IP。
// 安全缺省是"不信任代理头":默认 trustProxy=false,直接走 'direct' 共享限流桶
// (误伤可用性,但不给伪造头绕过限流的机会);真部署在可信反代(Caddy/Nginx)
// 之后时才显式设置 TRUST_PROXY=true 开启解析。
// 开启后取 XFF 的**最右段**(最近一跳代理写入的值):反代对 XFF 是追加不剥离,
// 最左段可由客户端任意伪造,而最右段只能由我们信任的代理写入,最难伪造。
// X-Real-IP 语义不变;'direct' 兜底不变。register:ip / redeem:ip 的限流
// 阈值与此无关——这里只决定"IP 是怎么算出来的"。
export function getClientIp(req: Request): string {
  const trustProxy = process.env.TRUST_PROXY === 'true'
  if (trustProxy) {
    const xff = req.headers.get('x-forwarded-for')
    if (xff) {
      const last = xff.split(',').pop()?.trim()
      if (last && last.length <= 45) return last
    }
    const xreal = req.headers.get('x-real-ip')
    if (xreal && xreal.length <= 45) return xreal
  }
  return 'direct'
}

// ---------- 路由公共助手 ----------

/**
 * 解析并校验 JSON body。失败抛 ApiError(400,含 zod 首条错误信息)。
 * preprocess 可在校验前做 trim/删除可选空字段等归一化。
 */
export async function parseBody<S extends z.ZodType>(
  req: Request | NextRequest,
  schema: S,
  preprocess?: (raw: Record<string, unknown>) => void,
): Promise<z.output<S>> {
  const raw: unknown = await req.json().catch(() => ({}))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, '请求体无效', 'VALIDATION_ERROR')
  }
  const rawObj = raw as Record<string, unknown>
  preprocess?.(rawObj)
  const parsed = schema.safeParse(rawObj)
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || '参数错误'
    throw new ApiError(400, msg, 'VALIDATION_ERROR')
  }
  return parsed.data
}

/**
 * 解析分页参数。page 从 1 起(默认 1);pageSize 默认 20,上限 100。
 * 返回 Prisma 的 skip/take。
 */
export function paginate(url: string, defaultPageSize = 20) {
  const sp = new URL(url).searchParams
  const page = Math.max(1, Number(sp.get('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(sp.get('pageSize')) || defaultPageSize))
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
}

/**
 * 校验任务存在且属于当前用户(不存在或非本人一律 404),返回任务整行。
 * M-62:非本人资源统一回 404「资源不存在或已删除」,不做 403 区分——
 * 403 会向探测者证实"该 id 存在但属于别人",404 让对象枚举得不到任何信号。
 * admin 路由的 403(FORBIDDEN 权限语义)不受影响。
 * 默认 omit 预览类大字段(deckSpec/engineReport/outline/theme),高频轮询路径
 * 不必搬运 JSON。
 * - includeLargeFields: true → 返回完整行(旧语义)
 * - omitHeavyFields: true    → 仅丢 deckSpec/engineReport 两个最重字段,
 *   保留 outline/theme(任务详情页大纲/主题仍可用,M-10 修复;
 *   与 includeLargeFields 互斥,同时传时 includeLargeFields 优先)
 * deckSpec 是整份 Deck Spec(预览与重下载的唯一来源),engineReport 是引擎构建报告,
 * 两者都可能几十 KB,列表/轮询接口不该带着它们跑。
 */
type GenerationTaskRow = NonNullable<Awaited<ReturnType<typeof db.generationTask.findUnique>>>

export async function assertTaskOwner(
  taskId: string,
  session: SessionUser,
  opts: { includeLargeFields?: boolean; omitHeavyFields?: boolean } = {},
): Promise<GenerationTaskRow> {
  const { includeLargeFields, omitHeavyFields } = opts
  const task = includeLargeFields
    ? await db.generationTask.findUnique({ where: { id: taskId } })
    : omitHeavyFields
      ? await db.generationTask.findUnique({
          where: { id: taskId },
          omit: { deckSpec: true, engineReport: true },
        })
      : await db.generationTask.findUnique({
          where: { id: taskId },
          omit: { deckSpec: true, engineReport: true, outline: true, theme: true },
        })
  if (!task) throw new ApiError(404, '任务不存在', 'TASK_NOT_FOUND')
  // M-62:非本人与不存在同响应(404),防对象枚举
  if (task.userId !== session.userId) {
    throw new ApiError(404, '资源不存在或已删除', 'TASK_NOT_FOUND')
  }
  // omit 分支是完整行的子集,统一按完整行返回
  return task as GenerationTaskRow
}
