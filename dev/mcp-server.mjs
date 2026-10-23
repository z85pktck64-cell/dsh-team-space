#!/usr/bin/env node
/**
 * 团队空间 MCP server（stdio 传输，零依赖）。
 *
 * 给 Codex / 任何 MCP 客户端提供团队空间的读取与写入能力。
 * 协议：JSON-RPC 2.0 over stdio，每条消息一行 JSON。
 * 不引 @modelcontextprotocol/sdk —— 官方 SDK 会带一串传递依赖，
 * 而这个项目一直是零依赖，手写 initialize / tools/list / tools/call 三个方法足够。
 *
 * 配置（~/.codex/config.toml）：
 *   [mcp_servers.team-space]
 *   command = "node"
 *   args = ["/绝对路径/dev/mcp-server.mjs"]
 *   env = { TEAM_SPACE_URL = "http://192.168.42.124:8080", TEAM_SPACE_DEVICE_ID = "..." }
 *
 * 环境变量：
 *   TEAM_SPACE_URL        团队空间网关地址（必填；主服务器模式填本机局域网地址）
 *   TEAM_SPACE_DEVICE_ID  调用者设备 id（写操作要用；不填会退回 'codex'）
 *   TEAM_SPACE_USER       调用者显示名（默认 'Codex'）
 */

