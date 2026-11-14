/**
 * postbuild-standalone.mjs — 把 static 与 public 拷进 standalone 产物
 *
 * 为什么要有这个文件:原来的 build 脚本是一行 POSIX shell
 * (`next build && (cp -r .next/static .next/standalone/.next/ && cp -r public ... || echo ...)`)。
 * 在 Windows 的 cmd 里 `(` 与 `||` 直接语法错,构建在**编译通过之后**才失败 —— 也就是
 * "tsc 绿了、next build 绿了、npm run build 红的",最难查的那种。改用 Node 脚本,
 * 三平台同一份逻辑,失败时给出具体原因。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const standalone = join(root, '.next', 'standalone')

if (!existsSync(standalone)) {
  // 没开 output:'standalone' 时没有这个目录,不算错误:直接 build 也能 next start
  console.log('[postbuild] 没有 .next/standalone(output 未设 standalone),跳过拷贝')
  process.exit(0)
}

const copies = [
  { from: join(root, '.next', 'static'), to: join(standalone, '.next', 'static'), label: 'static' },
  { from: join(root, 'public'), to: join(standalone, 'public'), label: 'public' },
]

for (const { from, to, label } of copies) {
  if (!existsSync(from)) {
    console.log(`[postbuild] 缺少 ${label} 源目录,跳过:${from}`)
    continue
  }
  mkdirSync(join(to, '..'), { recursive: true })
  cpSync(from, to, { recursive: true, force: true })
  console.log(`[postbuild] ${label} → ${to}`)
}

console.log('[postbuild] 完成')
