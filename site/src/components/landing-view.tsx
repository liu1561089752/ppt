/**
 * landing-view.tsx
 *
 * 落地页(未登录用户首屏):
 * - Hero:大标题"AI 一键生成 PPT"+ CTA 按钮
 * - 公告区:渲染公告(pinned 优先),用 Alert 组件
 * - 功能亮点(3 张卡片)
 * - 使用流程(3 步图示)
 * - FAQ 折叠(Accordion)
 *
 * 整页响应式,mobile-first。
 */
'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Sparkles,
  Languages,
  Palette,
  ArrowRight,
  ShoppingCart,
  KeyRound,
  FileDown,
  HelpCircle,
  Megaphone,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

import { useAppStore } from '@/store/app-store'
import { useAnnouncements, type Announcement } from '@/hooks/use-announcements'
import { Skeleton } from '@/components/ui/skeleton'

// --- 公告区 ---
function AnnouncementBlock() {
  const { data, isLoading } = useAnnouncements()
  const announcements = data || []

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (announcements.length === 0) return null

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2">
      {announcements.map((a) => (
        <AnnouncementItem key={a.id} item={a} />
      ))}
    </div>
  )
}

function AnnouncementItem({ item }: { item: Announcement }) {
  const variant =
    item.type === 'warning'
      ? 'destructive'
      : 'default'

  const icon =
    item.type === 'warning' ? (
      <AlertCircle />
    ) : item.type === 'success' ? (
      <CheckCircle2 />
    ) : (
      <Megaphone />
    )

  return (
    <Alert variant={variant}>
      {icon}
      <AlertTitle className="flex items-center gap-2">
        {item.pinned && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            置顶
          </Badge>
        )}
        <span>{item.title}</span>
      </AlertTitle>
      <AlertDescription>
        <p className="whitespace-pre-wrap break-words">{item.content}</p>
      </AlertDescription>
    </Alert>
  )
}

// --- Hero ---
function Hero() {
  const openAuthDialog = useAppStore((s) => s.openAuthDialog)
  const setView = useAppStore((s) => s.setView)
  const user = useAppStore((s) => s.user)

  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto max-w-5xl px-4 pt-12 pb-10 sm:px-6 sm:pt-16 lg:pt-20 lg:pb-12">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex flex-col items-center text-center"
        >
          <Badge variant="outline" className="mb-4 gap-1.5 px-3 py-1 text-xs">
            <Sparkles className="size-3.5 text-amber-500" />
            <span>AI 驱动 · 一键生成 · 多语言多主题</span>
          </Badge>

          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
            AI 一键生成 PPT
          </h1>
          <p className="mt-4 max-w-2xl text-sm text-muted-foreground sm:text-base">
            只需输入一个话题,大模型自动生成大纲、文案与排版,
            <br className="hidden sm:block" />
            一键下载 .pptx 文件,直接用 PowerPoint / WPS 打开。
          </p>

          <div className="mt-6 flex w-full max-w-md flex-col gap-2 sm:flex-row sm:justify-center">
            <Button
              size="lg"
              className="w-full sm:w-auto sm:px-8"
              onClick={() => (user ? setView('generate') : openAuthDialog('register'))}
            >
              <Sparkles className="size-4" />
              立即开始
              <ArrowRight className="size-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto sm:px-8"
              onClick={() => (user ? setView('redeem') : openAuthDialog('login'))}
            >
              <KeyRound className="size-4" />
              我有卡密
            </Button>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            {user
              ? '点击立即开始,30 秒生成你的第一份 PPT'
              : '注册后可在闲鱼购买卡密兑换生成次数'}
          </p>
        </motion.div>
      </div>
    </section>
  )
}

