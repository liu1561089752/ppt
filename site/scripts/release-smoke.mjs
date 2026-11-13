/**
 * release-smoke.mjs — 发布冒烟:真实走一遍"引擎就绪 → 登录 → 生成 → 轮询 → 下载 → 解包断言"
 *
 *   BASE_URL=http://127.0.0.1:3000 SMOKE_PASS=*** bun scripts/release-smoke.mjs
 *
 * 断言针对原生链路的真实事故面(不再有浏览器截图、CDN 依赖、预览 PNG):
 *  1. 引擎就绪:跑 scripts/engine-doctor.mjs --json,ok 必须为 true;
 *  2. 任务到 succeeded;GET /api/tasks/[id]/spec 返回非空 deckSpec + engineReport(预览可用);
 *  3. 下载产物:体积下限 + zip 魔数 PK;
 *  4. 解包:ppt/slides/slideN.xml 页数 ≥ 请求页数(没有半截交付);
 *     逐页 <p:sp>/<a:t> 双 0 判空白页(原生对象普查,替代旧的"截图是不是白的");
 *  5. ppt/media 的张数只作信息(纯文字 deck 可以是 0 张)。
 *
 * 全部用 node 内置(zlib 解析 zip),不依赖 jszip/unzip/sharp —— 部署机上没有这些也能跑。
 * 退出码:0=通过 1=失败
 */
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000'
const USER = process.env.SMOKE_USER || 'admin'
// 无默认值:内置密码等于给仓库留一个公开凭据;缺失时直接失败
if (!process.env.SMOKE_PASS) {
  console.error('缺少 SMOKE_PASS 环境变量')
  process.exit(1)
}
const PASS = process.env.SMOKE_PASS
const TOPIC = process.env.SMOKE_TOPIC || '红茶与咖啡的全球贸易简史'
const EXPECTED_SLIDES = Number(process.env.SMOKE_SLIDES || 8)
const MIN_BYTES = Number(process.env.SMOKE_MIN_BYTES || 40 * 1024)

const say = (m) => console.log(`[smoke] ${m}`)
const fail = (m) => {
  console.error(`[smoke] FAIL: ${m}`)
  process.exit(1)
}

// ── 极简 zip 读取(中央目录 + inflateRaw)────────────────────────────────

function readZipEntries(buf) {
  // EOCD 在文件末尾,最多带 64KB 注释
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) fail('产物里找不到 zip 中央目录(不是合法 pptx)')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) fail('zip 中央目录损坏')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntry(buf, entry) {
  const local = entry.localOffset
  if (buf.readUInt32LE(local) !== 0x04034b50) fail(`zip 局部头损坏:${entry.name}`)
  const nameLength = buf.readUInt16LE(local + 26)
  const extraLength = buf.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const data = buf.subarray(start, start + entry.compressedSize)
  return entry.method === 0 ? data : inflateRawSync(data)
}

async function api(path, opts = {}, cookie = '') {
  return fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  })
}

// 1. 引擎就绪(G4 同一把尺子)
say('引擎就绪探针…')
const doctor = spawnSync(process.execPath, [fileURLToPath(new URL('./engine-doctor.mjs', import.meta.url)), '--json'], {
  encoding: 'utf8',
  timeout: 120000,
})
let doctorJson = null
try {
  doctorJson = JSON.parse((doctor.stdout || '').trim().split('\n').filter(Boolean).pop())
} catch {
  doctorJson = null
}
if (!doctorJson || doctorJson.ok !== true) {
  fail(`engine-doctor 未通过:${(doctor.stderr || doctor.stdout || '').slice(0, 300)}`)
}
say(`引擎 OK:${doctorJson.root}(version ${doctorJson.version || 'n/a'},deps ${doctorJson.deps || 'n/a'})`)

// 2. 登录
say('登录…')
const loginRes = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: USER, password: PASS }),
})
if (loginRes.status !== 200) fail(`登录 ${loginRes.status}`)
const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] || ''
if (!cookie) fail('未取得会话 cookie')
say('登录 OK')

// 3. 发起生成
say(`发起生成(${EXPECTED_SLIDES} 页)…`)
const genRes = await api('/api/generate', {
  method: 'POST',
  body: JSON.stringify({ requestId: crypto.randomUUID(), topic: TOPIC, slideCount: EXPECTED_SLIDES, language: 'zh-CN' }),
}, cookie)
const genJson = await genRes.json().catch(() => ({}))
const taskId = genJson?.taskId || genJson?.data?.taskId
if (genRes.status !== 200 || !taskId) fail(`发起生成 ${genRes.status} ${JSON.stringify(genJson).slice(0, 200)}`)
say(`任务 ${taskId}`)

