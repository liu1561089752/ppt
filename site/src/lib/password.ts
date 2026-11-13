/**
 * 密码哈希
 */
import bcrypt from 'bcryptjs'
import { CONFIG } from './config'

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, CONFIG.BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}
