/**
 * app-store.ts
 *
 * 全局客户端状态(Zustand):
 * - user: 当前登录用户(use-current-user hook 通过 /api/auth/me 拉取后写入这里)
 * - view: 客户端路由(单页应用通过 view 切换视图,不走 Next.js 路由)
 * - authDialog: 登录/注册弹窗状态
 * - agreement: 用户协议/隐私/退款弹窗状态
 */
'use client'

import { create } from 'zustand'

export type View =
  | 'landing'
  | 'generate'
  | 'chat'
  | 'history'
  | 'redeem'
  | 'profile'
  | 'admin-cards'
  | 'admin-users'
  | 'admin-stats'
  | 'admin-logs'
  | 'admin-announcements'
  | 'admin-credit-changes'

export interface User {
  id: string
  username: string
  email: string | null
  remainingCredits: number
  isAdmin: boolean
  isActive: boolean
  createdAt: string
}

export type AuthDialogMode = 'login' | 'register'
export type AgreementTab = 'agreement' | 'privacy' | 'refund'

/** 合法视图词表(M-89):hash 恢复时只接受这里列出的值 */
export const VALID_VIEWS: readonly View[] = [
  'landing',
  'generate',
  'chat',
  'history',
  'redeem',
  'profile',
  'admin-cards',
  'admin-users',
  'admin-stats',
  'admin-logs',
  'admin-announcements',
  'admin-credit-changes',
]

/** 从 location.hash 解析合法 view,非法/缺失返回 null */
export function viewFromHash(hash: string): View | null {
  const v = hash.replace(/^#/, '') as View
  return VALID_VIEWS.includes(v) ? v : null
}

interface AppState {
  // 用户
  user: User | null
  setUser: (u: User | null) => void
  clearUser: () => void

  // 视图(客户端路由)
  view: View
  setView: (v: View) => void

  // AI 对话页当前任务
  activeTaskId: string | null
  openChat: (taskId: string) => void

  // 认证弹窗
  authDialogOpen: boolean
  authDialogMode: AuthDialogMode
  openAuthDialog: (mode?: AuthDialogMode) => void
  closeAuthDialog: () => void

  // 协议弹窗
  agreementOpen: boolean
  agreementTab: AgreementTab
  openAgreement: (tab?: AgreementTab) => void
  closeAgreement: () => void
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (u) => set({ user: u }),
  clearUser: () => set({ user: null, view: 'landing' }),

  view: 'landing',
  // 切换视图时同步 hash(M-89):history.pushState 不触发 popstate,
  // 浏览器返回键由 app-shell 的 popstate 监听消费;SSR 无 window 需守卫
  setView: (v) => {
    set({ view: v })
    if (typeof window !== 'undefined') {
      try {
        window.history.pushState({ view: v }, '', `#${v}`)
      } catch {
        /* 极端环境(隐私模式等)忽略,不影响视图切换 */
      }
    }
  },

  activeTaskId: null,
  openChat: (taskId) => set({ activeTaskId: taskId, view: 'chat' }),

  authDialogOpen: false,
  authDialogMode: 'login',
  openAuthDialog: (mode = 'login') =>
    set({ authDialogOpen: true, authDialogMode: mode }),
  closeAuthDialog: () => set({ authDialogOpen: false }),

  agreementOpen: false,
  agreementTab: 'agreement',
  openAgreement: (tab = 'agreement') => set({ agreementOpen: true, agreementTab: tab }),
  closeAgreement: () => set({ agreementOpen: false }),
}))
