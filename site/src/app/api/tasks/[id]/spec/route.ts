/**
 * GET /api/tasks/[id]/spec — 原生 Deck Spec 预览数据
 *
 * 预览的唯一数据源:库里存着生成时那份 Deck Spec JSON(`GenerationTask.deckSpec`)
 * 与引擎构建报告(`engineReport`)。前端 `ppt-preview.tsx` 直接按 spec 的
 * 英寸坐标画纸卡,不再有任何 HTML 幻灯片文件、截图或静态资源服务。
 *
 * 鉴权:`assertTaskOwner`(不存在/非本人一律 404,防对象枚举)。
 * 响应:`{ spec, engineReport, pages }`
 *  - deckSpec 为空(任务未走到规格阶段,或属 HTML 时代的历史任务)→ 404
 *    `NO_DECK_SPEC`,前端据此显示"该任务无预览数据",不当作错误弹红。
 *  - engineReport 解析失败不影响预览,降级为 null。
 */
import { NextRequest } from 'next/server'
import { requireUser } from '@/lib/session'
import { ok, handleApiError, ApiError, assertTaskOwner } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

/**
 * prisma client 是否已按新 schema 重新生成不影响本文件编译:
 * 两个字段用局部类型补齐(SQLite 侧列已存在,LLM 侧只读)。
 */
type DeckSpecFields = { deckSpec?: string | null; engineReport?: string | null }

/** 解析失败/字段不存在都按"没有"处理,预览层只做展示,不因脏数据 500 */
function safeParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function GET(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireUser()
    const { id } = await params

    // 预览按需拉取(打开弹窗一次),30 次/分钟足够翻页与重开
    const rl = rateLimit(`taskspec:${session.userId}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    // includeLargeFields: deckSpec 就是那个"大字段",必须完整取回
    const task = await assertTaskOwner(id, session, { includeLargeFields: true })
    const fields = task as typeof task & DeckSpecFields

    if (!fields.deckSpec) {
      throw new ApiError(
        404,
        '该任务没有可预览的 Deck Spec(任务未生成到规格阶段,或为旧版任务)',
        'NO_DECK_SPEC',
      )
    }

    const spec = safeParse<Record<string, unknown>>(fields.deckSpec)
    if (!spec) {
      throw new ApiError(500, '该任务的 Deck Spec 无法解析', 'DECK_SPEC_UNREADABLE')
    }

    const slides = Array.isArray(spec.slides) ? spec.slides : []
    if (slides.length === 0) {
      throw new ApiError(404, '该任务的 Deck Spec 没有任何页面', 'NO_DECK_SPEC')
    }

    return ok({
      spec,
      engineReport: safeParse<unknown>(fields.engineReport),
      pages: slides.length,
    })
  } catch (e) {
    return handleApiError(e)
  }
}
