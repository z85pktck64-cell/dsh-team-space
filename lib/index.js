/**
 * dsh-team-space — 宿主半（四表版）。
 *
 * 四张表：
 *   tasks    任务：会话分享 / 认领 / 回执（A/B/C）
 *   todos    团队待办：只做推荐清单，实际任务板仍是 DSH 的 team task / dsh-todo-panel
 *   plugins  插件：只存名称、版本、来源、审计结论、安装命令——**不代装**
 *   skills   SKILL：正文 + 内容 hash，认领 = 复制到本地
 *
 * 每条非任务记录都带 `version`（内容 sha256）与 `updatedAt`；
 * 更新时带上 baseVersion，版本不一致会被拒绝（手动更新 + 版本校验）。
 *
 * 会话认领/回执是三段式（跨设备必须这样，否则会话文件落在别人机器上打不开）：
 *   1. POST /claim          主服务器：标记认领 + 返回快照（{ mode:'remote', snapshot }）
 *   2. POST /import-session 成员本机：agents.create + 写快照 → { sessionId }
 *   3. POST /claim/commit   把副本 sessionId 回报主服务器（回执才知道从哪读）
 *   源会话就在本机时 /claim 直接返回 { mode:'local', sessionId }，一步到位。
 *
 * 路由：
 *   GET  /api/team-space/list
 *   POST /api/team-space/share    { sessionId, title }
 *   POST /api/team-space/share/submit  { ...快照 }   （成员模式：本机读快照后提交）
 *   POST /api/team-space/claim    { id, by } → { mode, sessionId?, snapshot? }
 *   POST /api/team-space/import-session { snapshot } → { sessionId }   （本机段）
 *   POST /api/team-space/claim/commit   { id, sessionId }
 *   POST /api/team-space/receipt  { shareId }        （副本在本机时）
 *   POST /api/team-space/receipt/submit { shareId, text }  （副本不在主服务器时）
 *   POST /api/team-space/entry/upsert { table, entry }
 *   POST /api/team-space/entry/remove { table, id }
 *   POST /api/team-space/remove   { id }   （任务表兼容）
 *   GET  /api/team-space/local-session?sessionId=&since=  （本机读快照，成员模式用）
 *
 * 安装是两段：/install-plugin（或 /install）只落地包并返回 checksum，
 * 不写 package.json / cordis.patch.yml；POST /plugin/enable { name, checksum } 才启用。
 * 中间那次「用户看着指纹确认」是唯一的信任边界。
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { homedir, networkInterfaces } from 'node:os'
import zlib from 'node:zlib'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path'

export const name = 'team-space'
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence', 'tools', 'connection', 'agents', 'agentDefaultModel']

const ROUTE = '/api/team-space'

/** 把插件登记进 profile 的 package.json dependencies —— loader 靠它解析插件包。 */
function registerProfileDependency(profileDir, name, version) {
  try {
    const file = join(profileDir, 'package.json')
    if (!existsSync(file)) return false
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    pkg.dependencies = pkg.dependencies ?? {}
    if (pkg.dependencies[name]) return true
    pkg.dependencies[name] = version ? `^${version}` : '*'
    renameSync(file, `${file}.bak-${Date.now()}`)
    pruneBackups(file)
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/** 把插件的 loader 行写进 profile 的 cordis.patch.yml（写前备份，已存在则跳过）。 */
function enablePluginRow(profileDir, pluginDir, shortName) {
  try {
    const profilePatch = join(profileDir, 'cordis.patch.yml')
    const current = existsSync(profilePatch) ? readFileSync(profilePatch, 'utf8') : ''
    const bundlePatch = join(pluginDir, 'cordis.patch.yml')
    let id = shortName
    const name = shortName
    if (existsSync(bundlePatch)) {
      const text = readFileSync(bundlePatch, 'utf8')
      const idMatch = text.match(/^\s*-?\s*id:\s*([\w@/.\-]+)/m)
      if (idMatch) id = idMatch[1]
    }
    const marker = `id: ${id}`
    if (current.includes(marker)) return 'already'
    if (existsSync(profilePatch)) {
      renameSync(profilePatch, `${profilePatch}.bak-${Date.now()}`)
      pruneBackups(profilePatch)
    }
    appendFileSync(profilePatch, `\n- insert:\n    - id: ${id}\n      name: ${name}\n`)
    return 'added'
  } catch {
    return 'failed'
  }
}

/** 找到当前 profile 的 node_modules 目录（插件安装位置）。 */
function profileNodeModules() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  try {
    for (const profile of readdirSync(profiles)) {
      const base = join(profiles, profile, 'node_modules')
      if (existsSync(join(base, '@local', 'dsh-team-space')) || existsSync(join(base, 'dsh-team-space'))) return base
    }
  } catch { /* 回退 */ }
  return join(profiles, 'desktop', 'node_modules')
}
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_ITEMS = 200
const MAX_TEXT_CHARS = 6_000
const MAX_FILES = 20
// handoffs 不能走通用 upsert：那样能直接把一条 open 委托写成 done，
// claim/complete 上的状态机护栏会被整条绕开。委托只能用 /handoff/* 专用路由。
const ENTRY_TABLES = ['todos', 'plugins', 'skills', 'repos']
/** 只读接口（/detail）能取的表。 */
const DETAIL_TABLES = ['tasks', 'todos', 'plugins', 'skills', 'repos', 'handoffs']
const MAX_BACKUPS = 5
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024
const JOIN_TTL_MS = 24 * 60 * 60 * 1000
/**
 * 「在线」的判定窗口。客户端每 5 分钟打一次心跳，这里容忍连丢两次给 15 分钟。
 * 别用 JOIN_TTL_MS —— 那是 24 小时，只适合算「有哪些设备曾经加入过」。
 */
const ONLINE_TTL_MS = 15 * 60 * 1000
/** 客户端日志上限：超过就只留最后 500 行。 */
const MAX_CLIENT_LOG_BYTES = 2 * 1024 * 1024
// 认领快照：事件流比文本大得多，超出就降级成文本快照，别把 claim 响应打满
const MAX_EXPORT_EVENTS = 5000
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
// 导入：事件来自网络，条数与体积都要封顶
const MAX_IMPORT_EVENTS = 5000
const MAX_IMPORT_BYTES = 8 * 1024 * 1024
const MAX_EVENT_BYTES = 256 * 1024

/** 错误码：前端按 code 分支，不要匹配中文文案。 */
const E = {
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  STATE_CONFLICT: 'STATE_CONFLICT',
  TOO_LARGE: 'TOO_LARGE',
}

const STATUS_OF = {
  [E.NOT_FOUND]: 404,
  [E.FORBIDDEN]: 403,
  [E.TOO_LARGE]: 413,
}

/** 带错误码的异常，route 会把它翻成 HTTP 状态码 + code 字段。 */
class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = E[code] ? code : E.BAD_REQUEST
  }
}

const fail = (code, message) => {
  throw new ApiError(code, message)
}

const HANDOFF_LABEL = { open: '待接收', doing: '进行中', done: '已完成', cancelled: '已取消' }

/** 委托允许的状态跳转。open 不能直接到 done —— 那会把「转人工/失败」伪造成执行结果。 */
const HANDOFF_NEXT = {
  open: ['doing', 'cancelled'],
  doing: ['done', 'cancelled'],
  done: [],
  cancelled: [],
}

/**
 * 委托状态流转的唯一入口：HTTP 路由和 agent 工具必须共用它，
 * 否则工具侧不校验就能把 open 直接写成 done（Codex 实测复现）。
 */
function assertHandoffTransition(record, next, by) {
  const current = record.status || 'open'
  if (current === next) {
    fail(E.STATE_CONFLICT, `这条委托已经是「${HANDOFF_LABEL[current] ?? current}」`)
  }
  if (!(HANDOFF_NEXT[current] ?? []).includes(next)) {
    fail(E.STATE_CONFLICT,
      `委托不能从「${HANDOFF_LABEL[current] ?? current}」直接变成「${HANDOFF_LABEL[next] ?? next}」，请先接收（claim）`)
  }
  if (next === 'doing') {
    if (!by) fail(E.BAD_REQUEST, '缺少接收人名字：先在我的资料里改个名字')
    if (record.target && record.target !== by) {
      fail(E.FORBIDDEN, `这条委托指定给「${record.target}」，你不能接收`)
    }
  }
  if (next === 'done' && record.assignee && by && record.assignee !== by) {
    fail(E.FORBIDDEN, `这条委托由「${record.assignee}」在执行，只有他能交回`)
  }
  return current
}

/** store 里真正的表；joins / hostDeviceId 不是表，不能被列表接口当成一张表遍历。 */
const TABLE_KEYS = ['tasks', 'todos', 'handoffs', 'plugins', 'skills', 'repos']

/**
 * child 是否真的落在 parent 目录内。
 * 用 startsWith 会把 /base_evil 当成 /base 的子目录 —— 必须按路径分段比。
 */
function isInside(parent, child) {
  const from = resolve(parent)
  const to = resolve(child)
  if (from === to) return true
  const rel = relative(from, to)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..'
}

/**
 * 包地址白名单。团队空间是局域网工具，明文 http 只放行本机与私有网段；
 * 公网地址必须 https —— 否则任何成员都能在条目里塞一个 http 地址让同事中招。
 *
 * 必须按「IP 字面量 + 网段」判断，不能用前缀正则：
 * `http://10.evil.com`、`http://192.168.evil.com` 都是公网域名，前缀正则会放行。
 */
function isAllowedPackageUrl(raw) {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false
    // URL 会把 IPv6 字面量规范成 [::1]，域名不会带方括号
    let host = parsed.hostname
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    if (host === '::1') return true
    if (net.isIP(host) === 6) return host === '::1' || host.startsWith('fe80') || host.startsWith('fd')
    // 域名一律不放行明文 http：10.evil.com 是域名不是 10/8
    if (net.isIP(host) !== 4) return false
    const octets = host.split('.').map(Number)
    if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
    const [a, b] = octets
    if (a === 127) return true                          // 回环
    if (a === 10) return true                           // 10/8
    if (a === 192 && b === 168) return true             // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true    // 172.16/12
    if (a === 169 && b === 254) return true             // 链路本地
    return false
  } catch {
    return false
  }
}

/** npm spec → 包名。@scope/pkg@1.2.3 不能简单按 '@' 切，否则结果为空串。 */
function specPackageName(spec) {
  const text = String(spec ?? '').trim()
  if (!text) return ''
  if (text.startsWith('@')) {
    const slash = text.indexOf('/')
    if (slash < 0) return ''
    const at = text.indexOf('@', slash)
    return at < 0 ? text : text.slice(0, at)
  }
  const at = text.indexOf('@')
  return at < 0 ? text : text.slice(0, at)
}

/**
 * 下载 tgz：每跳重定向都重新过白名单，边读边限体积。
 * 原来用 redirect:'follow' —— 内网地址 302 跳到公网后就不检查了；
 * 也先 arrayBuffer 再判大小 —— 声明的 content-length 可以撒谎，整包会先进内存。
 */
async function downloadPackage(url, limitBytes, hops = 0) {
  if (hops > 3) throw new Error('重定向次数过多，已中止')
  let response
  try {
    response = await fetch(url, { redirect: 'manual' })
  } catch (fetchError) {
    throw new Error(`下载失败：${String(fetchError?.message ?? fetchError)}`)
  }
  const status = response?.status ?? 0
  if (status >= 300 && status < 400) {
    const location = response.headers?.get?.('location')
    if (!location) throw new Error('重定向响应缺少 location，已中止')
    const next = new URL(location, url).href
    // 重定向目标必须重新过白名单：内网地址跳公网是典型绕过手法
    if (!isAllowedPackageUrl(next)) throw new Error('重定向目标地址不被允许，已中止')
    return downloadPackage(next, limitBytes, hops + 1)
  }
  if (!response.ok) throw new Error(`下载失败（HTTP ${status}）`)
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (declared > limitBytes) {
    throw new Error(`包体积 ${declared} 字节超过上限 ${limitBytes} 字节`)
  }
  const reader = response.body?.getReader?.()
  if (!reader) throw new Error('响应没有可读流，已中止')
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limitBytes) {
        throw new Error(`包体积超过上限 ${limitBytes} 字节，已中止`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    try { await reader.cancel() } catch { /* 已读完 */ }
  }
  return Buffer.concat(chunks)
}

/** tar -tvzf 的每一行以类型字符开头：l 是符号链接。 */
function tarHasSymlink(verbose) {
  return String(verbose ?? '').split('\n').some(line => line.startsWith('l'))
}

/**
 * 解压前先扫条目名：绝对路径、../、越界路径一律拒。
 * 原来先解压再检查 —— 检查到的时候文件已经写完了，等于没检查。
 */
async function safeExtractTgz(tmpFile, extractDir) {
  const [names, verbose] = await Promise.all([
    execFileAsync('tar', ['-tzf', tmpFile], { maxBuffer: 32 * 1024 * 1024 }),
    execFileAsync('tar', ['-tvzf', tmpFile], { maxBuffer: 32 * 1024 * 1024 }),
  ])
  if (tarHasSymlink(verbose.stdout)) {
    throw new Error('压缩包里含符号链接，已拒绝安装')
  }
  const entries = String(names.stdout ?? '').split('\n').filter(Boolean)
  for (const raw of entries) {
    const name = raw.replace(/\r$/, '')
    if (!name || name === './') continue
    if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
      throw new Error('压缩包里含绝对路径，已拒绝安装')
    }
    const normalized = normalize(name)
    if (normalized === '..' || normalized.startsWith('../') || normalized.split(sep).includes('..')) {
      throw new Error('压缩包里含路径穿越条目（..），已拒绝安装')
    }
  }
  mkdirSync(extractDir, { recursive: true })
  await execFileAsync('tar', ['-xzf', tmpFile, '-C', extractDir])
  // 解压后再兜底扫一遍：真有漏网的越界文件就整个临时目录删掉
  if (!isInside(extractDir, extractDir)) throw new Error('压缩包路径异常，已中止')
  return entries
}

