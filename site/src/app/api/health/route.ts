/**
 * GET /api/health — 部署健康检查(面板与冒烟脚本使用)
 *
 * - 顶层 ok 字段:面板/脚本无需解析内部细节即可判断健康状态
 * - 匿名请求只回 { ok, version }:health 是无鉴权探针,不能成为内部信息泄漏面
 * - 仅管理员会话(getSession 验 isAdmin)才回详细 checks
 * - 503 时 checks.env/checks.db 一律固定文案 'failed',
 *   e.message 可能含 DATABASE_URL/PROJECT_ROOT 前 40 字符,细节只进服务端日志
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { assertEnvSafety } from '@/lib/config'
import { getSession } from '@/lib/session'

export async function GET() {
  let envOk = true
  let dbOk = true
  try {
    assertEnvSafety()
  } catch (e) {
    envOk = false
    console.error('[health] env check failed:', (e as Error).message)
  }
  try {
    await db.$queryRaw`SELECT 1`
  } catch (e) {
    dbOk = false
    console.error('[health] db check failed:', (e as Error).message)
  }
  const healthy = envOk && dbOk

  // 匿名(含未登录/非管理员):最小披露,只回 ok + version
  const session = await getSession()
  const isAdmin = session?.isAdmin === true
  if (!isAdmin) {
    return NextResponse.json(
      { ok: healthy, version: 'v2.0.0' },
      { status: healthy ? 200 : 503 },
    )
  }

  const checks: Record<string, unknown> = {
    version: 'v2.0.0',
    runtime: 'bun',
    env: envOk ? 'ok' : 'failed', // 不回显 e.message(可能含敏感配置前缀)
    db: dbOk ? 'ok' : 'failed',
  }
  return NextResponse.json({ ok: healthy, ...checks }, { status: healthy ? 200 : 503 })
}
