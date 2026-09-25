/**
 * 从 **skill 目录 bundle** 读取并解析，产出可交给 `ctx.skills` **provider** 的定义。
 *
 * 标准格式（与 `dsh-skill-filesystem` 一致）：一个 skill 是**目录**，主文档 `<name>/SKILL.md`，
 * 其余细节放同目录下的 `references/` 等资源里——目的是**渐进披露**：
 * 目录里只出现 `description`/`whenToUse`，主文档在被调用时加载，细节等真正要做那一步再读。
 * 所以本加载器只读 `SKILL.md` 作正文，并把 `resourceBase`（目录路径）交出去，
 * 由 DSH 在加载时告诉模型"相对路径按这个基目录解析"。
 *
 * 两条宿主契约（踩过，别再踩）：
 *   1. `source`/`provider` 必须是字符串——`dsh-skill` 的 `validateDefinition` 在**加载期**校验，
 *      注册期不校验：少了它 catalog 有摘要、真去加载报 `source must be a string`。
 *   2. `invocation` 必须**两个布尔都给全**：`dsh-skill` 的 `toSummary` 不兜底，消费方
 *      `isModelInvocable()` 直接取 `skill.invocation.modelInvocable`——给 undefined 会抛。
 *      所以这里按 `dsh-skill-filesystem` 的 `parseInvocationPolicy` 语义产出**永远完整**的策略。
 *
 * 零依赖、只读 `node:fs`（安装期与运行期都能用）。
 *
 * @module dsh-stable-network/skills
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** skill 根目录（随包发布：`files` 里有 `skills`）。 */
export const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/** 主文档名。 */
export const MAIN_FILE = 'SKILL.md'

/**
 * 本插件 skill 的 **provider 名**：进 `ctx.skills.registerProvider()`，也是候选/定义的 `provider` 字段。
 * 不能叫 `runtime`（`dsh-skill` 保留给 `skills.register()`，会直接抛）。
 */
export const PROVIDER_NAME = 'stable-network'

/**
 * 本插件 skill 的 `source` 标签。
 *
 * 用 `bundled`（= "随 DSH 及其插件一起发的全局 skill"）：这是生态惯例，也是 `dsh-skill-badge`
 * / 社区 `dsh-agora` / `relay-dsh-plugin-monitor-author` 的做法；现存治理 UI（skill-explorer 等）
 * 按这七个已知 source 分组，自造标签会落进 "other" 桶。
 */
export const SKILL_SOURCE = 'bundled'

/**
 * `bundled` 根的排名，值等于 `@deepseek-ai/dsh-skill` 的 `BUNDLED_SKILL_RANK`。
 *
 * 不走 import 是为了保住本插件的**零依赖**（宿主里有这个包，但不该成为加载前提）；
 * `tests/host-contract.mjs` 在有宿主包时会拿真常量核对这个数字。
 *
 * 语义：数字越大优先级越低。600 意味着**让project(100/200)/custom(300)/user(400) 的同名 skill 赢**
 * ——用户自己写一份同名 skill 就能覆盖我们，这是插件自带 skill 应有的姿态。
 * （对比：`ctx.skills.register()` 的运行时 rank 写死 250，会反过来盖住用户的。）
 */
export const BUILTIN_SKILL_RANK = 600

/** frontmatter 里允许的键（其余键忽略，与官方解析器一致地宽容）。 */
const INVOCATION_KEYS = ['disable-model-invocation', 'user-invocable']

/** 驼峰旧写法：官方 `dsh-skill-filesystem` 明确拒绝，我们跟它对齐（静默忽略会让人以为开关生效了）。 */
const LEGACY_INVOCATION_KEYS = new Map([
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
])

/**
 * 极简 frontmatter 解析（`---` 包裹的 YAML 键值对，只认平铺的 `key: value`）。
 * 容忍开头的 UTF-8 BOM——编辑器/脚本很容易写进去，而"静默少一个 skill"是糟糕的失败模式。
 * @param raw - 文件原文。
 * @returns 平铺的键值表与正文。
 */