/** 安装审计：记下来源与 sha256，启用时要求回传同一个指纹。 */
function installAuditPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'team-space-installs.json')
}

function readInstallAudit() {
  try {
    const raw = JSON.parse(readFileSync(installAuditPath(), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function writeInstallAudit(name, record) {
  const audit = readInstallAudit()
  audit[name] = record
  mkdirSync(dirname(installAuditPath()), { recursive: true })
  const tmp = `${installAuditPath()}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(audit, null, 2)}\n`)
  renameSync(tmp, installAuditPath())
}

/** 备份旧版本再替换；拷贝失败要能回滚。 */
async function installCopy(root, dest, stamp) {
  let backup = ''
  if (existsSync(dest)) {
    backup = `${dest}.bak-${stamp}`
    renameSync(dest, backup)
    pruneBackups(dest)
  }
  try {
    mkdirSync(dirname(dest), { recursive: true })
    await execFileAsync('cp', ['-R', `${root}/.`, dest])
  } catch (copyError) {
    if (backup) {
      try { renameSync(backup, dest) } catch { /* 回滚失败只能留备份 */ }
    }
    throw copyError
  }
}

/**
 * 真正启用：写 profile 的 package.json 依赖 + cordis.patch.yml 的 loader 行。
 * 只在用户拿着安装结果的 checksum 确认过之后才调。
 */
function enableInstalled(name, checksum) {
  const audit = readInstallAudit()[name]
  if (!audit) fail(E.NOT_FOUND, '没有这条安装记录，请重新安装')
  if (checksum && audit.checksum && audit.checksum !== checksum) {
    fail(E.FORBIDDEN, '指纹与安装时不一致，拒绝启用（包被换过，请重新安装）')
  }
  const base = profileNodeModules()
  const dest = resolve(base, name)
  if (!isInside(base, dest) || !existsSync(join(dest, 'package.json'))) {
    fail(E.NOT_FOUND, '插件目录不存在，请重新安装')
  }
  const short = name.includes('/') ? name.split('/').pop() : name
  registerProfileDependency(dirname(base), name, audit.version)
  const enabled = enablePluginRow(dirname(base), dest, short)
  writeInstallAudit(name, { ...audit, enabled: true, enabledAt: Date.now() })
  return enabled
}

/** 只保留最近 MAX_BACKUPS 份 .bak-<时间戳>，其余删掉。 */
function pruneBackups(file) {
  try {
    const dir = dirname(file)
    const base = basename(file)
    const stale = readdirSync(dir)
      .filter(name => name.startsWith(`${base}.bak-`))
      .sort()
      .reverse()
      .slice(MAX_BACKUPS)
    for (const name of stale) rmSync(join(dir, name), { force: true })
  } catch { /* 清理失败不影响主流程 */ }
}

function storePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'team-space.json')
}

function loadStore() {
  try {
    const raw = JSON.parse(readFileSync(storePath(), 'utf8'))
    return {
      tasks: Array.isArray(raw?.tasks) ? raw.tasks : Array.isArray(raw?.items) ? raw.items : [],
      joins: Array.isArray(raw?.joins) ? raw.joins : [],
      todos: Array.isArray(raw?.todos) ? raw.todos : [],
      handoffs: Array.isArray(raw?.handoffs) ? raw.handoffs : [],
      plugins: Array.isArray(raw?.plugins) ? raw.plugins : [],
      skills: Array.isArray(raw?.skills) ? raw.skills : [],
      repos: Array.isArray(raw?.repos) ? raw.repos : [],
      hostDeviceId: typeof raw?.hostDeviceId === 'string' ? raw.hostDeviceId : '',
    }
  } catch {
    return { tasks: [], joins: [], todos: [], plugins: [], skills: [], repos: [], handoffs: [], hostDeviceId: '' }
  }
}

let cachedHostId = ''

/** 设备 id 单独存：hostDeviceId 是同步函数，不能承担 store 的异步写锁。 */
function deviceIdPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'team-space-device.json')
}

/**
 * 本机在团队空间里的稳定 id。agent 工具发起委托时拿不到浏览器的 deviceId，
 * 用它当 requesterDeviceId，结果回导才认得出「这条是我发起的」。
 */
function hostDeviceId() {
  if (cachedHostId) return cachedHostId
  try {
    let id = ''
    try {
      id = String(JSON.parse(readFileSync(deviceIdPath(), 'utf8'))?.id ?? '')
    } catch { /* 还没有 */ }
    if (!id.startsWith('host-')) {
      id = `host-${randomUUID()}`
      mkdirSync(dirname(deviceIdPath()), { recursive: true })
      const tmp = `${deviceIdPath()}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ id }, null, 2)}\n`)
      renameSync(tmp, deviceIdPath())
    }
    cachedHostId = id
  } catch {
    cachedHostId = ''
  }
  return cachedHostId
}

/**
 * 请求者身份。注意：这里没有认证，deviceId 是客户端自己在 query 里报的，
 * 所以它只能用来「防误看」，不能当安全边界——改一下参数就能冒充主服务器。
 * 要真隔离得先有成员凭证，那是另一件事。
 */
function viewerOf(req) {
  let deviceId = ''
  let name = ''
  try {
    const url = new URL(req.url, 'http://local')
    deviceId = clip(url.searchParams.get('deviceId'), 120)
    name = clip(url.searchParams.get('name'), 80)
  } catch { /* 没有 query 就当匿名 */ }
  return { deviceId, name, isHost: Boolean(deviceId) && deviceId === hostDeviceId() }
}

/** 名字 → 设备 id：取最近一次心跳。同一个人多台机器时以最新为准。 */
function deviceIdOfMember(name) {
  if (!name) return ''
  try {
    const hit = (loadStore().joins ?? [])
      .filter(item => item?.name === name && item?.deviceId)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
    return hit?.deviceId ?? ''
  } catch {
    return ''
  }
}

/**
 * 委托可见性：指定给某人的委托，只有被指定人、发起人和主服务器看得到。
 * target 为空表示「谁都能接」，仍然公开。
 * 拿不到任何身份的老客户端保持旧行为（全可见），否则升级当天会像「委托全丢了」。
 */
function handoffVisibleTo(record, viewer) {
  if (viewer.isHost) return true
  if (!record?.target) return true
  if (!viewer.deviceId && !viewer.name) return true
  // 名字大小写不敏感：记录里的 owner 可能是 "Xinzhan"，成员名是 "xinzhan"，
  // 直接比会让发起人看不到自己发出去的委托。
  const same = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase()
  if (same(record.target, viewer.name)) return true
  if (same(record.owner, viewer.name)) return true
  if (record.requesterDeviceId && record.requesterDeviceId === viewer.deviceId) return true
  const targetDevice = deviceIdOfMember(record.target)
  return Boolean(targetDevice) && targetDevice === viewer.deviceId
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

/** store 锁内容：pid + token，释放时只删自己那把（原来无条件 unlink，会删掉别人的锁）。 */
const LOCK_TOKEN = `${process.pid}-${randomUUID()}`

function lockPath() {
  return `${storePath()}.lock`
}

function tryLock() {
  try {
    const fd = openSync(lockPath(), 'wx')
    writeSync(fd, LOCK_TOKEN)
    closeSync(fd)
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    // 目录不可写之类的硬错误：不再等待，直接让上层写（退化成无锁）
    return true
  }
}

/** 陈旧锁判定：持有者进程还活着就不能动它（原来只看 mtime，会误删活锁）。 */
function stealStaleLock() {
  try {
    const content = readFileSync(lockPath(), 'utf8').trim()
    const pid = Number(content.split('-')[0])
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        return false // 进程还在
      } catch (killError) {
        if (killError?.code !== 'EPERM') {
          unlinkSync(lockPath())
          return true
        }
        return false
      }
    }
    unlinkSync(lockPath())
    return true
  } catch {
    return false
  }
}

function releaseLock() {
  try {
    if (readFileSync(lockPath(), 'utf8').trim() === LOCK_TOKEN) unlinkSync(lockPath())
  } catch { /* 锁已释放或不属于自己 */ }
}

/**
 * store 是单文件全量读写：load → 改 → save 必须整体在锁里，
 * 只锁 save 的话两个进程仍会各读一份旧快照再互相覆盖。
 * 等待用 setTimeout，不用 Atomics.wait（原来会同步阻塞宿主事件循环最多 3 秒）。
 */
async function withStoreLock(fn) {
  const started = Date.now()
  for (;;) {
    if (tryLock()) break
    if (Date.now() - started > 3000) {
      // 超时不再写：宁可报错也不要基于过期快照覆盖别人的数据
      throw new Error('团队空间正被另一个进程写入，请稍后重试')
    }
    try {
      if (Date.now() - statSync(lockPath()).mtimeMs > 10_000 && stealStaleLock()) continue
    } catch { /* 锁刚被释放，下一轮重试 */ }
    await sleep(20)
  }
  try {
    return await fn()
  } finally {
    releaseLock()
  }
}

/** 读改写一把锁做完：load → mutator → save。 */
async function mutateStore(mutator) {
  return withStoreLock(async () => {
    const store = loadStore()
    const result = await mutator(store)
    writeStore(store)
    return result
  })
}

/** 不加锁地落盘（只允许在已持锁的上下文里调）。 */
function writeStore(store) {
  const target = storePath()
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`)
    renameSync(tmp, target)
  } catch (failure) {
    try { unlinkSync(tmp) } catch { /* 清理残留 tmp */ }
    throw failure
  }
}

async function saveStore(store) {
  return withStoreLock(async () => {
    writeStore(store)
  })
}

const execFileAsync = promisify(execFile)

/** 这个包是否已经装在本机任一 profile 的 node_modules 里。 */
function installedInfo(name) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = join(home, 'profiles')
  const short = name.includes('/') ? name.split('/').pop() : name
  const candidates = []
  try {
    for (const profile of readdirSync(root)) {
      const base = join(root, profile, 'node_modules')
      candidates.push(join(base, name), join(base, '@local', short))
    }
    // 有些安装方式的插件就在 profiles/node_modules 下（没有 profile 子层）
    candidates.push(join(root, 'node_modules', name), join(root, 'node_modules', '@local', short))
  } catch {
    return { installed: false, installedVersion: '' }
  }
  for (const dir of candidates) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const version = JSON.parse(readFileSync(manifest, 'utf8')).version ?? ''
      let installedClientSha = ''
      try {
        const clientFile = join(dir, 'lib', 'client.js')
        if (existsSync(clientFile)) installedClientSha = hashOfText(readFileSync(clientFile, 'utf8'))
      } catch { /* 读不到就不判断代码指纹 */ }
      return { installed: true, installedVersion: String(version), installedClientSha }
    } catch {
      return { installed: true, installedVersion: '' }
    }
  }
  return { installed: false, installedVersion: '' }
}

/** 取一个非回环 IPv4，作为成员要填的主机地址。 */
function lanAddress() {
  const interfaces = networkInterfaces()
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

/** 8080 上有没有网关在听。 */
function gatewayRunning() {
  return new Promise(resolve => {
    const socket = net.connect({ port: 8080, host: '127.0.0.1' })
    const done = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(700, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** 能力词库：模块按团队实际业务自定义，角色按团队分工。 */
const CAPABILITY_DICT = {
  roles: ['产品', '测试', '客户端开发', 'Web开发', '后台开发', '设计', '3D'],
  modules: [
    // 示例词库：换成你自己团队的模块名即可（这里刻意用通用 App 模块，不绑定任何产品或公司）
    '登录注册', '支付', '消息推送', '设置', '地图导航', '音乐播放', '相册', '搜索',
    '订单', '购物车', '个人中心', '通知栏', '文件管理', '相机', '蓝牙', 'OTA',
  ],
  platforms: ['Android', 'iOS', '车机', '鸿蒙', 'Web', '后台', '服务端'],
  tech: ['Flutter', 'Kotlin', 'Gradle', 'APK', 'Python', 'Node', 'SQL', 'Jetpack', 'Compose'],
}

const ROLE_HINTS = {
  产品: ['产品', 'prd', '需求', '方案', '评审', '路标'],
  测试: ['测试', '用例', '回归', '验收', 'crash', 'bug'],
  客户端开发: [
    '客户端', 'android', 'ios', 'app', 'kotlin', 'java', 'apk', '编译', 'gradle',
    'activity', 'fragment', 'recyclerview', 'compose', 'jetpack', 'adb', 'studio',
    'launcher', 'systemui', '车机', '安卓', 'androidstudio', 'flutter',
  ],
  Web开发: ['web', '前端', 'h5', '页面', 'react', 'vue', 'css', 'html', '组件库'],
  后台开发: ['后台', '服务端', '接口', '数据库', 'api', 'sql', '网关', '微服务', '部署'],
  设计: ['设计', 'ui', '交互', '视觉', '原型', 'figma', '切图', '动效'],
  '3D': ['3d', '建模', '渲染', '场景', '车模', '材质', 'shader'],
}

/** 从会话标题里统计能力标签（只在本机跑，不上传原文）。 */
function suggestCapabilities(titles) {
  const hay = titles.join(' \n ').toLowerCase()
  const scored = new Map()
  const bump = (label, weight = 1) => scored.set(label, (scored.get(label) ?? 0) + weight)

  for (const item of [...CAPABILITY_DICT.modules, ...CAPABILITY_DICT.platforms, ...CAPABILITY_DICT.tech]) {
    const needle = item.toLowerCase()
    const count = hay.split(needle).length - 1
    if (count > 0) bump(item, count)
  }
  for (const [role, hints] of Object.entries(ROLE_HINTS)) {
    const hits = hints.filter(hint => hay.includes(hint.toLowerCase())).length
    if (hits > 0) bump(role, hits)
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([label, count]) => ({ label, count }))
}

/** 从目录向上找 git 仓库根（最多 4 层），返回仓库名。 */
function findRepo(dir) {
  let current = String(dir || '')
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || current === '/') break
    if (existsSync(join(current, '.git'))) return { name: basename(current), path: current }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** 从 git config 里读 remote url（只读，失败返回空）。 */
function repoRemote(repoPath) {
  try {
    const text = readFileSync(join(repoPath, '.git', 'config'), 'utf8')
    const match = text.match(/url\s*=\s*(.+)/)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

/** 扫常见代码根（深度 2），找本机 git 仓库名。只读、限量。 */
function scanRepos(limit = 40) {
  const roots = [
    join(homedir(), 'WorkBuddy'),
    join(homedir(), 'Documents'),
    join(homedir(), 'Developer'),
    join(homedir(), 'code'),
    join(homedir(), 'workspace'),
  ]
  const found = new Set()
  for (const root of roots) {
    if (found.size >= limit) break
    if (!existsSync(root)) continue
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true }).slice(0, 80)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const dir = join(root, entry.name)
      try {
        if (existsSync(join(dir, '.git'))) {
          found.add(dir)
          continue
        }
        for (const sub of readdirSync(dir, { withFileTypes: true }).slice(0, 40)) {
          if (!sub.isDirectory() || sub.name.startsWith('.') || sub.name === 'node_modules') continue
          if (existsSync(join(dir, sub.name, '.git'))) found.add(join(dir, sub.name))
        }
      } catch {
        /* 跳过无权限目录 */
      }
    }
  }
  return [...found].slice(0, limit)
}

function hashOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashOfText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

/** 本机是否已有这个 skill，以及本地文件的文本 hash。 */
function localSkillInfo(name) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'skills', name, 'SKILL.md')
  if (!existsSync(file)) return { installed: false, installedHash: '' }
  try {
    // 存档时 content 经过 trim（clip），本地比较也要用同样的规范化
    return { installed: true, installedHash: hashOfText(readFileSync(file, 'utf8').trim()) }
  } catch {
    return { installed: true, installedHash: '' }
  }
}

/** 写 peer 配置（页面上的"连接主服务器"用）。 */
function writePeerConfig(input) {
  const raw = clip(input?.serverUrl, 500).replace(/\/+$/, '')
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'storages', 'team-space-peer.json')
  if (!raw) {
    try { unlinkSync(file) } catch { /* 本来就不存在 */ }
    return { serverUrl: '' }
  }
  if (!/^https?:\/\/[^\s]+$/.test(raw)) throw new Error('serverUrl 必须是 http(s) 地址')
  const normalized = raw.endsWith('/api/team-space') ? raw : `${raw}/api/team-space`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ serverUrl: normalized }, null, 2)}\n`)
  return { serverUrl: normalized }
}

