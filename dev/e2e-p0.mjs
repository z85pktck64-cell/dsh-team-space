#!/usr/bin/env node
/**
 * P0 冒烟：补 selftest 没覆盖的路由（detail / download / member / portal / guide /
 * export-codex-skill / handoff/consume / MCP 跨通道）。
 *
 *   node dev/e2e-p0.mjs [port]
 *
 * 全部走 test 通道，跑完清理；只读接口（portal / guide）走真实通道。
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SUFFIX = '/api/team-space'
const TEST = { 'x-team-space-channel': 'test' }
let checks = 0
let failures = 0

function ok(name, cond, detail = '') {
  checks += 1
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function discoverPort() {
  const out = execSync('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true').toString()
  return [...new Set([...out.matchAll(/127\.0\.0\.1:(\d+)\s/g)].map(m => Number(m[1])))]
}

async function findBase(explicit) {
  for (const port of explicit ? [Number(explicit)] : discoverPort()) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${SUFFIX}/list`, { signal: AbortSignal.timeout(1500) })
      const data = await response.json().catch(() => null)
      if (response.ok && data?.tables) return { port, base: `http://127.0.0.1:${port}${SUFFIX}` }
    } catch { /* next */ }
  }
  throw new Error('没找到在跑的 team-space API（DSH 没启动？）')
}

