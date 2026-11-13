/**
 * view-boundary.tsx
 *
 * 视图级 React ErrorBoundary,包裹动态加载的视图组件。
 * - 开发环境:显示真实错误堆栈,便于调试
 * - 生产环境:显示友好提示 + "重试加载"按钮
 * - view 切换时自动重置 error 状态,允许重新加载
 */
'use client'

import * as React from 'react'
import { AlertCircle, RefreshCw, Home, Bug } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/app-store'

interface ViewBoundaryProps {
  view: string
  children: React.ReactNode
}

interface ViewBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
  /** 强制重新挂载子组件用 key(每次重试递增) */
  retryKey: number
}

const isDev = process.env.NODE_ENV !== 'production'

export class ViewBoundary extends React.Component<
  ViewBoundaryProps,
  ViewBoundaryState
> {
  constructor(props: ViewBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null, retryKey: 0 }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // 开发环境打印到控制台,生产环境可接入监控
    if (isDev) {
      console.error('[ViewBoundary] 视图加载失败:', this.props.view, error, errorInfo)
    }
    this.setState({ errorInfo })
  }

  componentDidUpdate(prevProps: ViewBoundaryProps) {
    // view 切换时重置 error 状态(允许重新加载)
    if (prevProps.view !== this.props.view && this.state.hasError) {
      this.setState({ hasError: false, error: null, errorInfo: null, retryKey: this.state.retryKey + 1 })
    }
  }

  handleRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      retryKey: this.state.retryKey + 1,
    })
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorCard
          view={this.props.view}
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          onRetry={this.handleRetry}
        />
      )
    }
    // 用 retryKey 作为 key,强制重新挂载子组件(清除内部状态)
    return <div key={this.state.retryKey}>{this.props.children}</div>
  }
}

function ErrorCard({
  view,
  error,
  errorInfo,
  onRetry,
}: {
  view: string
  error: Error | null
  errorInfo: React.ErrorInfo | null
  onRetry: () => void
}) {
  const setView = useAppStore((s) => s.setView)

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <Card>
        <CardHeader>
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertCircle className="size-6" />
          </div>
          <CardTitle className="text-lg">「{view}」模块加载失败</CardTitle>
          <CardDescription>
            该视图在渲染时发生错误。可尝试重新加载,或返回首页后再试。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 错误信息 */}
          {error && (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-destructive">
                <Bug className="size-4" />
                {error.name || 'Error'}
              </p>
              <p className="text-sm text-muted-foreground">{error.message}</p>
            </div>
          )}

          {/* 开发环境显示堆栈 */}
          {isDev && error?.stack && (
            <details className="rounded-md border bg-muted/30 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-muted-foreground">
                错误堆栈(仅开发环境可见)
              </summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                {error.stack}
                {errorInfo?.componentStack ? `\n\n组件堆栈:\n${errorInfo.componentStack}` : ''}
              </pre>
            </details>
          )}

          {/* 操作按钮 */}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={onRetry} className="gap-1.5">
              <RefreshCw className="size-4" />
              重新加载
            </Button>
            <Button variant="outline" onClick={() => setView('landing')} className="gap-1.5">
              <Home className="size-4" />
              返回首页
            </Button>
            <Button
              variant="ghost"
              onClick={() => window.location.reload()}
              className="gap-1.5"
            >
              <RefreshCw className="size-4" />
              刷新整页
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