/** 同事机器上的配置：指向"你的"团队的团队空间 API。 */
function peerConfig() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    const raw = JSON.parse(readFileSync(join(home, 'storages', 'team-space-peer.json'), 'utf8'))
    return { serverUrl: typeof raw?.serverUrl === 'string' ? raw.serverUrl.replace(/\/$/, '') : '' }
  } catch {
    return { serverUrl: '' }
  }
}

function send(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  // 跨机访问时浏览器会做 CORS 检查；这个 API 本来就是被成员跨域调用的。
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  res.end(JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function clip(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .filter(block => !block.text.includes('<system-reminder>'))
    .map(block => block.text)
    .join('\n')
    .trim()
}

function messageText(event) {
  if (event?.type === 'user/message') return textOf(event.data?.content)
  if (event?.type === 'assistant/message') return textOf(event.data?.message?.content)
  return ''
}

/**
 * 分享只保留预览：完整历史在认领时通过复制事件日志给到，
 * 团队空间里存全文只会让 JSON 和列表越来越重。
 */
function renderTranscript(events, title, maxChars = MAX_TEXT_CHARS) {
  const lines = [title ? `# ${title}` : '# 会话分享', '']
  let turns = 0
  for (const event of events ?? []) {
    const text = messageText(event)
    if (!text) continue
    lines.push(event.type === 'user/message' ? '## 用户' : '## 助手', '', text, '')
    turns++
  }
  const body = lines.join('\n')
  if (body.length <= maxChars) return body
  const half = Math.floor(maxChars / 2)
  const omitted = Math.max(0, turns - 2)
  return `${body.slice(0, half)}\n\n…（中间省略约 ${omitted} 条消息；认领这份会话可拿到完整历史）…\n\n${body.slice(-half)}`
}

function extractFiles(events) {
  const FILE_KEYS = new Set(['file_path', 'filePath', 'path', 'notebook_path', 'file', 'target'])
  const files = new Set()
  const visit = (value, key) => {
    if (typeof value === 'string') {
      const text = value.trim()
      if (key && FILE_KEYS.has(key) && text.length > 2 && text.length < 400
        && !text.includes('\n') && /^(?:\/|\.\.?\/|[A-Za-z]:[\\/])/.test(text)) {
        files.add(text)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key)
      return
    }
    if (value && typeof value === 'object') {
      for (const [childKey, item] of Object.entries(value)) visit(item, childKey)
    }
  }
  for (const event of events ?? []) {
    if (event?.type !== 'tool/call') continue
    try {
      visit(JSON.parse(event.data?.arguments ?? '{}'), '')
    } catch {
      /* 参数不是 JSON 就跳过 */
    }
    if (files.size >= MAX_FILES * 4) break
  }
  return [...files].slice(0, MAX_FILES)
}

async function createTextSession(ctx, cwd, text) {
  const sessionId = `session-${randomUUID()}`
  const now = Date.now()
  const handle = await ctx.sessionPersistence.create({
    version: 4, id: sessionId, createdAt: now, cwd, isSeeded: false, agentPreset: 'standard',
  })
  try {
    await handle.append([{
      type: 'user/message',
      seq: 0,
      time: now,
      data: {
        role: 'user',
        content: [{ type: 'text', text: text || '(空分享)' }],
        source: { kind: 'user' },
        id: randomUUID(),
      },
      surfaceOp: 'append',
    }])
    await handle.flush()
  } finally {
    await handle.close()
  }
  return sessionId
}

async function copySession(ctx, sourceId, cwd) {
  let source
  try {
    source = await ctx.sessionPersistence.open(sourceId, 'read')
    const { events } = await source.read()
    if (!Array.isArray(events) || events.length === 0) return null
    const sessionId = `session-${randomUUID()}`
    const remap = value => {
      if (typeof value === 'string') return value === sourceId ? sessionId : value
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]))
      }
      return value
    }
    const handle = await ctx.sessionPersistence.create({
      version: 4, id: sessionId, createdAt: Date.now(), cwd, isSeeded: false, agentPreset: 'standard',
    })
    try {
      await handle.append(events.map(remap))
      await handle.flush()
    } finally {
      await handle.close()
    }
    return sessionId
  } catch (error) {
    console.error('[team-space] 复制会话失败，退回文本快照', error)
    return null
  } finally {
    try {
      await source?.close()
    } catch {
      /* 已关闭 */
    }
  }
}

/** 认领时用的默认模型：agents.create 的 persona 需要一个具体 model。 */
function currentModelOptions(ctx) {
  try {
    const selection = ctx.agentDefaultModel.currentSelection()
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch (error) {
    console.error('[team-space] 读取默认模型失败', error)
  }
  return {}
}

/**
 * 用官方 agent 创建路径建会话（持久化 + announce）。
 * 认领必须走这条：只调 sessionPersistence.create 的会话只写盘、不广播，
 * 浏览器端会话目录不认识它 —— 前端 openSession 打不开、侧栏也没有新增（2026-10-22 实测）。
 */
async function createAnnouncedSession(ctx, cwd, buildSeed) {
  const agentOptions = currentModelOptions(ctx)
  const attempt = async meta => {
    const sessionId = `session-${randomUUID()}`
    await ctx.agents.create({ sessionId, meta, agentOptions, seed: buildSeed(sessionId) })
    return sessionId
  }
  try {
    return await attempt({ cwd, agentPreset: 'standard' })
  } catch (error) {
    console.error('[team-space] standard preset 建认领会话失败，改用默认 preset', error)
    return attempt({ cwd })
  }
}

/** 复制源会话事件，但通过 agent 创建（有 announce），返回新 sessionId。 */
async function copySessionAnnounced(ctx, sourceId, cwd) {
  let events = null
  let source
  try {
    source = await ctx.sessionPersistence.open(sourceId, 'read')
    const read = await source.read()
    if (Array.isArray(read.events) && read.events.length) events = read.events
  } catch (error) {
    console.error('[team-space] 读取源会话失败，退回文本快照', error)
  } finally {
    try {
      await source?.close()
    } catch {
      /* 已关闭 */
    }
  }
  if (!events) return null
  return createAnnouncedSession(ctx, cwd, sessionId => {
    const remap = value => {
      if (typeof value === 'string') return value === sourceId ? sessionId : value
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]))
      }
      return value
    }
    return events.map(remap)
  })
}

/** 文本快照的种子事件（源会话读不出来时的兜底）。 */
function textSeed(text) {
  return () => [{
    type: 'user/message',
    seq: 0,
    time: Date.now(),
    data: {
      role: 'user',
      content: [{ type: 'text', text: text || '(空分享)' }],
      source: { kind: 'user' },
      id: randomUUID(),
    },
    surfaceOp: 'append',
  }]
}

/** 回执只交「上次交回之后」的新事件；没交过就交认领之后的全部。 */
function freshEvents(events, claim) {
  const since = claim?.since ?? claim?.at ?? 0
  const fresh = since > 0 ? events.filter(event => (event?.time ?? 0) > since) : events
  return fresh.length ? fresh : events.slice(-1)
}

function buildReceipt(item, shareId, fresh) {
  return {
    id: randomUUID(),
    kind: 'receipt',
    parentId: shareId,
    title: `回执：${item.title}`,
    text: renderTranscript(fresh, `回执：${item.title}`),
    fromSessionId: item.claim?.sessionId ?? '',
    createdAt: Date.now(),
  }
}

/** 导入用的工作目录：远端给的 cwd 本机未必存在，不存在就退回当前目录。 */
function pickCwd(input) {
  const cwd = clip(input, 500)
  if (cwd) {
    try {
      if (existsSync(cwd) && statSync(cwd).isDirectory()) return cwd
    } catch { /* 退回当前目录 */ }
  }
  return process.cwd()
}

/**
 * 会话目录名就是 cwd 的编码：'/' → '-'，非 ASCII → '~XXXX'，首尾各包 '--'。
 * 例如 `--Volumes-~672C~5730~78C1~76D8~FF1AD-DSH--` 解出来是 `/Volumes/本地磁盘：D/DSH`。
 * 解不出来就返回空串（宁可退回 process.cwd()，也不要凭空造一个路径）。
 */
