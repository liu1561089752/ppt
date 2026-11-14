/**
 * error.tsx — App Router 路由段错误边界(M-06)
 * 视图层之外的渲染异常兜底:中文提示 + 重置按钮(重放当前路由段渲染)
 */
'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // 生产可接监控;开发直接看控制台
    console.error('[app-error]', error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
        页面出错了
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        页面渲染时发生错误,请重试;若持续出现请联系客服
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-2 inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        重试
      </button>
    </div>
  )
}
