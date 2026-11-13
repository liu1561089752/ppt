/**
 * config.ts — v2 集中配置(仅服务端)
 *
 * v2 规则:
 *  - `server-only` 标记:任何客户端组件误引本文件,构建期直接报错
 *    (旧仓教训:config 的模块级 throw 被 redeem-view 引用链拖进浏览器 → 页面崩溃)
 *  - PROJECT_ROOT 仍走环境变量:生产模式 server.js 会 chdir 到 .next/standalone,
 *    cwd 不可靠;启动校验(instrumentation)会拒绝 Windows 风格路径残留
 *  - 导出面与旧仓一致(CONFIG/PROJECT_ROOT/PATHS),移植库零改动
 */
import 'server-only'
import path from 'path'

function requireEnv(key: string, minLen: number): string {
  const v = process.env[key]
  if (!v || v.length < minLen) {
    throw new Error(`[config] 缺少 ${key}(至少 ${minLen} 字符)。请在 .env 中设置后重启。`)
  }
  return v
}

const jwtSecret = requireEnv('JWT_SECRET', 32)

// 启动安全校验:环境变量里出现 Windows 风格路径 = 迁移残留,直接拒绝。
// 只在生产拦:开发/CI 跑在 Windows 工作站上,cwd 本来就是 C:\… ,
// 这条规则要是无条件生效,本地与 CI 连启动都过不去(它守的是"部署产物里不许有迁移残留",
// 不是"开发机不许用 Windows")。
export function assertEnvSafety(): void {
  if (process.env.NODE_ENV !== 'production') return
  for (const key of ['DATABASE_URL', 'PROJECT_ROOT']) {
    const v = process.env[key] || ''
    if (/^[A-Za-z]:[\\/]/.test(v)) {
      throw new Error(`[config] ${key} 含 Windows 风格路径("${v.slice(0, 40)}…")——迁移残留,请在 .env 修正后重启`)
    }
  }
}

export const CONFIG = {
  JWT_SECRET: jwtSecret,
  JWT_EXPIRES_IN: '7d',
  COOKIE_NAME: 'chatppt_token',

  BCRYPT_ROUNDS: 10,

  RATE_LIMIT: {
    register: { windowMs: 24 * 60 * 60 * 1000, max: 3 },
    // loginFail 已删(M-53/M-100 死配置):登录失败处理改为指数退避
    // (rate-limit.ts recordBackoff,步长硬编码在 BACKOFF_STEPS_MS),
    // recordFail/isLocked 已删除,该配置全仓零引用
    redeem: { windowMs: 60 * 60 * 1000, maxUser: 10, maxIp: 30 },
    generate: { maxConcurrent: 2, maxDaily: 30 },
    events: { windowMs: 60 * 1000, max: 120 },
    downloadToken: { windowMs: 60 * 60 * 1000, max: 30 },
  },

  GENERATE: {
    maxSlideCount: 25,
    minSlideCount: 6,
    maxTopicLength: 500,
    taskTimeoutBaseMs: 10 * 60 * 1000,
    taskTimeoutPerSlideMs: 60 * 1000,
    maxCustomStyleLength: 500,
    retentionDays: 30,
  },

  DOWNLOAD: {
    tokenExpiresMs: 60 * 60 * 1000,
    // tokenLength 已删(M-66 死配置):令牌长度由 create-download-token 的
    // randomBytes(16).toString('hex')(=32 hex 字符)直接决定,全仓零引用
  },

  DEFAULT_ADMIN: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
    email: process.env.ADMIN_EMAIL || 'admin@chatppt.local',
  },

  // LLM 块已删:maxRetries / timeoutMs / fallbackToTemplate 全仓零引用——
  // 重试与超时由 kimi-client 自己的 MAX_RETRIES / 流式看门狗决定,
  // fallbackToTemplate 是"转换失败退回固定模板"时代的开关,原生链路没有这个概念。
} as const

// Edge Runtime(Next 16 会为 instrumentation 产出 Edge 构建)没有 process.cwd(),
// 也没有文件系统语义,所以这里必须先判运行时:Edge 下一律用占位符,
// 真正的路径解析只发生在 Node 运行时(server-only 模块)。
const isEdgeRuntime =
  typeof process === 'undefined' || typeof process.cwd !== 'function'

export const PROJECT_ROOT = isEdgeRuntime
  ? '/__edge_no_fs__'
  : process.env.PROJECT_ROOT || process.cwd()

// 启动期校验(M-68):生产环境缺 PROJECT_ROOT 会在启动时直接炸,
// 而不是悄悄把数据写进构建产物目录(.next/standalone)并在下次构建被删除。
// dev 分支只 warn 一次,不阻断开发。
// 注意:本模块为 server-only,任何服务端 import 都会触发这里的模块顶层代码。
// Node 运行时才做 throw/warn;Edge 构建里这两个动作都没有意义(不碰文件系统)。
if (isEdgeRuntime) {
  // Edge 侧不做任何启动校验(没有文件系统,PROJECT_ROOT 语义不适用)
} else if (process.env.NODE_ENV === 'production' && !process.env.PROJECT_ROOT) {
  throw new Error(
    '[config] 生产环境必须设置 PROJECT_ROOT:否则数据会写入构建产物目录并在下次构建时被删除。请在 .env 或 systemd 环境中显式设置后重启。',
  )
} else if (process.env.NODE_ENV !== 'production' && !process.env.PROJECT_ROOT) {
  // dev 缺省:cwd 即仓库根,可用,但明确提示一次
  console.warn(
    '[config] dev 环境未设置 PROJECT_ROOT,已回退为 process.cwd()。生产部署前请在 .env 中显式设置。',
  )
}

export const PATHS = {
  data: path.join(PROJECT_ROOT, 'data'),
  generated: path.join(PROJECT_ROOT, 'data', 'generated'),
  downloads: path.join(PROJECT_ROOT, 'data', 'generated'),
  skills: path.join(PROJECT_ROOT, 'skills'),
  public: path.join(PROJECT_ROOT, 'public'),
}