function decodeSessionDir(name) {
  const body = name.replace(/^--/, '').replace(/--$/, '')
  if (!body) return ''
  let out = '/'
  for (let i = 0; i < body.length;) {
    const ch = body[i]
    if (ch === '~') {
      const code = Number.parseInt(body.slice(i + 1, i + 5), 16)
      if (!Number.isFinite(code)) return ''
      out += String.fromCharCode(code)
      i += 5
    } else if (ch === '-') {
      out += '/'
      i += 1
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

/**
 * 会话的真实 cwd 只记在会话文件第一行，目录名不可靠：
 * `dsh-team-space` 与 `dsh/team/space` 编码后一模一样（'-' 既是分隔符也是字面连字符），
 * 按目录名反推会把路径解错（实测 `dsh-team-space` 被解成 `dsh/team/space`）。
 * 所以优先读文件；解不开再退回目录名，反正最后都要 statSync 存在性。
 */
function sessionCwd(dir) {
  const zstd = zlib.zstdDecompressSync
  if (typeof zstd !== 'function') return ''
  try {
    const subs = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('session-'))
      .map(entry => ({ name: entry.name, at: statSync(join(dir, entry.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const { name } of subs) {
      const file = join(dir, name, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const text = zstd(readFileSync(file)).toString('utf8')
      const first = text.slice(0, text.indexOf('\n'))
      const meta = JSON.parse(first)
      if (meta?.cwd) return meta.cwd
    }
  } catch { /* 读不出就看下一个会话 */ }
  return ''
}

/**
 * 最近用过的项目目录：扫 ~/.dsh/sessions 下最新的会话，读它真实的 cwd。
 *
 * 这是 cwd 的第二来源。第一来源（ctx.sessionQuery.listSessions）实测不存在——
 * 该服务只导出 searchSessions / searchEvents / close，调用会抛 TypeError 被静默吞掉，
 * 于是 bug 表现为「改了但没效果」：委托建的会话始终落在 ~/.dsh/profiles/desktop。
 */
function recentProjectCwd(home) {
  const root = join(home, 'sessions')
  const profilesRoot = join(home, 'profiles')
  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({ name: entry.name, at: statSync(join(root, entry.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
  } catch {
    return ''
  }
  for (const { name } of dirs) {
    const dir = join(root, name)
    const cwd = sessionCwd(dir) || decodeSessionDir(name)
    if (!cwd || cwd.startsWith(profilesRoot)) continue
    try {
      if (statSync(cwd).isDirectory()) return cwd
    } catch { /* 目录已删，看下一个 */ }
  }
  return ''
}

/**
 * 最近会话的 id（从 ~/.dsh/sessions 的目录名取）。只做一件事：给
 * ctx.sessionQuery.readTitleSnapshots 提供 id 列表。
 *
 * 为什么不用 ctx.sessionQuery.listSessions：本版本该服务只导出 searchSessions /
 * searchEvents / close，调用会抛 TypeError 被 catch 吞掉，表现成「生成能力卡返回空」。
 * 为什么不直接读会话文件：Node 的 zstdDecompressSync 只解第一帧（实测每个文件只出
 * 199-217 字符），而标题在后续帧里，所以文件路走不通。
 */
function recentSessionIds(home, limit = 80) {
  const root = join(home, 'sessions')
  const found = []
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const base = join(root, dir.name)
      let subs = []
      try {
        subs = readdirSync(base, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of subs) {
        // 目录名就是 session id，别把 `session-` 前缀剥掉：会话文件里记的是
        // "id":"session-xxxx"，剥掉前缀去查一个都匹配不上（全是 rejected）。
        if (!sub.isDirectory() || !/^session-[0-9a-f-]{36}$/.test(sub.name)) continue
        const file = join(base, sub.name, 'session.v4.jsonl.zstd')
        if (!existsSync(file)) continue
        try {
          // 按「会话文件」mtime 排，不是目录 mtime：目录 mtime 会把刚建、还没生成
          // 标题的会话排到前面，实测按目录排取 80 个只有 3 个有标题，按文件排有 25 个。
          found.push({ id: sub.name, at: statSync(file).mtimeMs })
        } catch { /* skip */ }
      }
    }
  } catch {
    return []
  }
  return found.sort((a, b) => b.at - a.at).slice(0, limit).map(item => item.id)
}

/**
 * 取这条分享在某个设备上的认领记录。
 * 多人各自认领后 claims 里有多份；没有 by 就退回最后一次认领（老数据只有 claim）。
 */
function claimOf(item, by) {
  const claims = item?.claims
  if (by && claims?.[by]) return claims[by]
  if (!by && item?.claim?.sessionId) return item.claim
  const list = Object.values(claims ?? {})
  return list.length ? list[list.length - 1] : (item?.claim ?? null)
}

/** 只写盘、不广播地落一份会话（agents.create 不可用时的最后兜底）。 */
async function persistEvents(ctx, cwd, seed) {
  const sessionId = `session-${randomUUID()}`
  const handle = await ctx.sessionPersistence.create({
    version: 4, id: sessionId, createdAt: Date.now(), cwd, isSeeded: false, agentPreset: 'standard',
  })
  try {
    await handle.append(seed(sessionId))
    await handle.flush()
  } finally {
    await handle.close()
  }
  return sessionId
}

/** 请求是否来自本机回环地址。 */
function isLoopbackRequest(req) {
  const addr = String(req?.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
  return addr === '' || addr === '127.0.0.1' || addr === '::1'
}

/** 本机是否真的持有这个会话的事件（读不到就说明会话在别人机器上）。 */
async function localEvents(ctx, sessionId) {
  if (!sessionId) return null
  try {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    const events = snapshot?.events
    if (!Array.isArray(events) || events.length === 0) return null
    return { events, cwd: snapshot?.session?.cwd ?? '' }
  } catch {
    return null
  }
}

/**
 * 认领快照。
 * 源会话就在这台机器上 → 给完整事件流（对方导入后是完整副本）；
 * 否则只能给分享时留下的文本快照 —— 主服务器没有别人的会话文件。
 */
async function claimSnapshot(ctx, item) {
  const local = await localEvents(ctx, item.sessionId)
  if (local) {
    const events = local.events.slice(-MAX_EXPORT_EVENTS)
    if (Buffer.byteLength(JSON.stringify(events), 'utf8') <= MAX_SNAPSHOT_BYTES) {
      return {
        kind: 'events',
        sourceSessionId: item.sessionId ?? '',
        title: item.title ?? '未命名会话',
        cwd: local.cwd || item.cwd || '',
        events,
        files: Array.isArray(item.files) ? item.files.slice(0, MAX_FILES) : [],
      }
    }
  }
  return {
    kind: 'text',
    sourceSessionId: item.sessionId ?? '',
    title: item.title ?? '未命名会话',
    cwd: item.cwd ?? '',
    text: item.text ?? '',
    files: Array.isArray(item.files) ? item.files.slice(0, MAX_FILES) : [],
  }
}

/** 导入的事件来自网络：只留白名单字段、限条数与体积，别把脏数据写进本机会话。 */
function sanitizeIncomingEvents(input) {
  if (!Array.isArray(input)) return null
  const events = []
  let bytes = 0
  for (const raw of input.slice(0, MAX_IMPORT_EVENTS)) {
    if (!raw || typeof raw !== 'object') continue
    const type = typeof raw.type === 'string' ? raw.type.slice(0, 64) : ''
    if (!type) continue
    const event = {
      type,
      seq: Number.isFinite(raw.seq) ? raw.seq : events.length,
      time: Number.isFinite(raw.time) ? raw.time : Date.now(),
      data: raw.data ?? null,
      ...(raw.surfaceOp ? { surfaceOp: String(raw.surfaceOp).slice(0, 32) } : {}),
    }
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (size > MAX_EVENT_BYTES) continue
    bytes += size
    if (bytes > MAX_IMPORT_BYTES) break
    events.push(event)
  }
  return events.length ? events : null
}

/**
 * 认领第 2 段（成员本机执行）：把快照写成一台真会话。
 * 会话文件必须建在「要打开它」的那台机器上 —— 主服务器代建的副本，成员 openSession 打不开。
 */
async function importSnapshot(ctx, snapshot, cwd) {
  const events = snapshot?.kind === 'events' ? sanitizeIncomingEvents(snapshot.events) : null
  const sourceId = clip(snapshot?.sourceSessionId, 200)
  const seedOf = events
    ? sessionId => {
      const walk = value => {
        if (typeof value === 'string') return value === sourceId ? sessionId : value
        if (Array.isArray(value)) return value.map(walk)
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
        }
        return value
      }
      return events.map(walk)
    }
    : textSeed(clip(snapshot?.text, 400_000))
  const kind = events ? 'events' : 'text'
  try {
    return { sessionId: await createAnnouncedSession(ctx, cwd, seedOf), kind }
  } catch (error) {
    console.error('[team-space] 带广播的导入失败，退回纯写盘', error)
    return { sessionId: await persistEvents(ctx, cwd, seedOf), kind }
  }
}

/** 每张表的可写字段与长度上限。 */
const FIELDS = {
  todos: { title: 200, owner: 80, status: 20, note: 2000 },
  handoffs: { title: 200, owner: 80, target: 80, status: 20, brief: 4000, result: 20000, note: 2000 },
  plugins: { name: 120, version: 60, source: 300, audit: 2000, installCommand: 1000, note: 2000, clientSha: 64 },
  skills: { name: 80, description: 200, content: 200_000 },
  repos: { name: 120, url: 500, description: 1000, owner: 80, tags: 200, branch: 200, note: 2000, verifiedAt: 40 },
}

function sanitizeEntry(table, input) {
  const fields = FIELDS[table]
  const record = {}
  for (const [key, max] of Object.entries(fields)) {
    record[key] = clip(input?.[key], max)
  }
  return record
}

/**
 * 头像只接受 http(s) 与 data:image。
 * 原来只 clip：外部头像 URL 会变成访问信标（谁看了团队空间、什么时候看的，对方服务器全知道）。
 */
function safeAvatar(raw) {
  const text = clip(raw, 20000)
  if (!text) return ''
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(text)) return text
  try {
    const parsed = new URL(text)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return text
  } catch { /* 不是 URL */ }
  return ''
}

/** 作者身份的比较键：去空白 + 忽略大小写，避免 Xinzhan / xinzhan 被当成两个人。 */
function authorKey(name) {
  return String(name ?? '').trim().replace(/\s+/g, '').toLowerCase()
}

function normalizeAuthor(input) {
  if (!input) return null
  const name = clip(input.name, 60)
  if (!name) return null
  return { name, avatar: safeAvatar(input.avatar) }
}

/**
 * 本机在团队空间里的作者身份。
 * agent 工具拿不到浏览器身份，一律不带 author —— 没有这个兜底，
 * 「无作者更新」就能静默覆盖别人发布的东西。
 */
function deviceAuthor() {
  try {
    const store = loadStore()
    const member = (store.skills ?? []).find(item => item.member && item.memberName)
    if (member) return { name: member.memberName }
  } catch { /* 读不到就用设备号 */ }
  const id = hostDeviceId()
  return { name: id ? `本机 ${id.slice(0, 8)}` : '本机' }
}

function versionOf(table, record) {
  return hashOf(sanitizeEntry(table, record))
}

/** 把简写 spec 转成 registry 接受的 JSON Schema。 */
function specToSchema(spec) {
  const required = []
  const properties = {}
  for (const [key, definition] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = definition
    if (isRequired) required.push(key)
    properties[key] = rest
  }
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }
}

/** 本地 defineTool：registry 只要求 output.render 是函数，其余字段原样传递。 */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToSchema(options.parameters),
    output: {
      schema: options.output.schema,
      // registry 会把 render 的返回值当作 content blocks 数组处理；
      // 之前返回空字符串会导致 content.some is not a function。
      // 注意签名是 (args, value)：宿主调用时第一个参数是参数对象，第二个才是 execute 的返回值。
      // 早期把第一个形参直接当成结果用，拿到的一直是 args，于是无参工具永远渲染成 {}。
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}, null, 2) }],
    },
    async execute(args) {
      return options.execute(args)
    },
  }
}

/**
 * 一条记录的创建/更新（带版本校验），路由与 agent 工具共用。
 *
 * 作者必须始终有值：agent 工具一律不带 author，原来会退化成「无作者」，
 * 于是任何同名条目都能被静默覆盖（Codex 实测复现）。没有显式作者就绑本机身份。
 * 换作者 = 接管别人的记录，必须同时满足「baseVersion 对得上」+「显式声明 takeOver」。
 */
async function upsertEntry(table, input) {
  return mutateStore(store => {
    const list = store[table] ?? []
    // 对话工具只给 name，不给 id：同名视为"更新这条"，否则每次都会插入新记录。
    const byName = input?.name ? list.find(entry => entry.name === input.name) : undefined
    const id = clip(input?.id, 200) || byName?.id || randomUUID()
    const existing = list.find(entry => entry.id === id) ?? byName
    const currentHash = existing?.contentHash ?? existing?.version
    if (existing && input?.baseVersion && currentHash !== input.baseVersion) {
      fail(E.VERSION_CONFLICT, '这条记录已被别人更新过，请刷新后再改')
    }
    const nextAuthor = normalizeAuthor(input?.author) ?? (existing ? deviceAuthor() : null)
    // 作者名按「归一化后」比较：条目作者是 Xinzhan、本机 join 名是 xinzhan 是同一个人，
    // 逐字符比会把本人更新判成「换作者接管」，逼着用户去带 takeOver。
    const prevKey = authorKey(existing?.author?.name)
    const nextKey = authorKey(nextAuthor?.name)
    // 报错要显示人看得懂的原名，比较用归一化键
    const prevLabel = existing?.author?.name ?? ''
    const nextLabel = nextAuthor?.name ?? ''
    // todos 是共享清单，谁都能改；其余表换作者就是接管，要显式确认
    if (existing && table !== 'todos' && prevKey && nextKey && prevKey !== nextKey) {
      const label = input?.name || input?.title || '这条记录'
      if (!input?.baseVersion || currentHash !== input.baseVersion) {
        fail(E.VERSION_CONFLICT, `「${label}」已经由 ${prevLabel} 发布，带上 baseVersion=${currentHash} 才能覆盖`)
      }
      if (input?.takeOver !== true) {
        fail(E.VERSION_CONFLICT, `「${label}」由 ${prevLabel} 发布，${nextLabel} 要接管请带上 takeOver=true`)
      }
    }
    const record = {
      id,
      ...sanitizeEntry(table, input ?? {}),
      author: nextAuthor ?? existing?.author ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    if (table === 'skills') record.textHash = hashOfText(record.content)
    record.contentHash = versionOf(table, record)
    const trimmed = [record, ...list.filter(entry => entry.id !== id)]
    const dropped = Math.max(0, trimmed.length - MAX_ITEMS)
    store[table] = trimmed.slice(0, MAX_ITEMS)
    return { ...record, _dropped: dropped }
  })
}

function readLocalSkill(name) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')
}

/** 创建动作全部沉在对话里：这三个工具是唯一的上传入口。 */
const SHARED_TOOLS = [
  defineTool({
    name: 'team_space_share_skill',
    description: 'Share a SKILL into the team space so teammates can copy it. '
      + 'Pass content, or omit it to read ~/.dsh/skills/<name>/SKILL.md.',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill directory name, e.g. "dsh-plugin-audit".' },
      description: { type: 'string', required: false, description: 'One-line description shown in the team space.' },
      content: { type: 'string', required: false, description: 'SKILL.md body; omit to read it from the local skills directory.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, version: { type: 'string' } },
        required: ['ok', 'version'],
      },
    },
    async execute(args) {
      const name = clip(args?.name, 80)
      if (!name) throw new Error('name is required')
      const content = clip(args?.content, 200_000) || readLocalSkill(name)
      const entry = await upsertEntry('skills', { name, description: args?.description ?? '', content })
      return { ok: true, version: entry.version }
    },
  }),
  defineTool({
    name: 'team_space_share_plugin',
    description: 'Add or update a plugin entry in the team space catalog: name, version, source, audit conclusion and install command. '
      + 'This never installs anything; it only records the audited metadata.',
    parameters: {
      name: { type: 'string', required: true, description: 'Package name, e.g. "dsh-taskboard".' },
      version: { type: 'string', required: false, description: 'Package version.' },
      source: { type: 'string', required: false, description: 'Where it comes from (repo, local path, npm).' },
      audit: { type: 'string', required: false, description: 'Audit conclusion: dependencies, install scripts, write scope, network.' },
      installCommand: { type: 'string', required: false, description: 'Command a teammate runs manually after auditing.' },
      note: { type: 'string', required: false },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, version: { type: 'string' } },
        required: ['ok', 'version'],
      },
    },
    async execute(args) {
      const name = clip(args?.name, 120)
      if (!name) throw new Error('name is required')
      const entry = await upsertEntry('plugins', {
        name,
        version: args?.version ?? '',
        source: args?.source ?? '',
        audit: args?.audit ?? '',
        installCommand: args?.installCommand ?? '',
        note: args?.note ?? '',
      })
      return { ok: true, version: entry.version }
    },
  }),
  defineTool({
    name: 'team_space_share_repo',
    description: 'Register or update a git repository in the team space index: name, url, description, owner, tags, note. '
      + 'The server stores metadata only — never code, never credentials.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short repository name.' },
      url: { type: 'string', required: true, description: 'Git URL without credentials.' },
      description: { type: 'string', required: false, description: 'What it produces, which APK it builds.' },
      owner: { type: 'string', required: false, description: 'Who maintains it.' },
      tags: { type: 'string', required: false, description: 'Comma-separated tags, e.g. "apk,车机".' },
      note: { type: 'string', required: false, description: 'Branch conventions, build command.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, version: { type: 'string' } },
        required: ['ok', 'version'],
      },
    },
    async execute(args) {
      const name = clip(args?.name, 120)
      const url = clip(args?.url, 500)
      if (!name) throw new Error('name is required')
      if (!url) throw new Error('url is required')
      if (/\/\/[^/]*@/.test(url)) throw new Error('URL 里不要带账号密码')
      const entry = await upsertEntry('repos', {
        name, url,
        description: args?.description ?? '',
        owner: args?.owner ?? '',
        tags: args?.tags ?? '',
        note: args?.note ?? '',
        verifiedAt: new Date().toISOString(),
      })
      return { ok: true, version: entry.contentHash }
    },
  }),
  defineTool({
    name: 'team_space_list_members',
    description: 'List members of this team space as skill cards: who they are, what they work on, which repos their machine has, and what work they can take. '
      + 'Call this whenever the user mentions a teammate, the team, cross-device work, joint debugging (联调), or assigning work to someone else, '
      + 'and also when this machine lacks the source repo, device, or environment the question needs, '
      + 'and always before team_space_create_handoff so you can pick the right target.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          count: { type: 'number' },
          members: { type: 'array', items: { type: 'string' } },
        },
        required: ['count', 'members'],
      },
    },
    async execute() {
      const store = loadStore()
      const members = (store.skills ?? [])
        .filter(item => item.member)
        .map(item => `${item.memberName || item.name}：${item.description || '（无描述）'}`)
      return { count: members.length, members }
    },
  }),
  defineTool({
    name: 'team_space_create_handoff',
    description: 'Create a handoff (委托): delegate a task to a teammate\'s DSH so it runs on their machine. '
      + 'Use when the task needs code, repos, devices or an environment that only exists on someone else\'s machine. '
      + 'Call team_space_list_members first to pick the target; when the result comes back, team_space_list_members and the result are how you continue.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short imperative title.' },
      brief: { type: 'string', required: true, description: 'Full context: what to do, how to reproduce, expected result.' },
      target: { type: 'string', required: false, description: 'Teammate name; empty means anyone can pick it up.' },
      owner: { type: 'string', required: false, description: 'Requester name (defaults to this device).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
        required: ['ok', 'id'],
      },
    },
    async execute(args) {
      const title = clip(args?.title, 200)
      const brief = clip(args?.brief, 4000)
      if (!title) throw new Error('title is required')
      if (!brief) throw new Error('brief is required')
      const record = {
        id: randomUUID(),
        title,
        brief,
        target: clip(args?.target, 80),
        owner: clip(args?.owner, 80) || deviceAuthor().name,
        author: normalizeAuthor(args?.author) ?? deviceAuthor(),
        // 原来硬编码空串：agent 发起的委托结果永远回导不了
        requesterDeviceId: clip(args?.deviceId, 120) || hostDeviceId(),
        status: 'open',
        result: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      record.contentHash = hashOf(record)
      await mutateStore(store => {
        store.handoffs ??= []
        store.handoffs.push(record)
      })
      return { ok: true, id: record.id }
    },
  }),
  defineTool({
    name: 'team_space_complete_handoff',
    description: 'Mark a team-space handoff (委托) as done and write back the result. Use this after finishing a delegated task.',
    parameters: {
      id: { type: 'string', required: true, description: 'Handoff id from the task you were given.' },
      result: { type: 'string', required: true, description: 'What you did, the conclusion, and anything the requester must know.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
        required: ['ok', 'id'],
      },
    },
    async execute(args) {
      const id = clip(args?.id, 200)
      const result = clip(args?.result, 20000)
      if (!id) throw new Error('id is required')
      // 和 HTTP 路由同一套校验：原来工具侧完全不校验，open 能直接写成 done
      await mutateStore(store => {
        const record = (store.handoffs ?? []).find(item => item.id === id)
        if (!record) fail(E.NOT_FOUND, 'handoff not found')
        assertHandoffTransition(record, 'done', '')
        record.result = result
        record.status = 'done'
        record.completedAt = Date.now()
        record.updatedAt = Date.now()
        record.contentHash = hashOf(record)
      })
      return { ok: true, id }
    },
  }),
  defineTool({
    name: 'team_space_add_todo',
    description: 'Add a team-space TODO recommendation. Execution still belongs to the DSH team task board or dsh-todo-panel.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short imperative line.' },
      owner: { type: 'string', required: false, description: 'Who owns it.' },
      status: { type: 'string', required: false, enum: ['open', 'doing', 'done'], description: 'Defaults to open.' },
      note: { type: 'string', required: false },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, version: { type: 'string' } },
        required: ['ok', 'version'],
      },
    },
    async execute(args) {
      const title = clip(args?.title, 200)
      if (!title) throw new Error('title is required')
      const entry = await upsertEntry('todos', {
        title,
        owner: args?.owner ?? '',
        status: args?.status ?? 'open',
        note: args?.note ?? '',
      })
      return { ok: true, version: entry.version }
    },
  }),
]