// --- 功能亮点 ---
const FEATURES = [
  {
    icon: <Sparkles className="size-5" />,
    title: 'AI 智能生成',
    desc: '大模型根据话题与受众,自动生成大纲、要点与文案,告别空白页焦虑。',
  },
  {
    icon: <Languages className="size-5" />,
    title: '多语言支持',
    desc: '支持中文、英文、日文等多种语言输出,适合汇报、留学、外贸场景。',
  },
  {
    icon: <Palette className="size-5" />,
    title: '多主题样式',
    desc: '内置商务 / 科技 / 教育 / 营销 4 套主题,配色与版式一键切换。',
  },
]

function Features() {
  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h2 className="mb-6 text-center text-lg font-semibold sm:text-xl">
        核心能力
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {FEATURES.map((f, idx) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.3, delay: idx * 0.08 }}
          >
            <Card className="h-full">
              <CardHeader>
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  {f.icon}
                </div>
                <CardTitle className="text-base">{f.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="text-sm leading-relaxed">
                  {f.desc}
                </CardDescription>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>
    </section>
  )
}

// --- 使用流程 ---
const STEPS = [
  {
    icon: <ShoppingCart className="size-5" />,
    title: '1 · 购买卡密',
    desc: '在闲鱼购买卡密,获取 16 位兑换码',
  },
  {
    icon: <KeyRound className="size-5" />,
    title: '2 · 登录兑换',
    desc: '注册/登录后,进入"兑换"页输入卡密',
  },
  {
    icon: <FileDown className="size-5" />,
    title: '3 · 一键生成',
    desc: '输入话题,等待生成,下载 .pptx 文件',
  },
]

function Steps() {
  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h2 className="mb-6 text-center text-lg font-semibold sm:text-xl">
        三步完成
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {STEPS.map((s) => (
          <Card key={s.title} className="relative h-full">
            <CardHeader>
              <div className="flex size-10 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600">
                {s.icon}
              </div>
              <CardTitle className="text-base">{s.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-sm leading-relaxed">
                {s.desc}
              </CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}

// --- FAQ ---
const FAQS = [
  {
    q: '生成的 PPT 是什么格式?',
    a: '下载的是 .pptx 格式,可直接用 Microsoft PowerPoint、WPS、Keynote 打开与编辑。所有版式、字体、配色都是基于 pptx 原生格式生成,完全可二次编辑。',
  },
  {
    q: '一次生成多少张幻灯片?',
    a: '默认生成 8 张幻灯片(含封面与封底),您可在生成页选择 6-25 张,根据话题复杂度调整。',
  },
  {
    q: '生成失败会扣次数吗?',
    a: '通常不会。全部页面生成失败时,系统自动退还本次扣除的全部次数;部分页面失败但其余正常交付时,按失败页数比例退还相应次数。退款记录可在"我的任务"中查看。',
  },
  {
    q: '卡密怎么获得?',
    a: '请通过闲鱼搜索"ChatPPT 卡密"或联系卖家下单,购买后获取 16 位兑换码(格式如 K7XQ-2M9F-P4WT-8YBN),登录后在"兑换卡密"页输入即可获得次数。',
  },
  {
    q: '次数可以退款吗?',
    a: '未兑换的卡密可联系闲鱼客服退款;已兑换的卡密视为已交付,不支持退款。具体规则请查看《退款政策》。',
  },
  {
    q: '可以使用生成的 PPT 商业用途吗?',
    a: '生成的内容版权归您所有,可用于商业用途。但请确保话题与生成内容不违反国家法律法规,详见《用户协议》。',
  },
]

function FAQ() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-center gap-2">
        <HelpCircle className="size-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold sm:text-xl">常见问题</h2>
      </div>
      <Accordion type="single" collapsible className="w-full">
        {FAQS.map((item, idx) => (
          <AccordionItem key={idx} value={`item-${idx}`}>
            <AccordionTrigger className="text-sm sm:text-base">
              {item.q}
            </AccordionTrigger>
            <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
              {item.a}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  )
}

export function LandingView() {
  return (
    <div className="flex flex-col">
      <Hero />
      <div className="px-4 sm:px-6">
        <AnnouncementBlock />
      </div>
      <Features />
      <Steps />
      <FAQ />
    </div>
  )
}
