#!/usr/bin/env node
/**
 * J08：客户端断网。
 *
 * 在真实浏览器里分别中断「认领委托」与「确认分享」请求，验证：
 * - 有明确失败提示；
 * - 页面不白屏；
 * - 服务端状态没有被静默改掉。
 *
 * 依赖 Playwright：
 *   NODE_PATH="$PWD/node_modules" node dev/e2e-offline.cjs \
 *     --url=http://127.0.0.1:<port>/?token=...
 */
const { chromium } = require('playwright')
const { join, resolve } = require('node:path')
const { mkdirSync } = require('node:fs')

const arg = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''
const URL_ARG = arg('url')
const SHOTS = resolve(arg('shots') || join(__dirname, '..', 'docs', 'images'))
if (!URL_ARG) {
  console.error('用法：node dev/e2e-offline.cjs --url=http://127.0.0.1:<port>/?token=...')
  process.exit(2)
}

const parsed = new URL(URL_ARG)
const API = `${parsed.origin}/api/team-space`
const STAMP = `offline-${Date.now().toString(36)}`
const TEST = { 'x-team-space-channel': 'test', accept: 'application/json' }
const handoffIds = []
let checks = 0
let failures = 0

function ok(name, cond, detail = '') {
  checks += 1
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures += 1
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}/${path}`, {
    method,
    headers: {
      ...TEST,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!response.ok || data?.ok === false) {
    throw new Error(`${path} → HTTP ${response.status} ${data?.error ?? text.slice(0, 160)}`)
  }
  return data
}

async function cleanup() {
  let deviceId = ''
  try { deviceId = (await api('gateway-status')).deviceId ?? '' } catch { /* 忽略 */ }
  for (const id of handoffIds) {
    await api('handoff/remove', { method: 'POST', body: { id, deviceId } }).catch(() => null)
  }
}

async function gotoApp(page) {
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(1800)
  await page.evaluate(() => {
    localStorage.setItem('team-space:name', 'Xinzhan')
    localStorage.setItem('team-space:channel', 'test')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
}

async function openTeam(page) {
  await page.locator('.ts-nav-text').click()
  await page.locator('.ts-root').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)
}

async function clickTab(page, label) {
  await page.locator('.ts-tab').filter({ hasText: label }).click()
  await page.waitForTimeout(350)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  console.log(`\nJ08 客户端断网 · ${parsed.origin} · ${STAMP}\n`)

  const handoff = await api('handoff/create', {
    method: 'POST',
    body: {
      title: `${STAMP}-待认领`,
      brief: 'J08：认领请求被中断时，不得静默成功，也不得白屏。',
      target: 'Xinzhan',
      owner: 'J08',
      author: { name: 'J08' },
    },
  })
  handoffIds.push(handoff.id)

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await gotoApp(page)
    await openTeam(page)

    // 1) 认领：服务端请求被中断
    await clickTab(page, '委托')
    const card = page.locator('.ts-session').filter({ hasText: `${STAMP}-待认领` }).first()
    await card.waitFor({ state: 'visible', timeout: 8000 })
    await page.route('**/api/team-space/handoff/claim**', route => route.abort('failed'))
    await card.getByRole('button', { name: '接收', exact: true }).click()
    const claimError = page.locator('.ts-error').last()
    await claimError.waitFor({ state: 'visible', timeout: 6000 })
    const claimErrorText = (await claimError.innerText()).trim()
    ok('J08 认领断网时显示可行动的中文错误',
      claimErrorText.includes('连不上团队空间服务器') && claimErrorText.includes('重试'),
      `error=${JSON.stringify(claimErrorText)}`)
    ok('J08 认领断网后页面仍在，没有白屏',
      await page.locator('.ts-root').isVisible() && await page.locator('.ts-brand').isVisible())
    ok('J08 认领断网后卡片仍是待接收',
      (await card.locator('.ts-badge').innerText()).trim() === '待接收'
        && await card.getByRole('button', { name: '接收', exact: true }).isVisible())
    const afterClaim = await api(`detail?table=handoffs&id=${encodeURIComponent(handoff.id)}`)
    ok('J08 认领断网后服务端仍为 open，未被静默认领',
      afterClaim.entry?.status === 'open' && !afterClaim.entry?.assignee,
      JSON.stringify({ status: afterClaim.entry?.status, assignee: afterClaim.entry?.assignee }))
    await page.screenshot({ path: join(SHOTS, 'ui-J08-offline-claim.png'), fullPage: true })
    await page.unroute('**/api/team-space/handoff/claim**')

    // 2) 分享：预览成功后，中断“确认上传”
    const sessionTitle = page.getByText('分析仓库并更新git', { exact: true }).first()
    const sessionTitleVisible = await sessionTitle.isVisible().catch(() => false)
    if (!sessionTitleVisible) {
      await page.getByRole('button', { name: /展开其余/ }).click().catch(() => null)
      await page.waitForTimeout(500)
    }
    await sessionTitle.waitFor({ state: 'visible', timeout: 8000 })
    await sessionTitle.hover()
    const rowMenu = page.locator('button[aria-label^="会话"]').first()
    await rowMenu.waitFor({ state: 'visible', timeout: 5000 })
    await rowMenu.click()

    const shareItem = page.getByRole('menuitem', { name: '分享到团队空间' })
    await shareItem.waitFor({ state: 'visible', timeout: 5000 })
    await shareItem.click()
    const dialog = page.getByRole('dialog').last()
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    const previewText = await dialog.innerText()
    ok('J08 分享先展示本地快照预览，再允许上传',
      previewText.includes('确认后才会上传') && previewText.includes('分析仓库并更新git'))

    const tasksBefore = new Set(((await api('list')).tables?.tasks ?? []).map(item => item.id))
    await page.route('**/api/team-space/share**', route => route.abort('failed'))
    await dialog.getByRole('button', { name: '确认上传', exact: true }).click()
    await dialog.getByText(/连不上团队空间服务器/).first()
      .waitFor({ state: 'visible', timeout: 6000 }).catch(() => null)
    const shareText = await dialog.innerText()
    ok('J08 分享断网时在对话框内显示可行动的中文错误',
      shareText.includes('连不上团队空间服务器') && shareText.includes('重试'), shareText.slice(-240))
    ok('J08 分享断网时不显示「已分享到团队空间」，也不白屏',
      !shareText.includes('已分享到团队空间')
        && await page.locator('.ts-root').isVisible()
        && await dialog.isVisible())
    const tasksAfter = new Set(((await api('list')).tables?.tasks ?? []).map(item => item.id))
    ok('J08 分享断网后服务端没有新增会话记录',
      tasksAfter.size === tasksBefore.size && [...tasksAfter].every(id => tasksBefore.has(id)),
      JSON.stringify({ before: tasksBefore.size, after: tasksAfter.size }))
    await page.unroute('**/api/team-space/share**')
    await page.close()
  } finally {
    await browser.close().catch(() => null)
    await cleanup().catch(error => console.log(`  ! 清理失败：${error.message}`))
  }

  console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 条失败` : '，全部通过'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch(async error => {
  console.error('\nJ08 中断：', error.stack || error.message, '\n')
  await cleanup().catch(() => null)
  process.exit(1)
})
