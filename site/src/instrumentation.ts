/**
 * instrumentation.ts — Next.js 启动钩子(约定文件,dev 与生产 standalone 均会调用 register)
 *
 * 在服务启动时注册维护任务(僵尸清扫 / 过期数据清理)。
 * db.ts 内另有一个动态 import 兜底钩子:standalone 打包若未收录本文件,
 * 第一个 db import 也会触发维护任务注册;幂等由 maintenance.ts 的
 * globalThis.__chatpptMaintenance 旗标保证,两钩子并存安全。
 */
export async function register() {
  const m = await import('./lib/maintenance')
  m.bootstrapMaintenance()
}
