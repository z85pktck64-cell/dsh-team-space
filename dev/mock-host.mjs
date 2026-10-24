// 用 mock 宿主加载插件，真起 HTTP 服务验证「认领三段式 / 回执两段式」
// 这样不用重启 DSH 也能验证宿主半的新逻辑。
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'ts-mock-home-'))
process.env.DSH_HOME = home

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const tools = new Map()
const state = {
  // 本机是否「持有」源会话：false = 跨设备场景（主服务器没有别人的会话文件）
  hasLocalSession: false,
  sessions: {},
  persistenceCreated: [],
  agentCreated: [],
}

const handle = () => {
  const bag = { events: [] }
  return {
    append: async events => { bag.events.push(...(Array.isArray(events) ? events : [events])) },
    flush: async () => {},
    close: async () => {},
    bag,
  }
}

const ctx = {
  webServer: {
    register: entry => routes.push(entry),
  },
  sessionQuery: {
    readSession: async id => state.sessions[id] ?? { events: [], session: { cwd: home } },
    readTitle: async () => ({ title: 'Mock 会话' }),
  },
  sessionPersistence: {
    create: async meta => {
      const h = handle()
      state.persistenceCreated.push({ meta, handle: h })
      return h
    },
    open: async id => {
      if (!state.hasLocalSession) throw new Error('本机没有这个会话')
      return { read: async () => ({ events: state.sessions[id]?.events ?? [] }), close: async () => {} }
    },
  },
  agents: {
    // 真实 DSH 的 agents.create 收的 seed 是事件数组（不是函数）
    create: async ({ sessionId, seed }) => {
      const events = Array.isArray(seed) ? seed : []
      state.agentCreated.push({ sessionId, events })
      return {}
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
  tools: {
    register: definition => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
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
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: `no route ${path}` }))
    return
  }
  Promise.resolve(found.handler(req, res)).catch(error => {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: error.message }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/team-space`

async function call(path, body, headers) {
  const merged = {
    accept: 'application/json',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(headers ?? {}),
  }
  const options = body === undefined
    ? { headers: merged }
    : { method: 'POST', headers: merged, body: JSON.stringify(body) }
  const response = await fetch(`${base}/${path}`, options)
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

async function callFail(path, body, headers) {
  const merged = { accept: 'application/json', 'content-type': 'application/json', ...(headers ?? {}) }
  const response = await fetch(`${base}/${path}`, { method: 'POST', headers: merged, body: JSON.stringify(body ?? {}) })
  const data = await response.json().catch(() => null)
  return { status: response.status, code: data?.code ?? '', error: data?.error ?? '' }
}

let checks = 0
let failed = 0
function ok(name, cond, detail = '') {
  checks += 1
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failed += 1
}

console.log(`\nmock 宿主已启动（DSH_HOME=${home}）\n`)

// ---------- 场景 1：跨设备（主服务器没有源会话） ----------
console.log('跨设备认领（主服务器不代建会话）')
const share = await call('share/submit', {
  sessionId: 'session-from-someone-else',
  title: '同事分享的会话',
  text: '同事会话的正文快照',
  cwd: '/private/tmp',
  messageCount: 2,
  uploader: { label: '同事', deviceId: 'dev-colleague' },
})
const shareId = share.data.item.id

// 认领人「连着的那台机器」：成员的浏览器报的是自己机器的 host-*，不是主服务器的
const gw = await call('gateway-status')
const hostId = String(gw.data?.deviceId ?? '')
ok('gateway-status 暴露本机 host-* id', hostId.startsWith('host-'), hostId)
const remoteHostId = 'host-colleague-machine'

const claimA = await call('claim', { id: shareId, by: 'dev-a', byName: '甲', hostId: remoteHostId })
ok('claim 返回 mode=remote', claimA.data.mode === 'remote', JSON.stringify(claimA.data).slice(0, 160))
ok('claim 不给 sessionId', !claimA.data.sessionId, String(claimA.data.sessionId))
ok('快照是文本（主服务器没有事件流）', claimA.data.snapshot?.kind === 'text', JSON.stringify(claimA.data.snapshot).slice(0, 160))
ok('快照带了正文', claimA.data.snapshot?.text === '同事会话的正文快照')

const imported = await call('import-session', { claimId: shareId, snapshot: claimA.data.snapshot })
ok('import-session 返回 sessionId', typeof imported.data.sessionId === 'string' && imported.data.sessionId.startsWith('session-'), JSON.stringify(imported.data))
ok('走 agents.create（有 announce）', state.agentCreated.length === 1, `agents.create=${state.agentCreated.length}`)
ok('种子事件带上了正文', JSON.stringify(state.agentCreated[0]?.events ?? []).includes('同事会话的正文快照'))
const importedId = imported.data.sessionId

const commit = await call('claim/commit', { id: shareId, sessionId: importedId, by: 'dev-a' })
ok('claim/commit 记下副本位置', commit.data.claim?.sessionId === importedId, JSON.stringify(commit.data))

const again = await call('claim', { id: shareId, by: 'dev-a' })
ok('同设备再认领复用副本', again.data.reused === true && again.data.sessionId === importedId, JSON.stringify(again.data))

const other = await call('claim', { id: shareId, by: 'dev-b' })
ok('换设备不复用（副本在别人机器上）', other.data.reused === false && !other.data.sessionId, JSON.stringify(other.data).slice(0, 160))

// ---------- 场景 2：回执两段式 ----------
console.log('回执两段式')
const receipt = await call('receipt/submit', {
  shareId, text: '我这边做完了：xxx', fromSessionId: importedId,
})
ok('receipt/submit 生成回执', receipt.data.receipt?.kind === 'receipt', JSON.stringify(receipt.data).slice(0, 160))
const emptyReceipt = await call('receipt/submit', { shareId, text: '   ' })
ok('空回执被拒', emptyReceipt.data.code === 'BAD_REQUEST', JSON.stringify(emptyReceipt.data))
const serverSide = await call('receipt', { shareId })
ok('副本不在本机时 /receipt 报 STATE_CONFLICT', serverSide.data.code === 'STATE_CONFLICT', JSON.stringify(serverSide.data))

// ---------- 场景 3：源会话在本机（单机 / 主服务器自己分享） ----------
console.log('本机认领（源会话在这台机器上）')
state.hasLocalSession = true
state.sessions['session-local-source'] = {
  events: [
    { type: 'user/message', seq: 0, time: 1000, data: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'agent/message', seq: 1, time: 2000, data: { content: [{ type: 'text', text: 'hi' }] } },
  ],
  session: { cwd: home },
}
const share2 = await call('share/submit', {
  sessionId: 'session-local-source', title: '本机会话', text: '本机正文', cwd: home,
  uploader: { label: '我', deviceId: 'dev-a' },
})
// 本机浏览器认领：报上来的 host id 就是这台机器 → 直接复制完整历史
const claimLocal = await call('claim', { id: share2.data.item.id, by: 'dev-a', hostId })
ok('claim 返回 mode=local', claimLocal.data.mode === 'local', JSON.stringify(claimLocal.data).slice(0, 160))
ok('直接给了 sessionId', typeof claimLocal.data.sessionId === 'string', String(claimLocal.data.sessionId))

// 同一条本机会话，成员（另一台机器）来认领：主服务器上有源会话也不许代建，
// 否则成员拿到的是主服务器磁盘上的 sessionId，在他自己机器上永远打不开。
const claimRemoteOfLocal = await call('claim', {
  id: share2.data.item.id, by: 'dev-colleague', byName: '同事', hostId: remoteHostId,
})
ok('源会话在本机但认领人不是本机 → remote',
  claimRemoteOfLocal.data.mode === 'remote' && !claimRemoteOfLocal.data.sessionId,
  JSON.stringify(claimRemoteOfLocal.data).slice(0, 160))
ok('远程认领拿到的是事件快照', claimRemoteOfLocal.data.snapshot?.kind === 'events',
  JSON.stringify(claimRemoteOfLocal.data.snapshot ?? {}).slice(0, 160))

// 老客户端（不带 hostId）：回落到按来源地址判断，本机回环仍走 local
const claimNoHost = await call('claim', { id: share2.data.item.id, by: 'dev-old' })
ok('不带 host id 的老客户端按回环地址回落', claimNoHost.data.mode === 'local',
  JSON.stringify(claimNoHost.data).slice(0, 160))

// ---------- 场景 4：local-session 增量 ----------
console.log('local-session 增量')
const full = await call('local-session?sessionId=session-local-source')
ok('A12 不带 since 返回全文', (full.data.text ?? '').length > 0, JSON.stringify(full.data).slice(0, 120))
const since = await call('local-session?sessionId=session-local-source&since=1500')
ok('A13 带 since 只剩增量', since.data.throughSeq === 1, JSON.stringify(since.data).slice(0, 200))

// ---------- E10：新会话 ----------
const newSession = await call('new-session', { cwd: home })
ok('E10 new-session 返回 sessionId', String(newSession.data?.sessionId ?? '').startsWith('session-'),
  JSON.stringify(newSession.data).slice(0, 160))
ok('E10 新会话走 agents.create 并被记录',
  state.agentCreated.some(item => item.sessionId === newSession.data?.sessionId),
  JSON.stringify(state.agentCreated.map(item => item.sessionId)))

// ---------- 场景 5：护栏 ----------
console.log('护栏')
const noId = await call('claim', { by: 'dev-a' })
ok('claim 缺 id 被拒', noId.data.code === 'BAD_REQUEST', JSON.stringify(noId.data))
const noSnap = await call('import-session', { snapshot: null })
ok('import-session 缺快照被拒', noSnap.data.code === 'BAD_REQUEST', JSON.stringify(noSnap.data))
const dirty = await call('import-session', {
  snapshot: {
    kind: 'events',
    sourceSessionId: 'session-from-someone-else',
    events: [
      { type: 'user/message', seq: 0, time: 1, data: { text: 'ok' }, evil: 'x' },
      { type: 'x', seq: 1, time: 2, data: 'y'.repeat(400 * 1024) },
    ],
  },
})
const dirtySeed = state.agentCreated.at(-1)?.events ?? state.persistenceCreated.at(-1)?.handle.bag.events ?? []
ok('脏事件被清洗后仍导入', dirty.data.sessionId?.startsWith('session-'), JSON.stringify(dirty.data))
ok('超大单条被丢弃', dirtySeed.length === 1, String(dirtySeed.length))
ok('未知字段被剥离', !('evil' in (dirtySeed[0] ?? {})), JSON.stringify(dirtySeed[0]))

// ---------- 场景 6：认领按设备分别存 ----------
console.log('认领按设备分别存')
const taskDetail = await call(`detail?table=tasks&id=${shareId}`)
ok('claims 里 dev-a / dev-b 各有一份',
  Boolean(taskDetail.data.entry?.claims?.['dev-a']) && Boolean(taskDetail.data.entry?.claims?.['dev-b']),
  JSON.stringify(Object.keys(taskDetail.data.entry?.claims ?? {})))

// ---------- 场景 7：F-Assign 状态机收口 ----------
console.log('F-Assign 状态机收口')
const h1 = await call('handoff/create', { title: 'mock 委托', brief: 'x', owner: '甲', deviceId: 'dev-a' })
const jump = await call('handoff/complete', { id: h1.data.id, result: '没接就交' })
ok('open → done 直跳被拒', jump.data.code === 'STATE_CONFLICT', JSON.stringify(jump.data))
const viaEntry = await call('entry/upsert', { table: 'handoffs', entry: { id: h1.data.id, status: 'done' } })
ok('handoffs 不走通用 upsert', viaEntry.data.code === 'BAD_REQUEST', JSON.stringify(viaEntry.data))
const cancel = await call('handoff/cancel', { id: h1.data.id, by: '甲', reason: 'mock 关单' })
ok('发起人可关单', cancel.data.ok === true, JSON.stringify(cancel.data))
const h2 = await call('handoff/create', { title: 'mock agent 委托', brief: 'x' })
const h2Detail = await call(`detail?table=handoffs&id=${h2.data.id}`)
ok('未给 deviceId 回落到 host-* 设备号',
  String(h2Detail.data.entry?.requesterDeviceId ?? '').startsWith('host-'),
  String(h2Detail.data.entry?.requesterDeviceId))
const wrongOwner = await call('handoff/cancel', { id: h2.data.id, by: '乙', reason: 'x' })
ok('非发起人不能关单', wrongOwner.data.code === 'FORBIDDEN', JSON.stringify(wrongOwner.data))

// ---------- 场景 8：作者护栏 ----------
console.log('作者护栏')
const s1 = await call('entry/upsert', {
  table: 'skills', entry: { name: 'mock-skill', description: '甲发布', content: 'A', author: { name: '甲' } },
})
const hijack = await call('entry/upsert', {
  table: 'skills', entry: { name: 'mock-skill', description: '乙覆盖', content: 'B', author: { name: '乙' } },
})
ok('换作者不带 baseVersion 被拒', hijack.data.code === 'VERSION_CONFLICT', JSON.stringify(hijack.data))
const noAuthor = await call('entry/upsert', {
  table: 'skills', entry: { name: 'mock-skill', description: '无作者', content: 'C' },
})
ok('不带 author 也被拒（绑本机身份后仍非原作者）', noAuthor.data.code === 'VERSION_CONFLICT', JSON.stringify(noAuthor.data))
const withVersion = await call('entry/upsert', {
  table: 'skills',
  entry: {
    name: 'mock-skill', description: '乙接管', content: 'D',
    author: { name: '乙' }, baseVersion: s1.data.entry.contentHash,
  },
})
ok('带 baseVersion 没 takeOver 仍被拒', withVersion.data.code === 'VERSION_CONFLICT', JSON.stringify(withVersion.data))
const taken = await call('entry/upsert', {
  table: 'skills',
  entry: {
    name: 'mock-skill', description: '乙接管', content: 'D',
    author: { name: '乙' }, baseVersion: s1.data.entry.contentHash, takeOver: true,
  },
})
ok('显式 takeOver 可以接管', taken.data.entry?.author?.name === '乙', JSON.stringify(taken.data.entry?.author))
// 条目作者 Xinzhan、本机 join 名 xinzhan：同一个人，不该被判成「换作者接管」
const caseA = await call('entry/upsert', {
  table: 'skills',
  entry: { name: 'mock-skill-case', description: '大写作者发布', content: 'A', author: { name: 'Xinzhan' } },
})
const caseB = await call('entry/upsert', {
  table: 'skills',
  entry: { name: 'mock-skill-case', description: '小写同名更新', content: 'B', author: { name: ' xinzhan ' } },
})
ok('作者名大小写/首尾空格不同视为同一人',
  caseB.data.entry?.description === '小写同名更新' && caseB.data.entry?.author?.name === 'xinzhan',
  JSON.stringify(caseB.data).slice(0, 160))
const caseC = await call('entry/upsert', {
  table: 'skills',
  entry: { name: 'mock-skill-case', description: '真·他人覆盖', content: 'C', author: { name: '乙' } },
})
ok('真的换人仍然被拦', caseC.data.code === 'VERSION_CONFLICT', JSON.stringify(caseC.data).slice(0, 160))

// ---------- 场景 9：安装链路护栏 ----------
console.log('安装链路护栏')
for (const host of ['10.evil.com', '192.168.evil.com', '172.16.evil.com', 'evil.example.com']) {
  const probe = await call('install-plugin', { name: 'x', url: `http://${host}/x.tgz` })
  ok(`http://${host} 被拒`, probe.data.code === 'FORBIDDEN', JSON.stringify(probe.data))
}
const badName = await call('install-plugin', { name: '../../evil', url: '', spec: '' })
ok('插件名含 ../ 被拒', badName.data.code === 'BAD_REQUEST', JSON.stringify(badName.data))
const badSpec = await call('install-plugin', { name: 'x', url: '', spec: '--registry=http://evil' })
ok('npm spec 带 flag 被拒', badSpec.data.code === 'BAD_REQUEST', JSON.stringify(badSpec.data))
// 分支顺序：合法 npm 包名 + tgz 地址 → 必须走 tgz 校验，而不是直接 npm 安装
const tgzFirst = await call('install-plugin', {
  name: 'dsh-taskboard', url: 'http://127.0.0.1:1/x.tgz', spec: 'dsh-taskboard@0.0.0',
})
ok('tgz 地址优先于 npm 分支', /下载失败/.test(String(tgzFirst.data.error ?? '')), JSON.stringify(tgzFirst.data))
const noRecord = await call('plugin/enable', { name: 'not-installed', checksum: 'x' })
ok('没有安装记录不能启用', noRecord.data.code === 'NOT_FOUND', JSON.stringify(noRecord.data))
const audit = await call('plugin/audit')
ok('plugin/audit 有记录', audit.data.ok === true && typeof audit.data.entries === 'object')

