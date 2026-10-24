#!/usr/bin/env node
/**
 * J04 多进程并发写 + J07 载荷边界。
 *
 * J04 需要两个真实 DSH 进程（同一个 DSH_HOME/store）：
 *   dsh web --port 0 --no-open   # 两个终端各起一次
 *   node dev/e2e-j.mjs --a=http://127.0.0.1:56404 --b=http://127.0.0.1:57750
 *
 * 所有写操作走 test 通道，结束（含失败）时清理。
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const arg = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''
const A = arg('a').replace(/\/$/, '')
const B = arg('b').replace(/\/$/, '')
if (!A || !B) {
  console.error('用法：node dev/e2e-j.mjs --a=http://127.0.0.1:<portA> --b=http://127.0.0.1:<portB>')
  process.exit(2)
}

const TEST = { 'x-team-space-channel': 'test', accept: 'application/json' }
const STAMP = `j-${Date.now().toString(36)}`
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const STORE = join(HOME, 'storages', 'team-space.json')
const LOCK = `${STORE}.lock`
const created = []
let checks = 0
let failures = 0

function ok(name, cond, detail = '') {
  checks += 1
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures += 1
}

async function call(origin, path, { method = 'GET', body, channel = 'test' } = {}) {
  const response = await fetch(`${origin}/api/team-space/${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(channel === 'test' ? TEST : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return { status: response.status, data, text, ok: response.ok && data?.ok !== false }
}

async function upsert(origin, table, entry) {
  const result = await call(origin, 'entry/upsert', { method: 'POST', body: { table, entry } })
  if (!result.ok) throw new Error(`${table}/${entry.name} → HTTP ${result.status} ${result.data?.error ?? result.text.slice(0, 120)}`)
  created.push({ table, id: result.data.entry.id })
  return result.data.entry
}

async function cleanup() {
  const seen = new Set()
  for (const item of created) {
    const key = `${item.table}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    await call(A, 'entry/remove', { method: 'POST', body: { table: item.table, id: item.id } }).catch(() => null)
  }
  const list = await call(A, 'list').catch(() => null)
  const leftovers = Object.entries(list?.data?.tables ?? {}).flatMap(([table, items]) =>
    (items ?? []).filter(item => [item.name, item.title, item.url].filter(Boolean).join(' ').includes(STAMP)).map(item => ({ table, id: item.id })))
  for (const item of leftovers) {
    await call(A, 'entry/remove', { method: 'POST', body: item }).catch(() => null)
  }
}

function assertStoreHealthy(label) {
  let parsed = null
  try { parsed = JSON.parse(readFileSync(STORE, 'utf8')) } catch { parsed = null }
  ok(`${label}：store 仍是完整可解析 JSON`, Boolean(parsed))
  const temps = readdirSync(dirname(STORE)).filter(name => name.startsWith('team-space.json.') && name.endsWith('.tmp'))
  ok(`${label}：没有遗留半写临时文件`, temps.length === 0, temps.join(', '))
  return parsed
}

async function j04() {
  const aList = await call(A, 'list')
  const bList = await call(B, 'list')
  ok('J04 两个 DSH 进程都能读到同一份 store',
    aList.ok && bList.ok
      && (aList.data.tables?.skills ?? []).length === (bList.data.tables?.skills ?? []).length,
    `A=${aList.status} B=${bList.status}`)

  const rounds = 40
  const started = Date.now()
  const jobs = []
  for (let index = 0; index < rounds; index += 1) {
    for (const origin of [A, B]) {
      jobs.push(call(origin, 'entry/upsert', {
        method: 'POST',
        body: {
          table: 'todos',
          entry: { title: `${STAMP}-race-${index}`, note: `并发写 ${index} @ ${origin}` },
        },
      }))
    }
  }
  const results = await Promise.all(jobs)
  for (const result of results) {
    if (result.data?.entry?.id) created.push({ table: 'todos', id: result.data.entry.id })
  }
  ok('J04 两个进程并发发起 80 次写全部成功',
    results.every(result => result.ok),
    JSON.stringify(results.filter(result => !result.ok).slice(0, 4).map(result => ({ status: result.status, error: result.data?.error }))))
  const after = await call(A, 'list')
  const ids = new Set((after.data?.tables?.todos ?? []).map(item => item.id))
  const written = results.map(result => result.data?.entry?.id).filter(Boolean)
  const rows = written.filter(id => ids.has(id))
  const afterB = await call(B, 'list')
  const idsB = new Set((afterB.data?.tables?.todos ?? []).map(item => item.id))
  let rawIds = new Set()
  try {
    const raw = JSON.parse(readFileSync(STORE, 'utf8'))
    rawIds = new Set((raw.todos ?? []).map(item => item.id))
  } catch { /* 由下一个断言报 */ }
  const bySite = Object.fromEntries([A, B].map(origin => [origin, results
    .filter(result => String(result.data?.entry?.note ?? '').endsWith(`@ ${origin}`))
    .map(result => result.data?.entry?.id)
    .filter(Boolean)
    .filter(id => ids.has(id)).length]))
  ok('J04 80 条并发记录一条不少（无丢失更新）', rows.length === rounds * 2,
    JSON.stringify({ actualA: rows.length, actualB: written.filter(id => idsB.has(id)).length, raw: written.filter(id => rawIds.has(id)).length, bySite, written: written.length }))
  ok('J04 并发写没有把 store 写坏', Boolean(assertStoreHealthy('J04')))
  console.log(`     80 次并发写耗时 ${Date.now() - started}ms`)

  if (existsSync(LOCK)) {
    ok('J04 锁超时前置条件：跑测试前没有残留锁', false, LOCK)
    return
  }
  writeFileSync(LOCK, `${process.pid}-live-holder`)
  try {
    const blocked = await call(A, 'entry/upsert', {
      method: 'POST',
    body: { table: 'todos', entry: { title: `${STAMP}-locked`, note: '应被锁拒绝' } },
    })
    ok('J04 有活进程持锁时写请求超时并返回明确错误',
      blocked.status >= 400 && /另一个进程写入|稍后重试/.test(String(blocked.data?.error ?? blocked.text)),
      `HTTP ${blocked.status} ${blocked.data?.error ?? blocked.text.slice(0, 120)}`)
    const still = await call(A, 'list')
    ok('J04 被锁拒绝的记录没有偷偷写入',
      !(still.data?.tables?.todos ?? []).some(item => item.title === `${STAMP}-locked`))
  } finally {
    try { unlinkSync(LOCK) } catch { /* 已清理 */ }
  }
}

