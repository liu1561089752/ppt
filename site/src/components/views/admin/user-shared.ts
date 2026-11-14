/**
 * user-shared.ts — 用户管理页(admin-users-view)拆分出的共享类型。
 */

export interface UserItem {
  id: string
  username: string
  email: string | null
  remainingCredits: number
  isActive: boolean
  isAdmin: boolean
  createdAt: string
  lastLoginAt: string | null
  lastLoginIp: string | null
}

export interface UsersResponse {
  items: UserItem[]
  total: number
  page: number
  pageSize: number
}

export interface UserDetail {
  id: string
  username: string
  email: string | null
  remainingCredits: number
  isActive: boolean
  isAdmin: boolean
  createdAt: string
  lastLoginAt: string | null
  lastLoginIp: string | null
  redemptions: Array<{
    id: string
    cardId: string
    code: string
    credits: number
    cardStatus: string
    xianyuOrderNo: string | null
    createdAt: string
  }>
  tasks: Array<{
    id: string
    topic: string
    status: string
    preset: string | null
    language: string
    slideCount: number
    creditsUsed: number
    model: string | null
    durationMs: number | null
    errorMessage: string | null
    createdAt: string
    finishedAt: string | null
  }>
  creditChanges: Array<{
    id: string
    change: number
    reason: string
    balance: number
    remark: string | null
    taskId: string | null
    createdAt: string
  }>
}
