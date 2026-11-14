/**
 * kimi-client.ts — LLM 客户端(Kimi 官方 API,单供应商)
 *
 * 供应商: Moonshot 开放平台(api.moonshot.cn)
 * 模型: kimi-k2.6(默认)/ kimi-k3 —— KIMI_MODEL 一处配置即可切换
 *
 * 能力:
 * - chat:对话补全
 * - formulaSearch:Kimi Formula 联网搜索(供 search-client 兜底调用)
 * - 输出清洗:extractCodeBlock(剥离 markdown 包裹)/ parseJsonLoose
 *
 * 实测要点(2026-09):
 * - kimi-k2.6 为推理模型,temperature 仅接受 1
 * - LLM 输出常被 ```json 包裹,需剥离
 * - Formula API 为 beta 端点,需 kimi-api-version 头
 */

// ---------- Provider 配置 ----------

const API_VERSION = '2026-09-01-beta'

/** 当前主力 LLM:配置了 DEEPSEEK_API_KEY 则用 DeepSeek,否则 Kimi */
export function isDeepSeek(): boolean {
  return !!(process.env.DEEPSEEK_API_KEY || '').trim()
}

function baseUrl(): string {
  if (isDeepSeek()) return (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '')
  return (process.env.KIMI_BASE_URL || 'https://api.moonshot.cn').replace(/\/$/, '')
}

/** API 基础路径(容忍 BASE_URL 带不带 /v1 两种写法) */
function apiBase(): string {
  const b = baseUrl()
  return b.endsWith('/v1') ? b.slice(0, -3) : b
}

/** 当前模型(deepseek-flash / kimi-k2.6) */
export function getKimiModel(): string {
  if (isDeepSeek()) return process.env.DEEPSEEK_MODEL || 'deepseek-flash'
  return process.env.KIMI_MODEL || 'kimi-k2.6'
}

function getApiKey(): string {
  const key = (isDeepSeek() ? process.env.DEEPSEEK_API_KEY : process.env.KIMI_API_KEY) || ''
  const k = key.trim()
  // 只要求非空:本地/自建的 OpenAI 兼容网关常用短密钥(如 "test"),
  // 早前用长度 ≥10 做"防手滑"启发式,会把这类合法配置直接判死。
  if (!k) {
    throw new Error('LLM_API_KEY_MISSING: 未配置 DEEPSEEK_API_KEY 或 KIMI_API_KEY')
  }
  return k
}

function baseHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${getApiKey()}`,
    'content-type': 'application/json',
  }
  if (!isDeepSeek()) h['kimi-api-version'] = API_VERSION
  return h
}

// ---------- 基础 HTTP(带重试) ----------

interface KimiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: unknown[]
  tool_call_id?: string
}

interface ChatOptions {
  messages: KimiMessage[]
  model?: string
  maxTokens?: number
  tools?: unknown[]
}

interface ChatResult {
  content: string
  reasoning?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  finishReason?: string
}

const MAX_RETRIES = 3

async function fetchWithRetry(url: string, init: RequestInit, timeoutMs = 300_000): Promise<Response> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 429 || res.status >= 500) {
        // 限流/服务端错误:退避重试
        const wait = 3000 * (attempt + 1)
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, wait))
          continue
        }
      }
      return res
    } catch (e) {
      lastErr = e
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
        continue
      }
    }
  }
  throw new Error(`Kimi 请求失败(重试 ${MAX_RETRIES} 次): ${(lastErr as Error)?.message || 'unknown'}`)
}

// ---------- 对话 ----------

/**
 * 流式对话 + 静默看门狗。
 *
 * 为什么不用整体超时:推理/长输出的合法请求可能跑几分钟(固定超时会误杀,
 * 上次生产任务规划阶段 300s 超时就是被固定超时打断的)。流式下数据持续
 * 到达(实测首 chunk 0.1s、最大间隔 0.5s),因此判据改为:
 *   - 首包(HTTP 头) 60s 内必须到达(连接/排队卡死判定)
 *   - 数据流中任意 90s 无 chunk(服务端卡死判定)
 * 触发任一条件立即中止并整体重试;持续有数据则允许跑到 max_tokens 上限。
 */
const STREAM_FIRST_BYTE_TIMEOUT_MS = 60_000
const STREAM_IDLE_TIMEOUT_MS = 90_000

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const model = opts.model || getKimiModel()
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 16000,
    stream: true,
    stream_options: { include_usage: true },
  }
  // Kimi 推理模型仅接受 1;deepseek-flash 可用默认温度
  body.temperature = 1
  if (opts.tools) body.tools = opts.tools

  let lastErr: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await chatStreamOnce(body)
    } catch (e) {
      lastErr = e
      const msg = (e as Error).message || ''
      // 4xx(非429)是请求本身问题,重试无意义
      if (/HTTP 4\d\d/.test(msg) && !msg.includes('429')) throw e
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
        continue
      }
    }
  }
  throw new Error(`LLM 请求失败(重试 ${MAX_RETRIES} 次): ${(lastErr as Error)?.message || 'unknown'}`)
}

/** 单次流式请求:聚合 delta + 看门狗 + usage 提取 */
async function chatStreamOnce(body: Record<string, unknown>): Promise<ChatResult> {
  const ctl = new AbortController()
  let firstByte = true
  let timer: ReturnType<typeof setTimeout> = setTimeout(
    () => ctl.abort(new Error('首包 60s 未到达')),
    STREAM_FIRST_BYTE_TIMEOUT_MS,
  )
  const resetIdle = () => {
    firstByte = false
    clearTimeout(timer)
    timer = setTimeout(() => ctl.abort(new Error('数据流 90s 无响应')), STREAM_IDLE_TIMEOUT_MS)
  }

  let res: Response
  try {
    res = await fetch(`${apiBase()}/v1/chat/completions`, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify(body),
      signal: ctl.signal,
      cache: 'no-store',
    })
  } catch (e) {
    clearTimeout(timer)
    throw new Error(`LLM ${firstByte ? '连接失败' : '请求中断'}: ${(e as Error).message || 'unknown'}`)
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer)
    const t = await res.text().catch(() => '')
    throw new Error(`LLM chat HTTP ${res.status}: ${t.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let usage: ChatResult['usage']
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (e) {
        throw new Error(`LLM 数据流中断: ${(e as Error).message || 'unknown'}`)
      }
      if (chunk.done) break
      resetIdle()
      buf += decoder.decode(chunk.value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const ev = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string
                tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
              }
              finish_reason?: string | null
            }>
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
          }
          if (ev.usage) {
            usage = {
              promptTokens: ev.usage.prompt_tokens,
              completionTokens: ev.usage.completion_tokens,
              totalTokens: ev.usage.total_tokens,
            }
          }
          const choice = ev.choices?.[0]
          const delta = choice?.delta
          if (delta?.content) content += delta.content
          if (delta?.reasoning_content) reasoning += delta.reasoning_content
          for (const tc of delta?.tool_calls || []) {
            const i = tc.index ?? 0
            if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', arguments: '' }
            if (tc.id) toolCalls[i].id = tc.id
            if (tc.function?.name) toolCalls[i].name += tc.function.name
            if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason
        } catch {
          /* 忽略单个坏事件 */
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }

  return {
    content,
    reasoning: reasoning || undefined,
    toolCalls: toolCalls.filter(Boolean),
    usage,
    finishReason,
  }
}

// ---------- 联网搜索(Formula API,固定走 Kimi) ----------

/**
 * Kimi Formula 联网搜索。
 * 注意:Formula 是 Moonshot 私有接口,必须固定走 Kimi 端点——
 * 即使主力 LLM 是 DeepSeek(apiBase 指向 DeepSeek),本函数也不能用
 * apiBase()/baseHeaders(),否则 404。
 */
function kimiBase(): string {
  const b = (process.env.KIMI_BASE_URL || 'https://api.moonshot.cn').replace(/\/$/, '')
  return b.endsWith('/v1') ? b.slice(0, -3) : b
}

function kimiHeaders(): Record<string, string> {
  const key = (process.env.KIMI_API_KEY || '').trim()
  if (!key) throw new Error('KIMI_API_KEY_MISSING: Formula 搜索需要 Kimi key')
  return {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    'kimi-api-version': API_VERSION,
  }
}

