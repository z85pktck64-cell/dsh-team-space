// 用 mock 宿主加载插件，真起 HTTP 服务验证「认领三段式 / 回执两段式」
// 这样不用重启 DSH 也能验证宿主半的新逻辑。
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'ts-mock-home-'))
process.env.DSH_HOME = home

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
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
  tools: { register: () => {} },
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

async function call(path, body) {
  const options = body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const response = await fetch(`${base}/${path}`, options)
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
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
ok('不带 since 返回全文', (full.data.text ?? '').length > 0, JSON.stringify(full.data).slice(0, 120))
const since = await call('local-session?sessionId=session-local-source&since=1500')
ok('带 since 只剩增量', since.data.throughSeq === 1, JSON.stringify(since.data).slice(0, 200))

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

server.close()
console.log(`\n结果：${checks - failed}/${checks} 通过${failed ? `，${failed} 条失败` : '，全部通过'}\n`)
process.exit(failed ? 1 : 0)
