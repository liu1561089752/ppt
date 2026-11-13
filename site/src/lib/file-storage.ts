/**
 * 文件存储 - 生成产物的本地文件系统操作
 */
import { promises as fs } from 'fs'
import path from 'path'
import { PATHS, CONFIG } from './config'
import { db } from './db'

// 保存生成的 PPT
export async function saveGenerated(
  userId: string,
  taskId: string,
  content: Buffer,
  ext = 'pptx',
): Promise<string> {
  const userDir = path.join(PATHS.generated, userId)
  await fs.mkdir(userDir, { recursive: true })
  const filename = `${taskId}.${ext}`
  await fs.writeFile(path.join(userDir, filename), content)
  return `${userId}/${filename}`
}

export async function readGenerated(filePath: string): Promise<Buffer> {
  const abs = path.join(PATHS.generated, filePath)
  return fs.readFile(abs)
}

/**
 * 清理过期生成产物(任务工作目录与 .pptx),每日由 maintenance 调度。
 * 超期判据用数据库 finishedAt(M-72):文件系统 mtime 会被浏览/同步/构建触碰,
 * 不可靠;以 DB 为准,删完文件同步把 resultFile 置 null(下载按钮自动消失)。
 * 注意:不清 outline/theme(JSON.parse 会把详情接口打 500)、不加 schema 字段(零迁移)。
 * 目录里不属于任何已知任务的残留文件维持现状,避免误删。
 */
export async function cleanupOldFiles(): Promise<void> {
  const retentionMs = CONFIG.GENERATE.retentionDays * 24 * 60 * 60 * 1000
  const cutoff = new Date(Date.now() - retentionMs)
  // 只删 DB 确认"成功且 finishedAt 超期"的任务产物
  const expired = await db.generationTask.findMany({
    where: { status: 'succeeded', finishedAt: { lt: cutoff } },
    select: { id: true, userId: true },
  })
  for (const task of expired) {
    const userDir = path.join(PATHS.generated, task.userId)
    const taskDir = path.join(userDir, task.id)
    // 任务工作目录(图片暂存等)与标准位置 pptx
    await fs.rm(taskDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(userDir, `${task.id}.pptx`), { force: true }).catch(() => {})
    // 文件没了,DB 同步置空,前端下载/预览入口随之消失
    await db.generationTask.updateMany({
      where: { id: task.id },
      data: { resultFile: null },
    })
    // 用户目录已空则顺手删掉
    try {
      const rest = await fs.readdir(userDir)
      if (rest.length === 0) await fs.rmdir(userDir).catch(() => {})
    } catch {
      /* ignore */
    }
  }
  if (expired.length > 0) {
    console.log(`[file-storage] 已清理超期产物 ${expired.length} 个任务(resultFile 置空)`)
  }
}