const BASE = (process.env.TEAM_SPACE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
const API = `${BASE}/api/team-space`
const DEVICE = process.env.TEAM_SPACE_DEVICE_ID || 'codex'
const USER = process.env.TEAM_SPACE_USER || 'Codex'
const PROTOCOL = '2024-11-05'

/** 调团队空间的 HTTP 接口；超时 20s，避免 Codex 卡住。 */
async function api(path, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(`${API}/${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    if (!response.ok) {
      const message = data?.error || data?.message || `HTTP ${response.status}`
      throw new Error(message)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

const TOOLS = [
  {
    name: 'team_space_list_skills',
    description: '列出团队空间里共享的技能（只返回名称与描述，不含正文）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'team_space_get_skill',
    description: '按名称取一条技能的完整正文。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名，例如 oi-prd-writer' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_space_list_members',
    description: '列出团队成员设备，含在线状态与能力卡。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'team_space_list_handoffs',
    description: '列出委托（可只取某个状态）。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'doing', 'done'], description: '按状态过滤，省略则全部' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'team_space_create_handoff',
    description: '发起一条委托给队友。target 是队友显示名或"任何人"留空。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话标题' },
        brief: { type: 'string', description: '完整说明：要做什么、怎么复现、期望结果' },
        target: { type: 'string', description: '指定队友名称；留空表示任何人都可接' },
      },
      required: ['title', 'brief'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_space_claim_handoff',
    description: '认领一条 open 状态的委托，认领后状态变为 doing。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '委托 id' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_space_complete_handoff',
    description: '给已认领（doing）的委托交回结果，状态变为 done。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '委托 id' },
        result: { type: 'string', description: '结果正文：做了什么、结论、对方需要注意的' },
      },
      required: ['id', 'result'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_space_list_sessions',
    description: '列出团队共享的会话（标题、预览、文件路径），不含完整正文。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'team_space_get_session',
    description: '按标题或 id 取一条共享会话的正文快照。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '会话记录 id（与 title 二选一）' },
        title: { type: 'string', description: '会话标题（与 id 二选一，用于按名字找）' },
      },
      additionalProperties: false,
    },
  },
]

/** 列表投影里 skills 的 content 已被裁掉，这里只挑需要的字段，避免把 800KB 全塞给模型。 */
function briefSkill(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description ?? '',
    updatedAt: item.updatedAt ?? item.createdAt ?? null,
  }
}

function briefSession(item) {
  return {
    id: item.id,
    title: item.title ?? '',
    preview: item.preview ?? '',
    messageCount: item.messageCount ?? 0,
    files: Array.isArray(item.files) ? item.files.slice(0, 10) : [],
    uploader: item.uploader?.label ?? '',
    updatedAt: item.updatedAt ?? item.createdAt ?? null,
  }
}

function briefHandoff(item) {
  return {
    id: item.id,
    title: item.title ?? '',
    target: item.target || '（任何人）',
    status: item.status ?? '',
    assignee: item.assignee ?? '',
    updatedAt: item.updatedAt ?? item.createdAt ?? null,
  }
}

const HANDLERS = {
  async team_space_list_skills() {
    const data = await api('list')
    const rows = (data?.tables?.skills ?? []).map(briefSkill)
    return { count: rows.length, skills: rows }
  },

  async team_space_get_skill(args) {
    const name = String(args.name ?? '').trim()
    if (!name) throw new Error('缺少 name')
    const data = await api('list')
    const hit = (data?.tables?.skills ?? []).find(item => item.name === name)
    if (!hit) throw new Error(`没有名为 ${name} 的技能`)
    const detail = await api(`detail?table=skills&id=${encodeURIComponent(hit.id)}`)
    return { name: hit.name, description: hit.description ?? '', content: detail?.entry?.content ?? '' }
  },

  async team_space_list_members() {
    // 两个概念别混：设备来自 gateway-status（谁在线），
    // 成员卡来自 member/list（谁有什么能力画像）。原来只读后者，
    // 而当前数据里没有成员卡，于是永远返回空数组。
    const [status, cards] = await Promise.all([
      api('gateway-status').catch(() => null),
      api('member/list').catch(() => null),
    ])
    const devices = (status?.devices ?? []).map(d => ({
      name: d.name ?? '',
      online: !!d.online,
    }))
    const memberCards = (cards?.members ?? []).map(c => ({
      name: c.name ?? '',
      bio: c.bio ?? '',
    }))
    return {
      onlineDevices: status?.onlineDevices ?? devices.filter(d => d.online).length,
      totalDevices: status?.joins ?? devices.length,
      devices,
      memberCards,
    }
  },

  async team_space_list_handoffs(args) {
    const status = String(args.status ?? '').trim()
    const data = await api('list')
    let rows = data?.tables?.handoffs ?? []
    if (status) rows = rows.filter(item => item.status === status)
    return { count: rows.length, handoffs: rows.map(briefHandoff) }
  },

  async team_space_create_handoff(args) {
    const title = String(args.title ?? '').trim()
    const brief = String(args.brief ?? '').trim()
    if (!title) throw new Error('缺少 title')
    if (!brief) throw new Error('缺少 brief')
    const created = await api('handoff/create', {
      method: 'POST',
      body: JSON.stringify({
        title,
        brief,
        target: String(args.target ?? '').trim(),
        owner: USER,
        deviceId: DEVICE,
        author: { name: USER, avatar: '' },
      }),
    })
    return { ok: true, id: created?.item?.id ?? created?.id ?? '', title }
  },

  async team_space_claim_handoff(args) {
    const id = String(args.id ?? '').trim()
    if (!id) throw new Error('缺少 id')
    await api('handoff/claim', { method: 'POST', body: JSON.stringify({ id, by: USER }) })
    return { ok: true, id, status: 'doing' }
  },

  async team_space_complete_handoff(args) {
    const id = String(args.id ?? '').trim()
    const result = String(args.result ?? '').trim()
    if (!id) throw new Error('缺少 id')
    if (!result) throw new Error('缺少 result')
    await api('handoff/complete', { method: 'POST', body: JSON.stringify({ id, result, by: USER }) })
    return { ok: true, id, status: 'done' }
  },

  async team_space_list_sessions() {
    const data = await api('list')
    const rows = (data?.tables?.tasks ?? []).map(briefSession)
    return { count: rows.length, sessions: rows }
  },

  async team_space_get_session(args) {
    const id = String(args.id ?? '').trim()
    const title = String(args.title ?? '').trim()
    if (!id && !title) throw new Error('需要 id 或 title')
    const data = await api('list')
    const rows = data?.tables?.tasks ?? []
    const hit = id
      ? rows.find(item => item.id === id)
      : rows.find(item => (item.title ?? '') === title) ?? rows.find(item => (item.title ?? '').includes(title))
    if (!hit) throw new Error('没有找到这条会话')
    const detail = await api(`detail?table=tasks&id=${encodeURIComponent(hit.id)}`)
    return { title: hit.title ?? '', cwd: hit.cwd ?? '', text: detail?.entry?.text ?? '' }
  },
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message) } })
}

async function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
    return
  }

  const { id, method, params } = message ?? {}
  // 通知类消息没有 id，不需要回复
  if (id === undefined) return

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'team-space', version: '1.0.0' },
      })
      return
    }
    if (method === 'tools/list') {
      reply(id, { tools: TOOLS })
      return
    }
    if (method === 'tools/call') {
      const name = params?.name
      const handler = HANDLERS[name]
      if (!handler) {
        replyError(id, `未知工具：${name}`)
        return
      }
      const result = await handler(params?.arguments ?? {})
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      return
    }
    if (method === 'ping') {
      reply(id, {})
      return
    }
    replyError(id, `不支持的方法：${method}`)
  } catch (error) {
    // 工具执行失败也要作为正常 result 返回 isError，让模型能看到原因
    if (method === 'tools/call') {
      reply(id, { content: [{ type: 'text', text: `调用失败：${error.message}` }], isError: true })
    } else {
      replyError(id, error.message)
    }
  }
}

let buffer = ''
let pending = 0
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    // 必须计数：handle 里有 await（HTTP 调用），stdin 收到 EOF 时直接 exit
    // 会把还没回来的响应一起杀掉，表现为「调用没输出」。
    pending++
    handle(line).finally(() => { pending-- })
  }
})
process.stdin.on('end', () => {
  const wait = () => (pending === 0 ? process.exit(0) : setTimeout(wait, 20))
  wait()
})