export function apply(ctx) {
  const route = handler => async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
      res.end()
      return
    }
    try {
      send(res, 200, { ok: true, ...(await handler(req)) })
    } catch (error) {
      const code = error?.code && E[error.code] ? error.code : E.BAD_REQUEST
      send(res, STATUS_OF[code] ?? 400, { ok: false, code, error: error?.message ?? String(error) })
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/list`,
        handler: route(async req => {
          const store = loadStore()
          const viewer = viewerOf(req)
          // 委托按可见性过滤（指定给某人的只有被指定人 + 发起人 + 主服务器看得到）；
          // 其余表照旧全量。计数也用过滤后的数量，否则列表条数和角标会对不上。
          const visible = table => (store[table] ?? [])
            .filter(entry => table !== 'handoffs' || handoffVisibleTo(entry, viewer))
          // 只遍历真正的表：store 里还有 joins / hostDeviceId 这类非表字段
          const counts = Object.fromEntries(
            TABLE_KEYS.map(table => [table, visible(table).length]),
          )
          // 列表只给元数据；正文/正文类大字段按需用 /detail 取。
          const slim = (table, entry) => {
            if (table === 'tasks') {
              const { text, ...rest } = entry
              // 老记录没有 preview：从正文里挑第一行非标题文本补一个
              if (!rest.preview && text) {
                const line = text.split('\n').find(value => value.trim() && !value.startsWith('#') && !value.startsWith('…'))
                if (line) rest.preview = line.trim().replace(/\s+/g, ' ').slice(0, 80)
              }
              return rest
            }
            if (table === 'skills') {
              const { content, ...rest } = entry
              const textHash = entry.textHash ?? (content ? hashOfText(content) : '')
              const local = localSkillInfo(entry.name)
              return { ...rest, textHash, ...local }
            }
            if (table === 'handoffs') {
              const { brief, result, ...rest } = entry
              return {
                ...rest,
                preview: String(brief ?? '').slice(0, 120),
                resultPreview: String(result ?? '').slice(0, 160),
              }
            }
            if (table === 'plugins') {
              return { ...entry, ...installedInfo(entry.name) }
            }
            return entry
          }
          const tables = Object.fromEntries(
            TABLE_KEYS.map(table => [table, visible(table).map(entry => slim(table, entry))]),
          )
          return { tables, counts, limits: { maxItems: MAX_ITEMS } }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/install`,
        handler: route(async req => {
          // 直接由宿主执行 npm 安装：不再依赖「自动开会话 + agent 有 shell」这条链，
          // 那条链在没有工具 preset 或会话不可见时会静默失败，表现为按钮卡在「安装中」。
          const body = await readJsonBody(req)
          const spec = clip(body.spec, 120)
          if (!/^[@a-zA-Z0-9][\w@/.\-]*$/.test(spec)) {
            fail(E.BAD_REQUEST, '只支持 npm 包名（例如 dsh-taskboard@0.6.7）')
          }
          const name = specPackageName(spec)
          if (!name) fail(E.BAD_REQUEST, '解析不出 npm 包名')
          const base = profileNodeModules()
          const dest = resolve(base, name)
          if (!isInside(base, dest)) fail(E.BAD_REQUEST, '插件安装路径越界')
          // 在空目录里装，避开 profile 里 link: 依赖（npm 不认该协议），
          // 也避免 pnpm add 顺手把依赖写进 profile 的 package.json —— 那等于绕过启用确认。
          const stage = join(tmpdir(), `ts-npm-${Date.now()}`)
          mkdirSync(stage, { recursive: true })
          writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'ts-stage', private: true }))
          const started = Date.now()
          let tail = ''
          try {
            const { stdout, stderr } = await execFileAsync(
              'npm', ['install', '--prefix', stage, spec, '--no-audit', '--no-fund'],
              { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
            )
            tail = String(stdout ?? '').split('\n').filter(Boolean).slice(-8).join('\n') || String(stderr ?? '').slice(-400)
          } catch (npmError) {
            fail(E.BAD_REQUEST, `npm 安装失败：${String(npmError?.stderr ?? npmError?.message ?? npmError).slice(0, 300)}`)
          }
          const staged = join(stage, 'node_modules', name)
          if (!existsSync(staged)) fail(E.BAD_REQUEST, 'npm 安装完成但没找到包目录')
          try {
            await installCopy(staged, dest, `${Date.now()}`)
          } finally {
            try { rmSync(stage, { recursive: true, force: true }) } catch { /* 忽略 */ }
          }
          let version = ''
          try { version = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version ?? '' } catch { /* 忽略 */ }
          writeInstallAudit(name, {
            name, url: '', spec, via: 'npm', version, path: dest, checksum: '', at: Date.now(), enabled: false,
          })
          return {
            ok: true,
            profile: dirname(base),
            path: dest,
            version,
            seconds: Math.round((Date.now() - started) / 1000),
            tail,
            enabled: false,
            needsEnable: true,
          }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/plugin/enable`,
        handler: route(async req => {
          // 启用是独立的一次确认：必须回传安装时给的 checksum，
          // 证明用户看的确实是那一份包。
          const body = await readJsonBody(req)
          const name = clip(body.name, 120)
          // 双保险：客户端已经禁用了「更新自己」，这里再拦一道。
          // 本机是 link 安装，替换目录会把运行中的宿主一起弄崩（实测点「更新」整个 DSH 闪退）。
          if (/^(@[^/]+\/)?dsh-team-space$/.test(name)) {
            fail(E.FORBIDDEN, '不能安装/更新正在运行的团队空间自己：请用安装脚本或手动替换文件')
          }
          if (!name || !/^[@a-zA-Z0-9][\w@/.\-]*$/.test(name) || name.includes('..')) {
            fail(E.BAD_REQUEST, '非法的插件名')
          }
          const enabled = enableInstalled(name, clip(body.checksum, 128))
          return { ok: true, name, enabled, needsRestart: true }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/plugin/audit`,
        handler: route(async req => {
          const url = new URL(req.url, 'http://local')
          const name = clip(url.searchParams.get('name'), 120) || ''
          const audit = readInstallAudit()
          return { ok: true, entries: name ? { [name]: audit[name] ?? null } : audit }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/install-plugin`,
        handler: route(async req => {
          // 安装 = 把包放进 node_modules；**不自动启用**。
          // 启用要由用户拿着安装结果显示确认一次（/plugin/enable + checksum），
          // 否则「同事发个链接 → 你点一下 → 重启后它就在你机器上跑代码」。
          const body = await readJsonBody(req)
          const name = clip(body.name, 120)
          const url = clip(body.url, 500)
          // name 会直接拼进 node_modules 路径，必须挡住 ../ 穿越（原来只 clip 不校验）
          if (!name || !/^[@a-zA-Z0-9][\w@/.\-]*$/.test(name) || name.includes('..')) {
            fail(E.BAD_REQUEST, '非法的插件名')
          }
          const short = name.includes('/') ? name.split('/').pop() : name
          const base = profileNodeModules()
          // scoped 包保留 scope 层：@local/dsh-x 不能落成 node_modules/dsh-x
          const dest = resolve(base, name)
          if (!isInside(base, dest)) fail(E.BAD_REQUEST, '插件安装路径越界')
          const spec = clip(body.spec, 160)
          // 与 /install 同一套校验：spec 会作为 argv 传给 npm/pnpm，以 - 开头会被当成 flag
          if (spec && !/^[@a-zA-Z0-9][\w@/.\-]*$/.test(spec)) {
            fail(E.BAD_REQUEST, '只支持 npm 包名（例如 dsh-taskboard@0.6.7）')
          }
          const enable = body.enable === true
          let via = 'npm'
          let checksum = ''

          // 有 tgz 地址就先走 tgz：原来先判断「名字像不像 npm 包名」，
          // 像就直接走 npm 并 return —— 自定义 tgz 的白名单/大小/tar 校验根本走不到。
          if (/^https?:\/\//.test(url)) {
            if (!isAllowedPackageUrl(url)) {
              fail(E.FORBIDDEN, '包地址不被允许：公网地址必须用 https，明文 http 仅限本机或局域网私有网段')
            }
            const buffer = await downloadPackage(url, MAX_PACKAGE_BYTES)
            checksum = createHash('sha256').update(buffer).digest('hex')
            const stamp = `${Date.now()}`
            const tmpFile = join(tmpdir(), `ts-plugin-${stamp}.tgz`)
            const extractDir = join(tmpdir(), `ts-plugin-${stamp}`)
            writeFileSync(tmpFile, buffer)
            try {
              await safeExtractTgz(tmpFile, extractDir)
              // 包内可能多一层目录：找含 package.json 的那层
              const entries = readdirSync(extractDir)
              let root = extractDir
              if (!existsSync(join(extractDir, 'package.json')) && entries.length === 1) {
                root = join(extractDir, entries[0])
              }
              if (!isInside(extractDir, root)) fail(E.BAD_REQUEST, '压缩包路径异常（疑似路径穿越），已中止')
              if (!existsSync(join(root, 'package.json'))) fail(E.BAD_REQUEST, '压缩包里没找到 package.json')
              installCopy(root, dest, stamp)
            } finally {
              try { rmSync(tmpFile, { force: true }) } catch { /* 忽略 */ }
              try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
            }
            via = 'tgz'
          } else if (spec) {
            // 在空目录里安装，避开 profile 里 link: 依赖（npm 不认该协议）
            // spec.split('@')[0] 对 @scope/pkg@1.2.3 会得到空串，dest 会退化成整个 node_modules
            const pkgName = specPackageName(spec)
            if (!pkgName || !/^[@a-zA-Z0-9][\w@/.\-]*$/.test(pkgName)) fail(E.BAD_REQUEST, '解析不出 npm 包名')
            const stage = join(tmpdir(), `ts-npm-${Date.now()}`)
            mkdirSync(stage, { recursive: true })
            writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'ts-stage', private: true }))
            try {
              await execFileAsync('npm', ['install', '--prefix', stage, spec, '--no-audit', '--no-fund'], {
                timeout: 180_000,
                maxBuffer: 8 * 1024 * 1024,
              })
            } catch (npmError) {
              fail(E.BAD_REQUEST, `npm 安装失败：${String(npmError?.stderr ?? npmError?.message ?? npmError).slice(0, 300)}`)
            }
            const staged = join(stage, 'node_modules', pkgName)
            if (!existsSync(staged)) fail(E.BAD_REQUEST, 'npm 安装完成但没找到包目录')
            try {
              installCopy(staged, dest, `${Date.now()}`)
            } finally {
              try { rmSync(stage, { recursive: true, force: true }) } catch { /* 忽略 */ }
            }
            via = 'npm'
          } else {
            fail(E.BAD_REQUEST, '条目既没有包地址也没有 npm 包名')
          }

          let version = ''
          try { version = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version ?? '' } catch { /* 忽略 */ }
          writeInstallAudit(name, {
            name, url, spec, via, version, path: dest, checksum, at: Date.now(), enabled: false,
          })
          if (!enable) {
            return {
              ok: true, via, version, path: dest, checksum,
              enabled: false, needsEnable: true, needsRestart: false,
            }
          }
          const enabled = enableInstalled(name, checksum)
          return { ok: true, via, version, path: dest, checksum, enabled, needsRestart: true }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/install-skill`,
        handler: route(async req => {
          // 技能安装不需要 agent 参与：正文就在团队空间里，直接写到本机 skills 目录即可。
          const body = await readJsonBody(req)
          const name = clip(body.name, 80)
          if (!name || !/^[\w.\-]+$/.test(name)) throw new Error('非法的 skill 名称')
          const content = String(body.content ?? '')
          if (!content.trim()) throw new Error('skill 正文为空')
          const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
          const dir = join(home, 'skills', name)
          mkdirSync(dir, { recursive: true })
          const file = join(dir, 'SKILL.md')
          writeFileSync(file, content)
          return { ok: true, path: file, hash: hashOfText(content.trim()) }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/local-state`,
        handler: route(async req => {
          // 「本机装了没」必须在请求方本机算：成员连的是主服务器，/list 里现算的状态是主服务器的。
          const url = new URL(req.url, 'http://local')
          const split = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean)
          const skills = {}
          for (const name of split(url.searchParams.get('skills')).slice(0, 300)) {
            skills[name] = localSkillInfo(name)
          }
          const plugins = {}
          for (const name of split(url.searchParams.get('plugins')).slice(0, 100)) {
            plugins[name] = installedInfo(name)
          }
          return { skills, plugins }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/detail`,
        handler: route(async req => {
          const url = new URL(req.url, 'http://local')
          // 兼容旧客户端：它们把 table/id 放在 POST body 里发过来
          const body = req.method === 'POST' ? await readJsonBody(req).catch(() => ({})) : {}
          const table = url.searchParams.get('table') || body.table || ''
          const id = url.searchParams.get('id') || body.id || ''
          if (!DETAIL_TABLES.includes(table)) throw new Error('未知的表')
          if (!id) throw new Error('缺少 id')
          const entry = loadStore()[table].find(item => item.id === id)
          if (!entry) throw new Error('记录不存在')
          return { entry }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/handoff/create`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const record = {
            id: randomUUID(),
            title: clip(body.title, 200) || '未命名委托',
            brief: clip(body.brief, 4000),
            target: clip(body.target, 80),
            owner: clip(body.owner, 80) || deviceAuthor().name,
            author: normalizeAuthor(body.author) ?? deviceAuthor(),
            // 浏览器自己发的委托用它自己的 deviceId；没给就退回宿主 id
            requesterDeviceId: clip(body.deviceId, 120) || hostDeviceId(),
            status: 'open',
            result: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          record.contentHash = hashOf(record)
          await mutateStore(store => {
            store.handoffs ??= []
            store.handoffs.push(record)
          })
          return { ok: true, id: record.id }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/handoff/claim`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const by = clip(body.by, 80)
          await mutateStore(store => {
            const record = (store.handoffs ?? []).find(item => item.id === clip(body.id, 200))
            if (!record) fail(E.NOT_FOUND, '委托不存在')
            assertHandoffTransition(record, 'doing', by)
            record.status = 'doing'
            record.assignee = by
            record.claimedAt = Date.now()
            record.updatedAt = Date.now()
            record.contentHash = hashOf(record)
          })
          return { ok: true }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/handoff/complete`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const by = clip(body.by, 80)
          await mutateStore(store => {
            const record = (store.handoffs ?? []).find(item => item.id === clip(body.id, 200))
            if (!record) fail(E.NOT_FOUND, '委托不存在')
            assertHandoffTransition(record, 'done', by)
            record.result = clip(body.result, 20000)
            record.status = 'done'
            record.completedAt = Date.now()
            record.updatedAt = Date.now()
            record.contentHash = hashOf(record)
          })
          return { ok: true }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/handoff/remove`,
        handler: route(async req => {
          // 委托不能走通用 /entry/remove（handoffs 不在 ENTRY_TABLES 里）：
          // 通用入口一旦放开，状态机就能被整个绕开。
          const body = await readJsonBody(req)
          // 删除只允许主服务器：成员能看委托，但不能把它从共享清单里抹掉。
          // 客户端会把 deviceId 同时带在 query 和 body 里，两处都认。
          const bodyDevice = clip(body.deviceId, 120)
          const isHost = viewerOf(req).isHost || (Boolean(bodyDevice) && bodyDevice === hostDeviceId())
          if (!isHost) fail(E.FORBIDDEN, '只有主服务器能删除委托')
          const id = clip(body.id, 200)
          if (!id) fail(E.BAD_REQUEST, '缺少 id')
          await mutateStore(store => {
            const before = (store.handoffs ?? []).length
            store.handoffs = (store.handoffs ?? []).filter(item => item.id !== id)
            if (store.handoffs.length === before) fail(E.NOT_FOUND, '委托不存在')
          })
          return { removed: id }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/handoff/cancel`,
        handler: route(async req => {
          // 发起人关单：open 的委托收不到人时，走这条而不是伪造一个 done
          const body = await readJsonBody(req)
          const by = clip(body.by, 80)
          await mutateStore(store => {
            const record = (store.handoffs ?? []).find(item => item.id === clip(body.id, 200))
            if (!record) fail(E.NOT_FOUND, '委托不存在')
            assertHandoffTransition(record, 'cancelled', by)
            if (record.owner && by && record.owner !== by) {
              fail(E.FORBIDDEN, `这条委托由「${record.owner}」发起，只有他能取消`)
            }
            record.result = clip(body.reason, 20000)
            record.status = 'cancelled'
            record.cancelledAt = Date.now()
            record.updatedAt = Date.now()
            record.contentHash = hashOf(record)
          })
          return { ok: true }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/handoff/consume`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          await mutateStore(store => {
            const record = (store.handoffs ?? []).find(item => item.id === clip(body.id, 200))
            if (!record) fail(E.NOT_FOUND, '委托不存在')
            record.deliveredAt = Date.now()
            record.updatedAt = Date.now()
          })
          return { ok: true }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/profile/suggest`,
        handler: route(async () => {
          const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
          // 原来直接调 ctx.sessionQuery.listSessions()，本版本没这个方法，
          // 抛 TypeError 被吞掉 → 「生成能力卡」一直返回空 bio。
          // 现在只从目录名拿 id，标题仍交给官方的 readTitleSnapshots。
          const ids = recentSessionIds(home, 80)
          let titles = []
          if (ids.length) {
            try {
              const observations = await ctx.sessionQuery.readTitleSnapshots(ids)
              titles = (observations ?? [])
                .map(item => (item?.status === 'fulfilled' ? item.value?.title?.title : ''))
                .filter(Boolean)
            } catch (error) {
              return { ok: true, basedOn: 0, suggestions: [], error: `读会话标题失败：${error?.message ?? error}` }
            }
          }
          if (!titles.length) {
            return { ok: true, basedOn: 0, suggestions: [], error: '没读到会话标题（刚建的会话可能还没生成标题）' }
          }
          // cwd 只取一个就够用来定位仓库，多读没有收益。
          const cwds = [recentProjectCwd(home)].filter(Boolean)
          const suggestions = suggestCapabilities([...titles, ...cwds])
          const labels = suggestions.map(item => item.label)
          const roles = labels.filter(label => CAPABILITY_DICT.roles.includes(label))
          const modules = labels.filter(label => CAPABILITY_DICT.modules.includes(label))
          const stacks = labels.filter(label => [...CAPABILITY_DICT.platforms, ...CAPABILITY_DICT.tech].includes(label))

          const repoMap = new Map()
          for (const repo of cwds.map(findRepo).filter(Boolean)) repoMap.set(repo.path, repo)
          for (const path of scanRepos()) {
            if (!repoMap.has(path)) repoMap.set(path, { name: basename(path), path })
          }
          const repos = [...repoMap.values()]
            .map(repo => ({ ...repo, remote: repoRemote(repo.path) }))
            .slice(0, 12)

          const recent = titles.slice(0, 10).map(title => String(title).slice(0, 48))

          const verbs = ['编译', '构建', '调试', '联调', '测试', '评审', '写文档', '排查', '定位', '重构', '适配', '验证']
          const actionHits = verbs
            .map(verb => ({ verb, count: titles.join(' ').split(verb).length - 1 }))
            .filter(item => item.count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, 6)

          const env = [
            `- 系统：${process.platform} ${process.arch}`,
            `- Node：${process.version}`,
            '- 本机 DSH + 终端：可跑构建、跑测试、查日志',
          ]

          const lines = []
          lines.push('## 我是谁')
          lines.push(roles.length ? `- 角色：${roles.join(' / ')}` : '- 角色：未识别（可手写）')
          if (modules.length) lines.push(`- 负责模块：${modules.join('、')}`)
          if (stacks.length) lines.push(`- 技术栈：${stacks.join(' / ')}`)
          lines.push('')
          lines.push('## 我机器上有什么')
          if (repos.length) {
            for (const repo of repos) {
              const remote = repo.remote ? `（${repo.remote}）` : ''
              lines.push(`- 仓库 ${repo.name}${remote}：${repo.path}`)
            }
          } else {
            lines.push('- 仓库：未扫描到（可手动补充路径）')
          }
          for (const item of env) lines.push(item)
          lines.push('')
          lines.push('## 我最近在忙')
          if (recent.length) {
            for (const title of recent) lines.push(`- ${title}`)
          } else {
            lines.push('- 暂无会话记录')
          }
          lines.push('')
          lines.push('## 我常做的事')
          if (actionHits.length) {
            lines.push(actionHits.map(item => `${item.verb}×${item.count}`).join('、'))
          } else {
            lines.push('- 暂无统计')
          }
          lines.push('')
          lines.push('## 能接什么活')
          if (modules.length) lines.push(`- 和 ${modules.slice(0, 4).join(' / ')} 相关的代码、接口、配置问题`)
          lines.push('- 查接口实现、确认协议字段与回调、定位问题')
          lines.push('- 跑构建/测试、复现问题、验证车机行为')
          lines.push('- 需要我这台机器上的仓库或环境时可直接派单')
          lines.push('')
          lines.push('## 怎么找我')
          lines.push('- 委托的 target 填我的名字')
          lines.push('- 复杂问题先在对话里说清楚上下文，再接单更快')
          const bio = lines.join('\n')
          return { basedOn: titles.length, suggestions, repos, recent, actions: actionHits, bio }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/member/save`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const name = clip(body.name, 60)
          const bio = clip(body.bio, 2000)
          if (!name) throw new Error('name 不能为空')
          const recordName = `member-${name}`
          await mutateStore(store => {
            store.skills ??= []
            const existing = store.skills.find(item => item.name === recordName)
            // bio 由 profile/suggest 生成时已经带「能接什么活 / 怎么找我」；
            // 再无脑追加一遍就会出现两个「怎么找我」（实测 xinzhan 那张卡就是这样）。
            const hasTail = /^##\s*(我能接的活|能接什么活|怎么找我)/m.test(bio)
            const content = hasTail
              ? `# ${name} 的能力卡\n\n${bio}`
              : [
                  `# ${name} 的能力卡`,
                  '',
                  bio || '（未填写）',
                  '',
                  '## 我能接的活',
                  '- 需要我这台机器上的仓库/环境/设备时，直接把委托派给我。',
                  '',
                  '## 怎么找我',
                  `- 委托的 target 填「${name}」。`,
                ].join('\n')
            if (existing) {
              existing.description = bio.slice(0, 200)
              existing.content = content
              existing.member = true
              existing.memberName = name
              existing.updatedAt = Date.now()
              existing.textHash = hashOfText(content)
              existing.contentHash = hashOf(existing)
            } else {
              const record = {
                id: randomUUID(),
                name: recordName,
                description: bio.slice(0, 200) || `${name} 的能力卡`,
                content,
                member: true,
                memberName: name,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              }
              record.textHash = hashOfText(content)
              record.contentHash = hashOf(record)
              store.skills.push(record)
            }
          })
          return { ok: true, name: recordName }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/member/list`,
        handler: route(async () => {
          const store = loadStore()
          return {
            ok: true,
            members: (store.skills ?? [])
              .filter(item => item.member)
              .map(item => ({ name: item.memberName || item.name, bio: item.description || '' })),
          }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/guide`,
        // 新手引导是独立 HTML 页面（带 SVG 配图），由插件自己提供，
        // 不依赖外部网站，也不进客户端 bundle。
        handler: async (req, res) => {
          try {
            const file = join(dirname(fileURLToPath(import.meta.url)), 'guide.html')
            const html = readFileSync(file, 'utf8')
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(html)
          } catch (error) {
            send(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/download`,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url, 'http://local')
            const file = url.searchParams.get('file') ?? ''
            // 只允许本插件的历史包，且不允许路径穿越
            if (!/^[\w.@-]+\.tgz$/.test(file) || file.includes('/')) {
              send(res, 400, { ok: false, error: '文件名不合法' })
              return
            }
            const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
            const dir = join(home, 'storages', 'team-space-dist')
            const path = join(dir, file)
            if (!existsSync(path)) {
              send(res, 404, { ok: false, error: '包不存在' })
              return
            }
            const data = readFileSync(path)
            res.writeHead(200, {
              'content-type': 'application/gzip',
              'content-disposition': `attachment; filename="${file}"`,
              'content-length': String(data.length),
              'access-control-allow-origin': '*',
            })
            res.end(data)
          } catch (error) {
            send(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/client-log`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
          const file = join(home, 'logs', 'team-space-client.log')
          mkdirSync(dirname(file), { recursive: true })
          // 原来无上限 append：页面报错刷屏就能把磁盘写满。超过上限就丢掉前半段。
          try {
            if (statSync(file).size > MAX_CLIENT_LOG_BYTES) {
              const kept = readFileSync(file, 'utf8').split('\n').slice(-500).join('\n')
              writeFileSync(file, `${kept}\n`)
            }
          } catch { /* 读不到就当新文件 */ }
          appendFileSync(file, `${JSON.stringify({
            at: new Date().toISOString(),
            level: clip(body.level, 40) || 'error',
            message: clip(body.message, 2000),
            stack: clip(body.stack, 6000),
            url: clip(body.url, 500),
          })}\n`)
          return { ok: true }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/gateway-status`,
        handler: route(async () => {
          const enabled = await gatewayRunning()
          // joins 原来只增不减，「已加入 N 台设备」永久虚高
          const deadline = Date.now() - JOIN_TTL_MS
          const live = await mutateStore(store => {
            const kept = (store.joins ?? [])
              .filter(item => (item.seenAt ?? item.at ?? 0) >= deadline)
            if (kept.length !== (store.joins ?? []).length) store.joins = kept
            return kept
          })
          // 「在线」按设备去重 + 短 TTL。自检心跳的 deviceId 是每次随机生成的，
          // 算进来会把在线数放大（实测 20 条里 16 条是它），必须排除。
          const onlineDeadline = Date.now() - ONLINE_TTL_MS
          const devices = live
            .filter(item => !String(item.deviceId ?? '').startsWith('selftest'))
            .map(item => {
              const at = item.seenAt ?? item.at ?? 0
              return {
                name: item.name || '未命名设备',
                deviceId: item.deviceId ?? '',
                at,
                online: at >= onlineDeadline,
              }
            })
            .sort((a, b) => (Number(b.online) - Number(a.online)) || (b.at - a.at))
          return {
            enabled,
            host: `http://${lanAddress()}:8080`,
            deviceId: hostDeviceId(),
            joins: devices.length,
            onlineDevices: devices.filter(item => item.online).length,
            devices,
            members: live.map(item => ({
              name: item.name || '未命名设备',
              capabilities: item.capabilities ?? [],
              at: item.seenAt ?? item.at ?? 0,
            })),
          }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/join`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const deviceId = clip(body.deviceId, 120)
          if (!deviceId) throw new Error('deviceId 不能为空')
          const name = clip(body.name, 60)
          const capabilities = Array.isArray(body.capabilities)
            ? body.capabilities.map(item => clip(item, 40)).filter(Boolean).slice(0, 20)
            : null
          // 心跳：页面开着就定期打这个接口，否则 24h TTL 会把活跃成员刷掉
          const joins = await mutateStore(store => {
            store.joins ??= []
            const existing = store.joins.find(item => item.deviceId === deviceId)
            if (existing) {
              if (name) existing.name = name
              if (capabilities) existing.capabilities = capabilities
              existing.seenAt = Date.now()
            } else {
              store.joins.push({
                deviceId,
                name: name || '未命名设备',
                capabilities: capabilities ?? [],
                at: Date.now(),
                seenAt: Date.now(),
              })
            }
            return store.joins.length
          })
          return { joins }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/new-session`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          // 默认 cwd 取用户的项目目录：profile 目录不是用户工作区，
          // 在那里建会话会让工具被 file policy 拦住。
          // 三级来源：① ctx.sessionQuery.listSessions（若该版本真有这个方法）
          //           ② 扫 ~/.dsh/sessions 目录名反推 ③ 进程 cwd
          const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
          const profilesRoot = join(home, 'profiles')
          let fallbackCwd = ''
          try {
            if (typeof ctx.sessionQuery?.listSessions === 'function') {
              const recent = [...((await ctx.sessionQuery.listSessions()) ?? [])].reverse()
              for (const item of recent) {
                const value = item?.cwd ?? item?.header?.cwd
                if (value && !value.startsWith(profilesRoot)) { fallbackCwd = value; break }
              }
            }
          } catch { /* 没有这个 API，走下一级 */ }
          if (!fallbackCwd) fallbackCwd = recentProjectCwd(home)
          if (!fallbackCwd) fallbackCwd = process.cwd()
          const cwd = clip(body.cwd, 500) || fallbackCwd
          const sessionId = `session-${randomUUID()}`
          // 走官方 agent 创建路径：会持久化、announce，客户端 store 才认识这个会话，
          // 之后 sessions.retain + prompt 才不会被判 unknown session。
          try {
            // persona 里的 {{model}} 需要一个具体模型；不传就用当前默认模型。
            let agentOptions = {}
            try {
              const selection = ctx.agentDefaultModel.currentSelection()
              if (selection?.provider && selection?.model) {
                agentOptions = { provider: selection.provider, model: selection.model }
              }
            } catch (selectionError) {
              console.error('[team-space] 读取默认模型失败', selectionError)
            }
            // 先按 standard preset 建；某些 profile 没有该 preset 时，退回默认 preset 再试一次
            // 内置 preset 名是 cordis / ptc；之前写 'standard' 会失败并回退到无工具的默认会话。
            try {
              await ctx.agents.create({ sessionId, meta: { cwd, agentPreset: 'cordis' }, agentOptions })
            } catch (presetError) {
              console.error('[team-space] cordis preset 建会话失败，改用默认 preset', presetError)
              await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })
            }
            return { sessionId, created: 'agent', model: agentOptions.model ?? null }
          } catch (error) {
            console.error('[team-space] agents.create 失败，回退到持久化空会话', error)
            const handle = await ctx.sessionPersistence.create({
              version: 4,
              id: sessionId,
              createdAt: Date.now(),
              cwd,
              isSeeded: false,
              agentPreset: 'standard',
            })
            try {
              await handle.flush()
            } finally {
              await handle.close()
            }
            return { sessionId, created: 'persistence' }
          }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/self-config`,
        handler: route(async req => {
          if (req.method === 'POST') return writePeerConfig(await readJsonBody(req))
          return peerConfig()
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/lan-link`,
        handler: route(async req => {
          const url = new URL(req.url, 'http://local')
          const base = url.searchParams.get('base') ?? ''
          if (!/^https?:\/\//.test(base)) throw new Error('base 必须是 http(s) 地址')
          return { url: ctx.connection.authenticatedUrl(base) }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/local-session`,
        handler: route(async req => {
          // 「读会话」必须发生在会话所在的那台机器：成员分享时请求会打到主服务器，
          // 主服务器读不到对方的会话文件，所以先在本机读成快照再提交。
          const url = new URL(req.url, 'http://local')
          const sessionId = clip(url.searchParams.get('sessionId'), 200)
          if (!sessionId) throw new Error('缺少 sessionId')
          // since：只要这个时间点之后的事件（交回回执时做增量，避免每次回传整段历史）
          const since = Number(url.searchParams.get('since')) || 0
          const snapshot = await ctx.sessionQuery.readSession(sessionId)
          const all = snapshot.events ?? []
          const events = since > 0 ? all.filter(event => (event?.time ?? 0) > since) : all
          const title = clip(await ctx.sessionQuery.readTitle(sessionId).then(t => t?.title).catch(() => ''), 200) || '未命名会话'
          const firstUser = events.find(event => event.type === 'user/message')
          return {
            hasSession: true,
            title,
            cwd: snapshot.session?.cwd ?? '',
            text: renderTranscript(events, title),
            files: extractFiles(events),
            messageCount: events.filter(event => messageText(event)).length,
            preview: firstUser ? textOf(firstUser.data?.content).replace(/\s+/g, ' ').slice(0, 80) : '',
            throughSeq: events.reduce((max, event) => Math.max(max, event?.seq ?? 0), 0),
          }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/share/submit`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const sessionId = clip(body.sessionId, 200)
          if (!sessionId) throw new Error('缺少 sessionId')
          const uploader = {
            label: clip(body.uploader?.label, 80) || '未知设备',
            avatar: clip(body.uploader?.avatar, 20000),
            deviceId: clip(body.uploader?.deviceId, 120),
            ip: String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''),
            at: Date.now(),
          }
          const { item: record, dropped } = await mutateStore(store => {
            const existing = store.tasks.find(item => item.sessionId === sessionId && item.kind === 'session')
            const next = {
              id: existing?.id ?? randomUUID(),
              kind: 'session',
              sessionId,
              title: clip(body.title, 200) || '未命名会话',
              cwd: clip(body.cwd, 500),
              text: clip(body.text, 400_000),
              files: Array.isArray(body.files) ? body.files.slice(0, 50) : [],
              messageCount: Number(body.messageCount) || 0,
              preview: clip(body.preview, 120),
              uploader,
              author: normalizeAuthor(body.author) ?? { name: uploader.label, avatar: safeAvatar(uploader.avatar) },
              throughSeq: Number(body.throughSeq) || 0,
              claim: existing?.claim ?? null,
              // 重复分享是覆盖同一条：原来把 createdAt 刷成现在，等于把首次分享时间抹掉
              createdAt: existing?.createdAt ?? Date.now(),
              updatedAt: Date.now(),
            }
            const trimmed = [next, ...store.tasks.filter(item => item.id !== next.id)]
            const droppedCount = Math.max(0, trimmed.length - MAX_ITEMS)
            store.tasks = trimmed.slice(0, MAX_ITEMS)
            return { item: next, dropped: droppedCount }
          })
          return { item: record, dropped }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/share`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const sessionId = clip(body.sessionId, 200)
          if (!sessionId) throw new Error('缺少 sessionId')

          const snapshot = await ctx.sessionQuery.readSession(sessionId)
          const title = clip(body.title, 200)
            || clip(await ctx.sessionQuery.readTitle(sessionId).then(t => t?.title).catch(() => ''), 200)
            || '未命名会话'
          const events = snapshot.events ?? []
          const messageCount = events.filter(event => messageText(event)).length
          const throughSeq = events.reduce((max, event) => Math.max(max, event?.seq ?? 0), 0)

          const uploader = {
            label: clip(body.uploader?.label, 80) || '未知设备',
            avatar: clip(body.uploader?.avatar, 20000),
            deviceId: clip(body.uploader?.deviceId, 120),
            ip: String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''),
            at: Date.now(),
          }

          const firstUser = events.find(event => event.type === 'user/message')
          const preview = firstUser ? textOf(firstUser.data?.content).replace(/\s+/g, ' ').slice(0, 80) : ''
          const { item: record, dropped } = await mutateStore(store => {
            const existing = store.tasks.find(item => item.sessionId === sessionId && item.kind === 'session')
            const next = {
              id: existing?.id ?? randomUUID(),
              kind: 'session',
              sessionId,
              title,
              cwd: snapshot.session?.cwd ?? '',
              text: renderTranscript(events, title),
              files: extractFiles(events),
              messageCount,
              preview,
              uploader,
              author: normalizeAuthor(body.author) ?? { name: uploader.label, avatar: safeAvatar(uploader.avatar) },
              throughSeq,
              claim: existing?.claim ?? null,
              // 重复分享是覆盖同一条：原来把 createdAt 刷成现在，等于把首次分享时间抹掉
              createdAt: existing?.createdAt ?? Date.now(),
              updatedAt: Date.now(),
            }
            const trimmed = [next, ...store.tasks.filter(item => item.id !== next.id)]
            const droppedCount = Math.max(0, trimmed.length - MAX_ITEMS)
            store.tasks = trimmed.slice(0, MAX_ITEMS)
            return { item: next, dropped: droppedCount }
          })
          return { item: record, dropped }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/claim`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const id = clip(body.id, 200)
          if (!id) fail(E.BAD_REQUEST, '缺少 id')
          const by = clip(body.by, 120)
          const byName = clip(body.byName, 80)
          if (!by) fail(E.BAD_REQUEST, '缺少认领人设备 id')

          // 认领按人/设备分别记（item.claims[deviceId]）：
          // 原来只存一份 item.claim，第二个人点认领会拿到第一个人的副本 sessionId ——
          // 那份会话在别人机器上，openSession 必然打不开。
          const previous = await mutateStore(store => {
            const item = store.tasks.find(entry => entry.id === id)
            if (!item) fail(E.NOT_FOUND, '记录不存在')
            item.claims ??= {}
            // 老数据迁移：历史记录只有 claim 字段
            if (item.claim && !Object.keys(item.claims).length && item.claim.deviceId) {
              item.claims[item.claim.deviceId] = { ...item.claim }
            }
            return { ...(item.claims[by] ?? null) }
          })
          // 远程认领在 commit 之前 sessionId 是空的，此时不能复用；
          // commit 之后会话就在这台机器上，再点认领应该直接打开它。
          if (previous?.sessionId && body.force !== true) {
            return { sessionId: previous.sessionId, reused: true, mode: previous.mode ?? 'local' }
          }

          // 关键分支：源会话就在这台机器上（主服务器自己分享的、或单机用），
          // 才谈得上「复制完整历史」；否则这台机器只有分享时留下的文本快照。
          const item = await mutateStore(store => ({ ...store.tasks.find(entry => entry.id === id) }))
          // 判断「认领人是不是坐在这台机器上」，两条路都不能只看一半：
          //   1) remoteAddress 不行 —— 成员请求经局域网网关代理进来，源地址一律是 127.0.0.1，
          //      会被误判成「本机」，于是成员拿到一个打不开的 sessionId（2.7.3 的 bug）。
          //   2) by === hostId 也不行 —— 浏览器用的是 localStorage 里的 id，跟宿主的 host-* 不是
          //      同一个值，那样连「主服务器自己认领自己的会话」都会被降级成按快照重建（2.7.4 的回归）。
          // 浏览器把自己连着的那台 DSH 的 host-* 报上来，两边一致才说明会话能在这台机器上复制。
          const hostId = hostDeviceId()
          const callerHost = clip(body.hostId, 120) || (String(by).startsWith('host-') ? by : '')
          const sameMachine = callerHost ? callerHost === hostId : isLoopbackRequest(req)
          const source = sameMachine ? await localEvents(ctx, item.sessionId) : null
          if (source) {
            const cwd = source.cwd || item.cwd || process.cwd()
            let sessionId = null
            try {
              sessionId = await copySessionAnnounced(ctx, item.sessionId, cwd)
            } catch (error) {
              console.error('[team-space] 带广播的认领失败，退回无广播副本', error)
            }
            if (!sessionId) sessionId = await copySession(ctx, item.sessionId, cwd)
            if (!sessionId) {
              try {
                sessionId = await createAnnouncedSession(ctx, cwd, textSeed(item.text))
              } catch (error) {
                console.error('[team-space] 带广播的兜底会话失败，退回纯写盘', error)
                sessionId = await createTextSession(ctx, cwd, item.text)
              }
            }
            await mutateStore(store => {
              const record = store.tasks.find(entry => entry.id === id)
              if (!record) fail(E.NOT_FOUND, '记录不存在')
              record.claims ??= {}
              record.claims[by] = { sessionId, at: Date.now(), by, byName, deviceId: by, mode: 'local' }
              record.claim = record.claims[by]
              record.claimCount = (record.claimCount ?? 0) + 1
            })
            return { sessionId, reused: false, mode: 'local' }
          }

          // 跨设备：这里不建会话。建会话必须由成员本机的 /import-session 完成，
          // 否则会话文件落在主服务器上，成员的 openSession 永远打不开。
          const snapshot = await claimSnapshot(ctx, item)
          await mutateStore(store => {
            const record = store.tasks.find(entry => entry.id === id)
            if (!record) fail(E.NOT_FOUND, '记录不存在')
            record.claims ??= {}
            record.claims[by] = {
              ...(record.claims[by] ?? {}),
              sessionId: null,
              at: Date.now(),
              by,
              byName,
              deviceId: by,
              mode: 'remote',
              snapshotKind: snapshot.kind,
            }
            record.claim = record.claims[by]
            record.claimCount = (record.claimCount ?? 0) + 1
          })
          return { sessionId: null, reused: false, mode: 'remote', snapshot }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/import-session`,
        handler: route(async req => {
          // 认领第 2 段：必须跑在「要打开会话」的那台机器上。
          // 主服务器只给快照，会话由本机 agents.create 建，浏览器端才认得它。
          const body = await readJsonBody(req)
          const snapshot = body?.snapshot
          if (!snapshot || typeof snapshot !== 'object') fail(E.BAD_REQUEST, '缺少快照')
          const cwd = pickCwd(body.cwd)
          const { sessionId, kind } = await importSnapshot(ctx, snapshot, cwd)
          return { sessionId, kind }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/claim/commit`,
        handler: route(async req => {
          // 成员本机建好副本后回报 sessionId：交回回执时才知道该从哪台机器读。
          const body = await readJsonBody(req)
          const id = clip(body.id, 200)
          const sessionId = clip(body.sessionId, 200)
          if (!id) fail(E.BAD_REQUEST, '缺少 id')
          if (!sessionId) fail(E.BAD_REQUEST, '缺少 sessionId')
          const by = clip(body.by, 120)
          const claim = await mutateStore(store => {
            const item = store.tasks.find(entry => entry.id === id)
            if (!item) fail(E.NOT_FOUND, '记录不存在')
            item.claims ??= {}
            item.claims[by] = {
              ...(item.claims[by] ?? {}),
              sessionId,
              at: item.claims[by]?.at ?? Date.now(),
              by,
              byName: clip(body.byName, 80),
              deviceId: by,
              mode: 'remote',
            }
            item.claim = item.claims[by]
            return { ...item.claims[by] }
          })
          return { claim }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/receipt`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const shareId = clip(body.shareId, 200)
          if (!shareId) fail(E.BAD_REQUEST, '缺少 shareId')
          const by = clip(body.by, 120)
          // 认领副本在别人机器上时，这台机器读不到 —— 让发起方走本机 /local-session + /receipt/submit。
          const view = await mutateStore(store => {
            const item = store.tasks.find(entry => entry.id === shareId)
            if (!item) fail(E.NOT_FOUND, '分享不存在')
            return { title: item.title ?? '未命名会话', claim: { ...(claimOf(item, by) ?? {}) } }
          })
          if (!view.claim?.sessionId) fail(E.STATE_CONFLICT, '还没有人认领这条分享')
          const source = await localEvents(ctx, view.claim.sessionId)
          if (!source) {
            fail(E.STATE_CONFLICT, '认领副本不在这台机器上：请在认领副本所在机器上交回，或由发起方本机提交回执')
          }
          const receipt = buildReceipt({ title: view.title }, shareId, freshEvents(source.events, view.claim))
          const dropped = await mutateStore(store => {
            const item = store.tasks.find(entry => entry.id === shareId)
            if (!item) fail(E.NOT_FOUND, '分享不存在')
            const trimmed = [receipt, ...store.tasks]
            const droppedCount = Math.max(0, trimmed.length - MAX_ITEMS)
            store.tasks = trimmed.slice(0, MAX_ITEMS)
            // 推进增量水位：不推的话每次交回都把整段历史重复贴一遍
            const claim = claimOf(item, by)
            if (claim) {
              claim.since = Date.now()
              item.claim = claim
            }
            return droppedCount
          })
          return { receipt, dropped }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/receipt/submit`,
        handler: route(async req => {
          // 回执第 2 段：增量文本由「副本所在机器」本机算好再提交（和 share/submit 一个套路）。
          const body = await readJsonBody(req)
          const shareId = clip(body.shareId, 200)
          if (!shareId) fail(E.BAD_REQUEST, '缺少 shareId')
          const text = clip(body.text, 400_000)
          if (!text.trim()) fail(E.BAD_REQUEST, '回执内容是空的')
          const by = clip(body.by, 120)
          const { receipt, dropped } = await mutateStore(store => {
            const item = store.tasks.find(entry => entry.id === shareId)
            if (!item) fail(E.NOT_FOUND, '分享不存在')
            const claim = claimOf(item, by)
            const record = {
              id: randomUUID(),
              kind: 'receipt',
              parentId: shareId,
              title: `回执：${item.title}`,
              text,
              fromSessionId: clip(body.fromSessionId, 200) || claim?.sessionId || '',
              createdAt: Date.now(),
            }
            const trimmed = [record, ...store.tasks]
            const droppedCount = Math.max(0, trimmed.length - MAX_ITEMS)
            store.tasks = trimmed.slice(0, MAX_ITEMS)
            if (claim) {
              claim.since = Date.now()
              item.claim = claim
            }
            return { receipt: record, dropped: droppedCount }
          })
          return { receipt, dropped }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/entry/upsert`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const table = clip(body.table, 40)
          if (!ENTRY_TABLES.includes(table)) throw new Error('未知的表')
          const entry = await upsertEntry(table, body.entry ?? {})
          return { entry, table }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/entry/remove`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const table = clip(body.table, 40)
          const id = clip(body.id, 200)
          if (!ENTRY_TABLES.includes(table)) throw new Error('未知的表')
          if (!id) throw new Error('缺少 id')
          await mutateStore(store => {
            const before = store[table].length
            store[table] = store[table].filter(entry => entry.id !== id)
            if (store[table].length === before) fail(E.NOT_FOUND, '记录不存在')
          })
          return { removed: id, table }
        }),
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/remove`,
        handler: route(async req => {
          const body = await readJsonBody(req)
          const id = clip(body.id, 200)
          if (!id) throw new Error('缺少 id')
          await mutateStore(store => {
            const before = store.tasks.length
            store.tasks = store.tasks.filter(item => item.id !== id)
            if (store.tasks.length === before) fail(E.NOT_FOUND, '记录不存在')
          })
          return { removed: id }
        }),
      }),
    ]
    for (const definition of SHARED_TOOLS) disposers.push(ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 路由表已随服务器收起 */
        }
      }
    }
  }, 'team-space: routes')
}
