import type { Metadata } from 'next'
import './globals.css'
import { Providers } from '@/components/providers'

export const metadata: Metadata = {
  title: 'ChatPPT · AI 一键生成 PPT',
  description:
    'ChatPPT 是基于大模型的 AI 一键 PPT 生成服务。输入话题,自动完成调研、规划与版式设计,输出原生可编辑的 .pptx 文件。',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        {/* UI 字体走系统字体栈(globals.css 的 --font-sans):HTML 幻灯片时代自托管的
            字体样式表与字体子集已随整条 HTML 渲染链下线,这里不再外链任何样式表 */}
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
