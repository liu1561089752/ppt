/**
 * agreement-dialog.tsx
 *
 * 用户协议 / 隐私政策 / 退款政策弹窗:
 * - Dialog + Tabs(3 个 tab)
 * - 纯文本静态文案(中文)
 * - 关键条款覆盖:卡密不退/禁止违规/账号责任/隐私数据/退款规则
 */
'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore, type AgreementTab } from '@/store/app-store'

const AGREEMENT_UPDATED = '2026 年 10 月'

const AGREEMENT_TEXT = `用户协议

最后更新:${AGREEMENT_UPDATED}

欢迎使用 ChatPPT AI 一键生成 PPT 服务(以下简称"本服务")。请仔细阅读以下条款,使用本服务即视为您已阅读并同意本协议。

1. 服务内容
   本服务基于 AI 大模型,根据用户提供的话题、受众、风格等输入,自动生成 PowerPoint 演示文稿(.pptx 文件)。生成结果仅供参考,您应自行核对其内容准确性。

2. 卡密购买与兑换
   (1) 本服务采用"卡密兑换"模式,您需通过闲鱼等渠道购买卡密后,登录账号在"兑换"页输入卡密获得生成次数。
   (2) 卡密为一次性虚拟商品,一旦兑换成功即视为已交付,兑换后不支持退换。
   (3) 卡密请在有效期内使用,过期未兑换的卡密视作自动作废。

3. 禁止违规使用
   您承诺不利用本服务生成下列内容:
   (1) 违反国家法律法规、危害国家安全、破坏社会稳定的内容;
   (2) 涉及政治敏感、谣言诽谤、淫秽色情、暴力恐怖等内容;
   (3) 侵犯他人知识产权、商业秘密、隐私权等合法权益的内容;
   (4) 其他任何违法违规、违背公序良俗的内容。
   因您违规使用造成的后果,由您自行承担全部责任,本服务有权不退款并封禁账号。

4. 账号责任
   (1) 您应妥善保管账号与密码,因您泄露导致的损失由您自行承担。
   (2) 每个账号仅限您本人使用,禁止出租、出借、转让、售卖账号。
   (3) 如发现账号被盗或异常使用,请立即通过闲鱼联系卖家。

5. 服务变更与终止
   (1) 因模型服务、政策调整、不可抗力等原因,本服务可能随时调整生成质量、可用模板或暂停服务。
   (2) 因您违反本协议,本服务有权随时封禁账号,封禁期间停止提供生成与下载服务;剩余次数将在封禁期间冻结,不可使用。

6. 争议解决
   本协议的订立、执行与解释均适用中华人民共和国法律。任何争议,优先通过闲鱼客服协商解决;协商不成的,由服务提供方所在地有管辖权的人民法院管辖。`

const PRIVACY_TEXT = `隐私政策

最后更新:${AGREEMENT_UPDATED}

我们深知个人信息对您的重要性,本政策说明我们在 ChatPPT 服务中收集、使用、保护您个人信息的方式。

1. 我们收集的信息
   (1) 注册信息:用户名、邮箱(选填,仅作账号标识);
   (2) 生成内容:您提交的话题、受众、风格、页数、额外要求等文本输入,以及 AI 生成的 PPT 内容;
   (3) 登录信息:最近一次登录的时间与 IP;
   (4) 操作记录:次数变动流水(兑换/生成/退款,含时间与结果)、生成任务状态、下载令牌发放与使用时间。

2. 我们如何使用信息
   (1) 用于提供 AI PPT 生成、卡密兑换、文件下载等核心服务功能;
   (2) 用于检测异常账号、防止滥用、保护系统稳定;
   (3) 用于必要的客服沟通(如订单核对、退款审核)。

3. 我们如何保护信息
   (1) 密码使用 bcrypt 哈希存储,不保存明文;
   (2) 会话使用 JWT + httpOnly cookie,不通过 URL 传递;
   (3) 数据库仅授权服务端访问,文件存储目录禁止穿越访问。

4. 信息共享
   除以下情况外,我们不会向任何第三方分享您的个人信息:
   (1) 经您事先同意;
   (2) 法律法规要求或行政、司法机关依法定程序要求;
   (3) 为完成卡密订单核对,与您通过闲鱼提供的订单号配合使用。

5. 信息留存
   您生成的 PPT 文件与幻灯片数据,我们保留 30 天后自动清理,以降低存储成本与隐私风险;
   清理后对应的任务记录将无法再下载文件。次数变动流水与账号信息在账号存续期间保留。

6. 您的权利
   您可通过闲鱼客服联系我们,要求查询、更正、删除您的个人信息。我们将在核实身份后处理。

7. 政策更新
   本政策可能更新,更新后我们会在站内公告。继续使用即视为同意更新后的政策。`

