/**
 * 卡密格式常量与纯校验(客户端安全)
 *
 * 示例: K7XQ-2M9F-P4WT-8YBN(Crockford Base32,16 字符 + 3 短横)
 *
 * ⚠️ 本模块同时被浏览器(兑换页格式校验)与服务端使用:
 * 禁止引入 config.ts / crypto / db 等服务端依赖,否则客户端 bundle
 * 会在浏览器中执行服务端模块级逻辑导致视图崩溃。
 * 生成卡密(需 crypto 随机源)在 card-code-gen.ts(服务端专用)。
 */

/** Crockford Base32(去掉易混淆的 0/O/1/I/L) */
export const CARD_CHARSET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CARD_GROUPS = 4
export const CARD_GROUP_LEN = 4

export function normalizeCardCode(input: string): string {
  // 去除空格、统一大写、把连续非字母数字字符转为单个短横
  const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-')
  // 校验字符集
  for (const c of cleaned) {
    if (c === '-') continue
    if (!CARD_CHARSET.includes(c)) return ''
  }
  return cleaned
}

export function isValidCardCodeFormat(input: string): boolean {
  const normalized = normalizeCardCode(input)
  if (!normalized) return false
  const groups = normalized.split('-').filter(Boolean)
  if (groups.length !== CARD_GROUPS) return false
  return groups.every((g) => g.length === CARD_GROUP_LEN)
}
