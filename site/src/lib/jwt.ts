/**
 * JWT 工具 - 签发与校验
 */
import jwt, { JwtPayload } from 'jsonwebtoken'
import { CONFIG } from './config'

export interface TokenPayload extends JwtPayload {
  userId: string
  username: string
  isAdmin: boolean
}

export function signToken(payload: Omit<TokenPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRES_IN })
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET, { algorithms: ['HS256'] })
    return decoded as TokenPayload
  } catch {
    return null
  }
}
