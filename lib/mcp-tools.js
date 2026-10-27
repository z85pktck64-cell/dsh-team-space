/**
 * 团队空间的 MCP 工具定义与处理器（传输无关）。
 *
 * 两种传输共用这一份：
 *   · dev/mcp-server.mjs —— stdio（Codex 本地进程）
 *   · lib/index.js       —— HTTP（POST /api/team-space/mcp，零安装）
 *
 * 之所以抽出来：工具语义和「怎么传输」无关，抄两份必然走样。
 */

export const PROTOCOL = '2024-11-05'

export const TOOLS = [
  {
    name: 'team_space_list_skills',
    description: '列出团队空间里共享的技能（只返回名称与描述，不含正文）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'team_space_get_skill',
    description: '按名称取一条技能的正文与完整包地址。多文件技能只有正文会丢 references/scripts；直接执行返回的 installCommand 即可装全（下载 + sha 校验 + 解压）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名，例如 oi-prd-writer' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_space_list_members',
    description: '列出团队成员设备（在线状态）与成员卡。',
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
    description: '发起一条委托给队友。target 是队友显示名，留空表示任何人都可接。',
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
const briefSkill = item => ({
  id: item.id,
  name: item.name,
  description: item.description ?? '',
  updatedAt: item.updatedAt ?? item.createdAt ?? null,
  // 多文件技能（带 references/scripts）只有正文会缺东西。
  // 列表里先标出来，客户端才知道这条要不要走完整包。
  fileCount: item.fileCount ? Number(item.fileCount) : 0,
  hasPackage: Boolean(item.packageUrl),
})

const briefSession = item => ({
  id: item.id,
  title: item.title ?? '',
  preview: item.preview ?? '',
  messageCount: item.messageCount ?? 0,
  files: Array.isArray(item.files) ? item.files.slice(0, 10) : [],
  uploader: item.uploader?.label ?? '',
  updatedAt: item.updatedAt ?? item.createdAt ?? null,
})

const briefHandoff = item => ({
  id: item.id,
  title: item.title ?? '',
  target: item.target || '（任何人）',
  status: item.status ?? '',
  assignee: item.assignee ?? '',
  updatedAt: item.updatedAt ?? item.createdAt ?? null,
})

/**
 * 建一组处理器。
 * @param {object} options
 * @param {string} options.apiBase  形如 http://127.0.0.1:8080/api/team-space
 * @param {string} [options.device] 调用者设备 id（写操作要用）
 * @param {string} [options.user]   调用者显示名
 */
export function createHandlers({ apiBase, device = 'mcp', user = 'MCP 客户端', channel = 'prod' }) {
  // 通道走 header：MCP 客户端设 TEAM_SPACE_CHANNEL=test 后，造出来的数据进测试通道，
  // 不会出现在同事看到的真实列表里，也不会触发企微通知。
  const channelHeaders = channel === 'test' ? { 'x-team-space-channel': 'test' } : {}
  const api = async (path, init = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch(`${apiBase}/${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...channelHeaders, ...(init.headers ?? {}) },
      })
      const text = await response.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
      if (!response.ok) throw new Error(data?.error || data?.message || `HTTP ${response.status}`)
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  return {
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
      const packageName = String(hit.name ?? '').replace(/[^\w.\-]/g, '') || 'skill'
      // 给客户端一条能直接粘进终端的命令：下载 → 校验 sha → 解压到技能目录。
      // 只有 packageUrl 的话，客户端还得自己拼 curl/tar，很容易漏掉 sha 校验。
      // 注意：macOS 用 shasum，Linux 一般用 `sha256sum -c -`。
      // 先删旧目录再解压：tar 覆盖已存在文件在某些文件系统上会失败，
      // 而且旧版有、新版删掉的文件会被留下来，变成新旧混杂。
      // packageName 已经过 [^\w.\-] 过滤，拼进路径不会穿越。
      const installCommand = hit.packageUrl
        ? [
            `curl -fsSL -o /tmp/${packageName}.tgz "${hit.packageUrl}"`,
            `&& echo "${hit.packageSha256}  /tmp/${packageName}.tgz" | shasum -a 256 -c -`,
            `&& rm -rf ~/.dsh/skills/${packageName}`,
            `&& mkdir -p ~/.dsh/skills`,
            `&& tar -xzf /tmp/${packageName}.tgz -C ~/.dsh/skills`,
            `&& echo "已装到 ~/.dsh/skills/${packageName}"`,
          ].join(' ')
        : ''
      return {
        name: hit.name,
        description: hit.description ?? '',
        content: detail?.entry?.content ?? '',
        // 正文只有 SKILL.md：带 references/scripts 的技能要靠这几个字段自己下载解压，
        // 否则拿到的是一个残缺技能（api-test-automation-pro 有 65 个文件）。
        packageUrl: hit.packageUrl || '',
        packageSha256: hit.packageSha256 || '',
        fileCount: hit.fileCount ? Number(hit.fileCount) : 0,
        installCommand,
      }
    },

    async team_space_list_members() {
      // 两个概念别混：设备来自 gateway-status（谁在线），成员卡来自 member/list（能力画像）
      const [status, cards] = await Promise.all([
        api('gateway-status').catch(() => null),
        api('member/list').catch(() => null),
      ])
      const devices = (status?.devices ?? []).map(d => ({ name: d.name ?? '', online: !!d.online }))
      const memberCards = (cards?.members ?? []).map(c => ({ name: c.name ?? '', bio: c.bio ?? '' }))
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
          owner: user,
          deviceId: device,
          author: { name: user, avatar: '' },
        }),
      })
      return { ok: true, id: created?.item?.id ?? created?.id ?? '', title }
    },

    async team_space_claim_handoff(args) {
      const id = String(args.id ?? '').trim()
      if (!id) throw new Error('缺少 id')
      await api('handoff/claim', { method: 'POST', body: JSON.stringify({ id, by: user }) })
      return { ok: true, id, status: 'doing' }
    },

    async team_space_complete_handoff(args) {
      const id = String(args.id ?? '').trim()
      const result = String(args.result ?? '').trim()
      if (!id) throw new Error('缺少 id')
      if (!result) throw new Error('缺少 result')
      await api('handoff/complete', { method: 'POST', body: JSON.stringify({ id, result, by: user }) })
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
}

/**
 * 处理一条 JSON-RPC 消息，返回要回给客户端的对象；通知类消息返回 null。
 * 传输层（stdio / HTTP）只负责收发，不碰这里的分发逻辑。
 */
export async function handleRpc(message, handlers) {
  const { id, method, params } = message ?? {}
  if (id === undefined) return null

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'team-space', version: '1.0.0' },
        },
      }
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    }
    if (method === 'tools/call') {
      const name = params?.name
      const handler = handlers[name]
      if (!handler) return { jsonrpc: '2.0', id, error: { code: -32000, message: `未知工具：${name}` } }
      const result = await handler(params?.arguments ?? {})
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    return { jsonrpc: '2.0', id, error: { code: -32000, message: `不支持的方法：${method}` } }
  } catch (error) {
    // 工具执行失败也作为正常 result 返回 isError，让模型能看到原因
    if (method === 'tools/call') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `调用失败：${error.message}` }], isError: true },
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32000, message: String(error.message) } }
  }
}
