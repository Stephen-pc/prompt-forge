/**
 * dsh-prompt-forge
 *
 * 一个极轻的 Cordis 插件：把包内的 skill 同步到 DSH 的本地 skill 根目录。
 *
 * 为什么不直接用 bundledSkillDir：
 *   那条路需要依赖 skill-filesystem 的挂载顺序与配置覆盖，任何一环变动都会静默失效。
 *   而 `<dshHome>/skills` 是官方文档列明的默认扫描根（rank 400），
 *   skill-filesystem 会监视它并在变化时自动刷新目录 —— 不需要任何内部 API。
 *
 * 所以这里只做一件事：把 skills/ 下的目录复制过去。幂等、可重入、失败不阻断启动。
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'prompt-forge'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, 'skills')
const MARKER = '.prompt-forge-version'
const MANIFEST = '.prompt-forge-manifest.json'
const FALLBACK_VERSION = '0.0.0'

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

/**
 * 读「哪些 skill 目录是本插件装的」这份账。
 *
 * 没有这份账就没法区分「上次我们铺过去的」和「用户自己手写的同名目录」，
 * 只能一律覆盖或一律跳过——前者会删掉用户的改动，后者升级永远不生效。
 */
function readManifest(dshHome) {
  try {
    const raw = JSON.parse(readFileSync(join(dshHome, MANIFEST), 'utf8'))
    return Array.isArray(raw.skills) ? raw.skills.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

function writeManifest(dshHome, skills) {
  try {
    writeFileSync(join(dshHome, MANIFEST), JSON.stringify({ skills }, null, 2), 'utf8')
  } catch {
    /* 记账失败只会让下次更保守（跳过），不会造成破坏 */
  }
}

function resolveDshHome(explicit) {
  if (explicit) return explicit
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

/**
 * 把包内 skill 同步到 `<dshHome>/skills`。
 * @param {{ dshHome?: string, force?: boolean }} [options]
 * @returns {{ installed: string[], skipped: boolean, skippedExisting: string[], root: string }}
 */
export function installSkills(options = {}) {
  const dshHome = resolveDshHome(options.dshHome)
  const skillsRoot = join(dshHome, 'skills')
  const markerPath = join(dshHome, MARKER)
  const version = readVersion()

  if (!existsSync(SRC_DIR)) {
    return { installed: [], skipped: true, root: skillsRoot }
  }

  if (!options.force && existsSync(markerPath)) {
    try {
      if (readFileSync(markerPath, 'utf8').trim() === version) {
        return { installed: [], skipped: true, root: skillsRoot }
      }
    } catch {
      /* marker 读不了就当作需要重装 */
    }
  }

  mkdirSync(skillsRoot, { recursive: true })

  const owned = new Set(readManifest(dshHome))
  const installed = []
  const skippedExisting = []

  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const from = join(SRC_DIR, entry.name)
    const to = join(skillsRoot, entry.name)

    // 目标已存在时，只有在「账上记着是我们装的」或者用户明确 force 的情况下才替换。
    // 否则可能是用户自己手写/改过的同名 skill —— 那不是我们的东西，不动它。
    // 早先这里是无条件 rmSync，注释写着「避免覆盖用户手写 skill」，但实现正好相反：
    // 用户放在 ~/.dsh/skills/prompt-forge 的本地特化版会被整个删掉，连他加的笔记一起。
    if (existsSync(to)) {
      if (!owned.has(entry.name) && !options.force) {
        skippedExisting.push(entry.name)
        continue
      }
      rmSync(to, { recursive: true, force: true })
    }

    cpSync(from, to, { recursive: true })
    installed.push(entry.name)
  }

  writeManifest(dshHome, [...new Set([...owned, ...installed])])

  try {
    writeFileSync(markerPath, version, 'utf8')
  } catch {
    /* 写不了 marker 只是下次会重装一次，不影响功能 */
  }

  return { installed, skipped: false, skippedExisting, root: skillsRoot }
}

export function apply(_ctx, config = {}) {
  try {
    const result = installSkills({ dshHome: config?.dshHome, force: config?.force })
    if (result.skipped) {
      console.log('[prompt-forge] skills already up to date')
    } else if (result.installed.length) {
      console.log(`[prompt-forge] installed skill(s): ${result.installed.join(', ')} -> ${result.root}`)
    }
    if (result.skippedExisting?.length) {
      console.warn(
        `[prompt-forge] 跳过 ${result.skippedExisting.join(', ')}：` +
        `${result.root} 下已有同名目录，但不是本插件装的，未做覆盖。` +
        '确认要替换请用 force 选项。'
      )
    }
  } catch (err) {
    // 插件加载失败不应该拖垮整个 harness
    console.warn('[prompt-forge] skill install failed:', err?.message ?? err)
  }
}
