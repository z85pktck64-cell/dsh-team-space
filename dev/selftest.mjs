#!/usr/bin/env node
/**
 * 端到端自检：直接打 HTTP API，覆盖读写与状态流转，最后清理测试数据。
 *   node dev/selftest.mjs [port]
 * 端口不传则从本机监听端口里自动探测（找能回 200 的 team-space API）。
 */
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const BASE_SUFFIX = '/api/team-space'
let failures = 0
let checks = 0

function ok(name, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 宿主 deviceId：删除委托只允许主服务器，所有 handoff/remove 都要带上它。 */
let HOST_DEVICE = ''

async function call(base, path, body) {
  // 统一补设备身份，避免每个删除点都要记得传（漏一处就会被 403 打断整个自检）。
  if (path === 'handoff/remove' && body && !body.deviceId) body = { ...body, deviceId: HOST_DEVICE }
  const options = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined
  const response = await fetch(`${base}/${path}`, options)
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok === false) {
    const error = new Error(`${path} → ${response.status} ${data?.error ?? ''}`)
    error.code = data?.code ?? ''
    throw error
  }
  return data
}

/** 期望失败：返回 { code, status }，用于验证非法操作被拦住。 */
async function callFail(base, path, body) {
  const response = await fetch(`${base}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = await response.json().catch(() => null)
  return { status: response.status, code: data?.code ?? '', error: data?.error ?? '' }
}

function discoverPort() {
  const out = execSync("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true").toString()
  const ports = [...new Set([...out.matchAll(/127\.0\.0\.1:(\d+)\s/g)].map(m => Number(m[1])))]
  return ports
}

async function findBase(explicit) {
  const candidates = explicit ? [Number(explicit)] : discoverPort()
  for (const port of candidates) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${BASE_SUFFIX}/list`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return { port, base: `http://127.0.0.1:${port}${BASE_SUFFIX}` }
    } catch {
      /* 下一个 */
    }
  }
  throw new Error('没找到在跑的 team-space API（DSH 没启动？）')
}

/**
 * 扫尾：把自检自己的痕迹清干净。
 * 残留的 selftest-* 条目会混进「分享会话」列表——点到它就是一个打不开的假 sessionId。
 */
/**
 * 「非服务器端」与「三端一致性」的回归检查。
 *
 * 这些 bug 有个共同点：在发布者本机看起来完全正常，只有成员端才暴露。
 * 典型例子：isSelf 按插件名判断，发布者是 link 安装所以显示「当前插件」看着对，
 * 但所有成员也都会被判成「当前插件」，永远点不了更新。
 *
 * 这里不做端到端模拟（那需要第二台机器），只做「能让这类错误变红」的静态 + 字段检查。
 */
