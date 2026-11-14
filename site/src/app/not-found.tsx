/**
 * not-found.tsx — Next.js App Router 404 页(全站中文,M-06)
 * 深链到不存在的路径时呈现,替代框架默认英文页
 */
import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
        页面不存在
      </h1>
      <p className="text-sm text-muted-foreground">
        您访问的地址可能已被移动或删除
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        返回首页
      </Link>
    </div>
  )
}
