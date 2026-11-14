/**
 * api-client.ts
 *
 * 前端统一的 fetch 封装:
 * - 自动处理 JSON 响应
 * - 失败时抛出 Error,message 为后端返回的 error 字段
 * - 401 且 code 为 UNAUTHORIZED(会话失效)时通过回调清除 user state(由调用方处理,不自动重定向)
 * - 所有路径均为相对路径,同源部署
 */

export interface ApiErrorShape {
  error: string
  code?: string
}

/** 401 回调注册机制:供 app-shell / use-current-user 监听并清空 user */
type UnauthHandler = () => void
const unauthHandlers = new Set<UnauthHandler>()

export function onUnauthorized(handler: UnauthHandler): () => void {
  unauthHandlers.add(handler)
  return () => unauthHandlers.delete(handler)
}

function notifyUnauthorized() {
  for (const h of unauthHandlers) {
    try {
      h()
    } catch {
      // ignore handler errors
    }
  }
}

/** 默认请求超时(30s):慢接口/断网不至于让表单永远转圈(M-88) */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 通用 API 请求封装
 * @param path 相对路径,如 '/api/auth/login'
 * @param options 标准 RequestInit(已有 signal 时不覆盖,可自行控制取消)
 * @returns 解析后的 JSON 响应
 * @throws Error 当 HTTP 状态非 2xx 时,message 取自后端 error 字段
 * @throws Error('请求超时,请重试') 当请求超过 30s 被超时中止
 */
export async function apiFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers || {}),
      },
      // 调用方已传 signal 则尊重之,否则默认 30s 超时(M-88)
      signal: options?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      credentials: 'include', // 自动携带 httpOnly cookie(session)
    })
  } catch (e) {
    // 超时中止(AbortSignal.timeout 触发的是 TimeoutError DOMException)
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('请求超时,请重试')
    }
    // 网络错误、CORS、断网
    throw new Error(
      e instanceof Error ? `网络错误: ${e.message}` : '网络请求失败,请稍后重试',
    )
  }

  // 尝试解析 JSON(后端统一返回 JSON,即使是错误)
  let payload: unknown = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      // 非 JSON 响应,留空
    }
  }

  // 401 一码两义:仅当响应体 code === 'UNAUTHORIZED'(会话失效/token 无效或过期)
  // 才通知回调清空 user state;其余 401(如登录/改密失败的 INVALID_CREDENTIALS)
  // 不触发登出,照常走下方错误提示通道(code 与 status 随抛出的错误传给调用方)
  if (res.status === 401) {
    const errShape = payload as ApiErrorShape | null
    if (errShape?.code === 'UNAUTHORIZED') {
      notifyUnauthorized()
    }
  }

  if (!res.ok) {
    const errShape = payload as ApiErrorShape | null
    const message =
      (errShape && typeof errShape.error === 'string' && errShape.error) ||
      `请求失败 (HTTP ${res.status})`
    const err = new Error(message) as Error & { code?: string; status?: number }
    if (errShape?.code) err.code = errShape.code
    err.status = res.status
    throw err
  }

  return payload as T
}

/** GET 请求快捷方法 */
export function apiGet<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  return apiFetch<T>(path, { ...options, method: 'GET' })
}

/** POST 请求快捷方法 */
export function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  options?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, {
    ...options,
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** PUT 请求快捷方法 */
export function apiPut<T = unknown>(
  path: string,
  body?: unknown,
  options?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, {
    ...options,
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** DELETE 请求快捷方法 */
export function apiDelete<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  return apiFetch<T>(path, { ...options, method: 'DELETE' })
}
