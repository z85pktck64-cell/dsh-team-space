#!/usr/bin/env node
/**
 * 成员端 / 门店端冒烟：在成员机上跑，验证「连主服务器」这条链路。
 *
 *   node dev/e2e-member.mjs \
 *     --server http://<主服务器>:8080/api/team-space \
 *     --local  http://127.0.0.1:<本机端口>/api/team-space \
 *     --name Neo --device <客户端 deviceId>
 *
 * 所有写操作走 test 通道，跑完清理；不触发企微通知。
 */
const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=')
  return [key, rest.join('=')]
}))
const SERVER = String(args.server ?? '').replace(/\/$/, '')
const LOCAL = String(args.local ?? '').replace(/\/$/, '')
const NAME = String(args.name ?? 'member')
const DEVICE = String(args.device ?? '')
const TEST = { 'x-team-space-channel': 'test' }

if (!SERVER) {
  console.error('缺少 --server')
  process.exit(2)
}

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
    signal: AbortSignal.timeout(8000),
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
function versionGt(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return false
}

async function main() {
  const stamp = `mem-${Date.now().toString(36)}`
  console.log(`\n成员端冒烟 · ${NAME} → ${SERVER}\n`)

  // 1. 网络与主服务器
  const list = await call(SERVER, 'list')
  ok('成员能连上主服务器 /list', Boolean(list.tables))

  // 2. G08：列表不返回纯本机字段
  const firstRow = Object.values(list.tables ?? {}).flat()[0] ?? {}
  ok('G08 /list 不含 installedLink', !('installedLink' in firstRow), Object.keys(firstRow).join(','))

  // 3. 本机安装态（成员视角）
  if (LOCAL) {
    const local = await call(LOCAL, 'local-state?plugins=dsh-team-space')
    const info = local.plugins?.['dsh-team-space'] ?? {}
    ok('G07 本机识别为「已安装」', info.installed === true, JSON.stringify(info))
    ok('G07 成员端 installedLink=false（不是发布者）', info.installedLink === false, JSON.stringify(info))

    const manifest = (list.tables?.plugins ?? []).find(item => item.name === 'dsh-team-space')
    if (manifest?.version) {
      const installed = String(info.installedVersion ?? '')
      const latest = String(manifest.version)
      if (versionGt(latest, installed)) {
        ok('I03 成员端版本低于清单 → 应提示「更新」', true, `本机 ${installed} / 清单 ${latest}`)
      } else if (installed === latest) {
        ok('I03 升级后版本与清单一致 → 应显示「当前插件」', true, `${installed} = ${latest}`)
      } else {
        ok('I03 本机版本不应高于清单（版本号可能写错）', false, `本机 ${installed} / 清单 ${latest}`)
      }
    } else {
      console.log('  - 清单里没有 dsh-team-space 条目，跳过版本比较')
    }
  }

  // 4. 主服务器建委托给成员（test 通道，不发通知）
  const created = await call(SERVER, 'handoff/create', {
    title: `${stamp}-handoff`,
    brief: '成员端冒烟：认领并交回',
    target: NAME,
    owner: '主服务器',
  }, TEST)
  const handoffId = created.item?.id ?? created.id

  const memberView = await call(SERVER, `list?deviceId=${encodeURIComponent(DEVICE)}&name=${encodeURIComponent(NAME)}`, undefined, TEST)
  const strangerView = await call(SERVER, `list?deviceId=${encodeURIComponent(`${stamp}-stranger`)}&name=路人`, undefined, TEST)
  ok('B05 指定成员能看到给自己的委托',
    (memberView.tables?.handoffs ?? []).some(item => item.id === handoffId))
  ok('B05 路人看不到别人的委托',
    !(strangerView.tables?.handoffs ?? []).some(item => item.id === handoffId))

  // 5. 成员认领 + 交回（真实门店端工作流）
  await call(SERVER, 'handoff/claim', { id: handoffId, by: NAME, deviceId: DEVICE }, TEST)
  const claimed = await call(SERVER, `detail?table=handoffs&id=${encodeURIComponent(handoffId)}`, undefined, TEST)
  ok('B06 成员认领后状态 doing', claimed.entry?.status === 'doing', claimed.entry?.status)
  await call(SERVER, 'handoff/complete', { id: handoffId, result: '门店端跑完', by: NAME, deviceId: DEVICE }, TEST)
  const done = await call(SERVER, `detail?table=handoffs&id=${encodeURIComponent(handoffId)}`, undefined, TEST)
  ok('B07 成员交回后状态 done 且 result 落库',
    done.entry?.status === 'done' && done.entry?.result === '门店端跑完',
    JSON.stringify({ status: done.entry?.status, result: done.entry?.result }))

  // 6. 成员写入 + 通道隔离
  const todo = await call(SERVER, 'entry/upsert', {
    table: 'todos',
    entry: { name: `${stamp}-todo`, description: '门店端写入' },
  }, TEST)
  const testList = await call(SERVER, 'list', undefined, TEST)
  ok('成员能写入共享数据（test 通道）',
    (testList.tables?.todos ?? []).some(item => item.id === todo.entry.id))
  const prodList = await call(SERVER, 'list')
  ok('F02 成员写的测试数据不污染真实列表',
    !(prodList.tables?.todos ?? []).some(item => item.id === todo.entry.id))

  // 7. MCP（成员零安装接入）
  const mcpTools = await req(SERVER, 'mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  })
  ok('成员端 MCP 暴露 9 个工具',
    (mcpTools.data?.result?.tools ?? []).length === 9,
    String((mcpTools.data?.result?.tools ?? []).length))
  const mcpSkills = await req(SERVER, 'mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'team_space_list_skills', arguments: {} } },
    headers: TEST,
  })
  ok('成员端 MCP 能读技能列表', !mcpSkills.data?.result?.isError)

  // 8. 门户与下载
  const portal = await req(SERVER, 'portal')
  ok('成员能打开团队空间门户', portal.status === 200 && /<html/i.test(portal.text))
  const guide = await req(SERVER, 'guide')
  ok('成员能打开新手引导', guide.status === 200 && /<html/i.test(guide.text))
  const manifestVersion = (list.tables?.plugins ?? []).find(item => item.name === 'dsh-team-space')?.version
  if (manifestVersion) {
    const download = await req(SERVER, `download?file=${encodeURIComponent(`dsh-team-space-${manifestVersion}.tgz`)}`)
    ok('I02 成员能下载清单里的安装包', download.status === 200, `HTTP ${download.status}`)
  }

  // 9. 清理
  await call(SERVER, 'entry/remove', { table: 'todos', id: todo.entry.id }, TEST)
  const gw = await call(SERVER, 'gateway-status')
  await call(SERVER, 'handoff/remove', { id: handoffId, deviceId: gw.deviceId }, TEST)
  const residual = await call(SERVER, 'list', undefined, TEST)
  const leftoverTodos = (residual.tables?.todos ?? []).filter(item => String(item.name ?? '').startsWith(stamp))
  const leftoverHandoffs = (residual.tables?.handoffs ?? []).filter(item => String(item.title ?? '').startsWith(stamp))
  ok('成员端测试无残留', leftoverTodos.length === 0 && leftoverHandoffs.length === 0,
    `todos=${leftoverTodos.length} handoffs=${leftoverHandoffs.length}`)

  console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 条失败` : '，全部通过'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch(error => {
  console.error('\n成员端冒烟中断：', error.message, '\n')
  process.exit(1)
})
