#!/usr/bin/env node
/**
 * push-via-api.mjs — 在 git push 不通（代理拦截 github.com:443）时，用 GitHub API 推送。
 *
 * 适用场景：`git push` 报 `CONNECT tunnel failed` 或 `Failed to connect to github.com:443`，
 * 但 `gh api user` 能正常返回。此时 api.github.com 是通的，只是 git 通道被挡。
 *
 * 用法：
 *   node scripts/push-via-api.mjs            # 用当前 HEAD 的工作区内容推送
 *   node scripts/push-via-api.mjs --dry-run  # 只打印将要上传的文件
 *
 * 前提：已安装 gh 并登录（gh auth status 正常）。
 *
 * 注意：本脚本以「本地工作区覆盖远程」的方式提交，commit 历史会与本地 git 不同步。
 * 网络正常时请优先用 git push。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const DRY = process.argv.includes('--dry-run')

function run(cmd, args, input) {
  return execFileSync(cmd, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  }).trim()
}

function ghApi(method, path, body) {
  const args = ['api', '-X', method, `${BASE}${path}`]
  if (body !== undefined) args.push('--input', '-')
  const out = run('gh', args, body === undefined ? undefined : JSON.stringify(body))
  return out ? JSON.parse(out) : null
}

// ---------- 解析仓库 ----------

let slug
try {
  const url = run('git', ['remote', 'get-url', 'origin'])
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (!m) throw new Error(`无法从 remote 解析 owner/repo: ${url}`)
  slug = `${m[1]}/${m[2]}`
} catch (e) {
  console.error('✗', e.message ?? e)
  console.error('  请先在仓库目录下执行 git remote add origin https://github.com/<owner>/<repo>.git')
  process.exit(1)
}

const branch = run('git', ['branch', '--show-current']) || 'main'
const message =
  run('git', ['log', '-1', '--pretty=%B']) || 'chore: sync via push-via-api'

console.log(`→ ${slug} (${branch})`)

// ---------- 文件清单 ----------

const files = run('git', ['ls-files'])
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => existsSync(f))

if (!files.length) {
  console.error('✗ 没有可提交的文件（git ls-files 为空）')
  process.exit(1)
}

console.log(`→ ${files.length} 个文件`)

if (DRY) {
  for (const f of files) console.log('   ', f)
  console.log('dry-run，未做任何修改')
  process.exit(0)
}

// ---------- 定位远程 head ----------

const BASE = `/repos/${slug}`
let parentSha = null
let baseTree = null

try {
  const ref = ghApi('GET', `/git/ref/heads/${branch}`)
  parentSha = ref.object.sha
  baseTree = ghApi('GET', `/git/commits/${parentSha}`).tree.sha
  console.log(`→ 远程 head ${parentSha.slice(0, 8)}`)
} catch {
  console.log('→ 空仓库，将用 Contents API 初始化')
}

// ---------- 创建 blobs ----------

const tree = []
for (const f of files) {
  const buf = readFileSync(f)
  const binary = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip)$/i.test(f)
  const blob = binary
    ? ghApi('POST', '/git/blobs', { content: buf.toString('base64'), encoding: 'base64' })
    : ghApi('POST', '/git/blobs', { content: buf.toString('utf8'), encoding: 'utf-8' })

  tree.push({ path: f.split('\\').join('/'), mode: '100644', type: 'blob', sha: blob.sha })
  process.stdout.write('.')
}
console.log(`\n→ ${tree.length} 个 blob 已创建`)

// ---------- tree / commit / ref ----------

const treeBody = { tree }
if (baseTree) treeBody.base_tree = baseTree
const newTree = ghApi('POST', '/git/trees', treeBody)

const newCommit = ghApi('POST', '/git/commits', {
  message,
  tree: newTree.sha,
  parents: parentSha ? [parentSha] : []
})

if (parentSha) {
  ghApi('PATCH', `/git/refs/heads/${branch}`, { sha: newCommit.sha, force: false })
} else {
  ghApi('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: newCommit.sha })
}

console.log(`✓ 已推送 ${newCommit.sha.slice(0, 8)} → https://github.com/${slug}`)
console.log('  提醒：本地 git 历史与远程不同步，网络恢复后请 git fetch && git reset --hard origin/' + branch)