/** Formula 链路里需要走 Kimi chat(带 tools),不能用主力 LLM 的 chat() */
async function kimiChatWithTools(
  messages: KimiMessage[],
  tools: unknown,
  maxTokens: number,
  model: string,
): Promise<ChatResult> {
  const body = {
    model,
    messages,
    tools,
    max_tokens: maxTokens,
    temperature: 1,
    stream: false, // Formula 工具轮不流式,链路短
  }
  const res = await fetchWithRetry(`${kimiBase()}/v1/chat/completions`, {
    method: 'POST',
    headers: kimiHeaders(),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Kimi chat HTTP ${res.status}: ${text.slice(0, 200)}`)
  const j = JSON.parse(text) as {
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
      finish_reason?: string
    }>
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }
  const msg = j.choices?.[0]?.message
  return {
    content: msg?.content || '',
    reasoning: msg?.reasoning_content,
    toolCalls: msg?.tool_calls?.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
    usage: j.usage
      ? { promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens, totalTokens: j.usage.total_tokens }
      : undefined,
    finishReason: j.choices?.[0]?.finish_reason,
  }
}

export async function formulaSearch(query: string, model?: string): Promise<string> {
  const m = model || process.env.KIMI_MODEL || 'kimi-k2.6'
  const formulaUri = 'moonshot/web-search:latest'
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // 1. 获取工具声明(固定 Kimi 端点)
  const toolsRes = await fetchWithRetry(`${kimiBase()}/v1/formulas/${formulaUri}/tools`, {
    method: 'GET',
    headers: kimiHeaders(),
  }, 30_000)
  if (!toolsRes.ok) throw new Error(`获取搜索工具失败: HTTP ${toolsRes.status}`)
  const tools = (await toolsRes.json()).tools

  // 2/3/4. 多轮循环:chat → 执行全部 tool_calls → 回传 → 直到收敛为纯文本
  const messages: KimiMessage[] = [
    { role: 'user', content: `请联网搜索以下内容并总结要点:${query}` },
  ]
  const MAX_TOOL_ROUNDS = 6
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await kimiChatWithTools(messages, tools, 8000, m)
    if (res.finishReason !== 'tool_calls' || !res.toolCalls?.length) {
      return res.content || ''
    }
    messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls })
    for (const tc of res.toolCalls) {
      const fiberRes = await fetchWithRetry(`${kimiBase()}/v1/formulas/${formulaUri}/fibers`, {
        method: 'POST',
        headers: kimiHeaders(),
        body: JSON.stringify({ name: tc.name, arguments: tc.arguments }),
      }, 60_000)
      if (!fiberRes.ok) throw new Error(`搜索执行失败: HTTP ${fiberRes.status}`)
      const fiber = (await fiberRes.json()) as { context?: { encrypted_output?: string } }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ encrypted_output: fiber.context?.encrypted_output || '' }),
      })
      await sleep(1200) // 组织 RPM 节流
    }
    await sleep(1200)
  }
  // 轮数超限:模型仍在调工具,放弃解读,抛错走知识摘要兜底
  throw new Error('Formula 搜索轮数超限')
}

// ---------- 输出清洗 ----------

/**
 * 剥离 LLM 输出中的 markdown 代码块包裹(实测 k2.6 会包裹 JSON)。
 * 处理:```json ... ``` / ``` ... ```
 */
export function extractCodeBlock(text: string): string {
  const t = (text || '').trim()
  if (!t) return ''
  // 匹配 ```lang\n...\n```
  const m = t.match(/```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```/)
  if (m) return m[1].trim()
  // 无语言标识的单行包裹
  if (t.startsWith('```')) {
    return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  }
  return t
}

/**
 * 从 LLM 文本中解析 JSON(容忍代码块包裹与前后噪音)。
 */
export function parseJsonLoose<T>(text: string): T | null {
  const cleaned = extractCodeBlock(text)
  // 尝试直接解析
  try {
    return JSON.parse(cleaned) as T
  } catch {
    /* continue */
  }
  // 提取最外层 { } 或 [ ]
  const objMatch = cleaned.match(/\{[\s\S]*\}/)
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]) as T
    } catch {
      /* continue */
    }
  }
  const arrMatch = cleaned.match(/\[[\s\S]*\]/)
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]) as T
    } catch {
      /* continue */
    }
  }
  return null
}

/** 凭证就绪检查 */
export function hasKimiKey(): boolean {
  const key = (process.env.KIMI_API_KEY || '').trim()
  return key.length > 10
}

/** LLM 门禁(M-35):任一主力 LLM 凭证存在即可,不区分供应商 */
export function hasLLMKey(): boolean {
  return isDeepSeek() || hasKimiKey()
}