// ---------- 场景 10：测试通道与功能通道隔离 ----------
// 为什么要在 mock 宿主里验：成员连的是主服务器，实测时所有读写都落在同一份 store 上。
// 这里用临时 DSH_HOME，既验隔离逻辑，本身也不碰任何真实数据。
console.log('测试通道 / 功能通道隔离')
const TEST = { 'x-team-space-channel': 'test' }

const realRepo = await call('entry/upsert', {
  table: 'repos', entry: { name: 'mock-real-repo', url: 'https://example.com/real' },
})
const testRepo = await call('entry/upsert', {
  table: 'repos', entry: { name: 'mock-test-repo', url: 'https://example.com/test' },
}, TEST)
ok('测试通道写入带 channel=test', testRepo.data.entry?.channel === 'test', String(testRepo.data.entry?.channel))
ok('真实通道写入不带 channel 标', !realRepo.data.entry?.channel, String(realRepo.data.entry?.channel))

const prodNames = ((await call('list')).data.tables?.repos ?? []).map(r => r.name)
const testNames = ((await call('list', undefined, TEST)).data.tables?.repos ?? []).map(r => r.name)
ok('测试记录不出现在真实列表', !prodNames.includes('mock-test-repo'), prodNames.join(','))
ok('真实记录在真实列表里', prodNames.includes('mock-real-repo'))
ok('测试通道同时看得到测试 + 真实记录',
  testNames.includes('mock-test-repo') && testNames.includes('mock-real-repo'), testNames.join(','))
