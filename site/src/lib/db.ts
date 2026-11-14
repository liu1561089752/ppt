import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// SQL 查询日志默认关闭(生产开硅会泄漏卡密/邮箱等参数且拖慢性能)。
// 需要调试时设 DB_DEBUG=query。
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.DB_DEBUG === 'query' ? ['query'] : [],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// 维护任务注册兜底(M-71):正常路径由 src/instrumentation.ts 调用;
// 若 standalone 打包未收录 instrumentation,首个 db import 也会触发注册。
// 动态 import 避开循环引用(maintenance.ts 反向 import 了本文件);
// 幂等由 maintenance.ts 的 globalThis.__chatpptMaintenance 旗标保证。
void import('./maintenance')
  .then((m) => m.bootstrapMaintenance())
  .catch(() => {})
