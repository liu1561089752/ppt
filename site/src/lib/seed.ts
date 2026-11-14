/**
 * 首次启动初始化 - 创建默认管理员 + 默认公告 + 默认协议
 * 通过 `bun run src/lib/seed.ts` 执行
 */
import { db } from './db'
import { hashPassword } from './password'
import { CONFIG } from './config'

async function seed() {
  console.log('🌱 开始初始化数据库...')

  // 1. 默认管理员(密码必须显式提供,绝不内置默认口令)
  if (!CONFIG.DEFAULT_ADMIN.password) {
    throw new Error('缺少 ADMIN_PASSWORD 环境变量,拒绝初始化管理员账号。请在 .env 中设置后重试。')
  }
  const existingAdmin = await db.user.findFirst({ where: { username: CONFIG.DEFAULT_ADMIN.username } })
  if (existingAdmin) {
    console.log(`✓ 管理员账号已存在: ${CONFIG.DEFAULT_ADMIN.username}`)
  } else {
    const passwordHash = await hashPassword(CONFIG.DEFAULT_ADMIN.password)
    await db.user.create({
      data: {
        username: CONFIG.DEFAULT_ADMIN.username,
        email: CONFIG.DEFAULT_ADMIN.email,
        passwordHash,
        isAdmin: true,
        isActive: true,
        remainingCredits: 999,
      },
    })
    console.log(`✓ 已创建管理员: ${CONFIG.DEFAULT_ADMIN.username}(密码来自 ADMIN_PASSWORD,不回显)`)
  }

  // 2. 默认公告
  const existingAnn = await db.announcement.findFirst()
  if (!existingAnn) {
    await db.announcement.createMany({
      data: [
        {
          title: '欢迎使用 ChatPPT',
          content: '输入主题,AI 自动生成 PPT。请先兑换卡密获得生成次数,然后到「生成 PPT」页面提交需求。',
          type: 'info',
          pinned: true,
          active: true,
        },
        {
          title: '如何获得卡密',
          content: '在闲鱼购买后,卖家会发送一张卡密(形如 K7XQ-2M9F-P4WT-8YBN)。登录后在「卡密兑换」页面输入即可获得 3 次生成机会。',
          type: 'info',
          active: true,
        },
        {
          title: '客服联系方式',
          content: '如有问题请在闲鱼联系卖家,或在站内提交工单。我们会尽快回复。',
          type: 'info',
          active: true,
        },
      ],
    })
    console.log('✓ 已创建 3 条默认公告')
  } else {
    console.log('✓ 公告已存在,跳过')
  }

  // 3. 系统配置
  const existingCfg = await db.systemConfig.findFirst()
  if (!existingCfg) {
    await db.systemConfig.createMany({
      data: [
        { key: 'site_name', value: 'ChatPPT - AI PPT 生成平台' },
        { key: 'card_credit_default', value: '3' },
        { key: 'card_expiry_days', value: '90' },
        { key: 'agreement_version', value: 'v1.0' },
      ],
    })
    console.log('✓ 已创建系统配置')
  }

  console.log('🎉 初始化完成')
  await db.$disconnect()
}

seed().catch((e) => {
  console.error('❌ 初始化失败:', e)
  process.exit(1)
})