ok('通道也能用 ?channel=test 指定（门户页走这条）',
  ((await call('list?channel=test')).data.tables?.repos ?? []).some(r => r.name === 'mock-test-repo'))

// mock 的 call 不抛错（返回 status/data），所以按状态码判，别照抄 selftest 的写法
const detailDenied = await call(`detail?table=repos&id=${testRepo.data.entry.id}`)
ok('真实通道取测试记录详情被拒',
  Boolean(testRepo.data.entry.id) && detailDenied.data.ok === false,
  JSON.stringify(detailDenied.data).slice(0, 120))

const denyRemove = await call('entry/remove', { table: 'repos', id: realRepo.data.entry.id }, TEST)
ok('测试通道删真实记录被拒', denyRemove.data.code === 'FORBIDDEN', JSON.stringify(denyRemove.data))
const denyUpdate = await call('entry/upsert', {
  table: 'repos', entry: { id: realRepo.data.entry.id, name: 'mock-real-repo', url: 'https://example.com/hacked' },
}, TEST)
ok('测试通道改真实记录被拒', denyUpdate.data.code === 'FORBIDDEN', JSON.stringify(denyUpdate.data))
ok('被拒之后真实记录没被改动',
  ((await call('list')).data.tables?.repos ?? []).find(r => r.id === realRepo.data.entry.id)?.url === 'https://example.com/real')

