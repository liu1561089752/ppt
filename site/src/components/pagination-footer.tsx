/**
 * 分页底栏 —— 全站唯一定义(原先 7 个列表页各复制约 35 行,省略号逻辑相同)。
 */
'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'

interface PaginationFooterProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

export function PaginationFooter({ page, pageSize, total, onPageChange }: PaginationFooterProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
      <p className="text-xs text-muted-foreground tabular-nums">
        共 {total} 条 · 第 {page}/{totalPages} 页
      </p>
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              onClick={(e) => {
                e.preventDefault()
                if (page > 1) onPageChange(page - 1)
              }}
              aria-disabled={page <= 1}
              className={cn(page <= 1 && 'pointer-events-none opacity-50')}
            />
          </PaginationItem>
          {Array.from({ length: totalPages }).map((_, i) => {
            const p = i + 1
            // 只显示当前页前后 2 页 + 第一页 + 最后一页
            if (p !== 1 && p !== totalPages && Math.abs(p - page) > 2) {
              if (p === 2 || p === totalPages - 1) {
                return (
                  <PaginationItem key={p}>
                    <span className="flex size-9 items-center justify-center text-muted-foreground">
                      …
                    </span>
                  </PaginationItem>
                )
              }
              return null
            }
            return (
              <PaginationItem key={p}>
                <PaginationLink
                  href="#"
                  isActive={p === page}
                  onClick={(e) => {
                    e.preventDefault()
                    onPageChange(p)
                  }}
                >
                  {p}
                </PaginationLink>
              </PaginationItem>
            )
          })}
          <PaginationItem>
            <PaginationNext
              href="#"
              onClick={(e) => {
                e.preventDefault()
                if (page < totalPages) onPageChange(page + 1)
              }}
              aria-disabled={page >= totalPages}
              className={cn(page >= totalPages && 'pointer-events-none opacity-50')}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
