#!/usr/bin/env node
/**
 * engine-doctor.mjs — G4 判据:打印解析到的原生引擎根 + 跑一次 `--check` 探针
 *
 *   node scripts/engine-doctor.mjs            # 人读输出
 *   node scripts/engine-doctor.mjs --json     # 机器读(CI 用),退出码即判据
 *
 * 为什么是 .mjs 而不是复用 src/lib/pipeline/native.ts:
 * 这个脚本要在**部署机**上跑(可能没有 tsx/TS 工具链),所以只依赖 node 内置模块。
 * 逻辑与 native.ts 的 engineDoctor 同源:目录存在 → cli.js 存在 → --help 能起 →
 * 最小 spec 的 --check 通过(这一步才会真正加载 engine/native_pptx、pptxgenjs、
 * fontkit、image-size、jszip;依赖缺失在这里就会炸,而不是等到用户生成时)。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const wantJson = process.argv.includes('--json')
const configured = (process.env.NATIVE_ENGINE_DIR || '').trim()
const root = resolve(process.cwd(), configured || join('..', 'pptx', 'native'))
const cli = join(root, 'cli.js')

function fail(message, detail) {
  if (wantJson) {
    process.stdout.write(JSON.stringify({ ok: false, root, message, detail: detail || null }) + '\n')
  } else {
    console.error('[engine-doctor] FAIL: ' + message)
    if (detail) console.error(detail)
  }
  process.exit(1)
}

function pass(payload) {
  if (wantJson) {
    process.stdout.write(JSON.stringify(Object.assign({ ok: true, root }, payload)) + '\n')
  } else {
    console.log('[engine-doctor] OK')
    console.log('  root    : ' + root)
    if (payload.version) console.log('  version : ' + payload.version)
    if (payload.slides) console.log('  probe   : --check 通过(' + payload.slides + ' 页最小 deck)')
    if (payload.deps) console.log('  deps    : ' + payload.deps)
  }
  process.exit(0)
}

if (!existsSync(root)) {
  fail('引擎目录不存在(设 NATIVE_ENGINE_DIR 指向 pptx/native)', '使用中的路径:' + root)
}
if (!existsSync(cli)) {
  fail('引擎目录里没有 cli.js(NATIVE_ENGINE_DIR 指错了?)', '使用中的路径:' + cli)
}

let version = null
try {
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version || null
} catch {
  version = null
}

// 依赖探测:不 require(避免本脚本自己被引擎依赖污染),只查文件是否在位;
// 真正的可加载性由下面的 --check 证明。
const DEPS = ['pptxgenjs', 'fontkit', 'image-size', 'jszip']
const missingDeps = DEPS.filter((name) => !existsSync(join(root, 'node_modules', name)))
const depsText = DEPS.map((name) => name + (missingDeps.includes(name) ? '(缺)' : '')).join(' · ')

const help = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8', timeout: 20000 })
if (help.error) fail('无法启动 node: ' + help.error.message)
if (help.status !== 0 || !/native deck tool/i.test(help.stdout || '')) {
  fail('cli.js --help 未按预期输出', String(help.stderr || help.stdout || '').slice(0, 400))
}

const dir = mkdtempSync(join(tmpdir(), 'engine-doctor-'))
let probe
try {
  const specFile = join(dir, 'probe.json')
  writeFileSync(specFile, JSON.stringify({
    title: 'engine doctor probe',
    language: 'zh-CN',
    pageSize: 'wide',
    slides: [{ elements: [{ type: 'text', text: 'ok', x: 0.5, y: 0.5, w: 2, h: 0.4 }] }],
  }), 'utf8')
  probe = spawnSync(process.execPath, [cli, specFile, '--check', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (probe.error) fail('--check 探针无法启动: ' + probe.error.message)
let parsed = null
try {
  parsed = JSON.parse((probe.stdout || '').trim().split('\n').filter(Boolean).pop())
} catch {
  parsed = null
}
if (probe.status !== 0 || !parsed || parsed.ok !== true) {
  fail('--check 探针失败(引擎或其依赖无法加载)', String(probe.stderr || probe.stdout || '').slice(0, 800))
}
if (missingDeps.length > 0) {
  // --check 能过说明依赖其实可用(可能被 hoist 到上层 node_modules),只作提示
  console.warn('[engine-doctor] 提示:引擎根下未见 ' + missingDeps.join(', ') + '(--check 已通过,可能来自上层 node_modules)')
}

pass({ version, slides: parsed.slides || 1, deps: depsText })
