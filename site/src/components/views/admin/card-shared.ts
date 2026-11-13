/**
 * card-shared.ts — 卡密管理页(admin-cards-view)拆分出的共享类型。
 */

export type CardStatus = 'unused' | 'used' | 'revoked'

export interface CardItem {
  id: string
  code: string
  credits: number
  status: CardStatus
  batchNo: string | null
  expiresAt: string | null
  redeemedBy: string | null
  redeemedAt: string | null
  createdAt: string
}

export interface CardsResponse {
  items: CardItem[]
  total: number
  page: number
  pageSize: number
}

export interface BatchItem {
  id: string
  batchNo: string
  credits: number
  quantity: number
  remark: string | null
  expiresAt: string | null
  createdAt: string
  createdBy: string
  stats: { total: number; unused: number; used: number; revoked: number }
}

export interface BatchesResponse {
  items: BatchItem[]
  total: number
  page: number
  pageSize: number
}

export interface GenerateResponse {
  batchNo: string
  quantity: number
  credits: number
  cards: { code: string; credits: number }[]
}
