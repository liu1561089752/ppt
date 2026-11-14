/**
 * start-standalone.mjs — 跨平台启动 standalone 服务
 *
 * 原来的 `NODE_ENV=production bun .next/standalone/server.js` 只能跑在 POSIX shell:
 * Windows 的 cmd 不认 `VAR=value cmd` 前缀,`npm start` 在开发机上直接失败。
 * 这里用 Node 设好环境再 require 服务端入口,三平台一致。
 *
 * 顺带把 PROJECT_ROOT 兜住:standalone 的 cwd 会切到 .next/standalone,
 * 不显式指定会把 db/ 与 data/generated 写进构建产物里,下次 build 一并删掉。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const siteRoot = resolve(here, '..')
const server = join(siteRoot, '.next', 'standalone', 'server.js')

if (!existsSync(server)) {
  console.error('[start] 找不到 .next/standalone/server.js —— 先跑一次 `npm run build`(需要 output: "standalone")')
  process.exit(1)
}

process.env.NODE_ENV = process.env.NODE_ENV || 'production'
if (!process.env.PROJECT_ROOT) {
  process.env.PROJECT_ROOT = siteRoot
  console.warn(`[start] 未设置 PROJECT_ROOT,已回退为站点根:${siteRoot}`)
}
process.env.PORT = process.env.PORT || '3000'
process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0'

console.log(`[start] standalone 启动:port=${process.env.PORT} PROJECT_ROOT=${process.env.PROJECT_ROOT}`)
await import(server)
