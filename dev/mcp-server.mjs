#!/usr/bin/env node
/**
 * 团队空间 MCP server（stdio 传输）。
 *
 * 工具定义与处理器在 lib/mcp-tools.js —— 和 HTTP 传输（POST /api/team-space/mcp）
 * 共用同一份，避免两处语义走样。
 *
 * 这个文件只负责：读 stdin 的一行行 JSON-RPC、分发、把结果写回 stdout。
 *
 * 配置（~/.codex/config.toml）：
 *   [mcp_servers.team-space]
 *   command = "node"
 *   args = ["<本机>/dev/mcp-server.mjs"]
 *   env = { TEAM_SPACE_URL = "http://<主服务器>:8080", TEAM_SPACE_DEVICE_ID = "..." }
 *
 * 不装插件、不配路径也行 —— 用 HTTP 版，只写一个 url：
 *   [mcp_servers.team-space]
 *   url = "http://<主服务器>:8080/api/team-space/mcp"
 *
 * 环境变量：
 *   TEAM_SPACE_URL        团队空间网关地址（默认 http://127.0.0.1:8080）
 *   TEAM_SPACE_DEVICE_ID  调用者设备 id（写操作要用；默认 'codex'）
 *   TEAM_SPACE_USER       调用者显示名（默认 'MCP 客户端'）
 *   TEAM_SPACE_CHANNEL    'test' 时写入进测试通道（实测用，不污染真实数据）
 */

import { createHandlers, handleRpc } from '../lib/mcp-tools.js'

const BASE = (process.env.TEAM_SPACE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
const handlers = createHandlers({
  apiBase: `${BASE}/api/team-space`,
  device: process.env.TEAM_SPACE_DEVICE_ID || 'codex',
  user: process.env.TEAM_SPACE_USER || 'MCP 客户端',
  // 实测用：TEAM_SPACE_CHANNEL=test 让写入进测试通道，不污染真实数据、不发企微通知
  channel: String(process.env.TEAM_SPACE_CHANNEL ?? '').trim().toLowerCase() === 'test' ? 'test' : 'prod',
})

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
    return
  }
  const reply = await handleRpc(message, handlers)
  if (reply) send(reply)
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
