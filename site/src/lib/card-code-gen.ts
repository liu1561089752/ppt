/**
 * 卡密生成(服务端专用,依赖 crypto 随机源)
 * 仅被管理端 API 引用,不要从客户端组件导入。
 */
import { randomBytes } from 'crypto'
import { CARD_CHARSET, CARD_GROUPS, CARD_GROUP_LEN } from './card-code'

function randomChar(): string {
  const buf = randomBytes(1)
  return CARD_CHARSET[buf[0] % CARD_CHARSET.length]
}

export function generateCardCode(): string {
  const parts: string[] = []
  for (let g = 0; g < CARD_GROUPS; g++) {
    let part = ''
    for (let i = 0; i < CARD_GROUP_LEN; i++) {
      part += randomChar()
    }
    parts.push(part)
  }
  return parts.join('-')
}