// 测试通道建的委托：不进真实列表，也不能被真实通道认领
const testHandoff = await call('handoff/create', { title: 'mock-test-handoff', brief: 'x', owner: '甲' }, TEST)
ok('测试通道建的委托不进真实列表',
  !((await call('list')).data.tables?.handoffs ?? []).some(h => h.id === testHandoff.data.id))
ok('测试通道看得到自己的委托',
  ((await call('list', undefined, TEST)).data.tables?.handoffs ?? []).some(h => h.id === testHandoff.data.id))

// 会话分享没有逐个改路由，靠 route() 里的通道作用域兜 —— 这条就是验那个作用域
const testShare = await call('share/submit', {
  sessionId: 'mock-session-test-channel', title: 'mock-test-session', text: '测试通道会话',
  uploader: { label: '甲', deviceId: 'dev-a' },
}, TEST)
ok('会话分享自动落测试通道（路由作用域生效）',
  testShare.data.item?.channel === 'test', String(testShare.data.item?.channel))
ok('测试通道分享的会话不进真实列表',
  !((await call('list')).data.tables?.tasks ?? []).some(t => t.id === testShare.data.item?.id))

const realHandoff = await call('handoff/create', { title: 'mock-real-handoff', brief: 'x', owner: '甲' })
const denyClaim = await call('handoff/claim', { id: realHandoff.data.id, by: '乙' }, TEST)
ok('测试通道认领真实委托被拒（「测试里点认领」绝不能等于真的认领）',
  denyClaim.data.code === 'FORBIDDEN', JSON.stringify(denyClaim.data))
ok('真实委托仍是 open（没被测试动作改掉）',
  ((await call('list')).data.tables?.handoffs ?? []).find(h => h.id === realHandoff.data.id)?.status === 'open')


// ---------- 场景 5：多路径一致性（HTTP / agent 工具 / MCP） ----------
console.log('多路径一致性：建委托 / 交回结果 / 通知副作用')

