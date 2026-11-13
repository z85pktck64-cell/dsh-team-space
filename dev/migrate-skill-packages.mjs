#!/usr/bin/env node
/**
 * 技能包迁移：把 store 里的「绝对 URL」改成「文件名」，并补齐缺包的技能。
 *
 * 背景（2026-11-13 实测）：
 *   - 42 条技能的 packageUrl 全部写死 http://192.168.42.124:8080，该 IP 已不可达 → 全部死链
 *   - 9 条技能没有包，其中 7 条的 tgz 其实已经在 team-space-dist/ 里，只是没关联
 *   - oi-prd-writer / docrelay-m03-contract 需要现场打包
 *
 * 可回滚：运行时先写 team-space.json.bak-<时间戳>-before-package-migration。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const storePath = join(home, 'storages', 'team-space.json')
const distDir = join(home, 'storages', 'team-space-dist')
const skillsDir = join(home, 'skills')
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)

copyFileSync(storePath, `${storePath}.bak-${stamp}-before-package-migration`)

const store = JSON.parse(readFileSync(storePath, 'utf8'))
const skills = store.skills ?? []
const report = { rewired: [], restored: [], packed: [], skipped: [] }

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const countFiles = file => execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\n').filter(line => line.trim() && !line.trim().endsWith('/')).length

function attach(skill, file) {
  const path = join(distDir, file)
  if (!existsSync(path)) return false
  skill.packageFile = file
  skill.packageSha256 = sha256(path)
  skill.fileCount = countFiles(path)
  delete skill.packageUrl
  return true
}

// 1) 已有 URL 的：提取文件名，改存相对
for (const skill of skills) {
  if (skill.packageFile) continue
  const match = String(skill.packageUrl ?? '').match(/[?&]file=([^&]+)/)
  if (!match) continue
  const file = decodeURIComponent(match[1])
  if (attach(skill, file)) report.rewired.push(skill.name)
  else report.skipped.push(`${skill.name}（URL 指向的 ${file} 不在 dist）`)
}

// 2) 没有包但 dist 里已有同名包的（孤儿包）
for (const skill of skills) {
  if (skill.packageFile) continue
  if (skill.member) continue
  const file = `skill-${skill.name}.tgz`
  if (existsSync(join(distDir, file)) && attach(skill, file)) report.restored.push(skill.name)
}

// 3) 还没有包、但本机有技能目录的：现场打包
for (const skill of skills) {
  if (skill.packageFile || skill.member) continue
  const src = join(skillsDir, skill.name)
  if (!existsSync(join(src, 'SKILL.md'))) {
    report.skipped.push(`${skill.name}（无本地目录）`)
    continue
  }
  const file = `skill-${skill.name}.tgz`
  execFileSync('tar', [
    '-czf', join(distDir, file),
    '--exclude=node_modules', '--exclude=.git', '--exclude=*.bak-*',
    '-C', skillsDir, skill.name,
  ])
  if (attach(skill, file)) report.packed.push(skill.name)
}

writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`)

console.log(`备份：${storePath}.bak-${stamp}-before-package-migration`)
console.log(`改地址形态：${report.rewired.length} 条`)
console.log(`补关联孤儿包：${report.restored.length} 条 -> ${report.restored.join(', ')}`)
console.log(`现场打包：${report.packed.length} 条 -> ${report.packed.join(', ')}`)
console.log(`跳过：${report.skipped.length} 条`)
for (const line of report.skipped) console.log(`  - ${line}`)

const after = JSON.parse(readFileSync(storePath, 'utf8')).skills ?? []
const noPackage = after.filter(item => !item.member && !item.packageFile)
console.log(`结果：${after.length} 条技能，${noPackage.length} 条仍无包`)
for (const item of noPackage) console.log(`  ⚠ ${item.name}`)
