/**
 * scripts/recipe-probe.ts — 提示词里的元素骨架必须能被引擎接受
 *
 * 站点的阶段 4 提示词里嵌了 13 段页面骨架 JSON,模型会照着抄。这些骨架一旦与引擎
 * 契约漂移(比如卡片漏了 `background: true`、columnTracks 写错形状),模型就会产出
 * 引擎拒收的规格,白白烧掉一轮配额 —— 而漂移不会让 tsc 报错。
 *
 * 这个脚本把骨架从**真实提示词**里抠出来,逐段交给引擎 `--check`:
 *   npx tsx scripts/recipe-probe.ts
 * 需要引擎依赖(node_modules)与 NATIVE_ENGINE_DIR;没有引擎就 skip(exit 0),不假装通过。
 */
import { writeFileSync } from 'node:fs'
import { checkSpec, engineRoot } from '../src/lib/pipeline/native'
import { buildPlanPrompt, buildSpecPrompt, resolvePresetTheme } from '../src/lib/pptx-prompts'
import type { DeckSpecJson, OutlinePlan } from '../src/lib/pipeline/types'

/** 从一段文本里抠出所有顶层 JSON 对象(字符串感知的括号匹配,不依赖换行) */
function extractJsonObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, index + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

const plan: OutlinePlan = {
  title: '配方探针',
  styleName: '雾绿',
  preset: 'sage',
  pages: [{ title: '探针页', template: 'content', brief: '用来展开配方的占位 brief。' }],
}

function deckWith(slides: unknown[], theme: ReturnType<typeof resolvePresetTheme>): DeckSpecJson {
  return {
    title: '配方探针',
    language: 'zh-CN',
    pageSize: 'wide',
    theme: {
      name: theme.name,
      colors: { ...theme.colors },
      fonts: { ...theme.fonts },
      sizes: { ...theme.sizes },
    },
    slides: slides as DeckSpecJson['slides'],
  }
}

async function main(): Promise<void> {
  try {
    engineRoot()
  } catch (error) {
    console.log(`[recipe-probe] SKIP 引擎不可用:${(error as Error).message}`)
    return
  }
  const theme = resolvePresetTheme('sage', 'zh-CN')
  const prompt = buildSpecPrompt(plan, {
    topic: '配方探针', language: 'zh-CN', slideCount: 1, facts: '占位资料',
  }, { name: theme.name, colors: { ...theme.colors } })
  // 同一份骨架同时给到规划提示词:那边的配方也必须过同一道门
  const plannerPrompt = buildPlanPrompt({ topic: '配方探针', language: 'zh-CN', slideCount: 1 })

  const objects = extractJsonObjects(prompt)
    .map((raw) => {
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((value): value is Record<string, unknown> => !!value && value.elements !== undefined)

  if (!objects.length) {
    console.error('[recipe-probe] FAIL 提示词里没找到任何页面骨架(提取器需要更新)')
    process.exitCode = 1
    return
  }

  let failed = 0
  for (const [index, slide] of objects.entries()) {
    const label = `#${index + 1} ${String(slide.template || 'unknown')}`
    const result = await checkSpec(deckWith([slide], theme))
    if (result.ok) {
      console.log(`[recipe-probe] OK   ${label}`)
    } else {
      failed++
      console.error(`[recipe-probe] FAIL ${label}`)
      for (const error of result.errors.slice(0, 6)) console.error(`    - ${error}`)
    }
  }

  // 规划提示词里不该再出现"不可排"的示范元素;至少确认它没教模型写 x/y
  if (/"(x|y|w)"\s*:/.test(plannerPrompt)) {
    failed++
    console.error('[recipe-probe] FAIL 规划提示词里出现了写字坐标的示范')
  }

  // `--deck <path>` 把 13 段骨架拼成一份 deck 写盘:人可以接着用它看实际渲染效果
  const deckFlag = process.argv.indexOf('--deck')
  if (deckFlag >= 0 && process.argv[deckFlag + 1]) {
    const out = process.argv[deckFlag + 1]
    writeFileSync(out, JSON.stringify(deckWith(objects, theme), null, 2), 'utf8')
    console.log(`[recipe-probe] 已写出合并 deck:${out}(${objects.length} 页)`)
  }

  console.log(`[recipe-probe] ${objects.length} 段骨架,${failed} 段失败`)
  if (failed) process.exitCode = 1
}

main().catch((error) => {
  console.error('[recipe-probe] 未捕获异常:', error)
  process.exitCode = 1
})

