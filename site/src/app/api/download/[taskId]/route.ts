/**
 * GET /api/download/[taskId]?token=xxx
 * 下载生成的 PPT 文件
 *
 * - 鉴权完全依赖 download token(限时 1 小时、限期内可重复下载),不依赖登录
 *   cookie——这样 `a.href` 直链下载在任何 cookie/SameSite 策略下都能工作
 * - 校验 token: 存在 + 未过期 + 任务归属一致(创建 token 时已校验归属)
 * - 限时多次是刻意设计:部分移动端浏览器(Via 等)会对下载链接先做预取探测,
 *   一次性 token 会被预取消耗导致真正下载 409;安全性由 128 位随机 + 1h 过期
 *   + 仅限绑定任务的单个文件保障
 * - 读取 PPT buffer,返回二进制流
 * - 文件名: chatppt-{topic-slug}.pptx,topic 非法字符替换为 -
 */
import { NextResponse, NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { readGenerated } from '@/lib/file-storage'
import { err, handleApiError, ApiError, getClientIp } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

function slugify(s: string): string {
  // 替换非法字符为 -,并限制长度
  const cleaned = s
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5\-_.\s]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (cleaned || 'untitled').slice(0, 80)
}

export async function GET(
  req: Request | NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await params

    // 轻限流:无会话路由按 IP 30/min(下载走磁盘 IO + 大文件流,防刷)
    const rl = rateLimit(`download:${getClientIp(req as Request)}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const url = new URL(req.url)
    const token = url.searchParams.get('token')
    if (!token) {
      throw new ApiError(400, '请提供 token', 'VALIDATION_ERROR')
    }

    // 1. 查 token
    const dlToken = await db.downloadToken.findUnique({
      where: { token },
    })
    if (!dlToken) {
      throw new ApiError(404, '下载链接无效', 'TASK_NOT_FOUND')
    }
    if (dlToken.taskId !== taskId) {
      throw new ApiError(404, '下载链接无效', 'TASK_NOT_FOUND')
    }
    if (dlToken.expiresAt.getTime() < Date.now()) {
      throw new ApiError(410, '下载链接已过期,请重新生成', 'TASK_NOT_READY')
    }
    // 注意:token 为「限时(1h)多次」而非一次性——部分移动端浏览器(Via 等)
    // 会对下载链接先做预取探测,一次性 token 会被预取消耗导致真正下载 409。
    // 安全性不变:128 位随机 + 1 小时过期 + 仅限绑定任务的单个文件。

    // 2. 查 task(联查任务归属用户的 isActive:封禁用户的存量令牌一律按无效处理)
    const task = await db.generationTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        userId: true,
        status: true,
        resultFile: true,
        topic: true,
        user: { select: { isActive: true } },
      },
    })
    if (!task) {
      throw new ApiError(404, '任务不存在', 'TASK_NOT_FOUND')
    }
    // 归属校验已在 create-download-token 时完成(token 与任务绑定)
    // 这里 dlToken.taskId === taskId 已隐式保证归属正确
    // (M-106:封禁用户即使 token 未过期/未吊销,下载时也复查 isActive,双保险)
    if (!task.user.isActive) {
      throw new ApiError(401, '下载链接无效', 'TOKEN_INVALID')
    }
    if (task.status !== 'succeeded' || !task.resultFile) {
      throw new ApiError(409, '任务尚未完成,无法下载', 'TASK_NOT_READY')
    }

    // 3. 记录使用时间(统计用;不作废 token——支持浏览器重试/续传/预取)
    await db.downloadToken
      .update({
        where: { id: dlToken.id },
        data: { usedAt: new Date() },
      })
      .catch(() => {})

    // 4. 读取 PPT buffer
    let buffer: Buffer
    try {
      buffer = await readGenerated(task.resultFile)
    } catch {
      throw new ApiError(404, '生成文件不存在,可能已被清理', 'TASK_NOT_FOUND')
    }

    // 5. 返回文件流
    const filename = `chatppt-${slugify(task.topic)}.pptx`
    const safeFilename = encodeURIComponent(filename)
    // ASCII-only fallback for `filename=`(HTTP header 是 ByteString,不能含 >255 字符)
    const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '') || 'chatppt.pptx'
    // 用 Blob 包装,避免 TS BodyInit 与 Buffer 类型不兼容问题
    const blob = new Blob([buffer as unknown as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    return new NextResponse(blob, {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${safeFilename}`,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    // NextResponse 已经返回的情况下也需要兼容
    if (e instanceof ApiError) {
      return err(e.status, e.message, e.code)
    }
    return handleApiError(e)
  }
}