async function j07() {
  const exact = await upsert(A, 'skills', {
    name: `${STAMP}-content-200k`,
    description: '边界：正文恰好 200000',
    content: 'A'.repeat(200_000),
  })
  const over = await upsert(B, 'skills', {
    name: `${STAMP}-content-over`,
    description: 'D'.repeat(2_000),
    content: 'B'.repeat(200_001),
  })
  const longRepo = await upsert(A, 'repos', {
    name: `N${STAMP}${'X'.repeat(300)}`,
    url: `https://gitlab.txzing.com/${'x'.repeat(700)}`,
    description: 'E'.repeat(5_000),
    type: 'git',
  })

  const exactDetail = await call(B, `detail?table=skills&id=${encodeURIComponent(exact.id)}`)
  const overDetail = await call(A, `detail?table=skills&id=${encodeURIComponent(over.id)}`)
  const repoDetail = await call(B, `detail?table=repos&id=${encodeURIComponent(longRepo.id)}`)

  ok('J07 正文恰好 200KB 能完整保存', exactDetail.ok && exactDetail.data.entry?.content?.length === 200_000,
    `len=${exactDetail.data?.entry?.content?.length}`)
  ok('J07 正文超过 200KB 按上限截断且不报 500',
    overDetail.ok && overDetail.data.entry?.content?.length === 200_000,
    `HTTP=${overDetail.status} len=${overDetail.data?.entry?.content?.length}`)
  ok('J07 skill 描述 2000 → 截断到 200', overDetail.data?.entry?.description?.length === 200,
    `len=${overDetail.data?.entry?.description?.length}`)
  ok('J07 链接名称超长 → 截断到 120', repoDetail.data?.entry?.name?.length === 120,
    `len=${repoDetail.data?.entry?.name?.length}`)
  ok('J07 链接 URL 超长 → 截断到 500', repoDetail.data?.entry?.url?.length === 500,
    `len=${repoDetail.data?.entry?.url?.length}`)
  ok('J07 链接描述超长 → 截断到 1000', repoDetail.data?.entry?.description?.length === 1_000,
    `len=${repoDetail.data?.entry?.description?.length}`)
  assertStoreHealthy('J07')
}

try {
  console.log(`\nJ04 / J07 · A=${A} B=${B} · ${STAMP}\n`)
  await j04()
  await j07()
} finally {
  await cleanup()
  const residual = await call(A, 'list').then(result => Object.entries(result.data?.tables ?? {})
    .flatMap(([table, items]) => (items ?? []).filter(item => [item.name, item.title, item.url].filter(Boolean).join(' ').includes(STAMP)).map(item => ({ table, name: item.name, title: item.title })))).catch(() => [])
  ok('J04/J07 测试无残留', residual.length === 0, JSON.stringify(residual))
  try { if (existsSync(LOCK)) unlinkSync(LOCK) } catch { /* 忽略 */ }
}

console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 条失败` : '，全部通过'}\n`)
process.exit(failures ? 1 : 0)
