/**
 * 会话工具 - 从 Next.js 请求读取/写入 JWT cookie
 *
 * JWT 只用于认证("这个 token 是我们签发的"),授权状态(isActive/isAdmin)
 * 一律以数据库为准——封禁用户或撤销管理员后立即生效,不随 token 存活。
 */
import { cookies } from 'next/headers'
import { CONFIG } from './config'
import { verifyToken, TokenPayload } from './jwt'
import { db } from './db'

export const SESSION_COOKIE = CONFIG.COOKIE_NAME

export type SessionUser = Pick<TokenPayload, 'userId' | 'username' | 'isAdmin'>

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7天
  })
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
}

export async function getSession(): Promise<TokenPayload | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifyToken(token)
}

/** 校验签名并回库复查用户状态,返回以数据库为准的会话用户 */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession()
  if (!session) throw new Error('UNAUTHORIZED')
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, username: true, isAdmin: true, isActive: true, passwordChangedAt: true },
  })
  if (!user) throw new Error('UNAUTHORIZED')
  if (!user.isActive) throw new Error('USER_BANNED')
  // 改密后旧会话失效:token 签发时间(秒)早于密码修改时间的直接拒绝。
  // 按秒比较,同一秒内改密后补发的新 token 不受影响。
  if (user.passwordChangedAt) {
    const iat = session.iat ?? 0
    if (iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw new Error('UNAUTHORIZED')
    }
  }
  return { userId: user.id, username: user.username, isAdmin: user.isAdmin }
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (!user.isAdmin) throw new Error('FORBIDDEN')
  return user
}