const notifyLog = join(home, 'notify.jsonl')
process.env.TEAM_SPACE_NOTIFY_LOG = notifyLog
const hookBodies = []
let hookStatus = 200
const hook = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    hookBodies.push(body)
    res.statusCode = hookStatus
    res.end('{"errcode":0}')
  })
})
await new Promise(resolve => hook.listen(0, '127.0.0.1', resolve))
process.env.TEAM_SPACE_NOTIFY_URL = `http://127.0.0.1:${hook.address().port}/hook`

const notifyRows = () => {
  try {
    return readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch { return [] }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function mcpCall(name, args, user = '甲') {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, user, method: 'tools/call', params: { name, arguments: args } }),
  })
  const data = await response.json()
  const text = data?.result?.content?.[0]?.text ?? '{}'
  return { ...JSON.parse(text), isError: Boolean(data?.result?.isError) }
}

const payload = { title: '多路径一致性', brief: '同一份说明', target: '甲', owner: '乙' }
const viaHttp = await call('handoff/create', payload)
const viaAgent = await tools.get('team_space_create_handoff').execute(payload)
const viaMcp = await mcpCall('team_space_create_handoff', payload)
await sleep(250)

const ids = { http: viaHttp.data.id, agent: viaAgent.id, mcp: viaMcp.id }
ok('三条路径都建出了委托', Object.values(ids).every(Boolean), JSON.stringify(ids))
const afterCreate = (await call('list')).data.tables?.handoffs ?? []
ok('三条委托都出现在同一张表里',
  Object.values(ids).every(id => afterCreate.some(h => h.id === id)))
ok('三条委托字段一致（status / target）',
  Object.values(ids).every(id => {
    const h = afterCreate.find(item => item.id === id)
    return h?.status === 'open' && h?.target === '甲'
  }))
const details = await Promise.all(Object.values(ids).map(id => call(`detail?table=handoffs&id=${id}`)))
ok('三条委托的 brief 一致（列表不返回 brief，要查 detail）',
  details.every(d => d.data?.entry?.brief === '同一份说明'),
  JSON.stringify(details.map(d => d.data?.entry?.brief)))
const sent = notifyRows().filter(row => row.status === 'sent')
ok('三条建委托路径各发一次通知（agent 工具曾经漏过）',
  Object.values(ids).every(id => sent.filter(r => r.handoffId === id).length === 1),
  JSON.stringify(notifyRows()))
ok('通知请求真的打到了 webhook', hookBodies.length === 3, `实际 ${hookBodies.length}`)

hookStatus = 500
const failNotify = await call('handoff/create', { title: '通知失败可观测', brief: 'x', owner: '乙' })
await sleep(250)
const failedRows = notifyRows().filter(row => row.status === 'failed' && row.handoffId === failNotify.data.id)
ok('webhook 返回 500 时记 failed，委托仍然创建成功',
  failedRows.length === 1 && failedRows[0].httpStatus === 500 && Boolean(failNotify.data.id),
  JSON.stringify(notifyRows()))
hookStatus = 200

await call('handoff/claim', { id: ids.http, by: '甲' })
await call('handoff/claim', { id: ids.agent, by: '甲' })
await mcpCall('team_space_claim_handoff', { id: ids.mcp })
const completeHttp = await call('handoff/complete', { id: ids.http, result: 'HTTP 做完', by: '甲' })
const completeAgent = await tools.get('team_space_complete_handoff').execute({ id: ids.agent, result: 'agent 做完' })
const completeMcp = await mcpCall('team_space_complete_handoff', { id: ids.mcp, result: 'MCP 做完' })
const afterDone = (await call('list')).data.tables?.handoffs ?? []
ok('三条路径都能把委托交回 done',
  Object.values(ids).every(id => afterDone.find(h => h.id === id)?.status === 'done'),
  JSON.stringify(afterDone.filter(h => Object.values(ids).includes(h.id)).map(h => [h.id, h.status])))
const doneDetails = await Promise.all(Object.values(ids).map(id => call(`detail?table=handoffs&id=${id}`)))
ok('三条路径交回结果都写进了 result（列表不返回 result）',
  doneDetails[0].data?.entry?.result === 'HTTP 做完'
  && doneDetails[1].data?.entry?.result === 'agent 做完'
  && doneDetails[2].data?.entry?.result === 'MCP 做完',
  JSON.stringify(doneDetails.map(d => d.data?.entry?.result)))

const agentCancel = await tools.get('team_space_create_handoff').execute({ title: '待取消', brief: 'x', owner: '乙' })
const cancelled = await call('handoff/cancel', { id: agentCancel.id, reason: '不做了', by: '乙' })
const afterCancel = ((await call('list')).data.tables?.handoffs ?? []).find(h => h.id === agentCancel.id)
ok('取消委托仍可用（状态变 cancelled）', cancelled.data?.ok === true && afterCancel?.status === 'cancelled',
  JSON.stringify({ reply: cancelled.data, status: afterCancel?.status }))

hook.close()


// ---------- 场景 6：安装链路端到端（D01 / D03 / D04 / D05 / D06） ----------
console.log('安装链路端到端（真下载 / 真解压 / 真启用）')

const fixtureRoot = join(home, 'fixture-pkg')
mkdirSync(fixtureRoot, { recursive: true })
writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ name: '@local/p0-fixture', version: '0.0.1', main: 'index.js' }))
writeFileSync(join(fixtureRoot, 'index.js'), 'export default {}\n')
const tarball = join(home, 'p0-fixture.tgz')
execSync(`tar -czf "${tarball}" -C "${fixtureRoot}" .`)