const REFUND_TEXT = `退款政策

最后更新:${AGREEMENT_UPDATED}

本政策说明卡密类商品的退款规则,购买前请仔细阅读。

1. 卡密性质说明
   本服务销售的商品为"卡密兑换次数",属于一次性虚拟商品。卡密一旦兑换成功,即视为商品已交付使用,根据平台规则与虚拟商品的性质,兑换后不支持无理由退款。

2. 未兑换卡密可退
   (1) 您购买的卡密如在有效期内尚未使用,可申请退款。
   (2) 退款请联系闲鱼客服,提供您的闲鱼订单号与卡密,我们核对未兑换状态后办理退款。

3. 已兑换卡密不退
   (1) 卡密一经兑换,即视为已消费,不予退款。
   (2) 兑换后的"剩余生成次数"为虚拟权益,不可提现、不可转让、不可退回卡密。

4. 系统故障例外
   (1) 若因系统故障导致您无法生成 PPT(如全部页面生成失败、扣次数但未出文件),系统将自动退还本次扣除的全部次数,可在"我的任务"中查看;
   (2) 若部分页面生成失败但其余页面正常交付,系统将按失败页数占计划页数的比例自动退还相应次数;
   (3) 因您自身网络问题、参数错误导致的生成失败,不属于退款范围。

5. 封禁不退
   (1) 因违反《用户协议》(如生成违法违规内容)导致账号被封禁的,封禁期间剩余次数冻结不可用。

6. 退款流程
   (1) 联系闲鱼客服,说明订单号、卡密、退款原因;
   (2) 客服核对卡密未兑换状态后,通过闲鱼原路退款;
   (3) 退款一般在 1-3 个工作日内到账,以闲鱼平台为准。

7. 客服联系
   请通过购买卡密的闲鱼渠道联系卖家,我们将在工作时间内尽快响应。`

const TAB_CONTENT: Record<AgreementTab, { title: string; body: string }> = {
  agreement: { title: '用户协议', body: AGREEMENT_TEXT },
  privacy: { title: '隐私政策', body: PRIVACY_TEXT },
  refund: { title: '退款政策', body: REFUND_TEXT },
}

export function AgreementDialog() {
  // 单独 selector 订阅,避免任意 store 变化触发重渲染
  const agreementOpen = useAppStore((s) => s.agreementOpen)
  const agreementTab = useAppStore((s) => s.agreementTab)
  const closeAgreement = useAppStore((s) => s.closeAgreement)
  const openAgreement = useAppStore((s) => s.openAgreement)

  const [tab, setTab] = React.useState<AgreementTab>(agreementTab)

  React.useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
    if (agreementOpen) setTab(agreementTab)
  }, [agreementOpen, agreementTab])

  return (
    <Dialog
      open={agreementOpen}
      onOpenChange={(open) => {
        if (!open) closeAgreement()
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>法律信息</DialogTitle>
          <DialogDescription>
            请仔细阅读以下条款。使用本服务即视为您已阅读并同意相应条款。
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as AgreementTab)
            openAgreement(v as AgreementTab)
          }}
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="agreement">用户协议</TabsTrigger>
            <TabsTrigger value="privacy">隐私政策</TabsTrigger>
            <TabsTrigger value="refund">退款政策</TabsTrigger>
          </TabsList>

          {(['agreement', 'privacy', 'refund'] as AgreementTab[]).map((key) => (
            <TabsContent key={key} value={key} className="mt-4">
              <ScrollArea className="h-[55vh] pr-4">
                <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed font-sans text-foreground/90">
                  {TAB_CONTENT[key].body}
                </pre>
              </ScrollArea>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