async function runCrossEnd(base) {
  // 不能用 .pathname：中文目录名会被百分号编码，readFileSync 直接 ENOENT
  const root = fileURLToPath(new URL('..', import.meta.url))
  const clientSrc = readFileSync(root + 'lib/client.js', 'utf8')
  const indexSrc = readFileSync(root + 'lib/index.js', 'utf8')
  const portalSrc = readFileSync(root + 'lib/portal.html', 'utf8')
  const mcpSrc = readFileSync(root + 'lib/mcp-tools.js', 'utf8')

  // 1) isSelf 不能再按插件名判断：那对所有成员都成立，等于成员永远不能更新
  ok('isSelf 不按插件名判断（成员端才暴露的坑）',
    !/const isSelf = \/\(\^\|\\\/dsh-team-space\$/.test(clientSrc)
    && /const isSelf = !!item\.installedLink/.test(clientSrc))

  // 2) 服务端必须给出 installedLink，客户端才有判据
  ok('服务端返回 installedLink 字段',
    /installedLink/.test(indexSrc) && /isSymbolicLink/.test(indexSrc))

  // 3) 安装状态的正确来源是 /local-state（请求方本机），不是 /list（响应方机器）
  const listed = await call(base, 'list').catch(() => null)
  const selfPlugin = (listed?.tables?.plugins ?? []).find(x => x.name === 'dsh-team-space')
  ok('/list 不返回 installedLink（它是纯本机概念，混进来会误导成员）',
    selfPlugin && selfPlugin.installedLink === undefined,
    selfPlugin ? `实际带出了 ${selfPlugin.installedLink}` : '没找到这条')
  const localState = await call(base, 'local-state?plugins=dsh-team-space').catch(() => null)
  const localSelf = localState?.plugins?.['dsh-team-space']
  ok('/local-state 返回 installedLink 布尔值（成员端判据）',
    localSelf && typeof localSelf.installedLink === 'boolean',
    localSelf ? `实际是 ${typeof localSelf.installedLink}` : '拿不到本机状态')

  // 4) MCP 的 TOOLS 与 HANDLERS 必须一一对应，否则 tools/list 报了却调不通
  const toolNames = [...mcpSrc.matchAll(/name: '(team_space_[a-z_]+)'/g)].map(m => m[1])
  const handlerNames = [...mcpSrc.matchAll(/async (team_space_[a-z_]+)\(/g)].map(m => m[1])
  const missing = toolNames.filter(n => !handlerNames.includes(n))
  ok(`MCP 工具与处理器一一对应（${toolNames.length} 个工具）`,
    toolNames.length > 0 && missing.length === 0,
    missing.length ? `缺处理器：${missing.join(', ')}` : '')
  // stdio 那半必须只做传输：工具定义留在 mcp-tools.js，抄回一份就会两处走样
  const stdioSrc = readFileSync(root + 'dev/mcp-server.mjs', 'utf8')
  ok('stdio 传输层没有重复定义工具',
    !/name: 'team_space_/.test(stdioSrc),
    'dev/mcp-server.mjs 里又出现了工具定义')

  // 5) 门户页调的接口，服务端必须有对应路由
  const portalPaths = [...portalSrc.matchAll(/API \+ '(\/[a-z-]+)/g)].map(m => m[1])
  const badPaths = [...new Set(portalPaths)].filter(p => !indexSrc.includes(`ROUTE}${p}`))
  ok(`门户页引用的接口都有对应路由（${[...new Set(portalPaths)].length} 个）`,
    badPaths.length === 0,
    badPaths.length ? `无对应路由：${badPaths.join(', ')}` : '')

  // 6) 排序规则两端必须一致：服务端不排序，客户端与门户页都用 updatedAt ?? createdAt
  ok('门户页与客户端用同一条排序规则',
    /updatedAt != null \? row\.updatedAt : row\.createdAt/.test(portalSrc)
    && /item\?\.updatedAt \?\? item\?\.createdAt/.test(clientSrc))

  // 7) installCommand 里不能带引号：客户端正则 /\S+\.tgz/ 会把引号一起吃进去
  const cmd = selfPlugin?.installCommand ?? ''
  ok('installCommand 的 tgz 地址没被引号包住',
    !/https?:\/\/\S+\.tgz["']/.test(cmd),
    cmd ? `实际：${cmd.slice(0, 70)}` : '没有 installCommand')

  // 8) installCopy 是 async，所有调用点必须 await：
  //    不等待的话 finally 会先删掉临时目录，cp 报 "No such file or directory"（包越大越容易踩）
  const copyCalls = [...indexSrc.matchAll(/(\n\s*)(await\s+)?installCopy\(/g)]
  const unawaited = copyCalls.filter(m => !m[2])
  ok(`installCopy 的调用都带 await（${copyCalls.length} 处）`,
    copyCalls.length > 0 && unawaited.length === 0,
    unawaited.length ? `缺 await：${unawaited.length} 处` : '')

  // 9) HTTP MCP：同事零安装的关键路径，必须能握手、能列工具、能真调用
  const rpc = async body => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response.json()
  }
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }).catch(() => null)
  ok('HTTP MCP 能握手（POST /mcp）',
    init?.result?.protocolVersion && init?.result?.serverInfo?.name === 'team-space',
    init?.error ? String(init.error.message) : '没有返回 protocolVersion')

  const listRpc = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }).catch(() => null)
  const httpTools = (listRpc?.result?.tools ?? []).map(t => t.name)
  ok(`HTTP MCP 列出 ${httpTools.length} 个工具`, httpTools.length === 9,
    `实际 ${httpTools.length} 个`)

  const callRpc = await rpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'team_space_list_skills', arguments: {} },
  }).catch(() => null)
  let skillOk = false
  try {
    const payload = JSON.parse(callRpc?.result?.content?.[0]?.text ?? '{}')
    skillOk = typeof payload.count === 'number' && payload.count > 0
  } catch { skillOk = false }
  ok('HTTP MCP 能真调用（list_skills 返回条目数）', skillOk,
    callRpc?.result?.isError ? String(callRpc.result.content?.[0]?.text).slice(0, 60) : '返回格式异常')

  // 10) 并发安装护栏：两次「更新」不能共用同一个临时目录
  ok('install-plugin 有并发锁（INSTALL_LOCKS）',
    /const INSTALL_LOCKS = new Set\(\)/.test(indexSrc)
    && /INSTALL_LOCKS\.has\(name\)/.test(indexSrc)
    && /INSTALL_LOCKS\.delete\(name\)/.test(indexSrc))
  ok('临时目录名带随机后缀（不用裸 Date.now）',
    /const stamp = `\$\{Date\.now\(\)\}-\$\{randomUUID\(\)/.test(indexSrc))
  ok('cp 前会检查源目录是否还在',
    /安装临时目录已被清理/.test(indexSrc))

  // 11) 「不能更新自己」的保护必须按 link 判断，不能按插件名：
  //     按名字会拦住所有成员（他们装的也是这个名字），点确认启用永远 403
  const enableBlock = indexSrc.slice(indexSrc.indexOf('/plugin/enable'))
  ok('plugin/enable 不按插件名拦 dsh-team-space',
    !/if \(\/\^\(\@\[\^\/\]\+\\\/\?\)\?dsh-team-space\$\/\|不能安装\/更新正在运行的团队空间自己/.test(enableBlock.slice(0, 800)),
    'enable 里还在按名字拦截')
  ok('link 安装的保护挪到了替换目录前',
    /本机是 link 安装（发布者机器）/.test(indexSrc))

  // 12) 启用必须同时写 bundles，否则重启不加载（装到 @local 但 bundles 指旧路径）
  ok('enable 会登记 profile 的 bundles',
    /function registerProfileBundle/.test(indexSrc)
    && /registerProfileBundle\(dirname\(base\)/.test(indexSrc))
  ok('install-plugin 与 enable 用同一套安装位置判断',
    (indexSrc.match(/const localSlot = join\(base, '@local', short\)/g) ?? []).length >= 2,
    '两处 dest 计算不一致，装到 A 却在 B 找')

  // 13) loader 行的 name 必须写相对路径（@local/x 或 x），不能只写短名：
  //     装到 @local 却写短名，加载器按 name 找不到包就静默跳过（Neo 的插件消失就是这个）
  ok('loader 行用相对路径而非短名',
    /const name = entry \|\| shortName/.test(indexSrc)
    && /enablePluginRow\(dirname\(base\), dest, short, bundleEntry\)/.test(indexSrc))

  // 14) toast 只能有一份定义，且动画每帧都要带 -50%：
  //     两份并存时后定义的 animation 会覆盖 translateX(-50%)，toast 左边缘贴中线，位置随文本长度变
  const toastDefs = (clientSrc.match(/^\.ts-toast\{/gm) ?? []).length   // 只认行首无缩进的顶层定义
  ok('toast 只有一份 CSS 定义', toastDefs === 1, `实际 ${toastDefs} 份`)
  ok('toast 动画每帧都带 -50%（否则居中会丢）',
    /@keyframes ts-toast-in\{from\{opacity:0;transform:translate\(-50%/.test(clientSrc)
    && /to\{opacity:1;transform:translate\(-50%/.test(clientSrc))

  // 15) loader 行的 name 必须加引号：@ * & 等在 YAML 是保留字符，
  //     `name: @local/x` 会让整个 profile 解析失败 → DSH 启动闪退（Neo 踩过）
  ok('loader 行 name 加了引号（YAML 保留字符）',
    /name: \$\{JSON\.stringify\(name\)\}/.test(indexSrc),
    'name 还是裸写，@ 开头的值会让 YAML 解析失败')

  // 16) 链接类型（repos.type）三端一致：git 给克隆指令，其余直接打开
  ok('repos 有 type 枚举校验', /REPO_TYPES = new Set\(\['git', 'doc', 'wiki', 'board', 'other'\]\)/.test(indexSrc))
  ok('DSH 客户端按 type 分流', /LINK_TYPES\[repoType\]/.test(clientSrc) && /isGit\s*\n?\s*\?\s*h\('button'/.test(clientSrc))
  ok('门户页按 type 分流', /var linkType = row\.type \|\| 'git'/.test(portalSrc))
  ok('MCP share_repo 接受 type', /One of git \| doc \| wiki \| board \| other/.test(indexSrc))
  // 三端都要有「链接」这个入口，不能有一端还叫「仓库」
  ok('门户页 tab 已改名「链接」', /label: '链接'/.test(portalSrc))
  ok('DSH 客户端 tab 已改名「链接」', /label: '链接'/.test(clientSrc))

  // 17) 链接按类型分组：文档最前（LINK_ORDER），两端都要有分组标题
  ok('客户端有链接分组顺序', /LINK_ORDER = \{ doc: 0, wiki: 1, board: 2, other: 3, git: 4 \}/.test(clientSrc))
  ok('门户页有链接分组顺序', /LINK_ORDER = \{ doc: 0, wiki: 1, board: 2, other: 3, git: 4 \}/.test(portalSrc))

  // 18) remove 必须支持按 table 删：原来写死只删 tasks，其他表点删除无效
  ok('/remove 支持 table 参数', /const table = clip\(body\.table, 40\) \|\| 'tasks'/.test(indexSrc))
  // 子分类横向：两端都用 chips 条
  ok('客户端横向子分类', /ts-subbar/.test(clientSrc) && /ts-subchip/.test(clientSrc))
  ok('门户页横向子分类', /subbar/.test(portalSrc) && /subchip/.test(portalSrc))

  // 19) 「+」只在 DSH 客户端和 MCP：门户页必须保持只读
  ok('门户页是只读的（没有 + 入口）',
    !/subchip-add/.test(portalSrc) && !/openLinkForm/.test(portalSrc)
    && /只读/.test(portalSrc))
  ok('客户端「+」在子分类条末尾', /ts-subchip-add/.test(clientSrc) && /setEditing\(\{\}\)/.test(clientSrc))
  ok('MCP share_repo 支持写链接', /team_space_share_repo/.test(indexSrc))

  // 20) README 必须保留「三个消费方」章节，否则以后改功能会漏掉 Codex / 门户页
  let readme = ''
  try { readme = readFileSync(root + 'README.md', 'utf8') } catch { /* 没有就报红 */ }
  ok('README 保留三端同步约定', readme.includes('三个消费方'))
}

async function sweep(base) {
  const list = await call(base, 'list')
  // 删除委托只允许主服务器，扫尾必须带上宿主 deviceId，否则会被 403 挡住（真实回归过一次）。
  const hostDevice = String((await call(base, 'gateway-status').catch(() => null))?.deviceId ?? '')
  let removed = 0
  for (const [table, rows] of Object.entries(list.tables ?? {})) {
    for (const row of rows ?? []) {
      const hay = [row.title, row.name, row.note, row.brief, row.text, row.sessionId, row.owner]
        .filter(Boolean).join(' ')
      if (!/selftest|自检/i.test(hay)) continue
      try {
        if (table === 'handoffs') await call(base, 'handoff/remove', { id: row.id, deviceId: hostDevice, name: 'xinzhan' })
        else if (table === 'tasks') await call(base, 'remove', { id: row.id })
        else await call(base, 'entry/remove', { table, id: row.id })
        removed += 1
      } catch {
        /* 已经没了 */
      }
    }
  }
  return removed
}

async function run(base) {
  console.log('基础读接口')
  const list = await call(base, 'list')
  ok('list 返回 tables', Boolean(list.tables), JSON.stringify(Object.keys(list.tables ?? {})))
  ok('counts 存在', Boolean(list.counts))
  ok('self-config 可读', typeof (await call(base, 'self-config')).serverUrl === 'string')
  const gw = await call(base, 'gateway-status')
  ok('gateway-status 有 enabled/host', typeof gw.enabled === 'boolean' && typeof gw.host === 'string')
  const members = await call(base, 'member/list')
  ok('member/list 返回数组', Array.isArray(members.members))
  const suggest = await call(base, 'profile/suggest')
  ok('profile/suggest 有 bio', typeof suggest.bio === 'string' && suggest.bio.length > 0)

  console.log('条目读写（todos）')
  const created = await call(base, 'entry/upsert', {
    table: 'todos',
    entry: { title: `自检条目 ${Date.now()}`, owner: 'selftest', status: 'open', note: 'by selftest' },
  })
  ok('entry/upsert 创建成功', Boolean(created.entry?.id))
  const todoId = created.entry.id
  const detail = await call(base, `detail?table=todos&id=${todoId}`)
  ok('detail 能取回', detail.entry?.id === todoId)
  const afterCreate = await call(base, 'list')
  ok('counts 增加', (afterCreate.counts?.todos ?? 0) > (list.counts?.todos ?? 0))
  await call(base, 'entry/remove', { table: 'todos', id: todoId })
  const afterRemove = await call(base, 'list')
  ok('entry/remove 生效', !(afterRemove.tables.todos ?? []).some(item => item.id === todoId))

  console.log('F-Assign 状态流转')
  const handoff = await call(base, 'handoff/create', {
    title: '自检委托', brief: 'selftest 流程验证', target: '', owner: 'selftest', deviceId: 'selftest-device',
  })
  ok('handoff/create 成功', Boolean(handoff.id))
  await call(base, 'handoff/claim', { id: handoff.id, by: 'selftest' })
  const claimed = await call(base, `detail?table=handoffs&id=${handoff.id}`)
  ok('claim 后状态为 doing', claimed.entry?.status === 'doing')
  await call(base, 'handoff/complete', { id: handoff.id, result: 'selftest 完成' })
  const done = await call(base, `detail?table=handoffs&id=${handoff.id}`)
  ok('complete 后状态为 done', done.entry?.status === 'done')
  ok('结果已写入', done.entry?.result === 'selftest 完成')
  await call(base, 'handoff/remove', { id: handoff.id })
  ok('测试委托已清理', true)

  console.log('F-Assign 状态机护栏')
  const guard = await call(base, 'handoff/create', {
    title: '自检护栏', brief: 'selftest 护栏验证', target: '张三', owner: 'selftest', deviceId: 'selftest-device',
  })
  const noBy = await callFail(base, 'handoff/claim', { id: guard.id })
  ok('claim 不带接收人被拒', noBy.code === 'BAD_REQUEST', noBy.error)
  const wrongPerson = await callFail(base, 'handoff/claim', { id: guard.id, by: '李四' })
  ok('非指定人接收被拒', wrongPerson.code === 'FORBIDDEN', wrongPerson.error)
  await call(base, 'handoff/claim', { id: guard.id, by: '张三' })
  await call(base, 'handoff/complete', { id: guard.id, result: 'selftest 完成' })
  const reComplete = await callFail(base, 'handoff/complete', { id: guard.id, result: '再来一次' })
  ok('已完成不能再交回', reComplete.code === 'STATE_CONFLICT', reComplete.error)
  const reClaim = await callFail(base, 'handoff/claim', { id: guard.id, by: '张三' })
  ok('已完成不能再被接收', reClaim.code === 'STATE_CONFLICT', reClaim.error)
  // open → done 直跳必须被拒：这条路径会把「转人工 / 失败」伪造成执行结果
  const straight = await call(base, 'handoff/create', {
    title: '自检直跳', brief: 'selftest', owner: 'selftest', deviceId: 'selftest-device',
  })
  const jump = await callFail(base, 'handoff/complete', { id: straight.id, result: '没认领就交回' })
  ok('open → done 直跳被拒', jump.code === 'STATE_CONFLICT', jump.error)
  // 通用 upsert 不能碰 handoffs：否则状态机整条失效
  const viaEntry = await callFail(base, 'entry/upsert', {
    table: 'handoffs', entry: { id: straight.id, status: 'done' },
  })
  ok('handoffs 不走通用 upsert', viaEntry.code === 'BAD_REQUEST', viaEntry.error)
  const cancelled = await call(base, 'handoff/cancel', { id: straight.id, by: 'selftest', reason: '自检关单' })
  ok('发起人可关单', cancelled.ok === true)
  await call(base, 'handoff/remove', { id: straight.id })
  const agentMade = await call(base, 'handoff/create', { title: '自检 agent 委托', brief: 'selftest' })
  const agentDetail = await call(base, `detail?table=handoffs&id=${agentMade.id}`)
  ok('未给 deviceId 时回落到 host-* 设备号',
    String(agentDetail.entry?.requesterDeviceId ?? '').startsWith('host-'),
    String(agentDetail.entry?.requesterDeviceId))
  await call(base, 'handoff/remove', { id: agentMade.id })
  await call(base, 'handoff/remove', { id: guard.id })

  console.log('跨作者同名覆盖护栏')
  const first = await call(base, 'entry/upsert', {
    table: 'skills',
    entry: { name: `selftest-skill-${Date.now()}`, description: '甲发布', content: 'A', author: { name: '甲' } },
  })
  const skillName = first.entry.name
  const hijack = await callFail(base, 'entry/upsert', {
    table: 'skills',
    entry: { name: skillName, description: '乙覆盖', content: 'B', author: { name: '乙' } },
  })
  ok('换作者不带 baseVersion 被拒', hijack.code === 'VERSION_CONFLICT', hijack.error)
  const sameAuthor = await call(base, 'entry/upsert', {
    table: 'skills',
    entry: { name: skillName, description: '甲更新', content: 'A2', author: { name: '甲' } },
  })
  ok('同一作者可正常更新', sameAuthor.entry?.description === '甲更新')
  // agent 工具一律不带 author：这台机器会被绑成「本机身份」，仍然不能吃掉甲的条目
  const noAuthor = await callFail(base, 'entry/upsert', {
    table: 'skills',
    entry: { name: skillName, description: '无作者覆盖', content: 'C' },
  })
  ok('不带 author 也拒（绑本机身份后仍非原作者）', noAuthor.code === 'VERSION_CONFLICT', noAuthor.error)
  // 只带 baseVersion 还不够：换作者 = 接管，必须显式 takeOver
  const withVersion = await callFail(base, 'entry/upsert', {
    table: 'skills',
    entry: {
      name: skillName, description: '乙接管', content: 'D',
      author: { name: '乙' }, baseVersion: sameAuthor.entry.contentHash,
    },
  })
  ok('带 baseVersion 但没 takeOver 仍被拒', withVersion.code === 'VERSION_CONFLICT', withVersion.error)
  const taken = await call(base, 'entry/upsert', {
    table: 'skills',
    entry: {
      name: skillName, description: '乙接管', content: 'D',
      author: { name: '乙' }, baseVersion: sameAuthor.entry.contentHash, takeOver: true,
    },
  })
  ok('显式 takeOver 可以接管', taken.entry?.author?.name === '乙' && taken.entry?.description === '乙接管')
  await call(base, 'entry/remove', { table: 'skills', id: first.entry.id })

  console.log('安装链路护栏')
  const badName = await callFail(base, 'install-plugin', { name: '../../evil', url: '', spec: '' })
  ok('插件名含 ../ 被拒', badName.code === 'BAD_REQUEST', badName.error)
  const badSpec = await callFail(base, 'install-plugin', { name: 'x', url: '', spec: '--registry=http://evil' })
  ok('npm spec 带 flag 被拒', badSpec.code === 'BAD_REQUEST', badSpec.error)
  const badUrl = await callFail(base, 'install-plugin', { name: 'x', url: 'http://evil.example.com/x.tgz' })
  ok('公网 http 包地址被拒', badUrl.code === 'FORBIDDEN', badUrl.error)
  // 域名长得像内网前缀（10.evil.com）必须被拒：按前缀正则判断会放行
  const lookalike = await callFail(base, 'install-plugin', { name: 'x', url: 'http://10.evil.com/x.tgz' })
  ok('10.evil.com 这类域名被拒', lookalike.code === 'FORBIDDEN', lookalike.error)
  const lookalike2 = await callFail(base, 'install-plugin', { name: 'x', url: 'http://192.168.evil.com/x.tgz' })
  ok('192.168.evil.com 这类域名被拒', lookalike2.code === 'FORBIDDEN', lookalike2.error)
  const privateOk = await callFail(base, 'install-plugin', { name: 'x', url: 'http://10.255.255.1:1/x.tgz' })
  ok('私有网段地址过白名单（只是连不上）', /下载失败|连接|ECONN/i.test(privateOk.error), privateOk.error)
  // 分支顺序：name 是合法 npm 包名 + 给了 tgz 地址时，必须走 tgz 而不是直接 npm 安装
  const tgzFirst = await callFail(base, 'install-plugin', {
    name: 'dsh-taskboard', url: 'http://10.255.255.1:1/x.tgz', spec: 'dsh-taskboard@0.0.0',
  })
  ok('tgz 地址优先于 npm 分支', /下载失败|连接|ECONN/i.test(tgzFirst.error), tgzFirst.error)
  // 名字要合法（先校名字再查记录），否则拿不到「没有安装记录」这条路径
  const noEnable = await callFail(base, 'plugin/enable', { name: 'selftest-not-installed', checksum: 'x' })
  ok('没有安装记录不能启用', noEnable.code === 'NOT_FOUND', noEnable.error)
  const badEnable = await callFail(base, 'plugin/enable', { name: '../evil', checksum: 'x' })
  ok('启用时非法插件名被拒', badEnable.code === 'BAD_REQUEST', badEnable.error)
  const audit = await call(base, 'plugin/audit')
  ok('plugin/audit 返回对象', audit.ok === true && typeof audit.entries === 'object')

  console.log('认领三段式（跨设备：主服务器只给快照，会话建在成员本机）')
  const sharedRecord = await call(base, 'share/submit', {
    sessionId: `selftest-${Date.now()}`,
    title: '自检分享',
    text: '自检正文：认领链路验证',
    messageCount: 1,
    cwd: process.cwd(),
    uploader: { label: 'selftest', deviceId: `selftest-${Date.now()}` },
  })
  const shareId = sharedRecord.item.id
  // 源会话不在本机 → 必须走 remote：只标记 + 给快照，绝不能代建会话。
  // hostId = 认领人连着的那台机器；成员报的是自己机器的 id，不能是主服务器的。
  const claimRes = await call(base, 'claim', {
    id: shareId, by: 'selftest-device', byName: 'selftest', hostId: 'host-selftest-remote',
  })
  ok('claim 返回快照而不是会话', claimRes.mode === 'remote' && Boolean(claimRes.snapshot), JSON.stringify(claimRes).slice(0, 120))
  ok('远程认领不返回 sessionId', !claimRes.sessionId, String(claimRes.sessionId))
  const imported = await call(base, 'import-session', { claimId: shareId, snapshot: claimRes.snapshot })
  ok('import-session 在本机建出会话', typeof imported.sessionId === 'string' && imported.sessionId.startsWith('session-'), String(imported.sessionId))
  const committed = await call(base, 'claim/commit', { id: shareId, sessionId: imported.sessionId, by: 'selftest-device' })
  ok('claim/commit 记下副本位置', committed.claim?.sessionId === imported.sessionId)
  const reused = await call(base, 'claim', { id: shareId, by: 'selftest-device' })
  ok('同设备再认领复用副本', reused.reused === true && reused.sessionId === imported.sessionId, JSON.stringify(reused))
  const otherDevice = await call(base, 'claim', { id: shareId, by: 'another-device' })
  ok('换设备不复用别人的副本', otherDevice.reused === false && !otherDevice.sessionId, JSON.stringify(otherDevice).slice(0, 120))
  // 反过来：报本机 hostId 也不能凭空变出会话——本机磁盘上没有这条源会话，仍然是 remote。
  // （2.7.3 的 bug 就出在这里：请求经网关代理进来，源地址是 127.0.0.1，被当成「本机」）
  const claimAsHost = await call(base, 'claim', { id: shareId, by: 'selftest-host', hostId: gw.deviceId })
  ok('报本机 hostId 也不会凭空给 sessionId',
    claimAsHost.mode === 'remote' && !claimAsHost.sessionId, JSON.stringify(claimAsHost).slice(0, 120))
  const noId = await callFail(base, 'claim', { by: 'x' })
  ok('claim 缺 id 被拒', noId.code === 'BAD_REQUEST', noId.error)
  const noSnap = await callFail(base, 'import-session', { snapshot: null })
  ok('import-session 缺快照被拒', noSnap.code === 'BAD_REQUEST', noSnap.error)

  // 认领必须按设备分别存：两个人各认各的，第二个人不能拿到第一个人机器上那份副本
  const taskDetail = await call(base, `detail?table=tasks&id=${shareId}`)
  ok('认领按设备分别存（claims）',
    Boolean(taskDetail.entry?.claims?.['selftest-device']) && Boolean(taskDetail.entry?.claims?.['another-device']),
    JSON.stringify(Object.keys(taskDetail.entry?.claims ?? {})))

  console.log('回执两段式')
  const receiptRes = await call(base, 'receipt/submit', { shareId, text: '自检回执正文', fromSessionId: imported.sessionId })
  ok('receipt/submit 生成回执', receiptRes.receipt?.kind === 'receipt')
  const emptyReceipt = await callFail(base, 'receipt/submit', { shareId, text: '   ' })
  ok('空回执被拒', emptyReceipt.code === 'BAD_REQUEST', emptyReceipt.error)
  await call(base, 'remove', { id: receiptRes.receipt.id })
  await call(base, 'remove', { id: shareId })
  ok('认领/回执测试数据已清理', true)

  console.log('列表契约')
  const limits = await call(base, 'list')
  ok('list 返回 limits.maxItems', typeof limits.limits?.maxItems === 'number', JSON.stringify(limits.limits))
  ok('tables 只含真正的表', Object.keys(limits.tables).every(key =>
    ['tasks', 'todos', 'handoffs', 'plugins', 'skills', 'repos'].includes(key)),
  Object.keys(limits.tables).join(','))
  const gw2 = await call(base, 'gateway-status')
  ok('gateway-status 返回 deviceId', typeof gw2.deviceId === 'string' && gw2.deviceId.length > 0)

  console.log('并发写（store 锁）')
  const parallel = await Promise.all(Array.from({ length: 10 }, (_, index) => call(base, 'entry/upsert', {
    table: 'todos',
    entry: { title: `并发 ${Date.now()}-${index}`, status: 'open', note: 'selftest' },
  }).then(result => ({ ok: true, id: result.entry.id })).catch(error => ({ ok: false, error: error.message }))))
  ok('10 个并发写入都不报错', parallel.every(item => item.ok),
    JSON.stringify(parallel.filter(item => !item.ok)))
  const afterParallel = await call(base, 'list')
  ok('并发写入的 10 条都落库', parallel.filter(item => item.ok)
    .every(item => (afterParallel.tables.todos ?? []).some(entry => entry.id === item.id)))
  for (const item of parallel) {
    if (item.ok) await call(base, 'entry/remove', { table: 'todos', id: item.id })
  }

  console.log('成员心跳')
  // 用固定 deviceId：以前是 `selftest-beat-${Date.now()}`，跑一次就多一台「设备」，
  // 攒出过 16 条假设备把「已加入 N 台」顶到 20+。
  const beforeBeat = await call(base, 'gateway-status')
  const joined = await call(base, 'join', { deviceId: 'selftest-heartbeat', name: '自检心跳' })
  const afterBeat = await call(base, 'gateway-status')
  ok('join 接口可用', joined.ok !== false)
  ok('自检心跳不污染设备列表',
    (afterBeat.devices ?? []).length === (beforeBeat.devices ?? []).length,
    `${(beforeBeat.devices ?? []).length} → ${(afterBeat.devices ?? []).length}`)
  ok('自检心跳不计入在线设备',
    (afterBeat.onlineDevices ?? 0) === (beforeBeat.onlineDevices ?? 0))

  console.log('客户端日志接口')
  const log = await call(base, 'client-log', { level: 'selftest', message: 'hello from selftest' })
  ok('client-log 接收成功', log.ok === true)

  console.log('工具渲染契约（源码级）')
  // 宿主调用 output.render 时传的是 (args, value)，第二个才是 execute 的返回值。
  // 写成单参数会把参数对象当结果，于是所有无参工具渲染成 {}（2026-10-22 实测过一次）。
  // 这条只拦源码退回旧写法，真正的行为验证要靠会话里调一次工具。
  const indexSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('defineTool.render 声明为 (args, value)',
    /render:\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)\s*=>/.test(indexSource))
  ok('defineTool.render 没有退回单参数写法',
    !/render:\s*[A-Za-z_$][\w$]*\s*=>/.test(indexSource))

  console.log('列表排序契约（源码级）')
  // 五个 tab 的列表都靠这一行按最后更新时间倒序；删了会退回存储顺序（最早的在前）。
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('列表按 updatedAt 倒序渲染',
    /sort\(\(a, b\) => lastTouched\(b\) - lastTouched\(a\)\)/.test(clientSource))
  ok('缺 updatedAt 时退回 createdAt',
    /lastTouched = item => \{[\s\S]{0,160}updatedAt \?\? item\?\.createdAt/.test(clientSource))

  console.log('文案与实现一致（源码级）')
  // 「发起委托」按钮已下架，任何位置的文案都不能再教人去点它——引导、空态提示都算。
  ok('没有文案还在让人点「发起委托」按钮',
    !/点右上角「发起委托」/.test(clientSource) && !/onClick: createHandoff/.test(clientSource))
  // 引导正文在独立的 guide.html 里（带 SVG 配图），不在 client.js 中。
  const guideSource = readFileSync(new URL('../lib/guide.html', import.meta.url), 'utf8')
  ok('引导页包含四节内容',
    ['会话上传', '会话领取', '委托', 'SKILL 与插件共享'].every(k => guideSource.includes(k)))
  ok('引导页是自包含文档（无外链脚本/样式）',
    !/<script/i.test(guideSource) && !/https?:\/\/(?!www\.w3\.org)/.test(guideSource))

  console.log('插件更新安全（源码级）')
  // 版本号不能按字符串比：'2.7.9' > '2.7.18' 会误判成「本机更新」。
  ok('插件版本比较是语义化的',
    /compareVersion\(item\.installedVersion, item\.version\)/.test(clientSource))
  // 点「更新」团队空间自己会把 link 换成真目录，运行中的宿主直接崩（实测过一次）。
  ok('客户端禁用更新自己', /const isSelf =/.test(clientSource))
  // 保护挪到了「替换目录前」并按 link 判断：按插件名拦会连成员一起拦死
  ok('宿主端在替换目录前拒绝 link 安装', /本机是 link 安装（发布者机器）/.test(indexSource))

  console.log('委托可见性（真实接口）')
  // 用现有数据验：找一个指定了人的委托，陌生人查列表必须看不到，主服务器必须看得到。
  // 团队里一条指定人的委托都没有时，这组用「跳过」而不是「通过」标记，免得变成恒真断言。
  const all = await call(base, 'list')
  const hostInfo = await call(base, 'gateway-status')
  const hostDevice = String(hostInfo?.deviceId ?? '')
  const targeted = (all.tables?.handoffs ?? []).find(item => item.target)
  if (!targeted) {
    console.log('  - 跳过：当前没有「指定给人」的委托可供验证')
  } else {
    const stranger = await call(base, 'list?deviceId=selftest-stranger&name=' + encodeURIComponent('自检路人'))
    ok('陌生设备看不到指定人的委托',
      !(stranger.tables?.handoffs ?? []).some(item => item.id === targeted.id),
      `可见 ${(stranger.tables?.handoffs ?? []).length} 条`)
    const asHost = await call(base, `list?deviceId=${encodeURIComponent(hostDevice)}&name=xinzhan`)
    ok('主服务器看得到指定人的委托',
      (asHost.tables?.handoffs ?? []).some(item => item.id === targeted.id))
    const denial = await callFail(base, 'handoff/remove', {
      id: 'selftest-not-exist', deviceId: 'selftest-stranger', name: '自检路人',
    })
    ok('非主服务器删除委托被拒', denial.status === 403, `实际 HTTP ${denial.status}`)
  }

}

async function main() {
  const { port, base } = await findBase(process.argv[2])
  console.log(`\n团队空间自检 · 端口 ${port}\n`)
  // 先拿宿主 deviceId：后面的删除委托要靠它通过「仅主服务器可删」的校验。
  HOST_DEVICE = String((await call(base, 'gateway-status').catch(() => null))?.deviceId ?? '')
  try {
    await run(base)
    await runCrossEnd(base)
  } finally {
    try {
      const removed = await sweep(base)
      console.log(`扫尾：清掉 ${removed} 条自检残留`)
      ok('清完后没有 selftest 残留', (await sweep(base)) === 0)
    } catch (error) {
      console.log(`扫尾失败：${error.message}`)
    }
  }
  console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 条失败` : '，全部通过'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch(error => {
  console.error('\n自检中断：', error.message, '\n')
  process.exit(1)
})
