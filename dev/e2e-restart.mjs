#!/usr/bin/env node
/**
 * J02：真实 DSH 宿主重启持久化。
 *
 * 自己拉起 `dsh web`，写入 test 通道数据，停进程，再用新进程读回。
 * 不碰正式服务；数据带随机 stamp，结束（含失败）时清理。
 *   node dev/e2e-restart.mjs
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const TEST = { 'x-team-space-channel': 'test', accept: 'application/json' }
const STAMP = `restart-${Date.now().toString(36)}`
const created = []
let checks = 0
let failures = 0
let current = null

function ok(name, cond, detail = '') {
  checks += 1
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures += 1
}

function startHost() {
  return new Promise((resolve, reject) => {
    const child = spawn('dsh', ['web', '--port', '0', '--no-open'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`DSH 启动超时：${output.slice(-800)}`))
    }, 60_000)
    const onData = chunk => {
      output += chunk.toString()
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+)/)
      if (!match) return
      clearTimeout(timer)
      const port = Number(match[1])
      child.__port = port
      child.__url = match[0]
      resolve({ child, port, url: match[0], base: `http://127.0.0.1:${port}/api/team-space` })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`DSH 在给出地址前退出（code=${code}）：${output.slice(-800)}`))
    })
  })
}

async function stopHost(host) {
  if (!host?.child || host.child.exitCode !== null) return
  host.child.kill('SIGTERM')
  await Promise.race([
    once(host.child, 'exit'),
    new Promise(resolve => setTimeout(() => {
      try { host.child.kill('SIGKILL') } catch { /* 忽略 */ }
      resolve()
    }, 8000)),
  ])
}

async function call(base, path, { method = 'GET', body, channel = 'test' } = {}) {
  const response = await fetch(`${base}/${path}`, {
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

async function upsert(base, table, entry) {
  const result = await call(base, 'entry/upsert', { method: 'POST', body: { table, entry } })
  if (!result.ok) throw new Error(`${table}/${entry.name} → HTTP ${result.status} ${result.data?.error ?? result.text.slice(0, 120)}`)
  created.push({ table, id: result.data.entry.id })
  return result.data.entry
}

async function cleanup(host) {
  if (!host) return
  for (const item of created) {
    await call(host.base, 'entry/remove', { method: 'POST', body: item }).catch(() => null)
  }
  if (created.handoffId) {
    const gateway = await call(host.base, 'gateway-status').catch(() => null)
    await call(host.base, 'handoff/remove', {
      method: 'POST',
      body: { id: created.handoffId, deviceId: gateway?.data?.deviceId ?? '' },
    }).catch(() => null)
  }
}

async function main() {
  console.log(`\nJ02 重启持久化 · ${STAMP}\n`)
  let first = null
  let second = null
  try {
    first = await startHost()
    current = first
    const firstPid = first.child.pid
    const firstPort = first.port
    console.log(`   第一次启动：${first.url}`)
    const skill = await upsert(first.base, 'skills', {
      name: `${STAMP}-skill`,
      description: '重启后应仍在',
      content: '# J02\nrestart persistence',
    })
    const plugin = await upsert(first.base, 'plugins', {
      name: `${STAMP}-plugin`,
      version: '1.0.0',
      source: 'J02',
      audit: '重启后应仍在',
      installCommand: '',
    })
    const handoff = await call(first.base, 'handoff/create', {
      method: 'POST',
      body: { title: `${STAMP}-handoff`, brief: '重启后状态应仍为 doing', target: 'J02', owner: 'J02' },
    })
    if (!handoff.ok) throw new Error(`handoff/create → ${handoff.status} ${handoff.data?.error}`)
    created.handoffId = handoff.data.id
    const claim = await call(first.base, 'handoff/claim', {
      method: 'POST', body: { id: created.handoffId, by: 'J02' },
    })
    if (!claim.ok) throw new Error(`handoff/claim → ${claim.status} ${claim.data?.error}`)
    const localBefore = await call(first.base, 'local-state?plugins=dsh-team-space')
    const installedBefore = localBefore.data?.plugins?.['dsh-team-space']
    const beforeList = await call(first.base, 'list')
    const beforeCounts = beforeList.data?.tables && Object.fromEntries(Object.entries(beforeList.data.tables).map(([key, rows]) => [key, rows.length]))
    ok('J02 重启前已写入技能、插件、委托（doing）',
      Boolean(skill.id && plugin.id && created.handoffId),
      JSON.stringify({ skill: skill.id, plugin: plugin.id, handoff: created.handoffId }))

    await stopHost(first)
    ok('J02 第一个 DSH 进程已经退出', first.child.exitCode !== null || first.child.killed)
    first = null

    second = await startHost()
    current = second
    console.log(`   重启后：${second.url}`)
    ok('J02 重启后是新进程、新端口',
      second.child.pid !== firstPid && second.port > 0 && second.port !== firstPort,
      JSON.stringify({ firstPid, secondPid: second.child.pid, firstPort, secondPort: second.port }))

    const afterList = await call(second.base, 'list')
    const afterCounts = afterList.data?.tables && Object.fromEntries(Object.entries(afterList.data.tables).map(([key, rows]) => [key, rows.length]))
    ok('J02 重启后各表条数一致，没有丢数据',
      JSON.stringify(afterCounts) === JSON.stringify(beforeCounts),
      JSON.stringify({ beforeCounts, afterCounts }))
    const skillAfter = await call(second.base, `detail?table=skills&id=${encodeURIComponent(skill.id)}`)
    const pluginAfter = await call(second.base, `detail?table=plugins&id=${encodeURIComponent(plugin.id)}`)
    const handoffAfter = await call(second.base, `detail?table=handoffs&id=${encodeURIComponent(created.handoffId)}`)
    ok('J02 技能正文与描述完整保留',
      skillAfter.data?.entry?.content === skill.content && skillAfter.data?.entry?.description === skill.description)
    ok('J02 插件条目完整保留', pluginAfter.data?.entry?.version === '1.0.0')
    ok('J02 委托状态 doing 与认领人保留',
      handoffAfter.data?.entry?.status === 'doing' && handoffAfter.data?.entry?.assignee === 'J02',
      JSON.stringify({ status: handoffAfter.data?.entry?.status, assignee: handoffAfter.data?.entry?.assignee }))
    const localAfter = await call(second.base, 'local-state?plugins=dsh-team-space')
    const installedAfter = localAfter.data?.plugins?.['dsh-team-space']
    ok('J02 本机安装记录（版本 / link 状态）没有丢',
      installedAfter?.installedVersion === installedBefore?.installedVersion
        && installedAfter?.installedLink === installedBefore?.installedLink,
      JSON.stringify({ installedBefore, installedAfter }))
  } finally {
    if (current) await cleanup(current)
    if (first) await stopHost(first)
    if (second) await stopHost(second)
  }
  console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 条失败` : '，全部通过'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch(error => {
  console.error('\nJ02 中断：', error.stack || error.message, '\n')
  cleanup(current).finally(() => process.exit(1))
})
