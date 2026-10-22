#!/usr/bin/env node
/**
 * 清掉自检残留在团队空间里的条目（selftest-* / 自检*）。
 * 用途：自检中途失败过一次，store 里就会留下假 sessionId，
 * 之后「分享会话」列表里能选到它，一认领就是个打不开的会话。
 *   node dev/cleanup-selftest.mjs [port]
 */
import { execSync } from 'node:child_process'

const BASE_SUFFIX = '/api/team-space'

async function call(base, path, body) {
  const options = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { headers: { accept: 'application/json' } }
  const response = await fetch(`${base}/${path}`, options)
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok === false) throw new Error(`${path} → ${data?.error ?? response.status}`)
  return data
}

function discoverPort() {
  const out = execSync('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true').toString()
  return [...new Set([...out.matchAll(/127\.0\.0\.1:(\d+)\s/g)].map(m => Number(m[1])))]
}

async function findBase(explicit) {
  for (const port of explicit ? [Number(explicit)] : discoverPort()) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${BASE_SUFFIX}/list`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return `http://127.0.0.1:${port}${BASE_SUFFIX}`
    } catch { /* 下一个 */ }
  }
  throw new Error('没找到在跑的 team-space API（DSH 没启动？）')
}

const base = await findBase(process.argv[2])
const list = await call(base, 'list')
const hits = []
for (const [table, rows] of Object.entries(list.tables ?? {})) {
  for (const row of rows ?? []) {
    const hay = [row.title, row.name, row.note, row.brief, row.text, row.sessionId, row.owner]
      .filter(Boolean).join(' ')
    if (/selftest|自检/i.test(hay)) hits.push({ table, row })
  }
}

if (!hits.length) {
  console.log('没有自检残留。')
  process.exit(0)
}

for (const { table, row } of hits) {
  const label = row.title ?? row.name ?? row.sessionId ?? row.id
  try {
    if (table === 'handoffs') await call(base, 'handoff/remove', { id: row.id })
    else if (table === 'tasks') await call(base, 'remove', { id: row.id })
    else await call(base, 'entry/remove', { table, id: row.id })
    console.log(`已删除 ${table}：${label}`)
  } catch (error) {
    console.log(`删除失败 ${table}：${label} — ${error.message}`)
  }
}
console.log(`\n共 ${hits.length} 条自检残留处理完毕。`)
