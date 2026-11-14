/**
 * card-result-dialog.tsx — 卡密生成结果 Dialog(展示所有 code + 单行复制 + 全部复制)。
 * 从 admin-cards-view.tsx 拆出,逻辑不变。
 */
'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  Copy,
  Check,
  Download,
} from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import type { GenerateResponse } from './card-shared'

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fallback
  }
  // 兼容兜底
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

interface ResultDialogProps {
  result: GenerateResponse | null
  onClose: () => void
}

export function ResultDialog({ result, onClose }: ResultDialogProps) {
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null)
  const [allCopied, setAllCopied] = React.useState(false)

  React.useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
    setCopiedCode(null)
    setAllCopied(false)
  }, [result])

  if (!result) return null

  const handleCopyOne = async (code: string) => {
    const ok = await copyText(code)
    if (ok) {
      setCopiedCode(code)
      setTimeout(() => setCopiedCode(null), 1500)
    } else {
      toast.error('复制失败,请手动复制')
    }
  }

  const handleCopyAll = async () => {
    const all = result.cards.map((c) => c.code).join('\n')
    const ok = await copyText(all)
    if (ok) {
      setAllCopied(true)
      toast.success(`已复制 ${result.cards.length} 个卡密`)
      setTimeout(() => setAllCopied(false), 2000)
    } else {
      toast.error('复制失败,请手动复制')
    }
  }

  const handleExport = () => {
    // 用批次号反查 batchId:由于 generate 接口只返回 batchNo,
    // 直接用 ?batchNo 不支持,故走状态筛选所有 unused + 该批次号筛选的方式不可行。
    // 简化:提示用户在批次卡片里导出(那里有 batchId);同时这里也支持复制全部
    toast.info('请到批次列表卡片点击「导出 CSV」按钮,获取完整文件')
  }

  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Check className="size-4 text-emerald-600" />
            卡密生成成功
          </DialogTitle>
          <DialogDescription>
            批次号 <span className="font-mono">{result.batchNo}</span> · 共{' '}
            {result.quantity} 张 · 每张 {result.credits} 次
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 overflow-y-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead>卡密</TableHead>
                <TableHead className="w-16 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.cards.map((c, i) => (
                <TableRow key={c.code}>
                  <TableCell className="text-center text-xs text-muted-foreground tabular-nums">
                    {i + 1}
                  </TableCell>
                  <TableCell className="font-mono text-xs tracking-wider">
                    {c.code}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => handleCopyOne(c.code)}
                    >
                      {copiedCode === c.code ? (
                        <Check className="size-3 text-emerald-600" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={handleExport} className="gap-1.5">
            <Download className="size-4" />
            导出 CSV
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
            <Button onClick={handleCopyAll} className="gap-1.5">
              {allCopied ? (
                <Check className="size-4 text-emerald-600" />
              ) : (
                <Copy className="size-4" />
              )}
              全部复制
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
