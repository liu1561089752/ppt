/**
 * app-shell.tsx
 *
 * 主外壳组件:
 * - 监听 useCurrentUser 拉取登录状态
 * - 用 Zustand 读 view state,根据 view 渲染对应视图组件
 * - 未实现的视图通过 next/dynamic + ErrorBoundary 优雅降级到"开发中"占位
 * - admin-* 视图只对 isAdmin=true 用户开放,否则提示无权限
 * - 整体布局:NavBar + main + Footer(Sticky Footer 通过 min-h-screen flex flex-col + mt-auto)
 * - 用 framer-motion 做轻量 view 切换过渡
 */
'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import { ShieldAlert, Loader2 } from 'lucide-react'

import { NavBar } from '@/components/nav-bar'
import { Footer } from '@/components/footer'
import { AuthDialog } from '@/components/auth-dialog'
import { AgreementDialog } from '@/components/agreement-dialog'
import { LandingView } from '@/components/landing-view'
import { ViewBoundary } from '@/components/view-boundary'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import { useAppStore, viewFromHash, type View } from '@/store/app-store'
import { useCurrentUser } from '@/hooks/use-current-user'

// --- 动态加载视图 ---
// 注:当前为 Task 4-b/4-c 占位实现(显示"开发中"卡片)。Task 4-b/4-c 实现
// 后会直接覆盖这些文件,保留 `export default function XxxView()` 命名即可。
const GenerateView = dynamic(
  () => import('@/components/views/generate-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const ChatView = dynamic(
  () => import('@/components/views/chat-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const HistoryView = dynamic(
  () => import('@/components/views/history-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const RedeemView = dynamic(
  () => import('@/components/views/redeem-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const ProfileView = dynamic(
  () => import('@/components/views/profile-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const AdminCardsView = dynamic(
  () => import('@/components/views/admin/admin-cards-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const AdminUsersView = dynamic(
  () => import('@/components/views/admin/admin-users-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const AdminStatsView = dynamic(
  () => import('@/components/views/admin/admin-stats-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const AdminLogsView = dynamic(
  () => import('@/components/views/admin/admin-logs-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const AdminAnnouncementsView = dynamic(
  () => import('@/components/views/admin/admin-announcements-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)
const AdminCreditChangesView = dynamic(
  () => import('@/components/views/admin/admin-credit-changes-view').then((m) => m.default),
  { ssr: false, loading: () => <ViewSkeleton /> },
)

// --- 加载占位 ---
function ViewSkeleton() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-8 sm:px-6">
      <Skeleton className="h-10 w-1/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

function FullScreenLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        <p className="text-sm">加载中…</p>
      </div>
    </div>
  )
}

function NoPermission() {
  const setView = useAppStore((s) => s.setView)
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:py-24">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <ShieldAlert className="size-6" />
          </div>
          <CardTitle className="text-base">无访问权限</CardTitle>
          <CardDescription className="text-sm">
            该模块仅对管理员开放,普通用户无法访问。如有疑问请联系客服。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button variant="outline" onClick={() => setView('landing')}>
            返回首页
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

// --- 视图渲染分发 ---
const ADMIN_VIEWS: View[] = [
  'admin-cards',
  'admin-users',
  'admin-stats',
  'admin-logs',
  'admin-announcements',
  'admin-credit-changes',
]

function renderViewContent(view: View, isAdmin: boolean): React.ReactNode {
  // 管理员视图权限校验
  if (ADMIN_VIEWS.includes(view) && !isAdmin) {
    return <NoPermission />
  }

  // 视图分发
  let element: React.ReactNode
  switch (view) {
    case 'landing':
      element = (
        <ViewBoundary view="首页">
          <LandingView />
        </ViewBoundary>
      )
      break
    case 'generate':
      element = (
        <ViewBoundary view="生成 PPT">
          <GenerateView />
        </ViewBoundary>
      )
      break
    case 'chat':
      element = (
        <ViewBoundary view="AI 生成对话">
          <ChatView />
        </ViewBoundary>
      )
      break
    case 'history':
      element = (
        <ViewBoundary view="我的任务">
          <HistoryView />
        </ViewBoundary>
      )
      break
    case 'redeem':
      element = (
        <ViewBoundary view="兑换卡密">
          <RedeemView />
        </ViewBoundary>
      )
      break
    case 'profile':
      element = (
        <ViewBoundary view="个人中心">
          <ProfileView />
        </ViewBoundary>
      )
      break
    case 'admin-cards':
      element = (
        <ViewBoundary view="卡密管理">
          <AdminCardsView />
        </ViewBoundary>
      )
      break
    case 'admin-users':
      element = (
        <ViewBoundary view="用户管理">
          <AdminUsersView />
        </ViewBoundary>
      )
      break
    case 'admin-stats':
      element = (
        <ViewBoundary view="数据看板">
          <AdminStatsView />
        </ViewBoundary>
      )
      break
    case 'admin-logs':
      element = (
        <ViewBoundary view="审计日志">
          <AdminLogsView />
        </ViewBoundary>
      )
      break
    case 'admin-announcements':
      element = (
        <ViewBoundary view="公告管理">
          <AdminAnnouncementsView />
        </ViewBoundary>
      )
      break
    case 'admin-credit-changes':
      element = (
        <ViewBoundary view="次数对账">
          <AdminCreditChangesView />
        </ViewBoundary>
      )
      break
    default:
      element = (
        <ViewBoundary view="首页">
          <LandingView />
        </ViewBoundary>
      )
  }
  return element
}

export function AppShell() {
  // 启动 useCurrentUser,拉取登录状态并同步到 store
  const userQuery = useCurrentUser()
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)

  const user = userQuery.data
  const isAdmin = !!user?.isAdmin
  const isInitialLoading = userQuery.isLoading

  // 未登录用户强制返回 landing
  React.useEffect(() => {
    if (!isInitialLoading && !user && view !== 'landing') {
      // 非登录态下访问任何非 landing 视图,回首页
      // (管理员视图已通过 renderViewContent 中的 NoPermission 兜底,
      //  这里只兜底非管理员视图)
      setView('landing')
    }
  }, [isInitialLoading, user, view, setView])

  // hash 路由恢复(M-89):
  // ① 首次挂载:hash 有合法 view 直接进入(如刷新后回到原视图)
  // ② popstate(浏览器返回/前进):读 hash 恢复 view,非法值回 landing
  //    (直接 set 内部状态,不走 setView 以免再次 pushState 打断历史链)
  React.useEffect(() => {
    const fromHash = viewFromHash(window.location.hash)
    if (fromHash && fromHash !== useAppStore.getState().view) {
      useAppStore.setState({ view: fromHash })
    }
    const onPopState = () => {
      const v = viewFromHash(window.location.hash) ?? 'landing'
      useAppStore.setState({ view: v })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // 首次加载用户态时显示 loader(避免在 fetch 完成前闪烁未登录状态)
  if (isInitialLoading) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <NavBar />
        <main className="flex-1">
          <FullScreenLoader />
        </main>
        <Footer />
      </div>
    )
  }

  const content = renderViewContent(view, isAdmin)

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <NavBar />
      <main className="flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {content}
          </motion.div>
        </AnimatePresence>
      </main>
      <Footer />

      {/* 全局弹窗 */}
      <AuthDialog />
      <AgreementDialog />
    </div>
  )
}
