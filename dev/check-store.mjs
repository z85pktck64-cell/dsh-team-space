#!/usr/bin/env node
/**
 * 存储健壮性：旧数据迁移（J01）+ 损坏不静默清空（J03）。
 * 用临时 DSH_HOME 直接加载插件，不碰真实数据。
 *   node dev/check-store.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let checks = 0
let failures = 0
function ok(name, cond, detail = '') {
  checks += 1
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures += 1
}

const home = mkdtempSync(join(tmpdir(), 'ts-store-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'storages'), { recursive: true })
const storeFile = join(home, 'storages', 'team-space.json')

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const routes = []
const ctx = {
  webServer: { register: entry => routes.push(entry) },
  sessionQuery: { readSession: async () => ({ events: [] }), readTitle: async () => ({ title: '' }) },
  sessionPersistence: { create: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }) },
  agents: { create: async () => ({}) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
  tools: { register: () => () => {} },
  connection: { authenticatedUrl: url => url, lanAddress: () => '127.0.0.1' },
  effect: fn => { try { fn?.() } catch { /* mock */ } },
  onDispose: () => {},
}
mod.apply(ctx)
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://mock').pathname
  const found = routes.find(entry => entry.path === path)
  if (!found) {
    res.statusCode = 404
    res.end('{}')
    return
  }
  Promise.resolve(found.handler(req, res)).catch(error => {
    if (res.headersSent) return
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: error.message }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/team-space`

async function call(path, body) {
  const response = await fetch(`${base}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return { status: response.status, data }
}

// J01：旧格式（没有 channel 字段）能不能读出来
writeFileSync(storeFile, JSON.stringify({
  tasks: [{ id: 'old-task', title: '旧会话', sessionId: 'session-old', createdAt: 1 }],
  skills: [{ id: 'old-skill', name: '旧技能', description: '旧', content: '旧正文', createdAt: 1 }],
}))
const migrated = await call('list')
ok('J01 旧 store 的 tasks 能读出来', (migrated.data?.tables?.tasks ?? []).length === 1,
  JSON.stringify(migrated.data?.tables?.tasks))
ok('J01 旧 store 的 skills 能读出来', (migrated.data?.tables?.skills ?? []).length === 1)

// J03：损坏的 store 不能被空数据覆盖
writeFileSync(storeFile, '{ 这不是 JSON')
const before = readFileSync(storeFile, 'utf8')
const listed = await call('list')
const wrote = await call('entry/upsert', {
  table: 'skills',
  entry: { name: 'new-skill', description: '新', content: '新正文' },
})
const after = readFileSync(storeFile, 'utf8')
let parsed = null
try { parsed = JSON.parse(after) } catch { parsed = null }
ok('J03 损坏的 store 被写接口拒绝（不应静默重建）',
  wrote.status >= 400 || after === before,
  `写接口 HTTP ${wrote.status}，文件${after === before ? '未变' : '已被覆盖'}`)
ok('J03 原文件内容仍可恢复（没有被空 store 覆盖）',
  after === before || after.includes('这不是 JSON'),
  `覆盖后内容：${after.slice(0, 120)}`)
ok('J03 列表接口不把损坏当成空数据继续写', listed.status >= 400 || (listed.data?.ok !== true && after === before),
  `HTTP ${listed.status}`)

server.close()
console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 条失败` : '，全部通过'}\n`)
process.exit(failures ? 1 : 0)
