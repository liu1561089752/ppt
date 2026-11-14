/**
 * 限流器 - 内存计数(单进程)
 * 生产环境多进程需替换为 Redis
 */
type Bucket = { count: number; resetAt: number }

const store = new Map<string, Bucket>()

// Map 键来自攻击者可控输入(如伪造 XFF 造出的海量 IP 桶),且注册窗口 24h
// 长驻 ⇒ 无上界 Map 会被撑成内存膨胀。设键数上界:超限时先清已过期条目,
// 仍满则按插入序(Map 自带)淘汰最旧,再写入新键。
const MAX_KEYS = 20000

function setLimited<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  isExpired: (v: T) => boolean,
): void {
  if (!map.has(key) && map.size >= MAX_KEYS) {
    // 先清一遍已过期条目(过期判据由调用方给,这里不需要额外的时间快照)
    for (const [k, v] of map.entries()) {
      if (isExpired(v)) map.delete(k)
    }
    // 仍满则按插入序淘汰最旧(map.keys().next().value)
    while (map.size >= MAX_KEYS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
  map.set(key, value)
}

interface RateLimitResult {
  ok: boolean
  remaining: number
  resetAt: number
}

export function rateLimit(
  key: string,
  windowMs: number,
  max: number,
): RateLimitResult {
  const now = Date.now()
  const bucket = store.get(key)
  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + windowMs
    setLimited(store, key, { count: 1, resetAt }, (v) => v.resetAt <= now)
    return { ok: true, remaining: max - 1, resetAt }
  }
  if (bucket.count >= max) {
    return { ok: false, remaining: 0, resetAt: bucket.resetAt }
  }
  bucket.count += 1
  return { ok: true, remaining: max - bucket.count, resetAt: bucket.resetAt }
}

// 登录失败计数存储。until=0 表示"无退避等待、纯计数中"。
const lockStore = new Map<string, { until: number; fails: number }>()

function lockRecordExpired(v: { until: number }): boolean {
  return v.until !== 0 && v.until <= Date.now()
}

export function clearFail(key: string): void {
  lockStore.delete(key)
}

// ---------- 登录失败指数退避(用户名维度,替代硬锁) ----------
// 规格书红线5:用户名维度禁用"5 次失败硬锁 15 分钟"(可定向锁死 admin),
// 改为指数退避:失败次数越多,要求等待越久,但始终是"需等待"而非"锁死"。
// 复用 lockStore 的 { until, fails } 结构:until 即"下次允许尝试的时间"。
const BACKOFF_STEPS_MS = [0, 5_000, 30_000, 2 * 60_000, 15 * 60_000]

// 记一次失败并返回本次要求的 retryAfter 毫秒数(0=可立即重试)。
// fails>=BACKOFF_STEPS.length 后每次失败都刷新到封顶冷却(15min)。
export function recordBackoff(key: string): number {
  const now = Date.now()
  const record = lockStore.get(key)
  if (!record) {
    setLimited(lockStore, key, { until: 0, fails: 1 }, lockRecordExpired)
    return BACKOFF_STEPS_MS[0]
  }
  record.fails += 1
  const idx = Math.min(record.fails - 1, BACKOFF_STEPS_MS.length - 1)
  const wait = BACKOFF_STEPS_MS[idx]
  if (wait > 0) record.until = now + wait
  return wait
}

// 只读查询当前是否处于退避等待中;返回还需等待的毫秒数(0=无需等待)。
// 只读不删:未锁定时不能顺手 delete 记录,否则失败计数被清零
// (过期记录由定时任务清理)。
export function backoffRemaining(key: string): number {
  const record = lockStore.get(key)
  if (!record || record.until === 0) return 0
  const remain = record.until - Date.now()
  return remain > 0 ? remain : 0
}

// 清理过期项(每5分钟一次,避免内存泄漏)。
// lockStore 只删"退避已过期"的记录;until=0 是计数中的记录,不能按时间删,
// 否则失败计数每 5 分钟被清零,退避永远无法升级(原实现的隐患)。
// 计数中的残留记录由成功登录(clearFail)或 MAX_KEYS 淘汰兜底。
let lastCleanup = Date.now()
setInterval(() => {
  const now = Date.now()
  if (now - lastCleanup < 5 * 60 * 1000) return
  lastCleanup = now
  for (const [k, v] of store.entries()) {
    if (v.resetAt <= now) store.delete(k)
  }
  for (const [k, v] of lockStore.entries()) {
    if (lockRecordExpired(v)) lockStore.delete(k)
  }
}, 60 * 1000).unref?.()