const pkgServer = createServer((req, res) => {
  res.setHeader('content-type', 'application/octet-stream')
  res.end(readFileSync(tarball))
})
await new Promise(resolve => pkgServer.listen(0, '127.0.0.1', resolve))
const pkgUrl = `http://127.0.0.1:${pkgServer.address().port}/p0-fixture.tgz`

const profileDir = join(home, 'profiles', 'desktop')
const installedRoot = join(profileDir, 'node_modules', '@local', 'p0-fixture')
const installedAt = join(installedRoot, 'package.json')
const profilePkg = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')
const lockFile = join(profileDir, 'pnpm-lock.yaml')
const oldArchive = join(home, 'plugins', 'p0-fixture-0.0.0.tgz')
mkdirSync(profileDir, { recursive: true })
mkdirSync(installedRoot, { recursive: true })
writeFileSync(installedAt, JSON.stringify({ name: '@local/p0-fixture', version: '0.0.0', main: 'index.js' }))
mkdirSync(join(home, 'plugins'), { recursive: true })
execSync(`cp "${tarball}" "${oldArchive}"`)
writeFileSync(profilePkg, `${JSON.stringify({
  name: 'mock-profile',
  private: true,
  dependencies: { '@local/p0-fixture': `file:${oldArchive}` },
}, null, 2)}\n`)
writeFileSync(lockFile, `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      '@local/p0-fixture':\n        specifier: file:${oldArchive}\n        version: file:../../plugins/p0-fixture-0.0.0.tgz\n\npackages:\n\n  '@local/p0-fixture@file:../../plugins/p0-fixture-0.0.0.tgz':\n    resolution: {integrity: sha512-old, tarball: file:../../plugins/p0-fixture-0.0.0.tgz}\n    version: 0.0.0\n\nsnapshots:\n\n  '@local/p0-fixture@file:../../plugins/p0-fixture-0.0.0.tgz': {}\n`)
const profileBeforeInstall = readFileSync(profilePkg, 'utf8')

// D07 / D08：link 安装不能被「更新」覆盖；普通 copy 安装仍应成功。
const selfSlot = join(profileDir, 'node_modules', '@local', 'dsh-team-space')
mkdirSync(join(profileDir, 'node_modules', '@local'), { recursive: true })
symlinkSync(fixtureRoot, selfSlot, 'dir')
const linkBlocked = await callFail('install-plugin', { name: 'dsh-team-space', url: pkgUrl })
ok('D08 link 安装点更新被拒（403）', linkBlocked.status === 403, JSON.stringify(linkBlocked))
ok('D08 被拒后 link 目录仍是符号链接', lstatSync(selfSlot).isSymbolicLink())
rmSync(selfSlot, { force: true })
const selfCopy = await call('install-plugin', { name: 'dsh-team-space', url: pkgUrl })
ok('D07 常规 copy 安装成功', selfCopy.data?.ok === true && existsSync(join(profileDir, 'node_modules', 'dsh-team-space', 'package.json')),
  JSON.stringify(selfCopy.data).slice(0, 200))

const installed = await call('install-plugin', { name: 'p0-fixture', url: pkgUrl })
ok('D01 tgz 安装返回 checksum', /^[a-f0-9]{64}$/.test(String(installed.data?.checksum ?? '')),
  JSON.stringify(installed.data).slice(0, 200))
ok('D01 包真的落到 node_modules/p0-fixture', existsSync(installedAt))
ok('D03 安装后不自动写 profile 依赖',
  readFileSync(profilePkg, 'utf8') === profileBeforeInstall)
ok('D03 安装后不自动写 loader 行',
  !existsSync(patchFile) || !readFileSync(patchFile, 'utf8').includes('p0-fixture'))

// 固化包必须排除备份与依赖目录：带依赖的插件否则会打出几倍大的包，重装还带出一堆残留
mkdirSync(join(installedRoot, '.bak-1700000000000'), { recursive: true })
writeFileSync(join(installedRoot, '.bak-1700000000000', 'stale.txt'), 'stale\n')
mkdirSync(join(installedRoot, 'node_modules', 'dummy'), { recursive: true })
writeFileSync(join(installedRoot, 'node_modules', 'dummy', 'index.js'), 'module.exports = 1\n')
// 造 5 个很旧的包：prune 只留最近 3 个
for (let i = 0; i < 5; i += 1) {
  const stale = join(home, 'plugins', `p0-fixture-0.8.${i}.tgz`)
  writeFileSync(stale, 'old')
  execSync(`touch -t 202001010000 "${stale}"`)
}

const enabled = await call('plugin/enable', { name: 'p0-fixture', checksum: installed.data.checksum })
ok('D04 确认启用成功且提示重启', enabled.data?.ok === true && enabled.data?.needsRestart === true)
ok('D04 启用后写了 profile 依赖',
  existsSync(profilePkg) && readFileSync(profilePkg, 'utf8').includes('p0-fixture'))
ok('D04 启用后写了 loader 行',
  existsSync(patchFile) && readFileSync(patchFile, 'utf8').includes('p0-fixture'))
const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
ok('D04 loader 行等于相对 node_modules 的路径', patchText.includes('name: "@local/p0-fixture"'), patchText.slice(0, 200))
ok('D04 loader 行的 name 加了引号（YAML 保留字符安全）', patchText.includes('name: "@local/p0-fixture"'), patchText.slice(0, 200))

