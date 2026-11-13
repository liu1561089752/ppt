/**
 * footer.tsx
 *
 * Sticky footer:
 * - 链接:用户协议 / 隐私政策 / 退款政策(打开 agreement 弹窗)
 * - 客服提示
 * - 版权信息
 * - 浅色样式,不抢主内容
 */
'use client'

import { useAppStore } from '@/store/app-store'

export function Footer() {
  const openAgreement = useAppStore((s) => s.openAgreement)

  return (
    <footer className="mt-auto border-t bg-muted/30">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {/* 链接区 */}
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => openAgreement('agreement')}
              className="hover:text-foreground hover:underline underline-offset-2 transition-colors"
            >
              用户协议
            </button>
            <span aria-hidden className="opacity-50">·</span>
            <button
              type="button"
              onClick={() => openAgreement('privacy')}
              className="hover:text-foreground hover:underline underline-offset-2 transition-colors"
            >
              隐私政策
            </button>
            <span aria-hidden className="opacity-50">·</span>
            <button
              type="button"
              onClick={() => openAgreement('refund')}
              className="hover:text-foreground hover:underline underline-offset-2 transition-colors"
            >
              退款政策
            </button>
          </nav>

          {/* 客服提示 */}
          <p className="text-xs text-muted-foreground">
            如有问题请通过
            <span className="font-medium text-foreground/80">闲鱼</span>
            联系卖家
          </p>
        </div>

        <div className="mt-4 border-t pt-4 text-center text-xs text-muted-foreground/80">
          © {new Date().getFullYear()} ChatPPT · AI 一键生成 PPT · 仅供学习参考,禁止违规使用
        </div>
      </div>
    </footer>
  )
}
