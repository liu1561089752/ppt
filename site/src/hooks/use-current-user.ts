/**
 * use-current-user.ts
 *
 * TanStack Query hook:
 * - 调用 GET /api/auth/me 获取当前登录用户
 * - 401 时返回 null(不抛错)
 * - 注册 401 回调,任何 apiFetch 收到 401 时自动 invalidate
 * - 成功时把 user 写入 Zustand store
 */
'use client'

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, onUnauthorized } from '@/lib/api-client'
import { useAppStore, type User } from '@/store/app-store'

interface MeResponse {
  user: User
}

async function fetchCurrentUser(): Promise<User | null> {
  try {
    const data = await apiFetch<MeResponse>('/api/auth/me')
    return data.user
  } catch (e) {
    const err = e as Error & { status?: number; code?: string }
    // 401 且 code 为 UNAUTHORIZED(会话失效)表示未登录,不是错误,返回 null;
    // 其余 401(如 INVALID_CREDENTIALS)不属于本 hook 的查询路径,继续抛出
    if (err?.status === 401 && err?.code === 'UNAUTHORIZED') return null
    // 其他错误继续抛出,触发 retry
    throw e
  }
}

export const CURRENT_USER_QUERY_KEY = ['currentUser'] as const

export function useCurrentUser() {
  const queryClient = useQueryClient()
  const setUser = useAppStore((s) => s.setUser)
  const clearUser = useAppStore((s) => s.clearUser)

  const query = useQuery<User | null, Error>({
    queryKey: CURRENT_USER_QUERY_KEY,
    queryFn: fetchCurrentUser,
    staleTime: 60 * 1000, // 1 分钟内不重复请求
    gcTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      // 会话失效(401 + UNAUTHORIZED)不重试(已视为 null)
      const err = error as Error & { status?: number; code?: string }
      if (err?.status === 401 && err?.code === 'UNAUTHORIZED') return false
      return failureCount < 2
    },
  })

  // 同步 user 到 Zustand store
  useEffect(() => {
    if (query.data !== undefined) {
      setUser(query.data)
    }
  }, [query.data, setUser])

  // 监听 apiFetch 抛出的 401,自动 invalidate + 清空 store
  useEffect(() => {
    return onUnauthorized(() => {
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, null)
      clearUser()
    })
  }, [queryClient, clearUser])

  return query
}
