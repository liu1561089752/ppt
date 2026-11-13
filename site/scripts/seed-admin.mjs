/**
 * v2 管理员播种 — 独立脚本(不经 server-only 配置链,直接读环境变量)
 * 用法: ADMIN_PASSWORD=密码 bun scripts/seed-admin.mjs
 *       已存在时默认只提示;需要重置密码: ADMIN_PASSWORD=新密码 bun scripts/seed-admin.mjs --reset
 *       (--reset 会更新已存在管理员的 passwordHash;仍要求 ADMIN_PASSWORD 同步提供)
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()
const username = process.env.ADMIN_USERNAME || 'admin'
const password = process.env.ADMIN_PASSWORD
const reset = process.argv.includes('--reset')

if (!password || password.length < 8) {
  console.error('缺少 ADMIN_PASSWORD 环境变量(至少 8 位),拒绝初始化管理员账号。')
  process.exit(1)
}

const existing = await db.user.findFirst({ where: { username } })
if (existing) {
  if (reset) {
    const passwordHash = await bcrypt.hash(password, 10)
    await db.user.update({
      where: { id: existing.id },
      data: { passwordHash, passwordChangedAt: new Date() },
    })
    console.log(`✓ 已重置管理员 ${username} 的密码(passwordChangedAt 已更新,旧会话全部失效)`)
  } else {
    console.log(`✓ 管理员已存在: ${username}(如需重置密码请加 --reset 参数,并同传 ADMIN_PASSWORD)`)
  }
} else {
  const passwordHash = await bcrypt.hash(password, 10)
  await db.user.create({
    data: {
      username,
      passwordHash,
      email: process.env.ADMIN_EMAIL || 'admin@chatppt.local',
      remainingCredits: 999,
      isAdmin: true,
    },
  })
  console.log(`✓ 已创建管理员 ${username}(余额 999,含管理后台权限)`)
}
await db.$disconnect()
