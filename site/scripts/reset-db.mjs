/**
 * reset-db.mjs — 初始化数据库:清空全部业务数据,保留管理员账号
 *
 * 清除:GenerationTask / ChatMessage / DownloadToken / CreditChange / Redemption /
 *       Card / CardBatch / AuditLog / Announcement / 非管理员用户
 *       + data/generated 下所有任务产物(原生 .pptx 与下载落盘的配图)
 * 保留:管理员账号(用户名密码不变,余额默认重置为 999)、SystemConfig(系统配置)
 *
 * 用法(在仓库根目录): bun scripts/reset-db.mjs [--keep-credits] [--db-only]
 *   --keep-credits  不改管理员余额
 *   --db-only       只清数据库,不删磁盘产物
 * 运行前自动把当前库备份到 db/custom.db.bak-<时间戳>(含 WAL)。
 * 建议先停止网站再执行,完成后重启(避免应用持有旧连接缓存)。
 * 注:原生链路没有 slides/ 与 preview/ 目录了,任务目录下只剩 .pptx 与 media/。
 */
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import path from 'node:path'

const REPO = dirname(import.meta.dir)
const keepCredits = process.argv.includes('--keep-credits')
const dbOnly = process.argv.includes('--db-only')

const dbUrl = process.env.DATABASE_URL || ''
if (!dbUrl.startsWith('file:')) {
  console.error(`DATABASE_URL 缺失或不是 file: 形式(${dbUrl || '未设置'})——请在仓库根目录用 bun 运行以自动加载 .env`)
  process.exit(1)
}
// DATABASE_URL 的 file: 路径按 .env 语境解析:
// - 绝对路径(云端 file:/home/chatppt/data/custom.db)原样使用
// - 相对路径(file:./db/custom.db)相对仓库根(即本脚本上一级)解析,
//   而不是相对 cwd —— 否则从仓库根运行时解析到 ../db/custom.db 必 ENOENT
const dbPath = path.isAbsolute(dbUrl.slice('file:'.length))
  ? dbUrl.slice('file:'.length)
  : join(REPO, 'prisma', dbUrl.slice('file:'.length))

// 1. 备份
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${dbPath}.bak-${ts}`
copyFileSync(dbPath, backup)
for (const ext of ['-wal', '-shm']) {
  if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, backup + ext)
}
console.log(`✓ 已备份原库 → ${backup}`)

// 2. 清库(按外键依赖顺序:子表 → 父表)
const db = new Database(dbPath)
db.exec('PRAGMA foreign_keys = ON')
const TABLES = [
  'ChatMessage', 'DownloadToken', 'CreditChange', 'Redemption',
  'Card', 'CardBatch', 'AuditLog', 'GenerationTask', 'Announcement',
]
const counts = {}
for (const t of TABLES) counts[t] = db.query(`SELECT COUNT(*) c FROM "${t}"`).get().c
const nonAdmins = db.query('SELECT COUNT(*) c FROM User WHERE isAdmin = 0').get().c

const wipe = db.transaction(() => {
  for (const t of TABLES) db.exec(`DELETE FROM "${t}"`)
  db.exec('DELETE FROM User WHERE isAdmin = 0')
  if (!keepCredits) db.exec('UPDATE User SET remainingCredits = 999, updatedAt = (unixepoch() * 1000) WHERE isAdmin = 1')
})
wipe()

const kept = db.query('SELECT username, remainingCredits FROM User').all()
console.log('✓ 已清空:', TABLES.map((t) => `${t}:${counts[t]}`).join(' '), `User(非管理员):${nonAdmins}`)
console.log('✓ 保留管理员:', kept.map((u) => `${u.username}(余额 ${u.remainingCredits})`).join(', ') || '(无!)')
db.close()

// VACUUM 必须在事务外单独执行(回收文件体积)
const vac = new Database(dbPath)
vac.exec('VACUUM')
vac.close()
console.log('✓ VACUUM 完成')

// 3. 清磁盘产物
const genDir = join(REPO, 'data', 'generated')
if (!dbOnly && existsSync(genDir)) {
  let dirs = 0
  let bytes = 0
  for (const name of readdirSync(genDir)) {
    const p = join(genDir, name)
    bytes += dirSize(p)
    rmSync(p, { recursive: true, force: true })
    dirs++
  }
  mkdirSync(genDir, { recursive: true })
  console.log(`✓ 已删除任务产物:${dirs} 个目录,${(bytes / 1024 / 1024).toFixed(1)}MB`)
} else if (dbOnly) {
  console.log('· --db-only:跳过磁盘产物清理')
}
console.log('完成。请重启网站使新库生效。')

function dirSize(p) {
  const st = statSync(p)
  if (!st.isDirectory()) return st.size
  let n = 0
  for (const f of readdirSync(p)) n += dirSize(join(p, f))
  return n
}
