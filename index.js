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
const FALLBACK_VERSION = '0.0.0'

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
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
 * @returns {{ installed: string[], skipped: boolean, root: string }}
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

  const installed = []
  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const from = join(SRC_DIR, entry.name)
    const to = join(skillsRoot, entry.name)

    // 只清理我们自己分发过的同名目录，避免覆盖用户手写 skill
    if (existsSync(to)) rmSync(to, { recursive: true, force: true })

    cpSync(from, to, { recursive: true })
    installed.push(entry.name)
  }

  try {
    writeFileSync(markerPath, version, 'utf8')
  } catch {
    /* 写不了 marker 只是下次会重装一次，不影响功能 */
  }

  return { installed, skipped: false, root: skillsRoot }
}

export function apply(_ctx, config = {}) {
  try {
    const result = installSkills({ dshHome: config?.dshHome, force: config?.force })
    if (result.skipped) {
      console.log('[prompt-forge] skills already up to date')
    } else if (result.installed.length) {
      console.log(`[prompt-forge] installed skill(s): ${result.installed.join(', ')} -> ${result.root}`)
    }
  } catch (err) {
    // 插件加载失败不应该拖垮整个 harness
    console.warn('[prompt-forge] skill install failed:', err?.message ?? err)
  }
}
