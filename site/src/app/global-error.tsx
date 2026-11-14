/**
 * global-error.tsx — App Router 全局错误边界(最外层兜底,M-06)
 * 必须自带 html/body 壳(layout 本身已失效才会走到这里)
 */
'use client'

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[global-error]', error)
  }, [error])

  return (
    <html lang="zh-CN">
      <body>
        <div
          style={{
            minHeight: '60vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            padding: 16,
            textAlign: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <h1 style={{ fontSize: 24, fontWeight: 600 }}>应用出错了</h1>
          <p style={{ color: '#666', maxWidth: 420, fontSize: 14 }}>
            应用加载时发生严重错误,请重试;若持续出现请联系客服
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 8,
              height: 40,
              padding: '0 24px',
              borderRadius: 6,
              border: 'none',
              background: '#171717',
              color: '#fff',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            重试
          </button>
        </div>
      </body>
    </html>
  )
}
