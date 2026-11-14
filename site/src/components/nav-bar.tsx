/**
 * nav-bar.tsx
 *
 * 顶部导航(响应式):
 * - 桌面:Logo + 标题 + 主菜单(Generate / History / Redeem / Profile)+ 管理员菜单 + 用户区
 * - 移动:Logo + 汉堡菜单(Sheet)展开
 * - 未登录:仅"登录""注册"按钮 + 主题切换
 * - 已登录:剩余次数 Badge + 用户名下拉(切换视图/登出)
 * - 管理员:合并为"管理后台"dropdown,5+1 项
 */
'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import {
  Menu,
  Moon,
  Sun,
  Sparkles,
  History,
  Gift,
  User as UserIcon,
  ShieldCheck,
  LayoutDashboard,
  LogOut,
  Home,
  KeyRound,
  Users,
  BarChart3,
  ScrollText,
  Megaphone,
  Coins,
  UserCog,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetHeader,
  SheetTitle,
  SheetClose,
} from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import {
  Avatar,
  AvatarFallback,
} from '@/components/ui/avatar'

import { useAppStore, type View } from '@/store/app-store'
import { apiPost } from '@/lib/api-client'
import { CURRENT_USER_QUERY_KEY } from '@/hooks/use-current-user'

interface NavItem {
  key: View
  label: string
  icon: React.ReactNode
}

const MAIN_NAV: NavItem[] = [
  { key: 'generate', label: '生成 PPT', icon: <Sparkles className="size-4" /> },
  { key: 'history', label: '我的任务', icon: <History className="size-4" /> },
  { key: 'redeem', label: '兑换卡密', icon: <Gift className="size-4" /> },
  { key: 'profile', label: '个人中心', icon: <UserIcon className="size-4" /> },
]

const ADMIN_NAV: NavItem[] = [
  { key: 'admin-cards', label: '卡密管理', icon: <KeyRound className="size-4" /> },
  { key: 'admin-users', label: '用户管理', icon: <Users className="size-4" /> },
  { key: 'admin-stats', label: '数据看板', icon: <BarChart3 className="size-4" /> },
  { key: 'admin-logs', label: '审计日志', icon: <ScrollText className="size-4" /> },
  { key: 'admin-announcements', label: '公告管理', icon: <Megaphone className="size-4" /> },
  { key: 'admin-credit-changes', label: '次数对账', icon: <Coins className="size-4" /> },
]

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
// eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后置位,规避 SSR/CSR 主题水合不一致(标准 mounted 模式)
  React.useEffect(() => setMounted(true), [])

  const isDark = mounted ? theme === 'dark' : false

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="切换主题"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="size-9"
    >
      {mounted && isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}

function LogoButton() {
  const setView = useAppStore((s) => s.setView)
  return (
    <button
      type="button"
      onClick={() => setView('landing')}
      className="flex items-center gap-2 outline-none"
      aria-label="ChatPPT 首页"
    >
      <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Sparkles className="size-4" />
      </span>
      <span className="text-base font-semibold tracking-tight">ChatPPT</span>
    </button>
  )
}