// J09：升级后 profile 依赖必须指向本次安装的包，而不是保留旧 tgz。
// 请求名用短名、真实包名带 @local，复刻 Neo 门店端的实际安装方式。
const profileAfter = JSON.parse(readFileSync(profilePkg, 'utf8'))
const dependency = profileAfter.dependencies?.['@local/p0-fixture'] ?? ''
const archive = dependency.startsWith('file:') ? dependency.slice(5) : ''
ok('J09 profile 依赖按真实包名更新到本次安装包',
  archive.endsWith('/plugins/p0-fixture-0.0.1.tgz') && existsSync(archive), dependency)
ok('J09 安装包已固化且与启用版本一致',
  existsSync(archive)
  && JSON.parse(execSync(`tar -xOf "${archive}" ./package.json`, { encoding: 'utf8' })).version === '0.0.1')
const listing = execSync(`tar -tzf "${archive}"`, { encoding: 'utf8' })
ok('J09 固化包不含 .bak 备份目录', !/\.bak-/.test(listing), listing.split('\n').filter(n => /\.bak-/.test(n)).join(','))
ok('J09 固化包不含 node_modules', !/node_modules/.test(listing), listing.split('\n').filter(n => /node_modules/.test(n)).join(','))
const tgzLeft = readdirSync(join(home, 'plugins')).filter(name => name.endsWith('.tgz'))
ok('J09 旧安装包清理到最近 3 个', tgzLeft.length === 3, tgzLeft.join(','))
ok('J09 本次安装包没有被清理掉', tgzLeft.includes('p0-fixture-0.0.1.tgz'), tgzLeft.join(','))

const lockAfter = readFileSync(lockFile, 'utf8')
ok('J09 lockfile importer 指向新包',
  lockAfter.includes(`specifier: file:${archive}`)
  && lockAfter.includes('version: file:../../plugins/p0-fixture-0.0.1.tgz')
  && !lockAfter.includes('p0-fixture-0.0.0.tgz'), lockAfter.slice(0, 600))
ok('J09 lockfile package/snapshot 都有新版本与 integrity',
  lockAfter.includes("'@local/p0-fixture@file:../../plugins/p0-fixture-0.0.1.tgz':")
  && /resolution: \{integrity: sha512-[A-Za-z0-9+/=]+, tarball: file:\.\.\/\.\.\/plugins\/p0-fixture-0\.0\.1\.tgz\}/.test(lockAfter))

