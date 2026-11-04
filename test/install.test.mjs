/**
 * installSkills 的行为契约。
 *
 *   node --test test/
 *
 * 用内置 node:test，不引任何第三方依赖——和「零依赖、装完就能跑」是同一个原则。
 * 每个用例都在独立的临时 DSH_HOME 里跑，互不干扰，跑完自清理。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { installSkills } from '../index.js'

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'pf-test-'))
  return home
}

function cleanup(home) {
  rmSync(home, { recursive: true, force: true })
}

/** 模拟用户自己在 skills/ 下手写了一个同名 skill。 */
function seedUserSkill(home, name = 'prompt-forge') {
  const dir = join(home, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '# 我自己改过的版本\n', 'utf8')
  writeFileSync(join(dir, 'my-notes.md'), '这是我加的东西\n', 'utf8')
  return dir
}

test('干净环境：把 skills/ 下的目录铺过去', () => {
  const home = freshHome()
  try {
    const r = installSkills({ dshHome: home })
    assert.equal(r.skipped, false)
    assert.ok(r.installed.includes('prompt-forge'), '应装上 prompt-forge')
    assert.ok(existsSync(join(home, 'skills', 'prompt-forge', 'SKILL.md')))
  } finally {
    cleanup(home)
  }
})

test('不覆盖用户手写的同名 skill', () => {
  const home = freshHome()
  try {
    const dir = seedUserSkill(home)
    const r = installSkills({ dshHome: home })

    assert.ok(r.skippedExisting.includes('prompt-forge'), '应报告跳过')
    assert.equal(r.installed.length, 0, '不应安装任何东西')
    assert.ok(existsSync(join(dir, 'my-notes.md')), '用户加的笔记必须还在')
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# 我自己改过的版本\n')
  } finally {
    cleanup(home)
  }
})

test('force：用户明确要求时才覆盖', () => {
  const home = freshHome()
  try {
    const dir = seedUserSkill(home)
    const r = installSkills({ dshHome: home, force: true })

    assert.equal(r.skippedExisting.length, 0)
    assert.ok(r.installed.includes('prompt-forge'))
    assert.equal(existsSync(join(dir, 'my-notes.md')), false, 'force 下允许清掉')
    assert.notEqual(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# 我自己改过的版本\n')
  } finally {
    cleanup(home)
  }
})

test('同版本重复调用：直接跳过，不做任何写入', () => {
  const home = freshHome()
  try {
    installSkills({ dshHome: home })
    const second = installSkills({ dshHome: home })
    assert.equal(second.skipped, true)
    assert.equal(second.installed.length, 0)
  } finally {
    cleanup(home)
  }
})

test('自己装过的目录，force 之外也允许随版本替换', () => {
  const home = freshHome()
  try {
    // 第一次：干净安装，manifest 记下归属
    installSkills({ dshHome: home })
    // 把内容改脏，模拟「旧版本留下的副本」
    const skill = join(home, 'skills', 'prompt-forge', 'SKILL.md')
    writeFileSync(skill, '# 旧版本\n', 'utf8')
    // 抹掉版本 marker，逼它重装
    rmSync(join(home, '.prompt-forge-version'), { force: true })

    const r = installSkills({ dshHome: home })
    assert.equal(r.skippedExisting.length, 0, '自己装的不该被当成用户的')
    assert.ok(r.installed.includes('prompt-forge'))
    assert.notEqual(readFileSync(skill, 'utf8'), '# 旧版本\n')
  } finally {
    cleanup(home)
  }
})