function parseFrontmatter(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const firstEnd = text.indexOf('\n')
  if (firstEnd < 0 || text.slice(0, firstEnd).replace(/\r$/, '') !== '---') {
    throw new Error('skill file missing YAML frontmatter')
  }
  const closingStart = text.indexOf('\n---', firstEnd + 1)
  if (closingStart < 0) throw new Error('skill file unclosed frontmatter')
  const header = text.slice(firstEnd + 1, closingStart)
  const body = text.slice(closingStart + 4) // skip "\n---" then the trailing newline
  const data = {}
  for (const line of header.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (m === null) continue
    const value = m[2].trim()
    // 顺手剥掉成对引号：`user-invocable: "false"` 得当成布尔，而不是字符串
    const quoted = /^(['"])(.*)\1$/.exec(value)
    data[m[1]] = quoted === null ? value : quoted[2]
  }
  return { data, body }
}

/**
 * 解析 frontmatter 里的调用策略布尔值（语义照抄 `dsh-skill-filesystem`）。
 * @param value - 原始值；`undefined` 表示键不存在。
 * @param key - 键名（报错文案用）。
 * @returns 布尔值，或键不存在时的 undefined。
 */
function parsePolicyBoolean(value, key) {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
      default: break
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/**
 * 从 frontmatter 产出**完整**的 invocation 策略（两个布尔都有值）。
 * @param data - frontmatter 键值表。
 * @returns `{modelInvocable, userInvocable}`。
 */
function parseInvocation(data) {
  for (const [legacy, canonical] of LEGACY_INVOCATION_KEYS) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
    }
  }
  const disableModel = parsePolicyBoolean(data[INVOCATION_KEYS[0]], INVOCATION_KEYS[0])
  const user = parsePolicyBoolean(data[INVOCATION_KEYS[1]], INVOCATION_KEYS[1])
  return {
    modelInvocable: disableModel !== true,
    userInvocable: user !== false,
  }
}

/** 列出一个 skill 目录下的细分文档（references/*.md，按名排序）。 */
export function listReferences(baseDir) {
  const dir = join(baseDir, 'references')
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({
      name,
      path: join(dir, name),
      bytes: statSync(join(dir, name)).size,
    }))
}

/** 一个 skill bundle 的主文档绝对路径。 */
export function skillMainFile(baseDir) {
  return join(baseDir, MAIN_FILE)
}

/**
 * **现读现解析**一个 skill bundle（provider 的 `get()` 用它，所以改正文不必重启）。
 *
 * 校验与 `loadSkills()` 同一套（name 必须是 kebab-case 且等于目录名、必须有 description），
 * 只是不扫 references——那一步是"整包自检"，属于激活期。
 *
 * @param baseDir - skill 目录。
 * @returns `{name, description, whenToUse?, invocation, content}`。
 */
export function readSkillBundle(baseDir) {
  const main = skillMainFile(baseDir)
  if (!existsSync(main)) throw new Error(`skill bundle ${baseDir} is missing ${MAIN_FILE}`)
  const { data, body } = parseFrontmatter(readFileSync(main, 'utf8'))
  const dir = basename(baseDir)
  if (typeof data.name !== 'string' || data.name.length === 0) {
    throw new Error(`skill ${dir}/${MAIN_FILE}: frontmatter requires name`)
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.name)) {
    throw new Error(`skill ${dir}/${MAIN_FILE}: name "${data.name}" must be kebab-case`)
  }
  if (data.name !== dir) {
    throw new Error(`skill ${dir}/${MAIN_FILE}: name "${data.name}" must match its directory name`)
  }
  if (typeof data.description !== 'string' || data.description.length === 0) {
    throw new Error(`skill ${dir}/${MAIN_FILE}: frontmatter requires description`)
  }
  return {
    name: data.name,
    description: data.description,
    ...(typeof data.whenToUse === 'string' && data.whenToUse.length > 0 ? { whenToUse: data.whenToUse } : {}),
    invocation: parseInvocation(data),
    content: body.trim(),
  }
}

/**
 * 读取**全部** skill 并做整包自检（激活期调用：缺目录 / 空 references 直接抛，绝不静默少一个 skill）。
 * @returns {Array<{name: string, description: string, whenToUse?: string,
 *                  invocation: {modelInvocable: boolean, userInvocable: boolean},
 *                  content: string, baseDir: string,
 *                  references: Array<{name: string, path: string, bytes: number}>}>}
 */
export function loadSkills() {
  if (!existsSync(SKILLS_DIR)) throw new Error(`skills directory not found: ${SKILLS_DIR}`)
  const dirs = readdirSync(SKILLS_DIR)
    .filter((name) => statSync(join(SKILLS_DIR, name)).isDirectory())
    .sort()
  if (dirs.length === 0) throw new Error(`no skill bundles under ${SKILLS_DIR} (expected <name>/${MAIN_FILE})`)
  const out = []
  for (const dir of dirs) {
    const baseDir = join(SKILLS_DIR, dir)
    const parsed = readSkillBundle(baseDir)
    const references = listReferences(baseDir)
    if (references.length === 0) throw new Error(`skill bundle ${dir} has no references/*.md (细分文档)`)
    const missing = references.filter((reference) => reference.bytes === 0)
    if (missing.length > 0) throw new Error(`skill ${dir}: empty reference file(s): ${missing.map((m) => m.name).join(', ')}`)
    out.push({ ...parsed, baseDir, references })
  }
  return out
}

/**
 * 把一个 skill 变成 `ctx.skills` provider 的**候选**（catalog 摘要：不含正文）。
 *
 * 必须显式给 `invocation`（见文件头第 2 条契约）、`rank`、`source`、`provider`、`resourceBase`。
 * `locator` 只带目录名——`get()` 只需要它。
 *
 * @param skill - `loadSkills()` 的一项。
 * @returns provider 候选。
 */
export function toCandidate(skill) {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: skill.invocation,
    source: SKILL_SOURCE,
    provider: PROVIDER_NAME,
    rank: BUILTIN_SKILL_RANK,
    resourceBase: { kind: 'directory', path: skill.baseDir },
    locator: { baseDir: skill.baseDir },
  }
}