// 同版本重新打包：归档路径与版本不变，但内容/哈希变了。lockfile 里的
// integrity 也必须同步，否则 pnpm --frozen-lockfile 会把合法更新判成篡改。
const integrityBeforeRepack = lockAfter.match(/resolution: \{integrity: (sha512-[^,]+),/)?.[1] ?? ''
writeFileSync(join(installedRoot, 'index.js'), 'export default { repacked: true }\n')
const repacked = await call('plugin/enable', { name: 'p0-fixture', checksum: installed.data.checksum })
const lockAfterRepack = readFileSync(lockFile, 'utf8')
const archiveBytesAfterRepack = readFileSync(archive)
const integrityAfterRepack = `sha512-${createHash('sha512').update(archiveBytesAfterRepack).digest('base64')}`
ok('J09 同版本重打包后 enable 仍成功', repacked.data?.ok === true && repacked.data?.needsRestart === true,
  JSON.stringify(repacked.data))
ok('J09 同版本重打包会刷新 lockfile integrity',
  Boolean(integrityBeforeRepack) && integrityBeforeRepack !== integrityAfterRepack
  && lockAfterRepack.includes(`integrity: ${integrityAfterRepack}`),
  JSON.stringify({ integrityBeforeRepack, integrityAfterRepack }))

// 真正跑一次 pnpm：lock 与固化包必须自洽，不能把版本回退到 0.0.0
execSync('pnpm install --offline --frozen-lockfile --ignore-scripts', { cwd: profileDir, stdio: 'pipe' })
ok('J09 pnpm --frozen-lockfile 重装后仍是 0.0.1',
  JSON.parse(readFileSync(installedAt, 'utf8')).version === '0.0.1')

const badChecksum = await callFail('plugin/enable', { name: 'p0-fixture', checksum: 'deadbeef' })
ok('D05 checksum 不一致被拒', badChecksum.code === 'FORBIDDEN', JSON.stringify(badChecksum))
const unknown = await callFail('plugin/enable', { name: 'p0-not-installed', checksum: 'x' })
ok('D06 没有安装记录不能启用', unknown.code === 'NOT_FOUND', JSON.stringify(unknown))

// D12：同一个插件同时点两次更新，只能有一个进入安装流程。
const raceServer = createServer((req, res) => {
  setTimeout(() => {
    res.setHeader('content-type', 'application/octet-stream')
    res.end(readFileSync(tarball))
  }, 350)
})
await new Promise(resolve => raceServer.listen(0, '127.0.0.1', resolve))
const raceUrl = `http://127.0.0.1:${raceServer.address().port}/p0-race.tgz`
const race = await Promise.all([
  call('install-plugin', { name: 'p0-race', url: raceUrl }),
  call('install-plugin', { name: 'p0-race', url: raceUrl }),
])
const raceStatuses = race.map(item => item.status).sort()
const raceRejected = race.find(item => item.status !== 200)
ok('D12 并发安装只允许一个进入下载/替换流程',
  raceStatuses.filter(status => status === 200).length === 1 && raceStatuses.filter(status => status === 400).length === 1,
  JSON.stringify(race.map(item => ({ status: item.status, error: item.data?.error }))))
ok('D12 被拒请求有明确「正在安装」提示',
  String(raceRejected?.data?.error ?? '').includes('正在安装'),
  JSON.stringify(raceRejected?.data ?? {}))

// D13：拿坏包更新时，旧版本必须保持可用，不能被半成品覆盖。
const badTarball = join(home, 'bad-package.tgz')
writeFileSync(badTarball, 'this is not a tar archive\n')
const badServer = createServer((req, res) => {
  res.setHeader('content-type', 'application/octet-stream')
  res.end(readFileSync(badTarball))
})
await new Promise(resolve => badServer.listen(0, '127.0.0.1', resolve))
const badUrl = `http://127.0.0.1:${badServer.address().port}/bad.tgz`
const badInstall = await call('install-plugin', { name: 'p0-fixture', url: badUrl })
ok('D13 坏包安装失败并返回非 2xx', badInstall.status >= 400, JSON.stringify({ status: badInstall.status, error: badInstall.data?.error }))
ok('D13 坏包失败后旧版本仍完好',
  existsSync(installedAt) && JSON.parse(readFileSync(installedAt, 'utf8')).version === '0.0.1',
  existsSync(installedAt) ? readFileSync(installedAt, 'utf8') : '(旧目录不存在)')

raceServer.close()
badServer.close()

pkgServer.close()

// E06 / D09：agent 工具成员列表、技能安装
await call('member/save', { name: 'p0-agent-member', bio: '## 能接什么活\n- mock' })
const agentMembers = await tools.get('team_space_list_members').execute({})
const httpMembers = await call('member/list')
const agentNames = (agentMembers.members ?? []).map(item => String(item).split('：')[0])
const httpNames = (httpMembers.data.members ?? []).map(item => item.name)
ok('E06 agent list_members 与 /member/list 成员集合一致（结构各自约定）',
  JSON.stringify(agentNames.sort()) === JSON.stringify(httpNames.sort()),
  JSON.stringify({ agent: agentNames, http: httpNames }))

const skillInstalled = await call('install-skill', { name: 'p0-installed-skill', content: 'P0 SKILL 正文' })
const skillFile = join(home, 'skills', 'p0-installed-skill', 'SKILL.md')
ok('D09 技能安装真的落盘', existsSync(skillFile) && readFileSync(skillFile, 'utf8') === 'P0 SKILL 正文',
  String(skillFile))

// ---------- 场景 11：客户端版本闸门（强制一致） ----------
// 旧客户端写不进去、读得到；同版本正常；不带版本头的（老客户端/curl/MCP/agent 工具）放行。
console.log('客户端版本闸门')
const hostVersion = (await call('list')).data.version?.host ?? ''
ok('list 返回宿主版本', /^\d+\.\d+\.\d+$/.test(hostVersion), hostVersion)

const staleWrite = await call('entry/upsert', {
  table: 'repos', entry: { name: 'mock-stale-write', url: 'https://example.com/stale' },
}, { ...TEST, 'x-team-space-version': '0.0.1' })
ok('旧客户端写入被拒（UPGRADE_REQUIRED）', staleWrite.data.code === 'UPGRADE_REQUIRED', JSON.stringify(staleWrite.data))
ok('被拒时带回了宿主版本（弹窗要显示）', staleWrite.data.hostVersion === hostVersion, String(staleWrite.data.hostVersion))

const staleRead = await call('list', undefined, { 'x-team-space-version': '0.0.1' })
ok('旧客户端读放行（读不会写坏数据）',
  staleRead.data.ok === true && staleRead.data.version?.host === hostVersion)

// 心跳必须豁免：被拦的话旧版客户端每 5 秒报错、设备列表也看不见人，
// 用户看到的是「连不上」，而真实原因只是「写需要升级」。
const staleJoin = await call('join', { deviceId: 'mock-stale-device', name: '旧版心跳' },
  { 'x-team-space-version': '0.0.1' })
ok('旧客户端心跳不被拦（否则像「连不上」）', staleJoin.data.ok === true, JSON.stringify(staleJoin.data))

const freshWrite = await call('entry/upsert', {
  table: 'repos', entry: { name: 'mock-fresh-write', url: 'https://example.com/fresh' },
}, { ...TEST, 'x-team-space-version': hostVersion })
ok('同版本客户端可写', freshWrite.data.ok === true, JSON.stringify(freshWrite.data).slice(0, 120))

const legacyWrite = await call('entry/upsert', {
  table: 'repos', entry: { name: 'mock-legacy-write', url: 'https://example.com/legacy' },
}, TEST)
ok('不带版本头的老客户端放行（服务端无法判断，只能放）', legacyWrite.data.ok === true,
  JSON.stringify(legacyWrite.data).slice(0, 120))

// 收尾
for (const name of ['mock-stale-write', 'mock-fresh-write', 'mock-legacy-write']) {
  const hit = ((await call('list', undefined, TEST)).data.tables?.repos ?? []).find(r => r.name === name)
  if (hit) await call('entry/remove', { table: 'repos', id: hit.id }, TEST)
}

server.close()
console.log(`\n结果：${checks - failed}/${checks} 通过${failed ? `，${failed} 条失败` : '，全部通过'}\n`)
process.exit(failed ? 1 : 0)
