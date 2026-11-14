/**
 * use-announcements.ts
 *
 * TanStack Query hook:
 * - 调用 GET /api/announcements 获取公开公告列表
 * - 任何人(包括未登录)都可访问
 */
'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-client'

export interface Announcement {
  id: string
  title: string
  content: string
  type: 'info' | 'warning' | 'success'
  pinned: boolean
  createdAt: string
}

interface AnnouncementsResponse {
  items: Announcement[]
}

async function fetchAnnouncements(): Promise<Announcement[]> {
  const data = await apiFetch<AnnouncementsResponse>('/api/announcements')
  return data.items || []
}

export const ANNOUNCEMENTS_QUERY_KEY = ['announcements'] as const

export function useAnnouncements() {
  return useQuery<Announcement[], Error>({
    queryKey: ANNOUNCEMENTS_QUERY_KEY,
    queryFn: fetchAnnouncements,
    staleTime: 5 * 60 * 1000, // 5 分钟内不重复请求(公告不常更新)
    gcTime: 10 * 60 * 1000,
    retry: 1,
  })
}