export function NavBar() {
  // 单独 selector 订阅,避免任意 store 变化触发整栏重渲染
  const user = useAppStore((s) => s.user)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const openAuthDialog = useAppStore((s) => s.openAuthDialog)
  const clearUser = useAppStore((s) => s.clearUser)
  const queryClient = useQueryClient()
  const [mobileOpen, setMobileOpen] = React.useState(false)

  const handleLogout = async () => {
    if (!window.confirm('确定退出登录?')) return
    try {
      await apiPost('/api/auth/logout')
      toast.success('已退出登录')
    } catch (e) {
      toast.error((e as Error).message || '退出登录失败')
    } finally {
      // 即使后端报错也清本地状态(用户已经想登出了)
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, null)
      clearUser()
      setView('landing')
    }
  }

  // 切换账号(M-44):本地登出(不清服务端会话语义由 logout 路由处理)后打开登录弹窗
  const handleSwitchAccount = async () => {
    try {
      await apiPost('/api/auth/logout')
    } catch {
      /* 本地切换不依赖服务端成功 */
    }
    queryClient.setQueryData(CURRENT_USER_QUERY_KEY, null)
    clearUser()
    setView('landing')
    setMobileOpen(false)
    openAuthDialog('login')
  }

  // 切换视图(并关闭移动菜单)
  const goView = (v: View) => {
    setView(v)
    setMobileOpen(false)
  }

  // 未登录用户的右侧按钮
  const renderLoggedOutActions = () => (
    <div className="flex items-center gap-1.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => openAuthDialog('login')}
        className="text-sm"
      >
        登录
      </Button>
      <Button
        size="sm"
        onClick={() => openAuthDialog('register')}
        className="text-sm"
      >
        注册
      </Button>
    </div>
  )

  // 已登录用户的右侧用户区
  const renderUserMenu = () => {
    if (!user) return null
    return (
      <div className="flex items-center gap-2">
        {/* 剩余次数 Badge */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => goView('profile')}
          className="gap-1.5"
        >
          <Sparkles className="size-3.5 text-amber-500" />
          <span className="font-medium">{user.remainingCredits}</span>
          <span className="text-muted-foreground">次</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2 px-1.5">
              <Avatar className="size-7">
                <AvatarFallback className="bg-primary/10 text-xs">
                  {user.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="hidden text-sm font-medium sm:inline-block max-w-24 truncate">
                {user.username}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-sm font-medium truncate">{user.username}</span>
              <span className="text-xs text-muted-foreground">
                剩余 {user.remainingCredits} 次
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => goView('generate')}>
              <Sparkles className="size-4" />
              生成 PPT
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => goView('history')}>
              <History className="size-4" />
              我的任务
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => goView('redeem')}>
              <Gift className="size-4" />
              兑换卡密
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => goView('profile')}>
              <UserIcon className="size-4" />
              个人中心
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSwitchAccount}>
              <UserCog className="size-4" />
              切换账号
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={handleLogout}
            >
              <LogOut className="size-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  // 管理员合并菜单
  const renderAdminDropdown = () => {
    if (!user?.isAdmin) return null
    const activeAdminView = ADMIN_NAV.find((n) => n.key === view)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={activeAdminView ? 'secondary' : 'ghost'}
            size="sm"
            className="gap-1.5"
          >
            <ShieldCheck className="size-4" />
            <span>管理后台</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="flex items-center gap-2">
            <LayoutDashboard className="size-4" />
            后台管理
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {ADMIN_NAV.map((item) => (
            <DropdownMenuItem
              key={item.key}
              onClick={() => goView(item.key)}
              className={cn(view === item.key && 'bg-accent')}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // 移动端菜单内容
  const renderMobileMenu = () => (
    <div className="flex h-full flex-col gap-2 p-4">
      <SheetHeader className="text-left">
        <SheetTitle className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </span>
          ChatPPT
        </SheetTitle>
      </SheetHeader>

      <Separator />

      {/* 用户信息卡片 */}
      {user ? (
        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Avatar className="size-9">
                <AvatarFallback className="bg-primary/10 text-xs">
                  {user.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="text-sm font-medium">{user.username}</div>
                <div className="text-xs text-muted-foreground">
                  剩余 {user.remainingCredits} 次
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <SheetClose asChild>
            <Button
              variant="outline"
              onClick={() => openAuthDialog('login')}
            >
              登录
            </Button>
          </SheetClose>
          <SheetClose asChild>
            <Button onClick={() => openAuthDialog('register')}>注册</Button>
          </SheetClose>
        </div>
      )}

      <Separator />

      {/* 导航区 */}
      <nav className="flex flex-col gap-1">
        <SheetClose asChild>
          <Button
            variant={view === 'landing' ? 'secondary' : 'ghost'}
            onClick={() => goView('landing')}
            className="justify-start gap-2"
          >
            <Home className="size-4" />
            首页
          </Button>
        </SheetClose>

        {user && (
          <>
            {MAIN_NAV.map((item) => (
              <SheetClose asChild key={item.key}>
                <Button
                  variant={view === item.key ? 'secondary' : 'ghost'}
                  onClick={() => goView(item.key)}
                  className="justify-start gap-2"
                >
                  {item.icon}
                  {item.label}
                </Button>
              </SheetClose>
            ))}
          </>
        )}
      </nav>

      {user?.isAdmin && (
        <>
          <Separator />
          <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            管理后台
          </div>
          <nav className="flex flex-col gap-1">
            {ADMIN_NAV.map((item) => (
              <SheetClose asChild key={item.key}>
                <Button
                  variant={view === item.key ? 'secondary' : 'ghost'}
                  onClick={() => goView(item.key)}
                  className="justify-start gap-2"
                >
                  {item.icon}
                  {item.label}
                </Button>
              </SheetClose>
            ))}
          </nav>
        </>
      )}

      <Separator />

      {/* 主题与登出 */}
      <div className="mt-auto flex items-center justify-between gap-2">
        <ThemeToggle />
        {user && (
          <div className="flex items-center gap-1">
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSwitchAccount}
                className="gap-2"
              >
                <UserCog className="size-4" />
                切换账号
              </Button>
            </SheetClose>
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="gap-2 text-destructive hover:text-destructive"
              >
                <LogOut className="size-4" />
                退出登录
              </Button>
            </SheetClose>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* 左:Logo + 桌面导航 */}
        <div className="flex items-center gap-6">
          <LogoButton />

          {/* 桌面端主菜单(仅登录显示) */}
          {user && (
            <nav className="hidden items-center gap-1 md:flex">
              <Button
                variant={view === 'landing' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => goView('landing')}
                className="gap-1.5"
              >
                <Home className="size-4" />
                首页
              </Button>
              {MAIN_NAV.map((item) => (
                <Button
                  key={item.key}
                  variant={view === item.key ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => goView(item.key)}
                  className="gap-1.5"
                >
                  {item.icon}
                  {item.label}
                </Button>
              ))}
              {renderAdminDropdown()}
            </nav>
          )}
        </div>

        {/* 右:操作区 */}
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          {user ? renderUserMenu() : (
            <div className="hidden sm:block">
              {renderLoggedOutActions()}
            </div>
          )}

          {/* 移动端汉堡菜单 */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="打开菜单"
              >
                <Menu className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 p-0">
              {renderMobileMenu()}
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