// 4. 轮询终态(上限 20 分钟;任务看门狗约 18 分钟,轮询窗口必须盖过它)
const deadline = Date.now() + 20 * 60 * 1000
let task = null
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15000))
  const t = await (await api(`/api/tasks/${taskId}`, {}, cookie)).json()
  task = t?.data || t
  say(`状态 ${task?.status} ${task?.progressStage || ''} ${task?.progress ?? ''}%`)
  if (['succeeded', 'failed', 'refunded', 'cancelled'].includes(task?.status)) break
}
if (task?.status !== 'succeeded') fail(`任务终态 ${task?.status}: ${task?.errorMessage || ''}`)
say('生成成功')

// 5. 规格接口(预览的数据源)
say('规格接口断言…')
const specRes = await api(`/api/tasks/${taskId}/spec`, {}, cookie)
if (specRes.status !== 200) fail(`/api/tasks/${taskId}/spec HTTP ${specRes.status}`)
const specJson = await specRes.json().catch(() => ({}))
const specPayload = specJson?.data || specJson
const spec = specPayload?.spec
const slidesInSpec = Array.isArray(spec?.slides) ? spec.slides.length : 0
if (!spec || slidesInSpec === 0) fail('deckSpec 为空')
const engineReport = specPayload?.engineReport
const report = typeof engineReport === 'string' ? JSON.parse(engineReport) : engineReport
if (!report || typeof report !== 'object') fail('engineReport 缺失或不可解析')
say(`规格 OK:${slidesInSpec} 页,warnings=${report.warnings},bytes=${report.bytes},objects=${Object.keys(report.objects || {}).length} 类`)
if (slidesInSpec < EXPECTED_SLIDES) fail(`deckSpec 页数 ${slidesInSpec} < 请求 ${EXPECTED_SLIDES}`)

// 6. 下载
say('下载 PPTX…')
const tk = await (await api(`/api/tasks/${taskId}/create-download-token`, { method: 'POST' }, cookie)).json()
const token = tk?.data?.token || tk?.token
if (!token) fail('未取得下载 token')
const dl = await fetch(`${BASE}/api/download/${taskId}?token=${token}`)
if (dl.status !== 200) fail(`下载 ${dl.status}`)
const buf = Buffer.from(await dl.arrayBuffer())
if (buf.length < MIN_BYTES) fail(`产物过小 ${buf.length} 字节(原生 8 页实测约 175KB,阈值 ${MIN_BYTES})`)
if (!(buf[0] === 0x50 && buf[1] === 0x4b)) fail('产物不是 zip(PK 魔数校验失败)')
say(`下载 OK(${Math.round(buf.length / 1024)}KB,PK 校验通过)`)

// 7. 解包断言
say('解包断言…')
const dir = mkdtempSync(join(tmpdir(), 'smoke-native-'))
try {
  writeFileSync(join(dir, 'out.pptx'), buf)
  const entries = readZipEntries(buf)
  if (!entries.some((e) => e.name === '[Content_Types].xml')) fail('产物缺少 [Content_Types].xml')
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/u.test(e.name))
    .sort((a, b) => Number(a.name.match(/slide(\d+)/u)[1]) - Number(b.name.match(/slide(\d+)/u)[1]))
  if (slideEntries.length === 0) fail('产物里没有任何 ppt/slides/slideN.xml')
  if (slideEntries.length < EXPECTED_SLIDES) {
    fail(`产物页数 ${slideEntries.length} < 请求 ${EXPECTED_SLIDES}(半截交付)`)
  }
  const blanks = []
  for (const entry of slideEntries) {
    const xml = readZipEntry(buf, entry).toString('utf8')
    const shapes = (xml.match(/<p:sp[\s>]/gu) || []).length
    const texts = (xml.match(/<a:t[\s>]/gu) || []).length
    say(`  ${entry.name}: <p:sp>=${shapes} <a:t>=${texts}`)
    if (shapes === 0 && texts === 0) blanks.push(entry.name)
  }
  if (blanks.length > 0) fail(`空白页(形状与文本双 0):${blanks.join(', ')}`)
  const media = entries.filter((e) => /^ppt\/media\//u.test(e.name)).length
  const charts = entries.filter((e) => /^ppt\/charts\/chart\d+\.xml$/u.test(e.name)).length
  const tables = slideEntries.filter((e) => /<a:tbl[\s>]/u.test(readZipEntry(buf, e).toString('utf8'))).length
  say(`解包 OK:${slideEntries.length} 页,无空白页;media ${media} 个,charts ${charts} 个,含表格的页 ${tables} 个`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('[smoke] ✅ 全部通过')
