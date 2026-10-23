#!/usr/bin/env node
/**
 * 本地预览构建：从 lib/client.js 抽出 CSS，生成 dev/preview.html。
 * 用途：改样式不用装插件、不用重启 DSH，浏览器刷新即可看。
 *
 *   node dev/build-preview.mjs && open dev/preview.html
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
if (start < 'const CSS = `'.length) throw new Error('找不到 CSS 模板')
const end = source.indexOf('`', start)
const css = source.slice(start, end)

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>团队空间 · 本地预览</title>
<style>
html,body{margin:0;height:100%;background:#111;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}
.ts-root{height:100%}
${css}
</style>
</head>
<body>
<div class="ts-root" data-theme="dark">
  <div class="ts-page">
    <header class="ts-topbar">
      <div class="ts-brand-row">
        <h1 class="ts-brand">团队空间</h1>
        <button class="ts-brand-refresh" title="刷新"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg></button>
      </div>
      <div class="ts-topbar-actions">
        <label class="ts-search">
          <svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>
          <input placeholder="搜索标题、描述、URL…">
          <span class="ts-kbd"><span>⌘</span><span>K</span></span>
        </label>
        <div class="ts-pop-wrap">
          <button class="ts-avatar-btn"><span class="ts-avatar ts-avatar-letter" style="width:32px;height:32px;background:#5b6cff">X</span></button>
        </div>
      </div>
    </header>

    <nav class="ts-tabs">
      <button class="ts-tab" data-active="true"><span class="ts-tab-ico"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l2.5 2.5L16 8"/><rect x="4" y="4" width="16" height="16" rx="4"/></svg></span><span class="ts-tab-label">会话</span><span class="ts-count">2</span></button>
      <button class="ts-tab"><span class="ts-tab-ico"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8h13"/><path d="m14 5 3 3-3 3"/><path d="M20 16H7"/><path d="m10 13-3 3 3 3"/></svg></span><span class="ts-tab-label">F-Assign</span><span class="ts-count">1</span></button>
      <button class="ts-tab"><span class="ts-tab-ico"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h3M4 13h3M4 19h3M11 7h9M11 13h9M11 19h9"/></svg></span><span class="ts-tab-label">TODO</span><span class="ts-count">1</span></button>
      <button class="ts-tab"><span class="ts-tab-ico"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3v3a3 3 0 0 1-3 3H3v2h3a3 3 0 0 1 3 3v3h2v-3a3 3 0 0 1 3-3h4v-2h-4a3 3 0 0 1-3-3V3z"/></svg></span><span class="ts-tab-label">插件</span><span class="ts-count">4</span></button>
      <button class="ts-tab"><span class="ts-tab-ico"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l1.9 4.9L19 9.8l-4.2 3.2L15.7 19 12 16.1 8.3 19l.9-6L5 9.8l5.1-1.9z"/></svg></span><span class="ts-tab-label">SKILL</span><span class="ts-count">48</span></button>
      <button class="ts-tab"><span class="ts-tab-ico"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="12" r="2.2"/><path d="M7 8.2v7.6M9.2 6h3.3a2 2 0 0 1 2 2v2M17 14.2h-6"/></svg></span><span class="ts-tab-label">Git</span><span class="ts-count">2</span></button>
    </nav>

    <div class="ts-list">
      <article class="ts-session" data-kind="tasks" data-status="open" style="--i:0">
        <div class="ts-s-main">
          <div class="ts-s-head">
            <span class="ts-type-ico"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l2.5 2.5L16 8"/><rect x="4" y="4" width="16" height="16" rx="4"/></svg></span>
            <h3 class="ts-s-title">固定翻译 dsh 思考内容为中文</h3>
            <span class="ts-badge ts-badge--open">待认领</span>
          </div>
          <p class="ts-s-desc">将 dsh 思考的部分固定翻译成中文展示</p>
          <div class="ts-s-meta">
            <span class="ts-author"><span class="ts-avatar ts-avatar-xs ts-avatar-letter" style="background:#5b6cff">X</span><span>Xinzhan</span></span>
            <span><svg class="ts-i ts-i-sm" style="display:inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg> 3 个附件</span>
            <span class="mono">seq 191</span>
          </div>
        </div>
        <div class="ts-s-side">
          <span class="ts-s-time"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>今天 09:20</span>
          <div class="ts-s-actions">
            <button class="ts-btn ts-btn-claim">认领</button>
            <button class="ts-btn ts-btn-ghost">⋯</button>
          </div>
        </div>
      </article>

      <article class="ts-session" data-kind="handoffs" data-status="open" style="--i:1">
        <div class="ts-s-main">
          <div class="ts-s-head">
            <span class="ts-type-ico"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8h13"/><path d="m14 5 3 3-3 3"/><path d="M20 16H7"/><path d="m10 13-3 3 3 3"/></svg></span>
            <h3 class="ts-s-title">联调拍照回调接口</h3>
            <span class="ts-badge ts-badge--new">进行中</span>
          </div>
          <p class="ts-s-desc">在张三的机器上复现拍照回调超时，确认签名校验与时间戳精度</p>
          <div class="ts-s-meta">
            <span class="ts-author"><span class="ts-avatar ts-avatar-xs ts-avatar-letter" style="background:#14b8a6">L</span><span>李四</span></span>
            <span class="mono">给 张三</span>
          </div>
        </div>
        <div class="ts-s-side">
          <span class="ts-s-time">2 小时前</span>
          <div class="ts-s-actions">
            <button class="ts-btn ts-btn-soft">交回结果</button>
            <button class="ts-btn ts-btn-ghost">⋯</button>
          </div>
        </div>
      </article>
    </div>

    <!-- 浮窗预览（常显） -->
    <div style="position:fixed;right:28px;top:96px;">
      <div class="ts-pop" style="opacity:1;transform:none;pointer-events:auto;position:static;">
        <div class="ts-pop-head ts-pop-user">
          <button class="ts-avatar-btn"><span class="ts-avatar ts-avatar-letter" style="width:34px;height:34px;background:#5b6cff">X</span></button>
          <div class="ts-pop-user-box">
            <div class="ts-pop-user-name">
              <span class="ts-pop-title">Xinzhan</span>
              <button class="ts-icon-btn"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/></svg></button>
            </div>
            <span class="ts-pop-sub">主服务器</span>
          </div>
          <span class="ts-conn-state" data-on="true"><span class="ts-dot"></span>已开启</span>
        </div>
        <div class="ts-pop-row"><span class="ts-pop-k">能力卡</span><div class="ts-caps"><span class="ts-cap-empty">客户端开发 / 车机 / 移动端…</span><button class="ts-cap-action">编辑</button></div></div>
        <div class="ts-pop-row"><span class="ts-pop-k">域名</span><span class="ts-pop-v mono"></span></div>
        <div class="ts-pop-row"><span class="ts-pop-k">已加入</span><span class="ts-pop-v"><b>2</b> 台设备</span></div>
        <div class="ts-pop-row">
          <span class="ts-pop-k">委托</span>
          <label class="ts-switch"><input type="checkbox" checked><span>自动接收委托</span></label>
        </div>
        <div class="ts-pop-row ts-join">
          <span class="ts-pop-k">加入</span>
          <input class="ts-pop-input" value="">
          <button class="ts-pop-go"><svg class="ts-i ts-i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h13"/><path d="m12 6 6 6-6 6"/></svg></button>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>
`

writeFileSync(join(here, 'preview.html'), page)
console.log('✓ dev/preview.html 已生成（CSS', css.length, 'chars）')
