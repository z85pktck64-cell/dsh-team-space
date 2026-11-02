/**
 * 工具返回值回归测试。
 *
 * 背景：宿主 dsh-tools 在派发工具结果前会做 snapshotJsonValue()，
 * 只要对象里出现 undefined / Date / BigInt / Map 等不可无损 JSON 化的值，
 * 整个调用就报 `tool "..." returned invalid output: value is not lossless JSON`，
 * 而写操作其实已经落库。曾经 { ok: true, version: entry.version } 里的
 * entry.version 恒为 undefined（记录字段叫 contentHash），一次挂了 3 个写工具。
 *
 * 这个文件同时检查两件事：
 *   1) 返回值能无损 round-trip；
 *   2) 返回值符合工具自己声明的 output.schema（required、类型、无多余字段）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'team-space-tool-output-'))
process.env.DSH_HOME = HOME
delete process.env.TEAM_SPACE_NOTIFY_URL

const { __testing } = await import('../lib/index.js')

function assertLosslessJson(value, label) {
  const walk = (node, path) => {
    if (node === null) return
    const type = typeof node
    if (type === 'undefined') throw new Error(`${label}: ${path} 为 undefined`)
    if (type === 'number' && !Number.isFinite(node)) throw new Error(`${label}: ${path} 为 ${String(node)}`)
    if (type === 'bigint') throw new Error(`${label}: ${path} 为 BigInt`)
    if (type === 'function' || type === 'symbol') throw new Error(`${label}: ${path} 为 ${type}`)
    if (node instanceof Date) throw new Error(`${label}: ${path} 为 Date（请转 ISO 字符串）`)
    if (node instanceof Map || node instanceof Set) throw new Error(`${label}: ${path} 为 ${node.constructor.name}`)
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}[${index}]`))
    if (type === 'object') return Object.entries(node).forEach(([key, item]) => walk(item, `${path}.${key}`))
  }
  walk(value, '$')

  let text
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new Error(`${label}: 无法序列化 — ${error.message}`)
  }
  assert.notEqual(text, undefined, `${label}: 顶层不可序列化（undefined/function/symbol）`)
  assert.deepEqual(JSON.parse(text), value, `${label}: 不是 lossless JSON`)
}

function assertToolOutput(tool, result) {
  assertLosslessJson(result, tool.name)
  const { schema } = tool.output
  for (const key of Object.keys(result)) {
    assert.ok(
      Object.hasOwn(schema.properties, key),
      `${tool.name} 返回了 schema 之外的字段：${key}`,
    )
  }
  for (const key of schema.required) {
    assert.ok(Object.hasOwn(result, key), `${tool.name} 缺少 required 字段：${key}`)
  }
  for (const [key, definition] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(result, key)) continue
    if (definition.type === 'string') assert.equal(typeof result[key], 'string', `${tool.name}.${key} 必须是 string`)
    if (definition.type === 'number') assert.equal(typeof result[key], 'number', `${tool.name}.${key} 必须是 number`)
    if (definition.type === 'boolean') assert.equal(typeof result[key], 'boolean', `${tool.name}.${key} 必须是 boolean`)
    if (definition.type === 'array') assert.ok(Array.isArray(result[key]), `${tool.name}.${key} 必须是 array`)
  }
  if (schema.properties.version) {
    assert.ok(result.version.length > 0, `${tool.name}.version 不能是空字符串`)
  }
}

const tools = new Map(__testing.SHARED_TOOLS.map(tool => [tool.name, tool]))

test('断言工具本身能抓住 Date / undefined', () => {
  assert.throws(() => assertLosslessJson({ createdAt: new Date() }, 'x'), /Date/)
  assert.throws(() => assertLosslessJson({ note: undefined }, 'x'), /undefined/)
  assert.throws(() => assertLosslessJson({ count: Number.NaN }, 'x'), /NaN/)
  assert.doesNotThrow(() => assertLosslessJson({ createdAt: '2025-09-09T06:31:20Z', note: null }, 'x'))
})

test('每个工具声明的 output.schema 自身是无损 JSON', () => {
  assert.equal(tools.size, 7)
  for (const tool of tools.values()) assertLosslessJson(tool.output.schema, `${tool.name}.output.schema`)
})

test('写工具成功路径返回合法 DTO', async () => {
  const addTodo = tools.get('team_space_add_todo')
  const minimal = await addTodo.execute({ title: 'probe-minimal' })
  assertToolOutput(addTodo, minimal)
  assert.equal(minimal.ok, true)

  const full = await addTodo.execute({ title: 'probe-full', owner: 'xinzhan', status: 'doing', note: '备注' })
  assertToolOutput(addTodo, full)

  const skill = tools.get('team_space_share_skill')
  const sharedSkill = await skill.execute({ name: 'lossless-test-skill', description: 'test', content: '# test\n' })
  assertToolOutput(skill, sharedSkill)

  const plugin = tools.get('team_space_share_plugin')
  const sharedPlugin = await plugin.execute({ name: 'lossless-test-plugin', version: '1.0.0' })
  assertToolOutput(plugin, sharedPlugin)

  const repo = tools.get('team_space_share_repo')
  const sharedRepo = await repo.execute({ name: 'lossless-test-repo', url: 'https://example.com/repo.git' })
  assertToolOutput(repo, sharedRepo)
})

test('委托工具返回合法 DTO', async () => {
  const create = tools.get('team_space_create_handoff')
  const created = await create.execute({ title: 'lossless probe', brief: '验证工具返回值' })
  assertToolOutput(create, created)

  // 委托必须先 claim 才能 complete；这里直接把临时 store 里的状态推到 doing，
  // 只验证 complete_handoff 的返回值，不重复测试状态机本身。
  const storeFile = join(HOME, 'storages', 'team-space.json')
  const store = JSON.parse(readFileSync(storeFile, 'utf8'))
  store.handoffs.find(item => item.id === created.id).status = 'doing'
  writeFileSync(storeFile, JSON.stringify(store, null, 2))

  const complete = tools.get('team_space_complete_handoff')
  const completed = await complete.execute({ id: created.id, result: 'done' })
  assertToolOutput(complete, completed)
  assert.equal(completed.id, created.id)
})

test('只读工具返回合法 DTO', async () => {
  const list = tools.get('team_space_list_members')
  const result = await list.execute({})
  assertToolOutput(list, result)
})

test('落库记录读回后仍是无损 JSON，且 version 等于 contentHash', async () => {
  const addTodo = tools.get('team_space_add_todo')
  const returned = await addTodo.execute({ title: 'probe-minimal' })
  const store = JSON.parse(readFileSync(join(HOME, 'storages', 'team-space.json'), 'utf8'))
  const record = store.todos.find(item => item.title === 'probe-minimal')
  assert.ok(record, '写工具应先落库')
  assertLosslessJson(record, 'team-space.json todos[0]')
  assert.equal(returned.version, record.contentHash)
  assert.equal(typeof returned.version, 'string')
})