async function req(base, path, { method = 'GET', body, headers } = {}) {
  const merged = {
    accept: 'application/json',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(headers ?? {}),
  }
  const response = await fetch(`${base}/${path}`, {
    method,
    headers: merged,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return { status: response.status, data, text }
}

async function call(base, path, body, headers) {
  const { status, data, text } = await req(base, path, { method: body === undefined ? 'GET' : 'POST', body, headers })
  if (status < 200 || status >= 300 || data?.ok === false) {
    throw new Error(`${path} → ${status} ${data?.error ?? text.slice(0, 80)}`)
  }
  return data
}

const mcp = async (base, body, headers) => {
  const { data } = await req(base, 'mcp', { method: 'POST', body, headers })
  return data
}
const mcpCall = async (base, name, args, headers) => {
  const reply = await mcp(base, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers)
  const text = reply?.result?.content?.[0]?.text ?? '{}'
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = { raw: text } }
  return { payload, isError: Boolean(reply?.result?.isError) }
}

async function main() {
  const { base } = await findBase(process.argv[2])
  const stamp = `p0-${Date.now().toString(36)}`
  const skillName = `${stamp}-skill`
  const memberName = `${stamp}-member`
  const memberRecordName = `member-${memberName}`
  const exportName = `${stamp}-export`
  let handoffId = ''

  console.log(`\nP0 冒烟 · ${base}\n`)

  // C05：列表不带正文，detail 才带
  const upserted = await call(base, 'entry/upsert', {
    table: 'skills',
    entry: { name: skillName, description: 'p0 冒烟', content: 'P0 BODY 正文' },
  }, TEST)
  const testList = await call(base, 'list', undefined, TEST)
  const listed = (testList.tables?.skills ?? []).find(item => item.name === skillName)
  ok('C05 /list 里没有技能正文', Boolean(listed) && !('content' in listed))
  const detail = await call(base, `detail?table=skills&id=${encodeURIComponent(upserted.entry.id)}`, undefined, TEST)
  ok('C05 /detail 返回技能正文', detail.entry?.content === 'P0 BODY 正文', JSON.stringify(detail).slice(0, 160))

  // F02：真实通道看不到测试记录
  const prodList = await call(base, 'list')
  ok('F02 真实列表看不到测试技能', !(prodList.tables?.skills ?? []).some(item => item.name === skillName))
  const prodDetail = await req(base, `detail?table=skills&id=${encodeURIComponent(upserted.entry.id)}`)
  ok('F05 真实通道连详情也取不到测试记录', prodDetail.data?.ok === false)

  // D11：下载路径穿越
  for (const file of ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '/etc/passwd', 'a/b.tgz']) {
    const result = await req(base, `download?file=${file}`)
    ok(`D11 拒绝非法文件名 ${file}`, result.status === 400, `HTTP ${result.status}`)
  }

  // E05：成员卡
  await call(base, 'member/save', { name: memberName, bio: '## 能接什么活\n- p0 冒烟' }, TEST)
  const members = await call(base, 'member/list', undefined, TEST)
  ok('E05 成员卡保存后可见',
    (members.members ?? []).some(item => item.name === memberName),
    JSON.stringify(members).slice(0, 160))

  const mcpMembers = await mcpCall(base, 'team_space_list_members', {}, TEST)
  ok('E07 MCP list_members 的 memberCards 与 /member/list 成员集合一致',
    (mcpMembers.payload.memberCards ?? []).some(item => item.name === memberName),
    JSON.stringify(mcpMembers.payload).slice(0, 160))

  // E08：局域网地址
  const lan = await call(base, `lan-link?base=${encodeURIComponent('http://127.0.0.1:8080')}`, undefined, TEST)
  ok('E08 /lan-link 返回可访问地址', /^https?:\/\//.test(String(lan.url ?? '')), JSON.stringify(lan))

  // B16：投递标记
  const handoff = await call(base, 'handoff/create', { title: `${stamp}-consume`, brief: 'p0', owner: 'p0' }, TEST)
  handoffId = handoff.item?.id ?? handoff.id
  await call(base, 'handoff/consume', { id: handoffId }, TEST)
  const consumed = await call(base, `detail?table=handoffs&id=${encodeURIComponent(handoffId)}`, undefined, TEST)
  ok('B16 consume 写 deliveredAt 且不改状态',
    Boolean(consumed.entry?.deliveredAt) && consumed.entry?.status === 'open',
    JSON.stringify({ deliveredAt: consumed.entry?.deliveredAt, status: consumed.entry?.status }))

  // D10：导出 Codex skill
  const exported = await call(base, 'export-codex-skill', {
    name: exportName,
    description: 'p0 导出',
    content: 'P0 EXPORT 正文',
  }, TEST)
  const exportFile = exported.path ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills', exportName, 'SKILL.md')
  ok('D10 导出文件真的落盘且带正文',
    existsSync(exportFile) && readFileSync(exportFile, 'utf8').includes('P0 EXPORT 正文'),
    exportFile)

  // 只读页面
  const guide = await req(base, 'guide')
  ok('门户新手引导返回 HTML', guide.status === 200 && /<html/i.test(guide.text), `HTTP ${guide.status}`)
  const portal = await req(base, 'portal')
  ok('G05 门户页可打开', portal.status === 200 && /<html/i.test(portal.text), `HTTP ${portal.status}`)
  ok('门户页内置 test 通道横幅逻辑', /test-banner/.test(portal.text))
  ok('门户页是只读的（没有 entry/upsert 写入口）', !/entry\/upsert/.test(portal.text))

  // G / J06：MCP 跨端与通道
  const toolsList = await mcp(base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  const toolNames = (toolsList?.result?.tools ?? []).map(item => item.name)
  ok('G11 MCP 暴露 9 个工具', toolNames.length === 9, toolNames.join(','))

  const prodMcp = await mcpCall(base, 'team_space_list_skills', {})
  ok('J06 真实通道 MCP 看不到测试技能',
    !(prodMcp.payload.skills ?? []).some(item => item.name === skillName),
    JSON.stringify(prodMcp.payload).slice(0, 160))
  const testMcp = await mcpCall(base, 'team_space_list_skills', {}, TEST)
  ok('J06 测试通道 MCP 能看到测试技能',
    (testMcp.payload.skills ?? []).some(item => item.name === skillName))
  const got = await mcpCall(base, 'team_space_get_skill', { name: skillName }, TEST)
  ok('G03 MCP get_skill 返回正文', got.payload.content === 'P0 BODY 正文', JSON.stringify(got.payload).slice(0, 160))
  const gotProd = await mcpCall(base, 'team_space_get_skill', { name: skillName })
  ok('J06 真实通道 MCP 取不到测试技能', gotProd.isError === true)

  // 清理
  const after = await call(base, 'list', undefined, TEST)
  for (const item of after.tables?.skills ?? []) {
    if (item.name?.startsWith(stamp) || item.name === memberRecordName) {
      await call(base, 'entry/remove', { table: 'skills', id: item.id }, TEST)
    }
  }
  if (handoffId) {
    const gw = await call(base, 'gateway-status')
    await call(base, 'handoff/remove', { id: handoffId, deviceId: gw.deviceId }, TEST)
  }
  try { rmSync(dirname(exportFile), { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }

  const residual = await call(base, 'list', undefined, TEST)
  const leftoverSkills = (residual.tables?.skills ?? [])
    .filter(item => item.name?.startsWith(stamp) || item.name === memberRecordName)
  const leftoverHandoffs = (residual.tables?.handoffs ?? []).filter(item => String(item.title ?? '').startsWith(stamp))
  ok('测试通道无残留', leftoverSkills.length === 0 && leftoverHandoffs.length === 0,
    `skills=${leftoverSkills.length} handoffs=${leftoverHandoffs.length}`)

  // 一键更新的前置：本机必须能报出真实安装路径，否则客户端会按短名装成第二份
  const localSelf = await call(base, 'local-state?plugins=dsh-team-space')
  const selfPath = localSelf?.plugins?.['dsh-team-space']?.installedPath
  ok('/local-state 返回本机安装路径（一键更新靠它定位）',
    /^[@a-zA-Z0-9][\w@/.\-]*$/.test(String(selfPath ?? '')), String(selfPath || '(空)'))
  const listedPlugin = (await call(base, 'list')).tables?.plugins?.find(item => item.name === 'dsh-team-space')
  ok('/list 的插件条目带 downloadUrl（一键更新直接用它）',
    /^https?:\/\//.test(String(listedPlugin?.downloadUrl ?? '')), String(listedPlugin?.downloadUrl || '(空)'))

  // CORS 预检：浏览器跨源时会先发 OPTIONS，服务端必须放行客户端真正带的 header。
  // curl / Node fetch 不做预检 —— 这正是「本机全绿、成员那边显示连不上」的根因，必须单独验。
  const preflight = await fetch(`${base}/list`, {
    method: 'OPTIONS',
    headers: {
      origin: 'dsh-app://app',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-team-space-version, x-team-space-channel',
    },
  })
  const allowedHeaders = String(preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase()
  ok('CORS 预检放行 x-team-space-version（跨源成员必需）',
    allowedHeaders.includes('x-team-space-version'), allowedHeaders)
  ok('CORS 预检放行 x-team-space-channel',
    allowedHeaders.includes('x-team-space-channel'), allowedHeaders)

  console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 条失败` : '，全部通过'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch(error => {
  console.error('\nP0 冒烟中断：', error.message, '\n')
  process.exit(1)
})
