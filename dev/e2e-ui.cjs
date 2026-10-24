#!/usr/bin/env node
/**
 * H01–H16 浏览器交互回归。
 *
 * 依赖 Playwright（仓库本身不引入运行时依赖）：
 *   npm i --no-save playwright
 *   NODE_PATH="$PWD/node_modules" node dev/e2e-ui.cjs --url=http://127.0.0.1:<port>/?token=...
 *
 * 写操作全部走 test 通道，并创建带随机 stamp 的临时记录；结束（含失败）时清理。
 */
const { chromium } = require('playwright')
const { mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const arg = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''
const URL_ARG = arg('url')
const SHOTS = resolve(arg('shots') || join(__dirname, '..', 'docs', 'images'))
if (!URL_ARG) {
  console.error('用法：node dev/e2e-ui.cjs --url=http://127.0.0.1:<port>/?token=...')
  process.exit(2)
}

const parsed = new URL(URL_ARG)
const ORIGIN = parsed.origin
const API = `${ORIGIN}/api/team-space`
const STAMP = `ui-${Date.now().toString(36)}`
const TEST = { 'x-team-space-channel': 'test', accept: 'application/json' }

let checks = 0
let failures = 0
const seeded = []
const createdNames = []

function ok(name, cond, detail = '') {
  checks += 1
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures += 1
}

async function api(path, { method = 'GET', body, channel = 'test' } = {}) {
  const response = await fetch(`${API}/${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(channel === 'test' ? TEST : {}),
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

async function seed(table, entry) {
  const data = await api('entry/upsert', { method: 'POST', body: { table, entry } })
  seeded.push({ table, id: data.entry.id })
  return data.entry
}

async function cleanup() {
  const list = await api('list').catch(() => null)
  const rows = Object.entries(list?.tables ?? {}).flatMap(([table, items]) => (items ?? []).map(item => ({ table, item })))
    .filter(({ table, item }) => {
      if (seeded.some(entry => entry.table === table && entry.id === item.id)) return true
      const hay = [item.name, item.title, item.url, item.description].filter(Boolean).join(' ')
      return hay.includes(STAMP)
    })
  for (const { table, item } of rows) {
    await api('entry/remove', { method: 'POST', body: { table, id: item.id } }).catch(() => null)
  }
  if (createdNames.length) {
    const after = await api('list').catch(() => null)
    for (const name of createdNames) {
      const item = (after?.tables?.repos ?? []).find(row => row.name === name)
      if (item) await api('entry/remove', { method: 'POST', body: { table: 'repos', id: item.id } }).catch(() => null)
    }
  }
}

async function shot(page, name) {
  await page.waitForTimeout(120)
  await page.screenshot({ path: join(SHOTS, name), fullPage: true })
}

async function gotoApp(page, { name = 'Xinzhan', channel = 'prod' } = {}) {
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(1800)
  await page.evaluate(({ name, channel }) => {
    localStorage.setItem('team-space:name', name)
    if (channel === 'test') localStorage.setItem('team-space:channel', 'test')
    else localStorage.removeItem('team-space:channel')
  }, { name, channel })
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

async function cardNamed(page, name) {
  return page.locator('.ts-session').filter({ hasText: name }).first()
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  console.log(`\nH 组 UI 回归 · ${ORIGIN} · ${STAMP}\n`)

  const channelSkill = await seed('skills', {
    name: `${STAMP}-channel`,
    description: 'H03/H04 测通道计数',
    content: '# channel fixture',
  })
  const freshPlugin = await seed('plugins', {
    name: `${STAMP}-fresh-plugin`,
    version: '1.0.0',
    source: 'H12 fixture',
    audit: '仅测试数据',
    installCommand: '',
  })
  const updatePlugin = await seed('plugins', {
    name: 'dsh-tool-app-verify',
    version: '9.9.9',
    source: 'H12 fixture',
    audit: '本机已安装旧版，预期显示更新',
    installCommand: '',
  })
  const deleteLink = await seed('repos', {
    name: `${STAMP}-删除确认`,
    url: `https://example.feishu.cn/docx/${STAMP}-delete`,
    description: `H13 fixture ${STAMP}`,
    type: 'doc',
  })
  const conflictLink = await seed('repos', {
    name: `${STAMP}-冲突接管`,
    url: `https://example.feishu.cn/docx/${STAMP}-conflict`,
    description: `H14 fixture ${STAMP}`,
    type: 'doc',
  })
  const searchLink = await seed('repos', {
    name: `NAME-${STAMP}`,
    url: `https://example.feishu.cn/docx/URL-${STAMP}`,
    description: `DESC-${STAMP}`,
    type: 'doc',
  })

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    // H01 / H02：侧栏待认领数 + 数字位置
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      await gotoApp(page, { name: '佳瑛' })
      const prod = await api('list', { channel: 'prod' })
      const expected = (prod.tables?.handoffs ?? []).filter(item => item.status === 'open' && item.target === '佳瑛').length
      await page.waitForFunction(value => {
        const text = document.querySelector('.ts-nav-text')?.innerText ?? ''
        return value > 0 ? text.includes(`（${value}）`) : !text.includes('（')
      }, expected, { timeout: 12_000 }).catch(() => null)
      const navText = await page.locator('.ts-nav-text').innerText()
      ok('H01 侧栏显示「团队空间（N）」，N 与可见 open 委托一致',
        expected > 0 ? navText.includes(`（${expected}）`) : !navText.includes('（'),
        `expected=${expected} actual=${JSON.stringify(navText)}`)
      const positions = await page.locator('.ts-nav-text').evaluate(node => {
        const textNode = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.includes('团队空间'))
        const range = document.createRange()
        range.selectNodeContents(textNode)
        const textRect = range.getBoundingClientRect()
        const count = node.querySelector('.ts-nav-count')
        const countRect = count?.getBoundingClientRect()
        return { textRight: textRect.right, countLeft: countRect?.left ?? null, order: count ? [...node.childNodes].indexOf(count) : -1 }
      })
      ok('H02 数字在文字之后，不在前面',
        positions.countLeft === null || (positions.countLeft >= positions.textRight - 1 && positions.order > 0),
        JSON.stringify(positions))
      await shot(page, 'ui-H01-H02-nav-count.png')
      await page.close()
    }

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await gotoApp(page, { name: 'Xinzhan', channel: 'prod' })
    await openTeam(page)

    // H03 / H04：切测试通道，徽标出现且列表不用刷新立即变
    {
      await page.evaluate(() => { window.__h04Sentinel = 'alive' })
      await clickTab(page, 'SKILL')
      const before = Number((await page.locator('.ts-tab').filter({ hasText: 'SKILL' }).locator('.ts-count').innerText()).trim())
      const expectedAfter = (await api('list')).tables.skills.length
      await page.getByRole('button', { name: '我的资料' }).click()
      await page.locator('.ts-channel-btn').click()
      await page.locator('.ts-channel-pill').waitFor({ state: 'visible', timeout: 4000 })
      await page.waitForFunction(expected => {
        const tab = [...document.querySelectorAll('.ts-tab')].find(node => node.innerText.includes('SKILL'))
        return Number(tab?.querySelector('.ts-count')?.textContent ?? -1) === expected
      }, expectedAfter, { timeout: 5000 }).catch(() => null)
      const after = Number((await page.locator('.ts-tab').filter({ hasText: 'SKILL' }).locator('.ts-count').innerText()).trim())
      const pill = page.locator('.ts-channel-pill')
      const style = await pill.evaluate(node => {
        const computed = getComputedStyle(node)
        return { background: computed.backgroundColor, color: computed.color, visible: computed.display !== 'none' }
      })
      ok('H03 切到测试通道后出现橙色通道徽标', await pill.isVisible() && style.background !== 'rgba(0, 0, 0, 0)', JSON.stringify(style))
      ok('H04 通道切换后列表立即刷新（计数等于 test 视图，无需手动刷新）',
        after === expectedAfter && after > before, `prod ${before} → test ${after}（期望 ${expectedAfter}）`)
      ok('H04 切换过程没有整页刷新', await page.evaluate(() => window.__h04Sentinel) === 'alive')
      ok('H04 测试记录已出现在测试通道列表中', (await page.locator('.ts-root').innerText()).includes(channelSkill.name))
      await shot(page, 'ui-H03-H04-channel.png')
    }

    // H05 / H06 / H07：添加链接只填两项、弹窗、保存后即刻可见、顺序正确
    {
      const linkName = `${STAMP}-ui-added`
      createdNames.push(linkName)
      await clickTab(page, '链接')
      const chipsBefore = await page.locator('.ts-subbar .ts-subchip').allTextContents()
      ok('H07 链接子表按「文档在最前、+ 在最后」排列',
        chipsBefore[0]?.includes('文档') && chipsBefore[chipsBefore.length - 1]?.trim() === '+',
        JSON.stringify(chipsBefore))
      await page.locator('.ts-subchip-add').click()
      const modal = page.locator('.ts-entry-modal')
      await modal.waitFor({ state: 'visible' })
      const labels = await modal.locator('.ts-label').allTextContents()
      const inputCount = await modal.locator('input').count()
      const textareaCount = await modal.locator('textarea').count()
      ok('H05 添加链接使用弹窗，且只填名称 + 链接两个字段',
        (await modal.getAttribute('role')) === 'dialog' && inputCount === 2 && textareaCount === 0
          && labels.some(text => text.includes('名称')) && labels.some(text => text.includes('链接')),
        JSON.stringify({ labels, inputCount, textareaCount }))
      await modal.locator('input').nth(0).fill(linkName)
      await modal.locator('input').nth(1).fill(`https://example.feishu.cn/docx/${STAMP}-ui-added`)
      await shot(page, 'ui-H05-add-link-dialog.png')
      await page.evaluate(() => { window.__h06Sentinel = 'alive' })
      await modal.getByRole('button', { name: '保存', exact: true }).click()
      await modal.waitFor({ state: 'hidden', timeout: 8000 })
      const createdCard = await cardNamed(page, linkName)
      await createdCard.waitFor({ state: 'visible', timeout: 8000 })
      ok('H06 保存后链接立即可见，无需刷新页面',
        await createdCard.isVisible() && await page.evaluate(() => window.__h06Sentinel) === 'alive')
      const newDetail = (await api('list')).tables.repos.find(item => item.name === linkName)
      ok('H06 保存结果已真实落库（test 通道）', Boolean(newDetail), JSON.stringify(newDetail ?? {}))
      const chipsAfter = await page.locator('.ts-subbar .ts-subchip').allTextContents()
      ok('H07 新增文档后仍保持「文档在最前、+ 在最后」',
        chipsAfter[0]?.includes('文档') && chipsAfter[chipsAfter.length - 1]?.trim() === '+',
        JSON.stringify(chipsAfter))
      await shot(page, 'ui-H06-H07-created-link.png')
    }

    // H08：只读门户没有新增入口
    {
      const portal = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      await portal.goto(`${API}/portal`, { waitUntil: 'domcontentloaded' })
      await portal.waitForTimeout(1200)
      const body = await portal.locator('body').innerText()
      const addButtons = await portal.locator('.subchip-add, [aria-label*="新增"], button').evaluateAll(nodes =>
        nodes.filter(node => /新增|添加|编辑|删除|保存/.test(node.innerText)).length)
      ok('H08 只读门户不出现新增 / 编辑 / 删除入口',
        body.includes('只读门户') && addButtons === 0 && !(await portal.locator('.subchip-add').count()),
        `offenders=${addButtons}`)
      await shot(portal, 'ui-H08-portal.png')
      await portal.close()
    }

    // H09 / H10：@ 菜单排序、成员/链接/技能齐全、选成员插入模板
    {
      const atPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      await atPage.goto(URL_ARG, { waitUntil: 'domcontentloaded' })
      await atPage.waitForTimeout(2200)
      const editor = atPage.locator('[contenteditable="true"]').first()
      const clearEditor = async () => {
        await editor.click()
        await atPage.keyboard.press('Meta+A')
        await atPage.keyboard.press('Backspace')
      }
      await clearEditor()
      await editor.type('@', { delay: 120 })
      const listbox = atPage.locator('[role="listbox"]').first()
      await listbox.waitFor({ state: 'visible', timeout: 6000 })
      const broad = await listbox.innerText()
      const hasMember = broad.includes('团队空间 · 成员') && broad.includes('Neo')
      const hasLink = broad.includes('团队空间 · 链接') && broad.includes('launcher2')
      await clearEditor()
      await editor.type('@oi', { delay: 80 })
      await atPage.waitForTimeout(700)
      const skillMenu = await atPage.locator('[role="listbox"]').first().innerText()
      const hasSkill = skillMenu.includes('团队空间 · 技能') && /oi-[a-z-]+/.test(skillMenu)
      ok('H09 @ 菜单同时包含成员、链接、技能三组',
        hasMember && hasLink && hasSkill,
        JSON.stringify({ hasMember, hasLink, hasSkill, broad: broad.slice(0, 500), skillMenu: skillMenu.slice(0, 500) }))
      await shot(atPage, 'ui-H09-at-menu.png')
      await clearEditor()
      await editor.type('@launcher2', { delay: 80 })
      await atPage.waitForTimeout(700)
      const exactRows = await atPage.locator('[role="listbox"] button[role="option"] ._3e4SsG_itemName').allTextContents()
      ok('H09 精确名排在前缀名之前（launcher2 > launcher2-web3d）',
        exactRows[0] === 'launcher2' && exactRows.indexOf('launcher2-web3d') > 0,
        JSON.stringify(exactRows.slice(0, 6)))
      await clearEditor()
      await editor.type('@showcar', { delay: 60 })
      await atPage.waitForTimeout(700)
      const names = await atPage.locator('[role="listbox"] button[role="option"] ._3e4SsG_itemName').allTextContents()
      const prefixLast = Math.max(...['showcar-adas', 'showcar-theme', 'ShowCar RoadMap', 'showcar-devices', 'showcar-virtualdisplay']
        .map(name => names.indexOf(name)).filter(index => index >= 0))
      const contains = names.indexOf('txz-showcar-app')
      ok('H09 名字前缀排在名字包含之前（showcar-* > txz-showcar-app）',
        prefixLast >= 0 && contains > prefixLast,
        JSON.stringify({ prefixLast, contains, names: names.slice(0, 12) }))
      await clearEditor()
      await editor.type('@Neo', { delay: 80 })
      await atPage.waitForTimeout(700)
      const neo = atPage.locator('[role="listbox"] button[role="option"]').filter({ hasText: 'Neo' }).first()
      await neo.click()
      await atPage.waitForTimeout(350)
      const inserted = await editor.innerText()
      ok('H10 选成员后插入「给「X」派一个委托，事项：」模板',
        inserted.includes('给「Neo」派一个委托，事项：'), JSON.stringify(inserted.slice(0, 160)))
      await shot(atPage, 'ui-H10-insert-member.png')
      await atPage.close()
    }

    // 回到团队空间页签（atPage 是另一个页面，当前 page 仍停在链接页签）
    await clickTab(page, '链接')

    // H11：不同长度 toast 的中心点不漂移
    {
      await page.getByRole('button', { name: '我的资料' }).click()
      await page.getByRole('button', { name: /复制 Codex MCP 配置/ }).click()
      const toast = page.locator('.ts-toast').first()
      await toast.waitFor({ state: 'visible', timeout: 4000 })
      const first = await toast.evaluate(node => {
        const rect = node.getBoundingClientRect()
        return { center: rect.left + rect.width / 2, text: node.innerText }
      })
      await shot(page, 'ui-H11-toast-long.png')
      await page.waitForTimeout(2300)
      await page.getByRole('button', { name: '我的资料' }).click().catch(() => null)
      await page.getByRole('button', { name: '我的资料' }).click().catch(() => null)
      await page.getByRole('button', { name: '复制域名' }).click()
      await toast.waitFor({ state: 'visible', timeout: 4000 })
      const second = await toast.evaluate(node => {
        const rect = node.getBoundingClientRect()
        return { center: rect.left + rect.width / 2, text: node.innerText }
      })
      ok('H11 多次 toast 的中心点不漂移',
        Math.abs(first.center - second.center) <= 1 && first.text !== second.text,
        JSON.stringify({ first, second }))
    }

    // H12：当前插件 / 更新 / 安装 三态
    {
      await clickTab(page, '插件')
      const stateOf = async name => {
        const card = await cardNamed(page, name)
        return (await card.locator('button.ts-btn[data-primary="true"]').innerText()).trim()
      }
      const states = {
        self: await stateOf('dsh-team-space'),
        update: await stateOf('dsh-tool-app-verify'),
        install: await stateOf(freshPlugin.name),
      }
      ok('H12 插件安装按钮三态正确（当前插件 / 更新 / 安装）',
        states.self === '当前插件' && states.update === '更新' && states.install === '安装',
        JSON.stringify(states))
      await shot(page, 'ui-H12-plugin-states.png')
    }

    // H13：删除二次确认，取消不删
    {
      await clickTab(page, '链接')
      const card = await cardNamed(page, deleteLink.name)
      await card.getByRole('button', { name: '更多操作' }).click()
      await page.locator('.ts-menu').getByRole('menuitem', { name: '删除', exact: true }).click()
      const dialog = page.locator('.ts-modal[role="dialog"]').filter({ hasText: '删除' }).last()
      await dialog.waitFor({ state: 'visible' })
      ok('H13 删除前有二次确认弹窗', (await dialog.innerText()).includes(`删除「${deleteLink.name}」？`))
      await shot(page, 'ui-H13-delete-confirm.png')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 4000 })
      const still = await cardNamed(page, deleteLink.name)
      ok('H13 取消后记录仍在（未删除）', await still.isVisible())
    }

    // H14：版本冲突提示 + 接管按钮
    {
      const card = await cardNamed(page, conflictLink.name)
      await card.getByRole('button', { name: '更多操作' }).click()
      await page.locator('.ts-menu').getByRole('menuitem', { name: '编辑', exact: true }).click()
      const modal = page.locator('.ts-entry-modal')
      await modal.waitFor({ state: 'visible' })
      const current = (await api('list')).tables.repos.find(item => item.id === conflictLink.id)
      await api('entry/upsert', {
        method: 'POST',
        body: {
          table: 'repos',
          entry: {
            id: current.id,
            name: current.name,
            url: current.url,
            description: current.description,
            type: current.type,
            owner: current.owner,
            tags: current.tags,
            branch: current.branch,
            note: current.note,
            verifiedAt: current.verifiedAt,
            baseVersion: current.contentHash,
            takeOver: true,
            author: { name: 'H14 另一位测试者' },
          },
        },
      })
      await modal.locator('button[data-primary="true"]').click()
      const conflict = page.locator('.ts-conflict').filter({ hasText: '接管' })
      await conflict.waitFor({ state: 'visible', timeout: 6000 })
      const conflictText = await conflict.innerText()
      ok('H14 版本冲突时显示冲突原因与「接管这条记录」按钮',
        conflictText.includes('接管这条记录') && /发布|更新/.test(conflictText), conflictText.slice(0, 240))
      await shot(page, 'ui-H14-version-conflict.png')
      await conflict.getByRole('button', { name: '接管这条记录' }).click()
      await page.locator('.ts-entry-modal').waitFor({ state: 'hidden', timeout: 6000 })
      const taken = (await api('list')).tables.repos.find(item => item.id === conflictLink.id)
      ok('H14 接管后作者切回当前用户，记录没有丢', taken?.author?.name === 'Xinzhan', JSON.stringify(taken?.author))
    }

    // H15：五张表空状态都有可操作入口（用受控空列表真实渲染 UI）
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      await context.route('**/api/team-space/list**', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          tables: { tasks: [], todos: [], handoffs: [], plugins: [], skills: [], repos: [] },
          counts: { tasks: 0, todos: 0, handoffs: 0, plugins: 0, skills: 0, repos: 0 },
          limits: { maxItems: 500 },
        }),
      }))
      const emptyPage = await context.newPage()
      await emptyPage.goto(URL_ARG, { waitUntil: 'domcontentloaded' })
      await emptyPage.waitForTimeout(1800)
      await openTeam(emptyPage)
      const emptyChecks = []
      for (const label of ['会话', '委托', '插件', 'SKILL', '链接']) {
        await clickTab(emptyPage, label)
        const empty = emptyPage.locator('.ts-empty-box').first()
        await empty.waitFor({ state: 'visible', timeout: 4000 })
        const text = await empty.innerText()
        emptyChecks.push({ label, hasHint: /创建动作|分享到团队空间|重新加载/.test(text), hasAction: await empty.getByRole('button', { name: '重新加载' }).isVisible() })
      }
      ok('H15 每张表的空状态都有可操作提示与「重新加载」',
        emptyChecks.every(item => item.hasHint && item.hasAction), JSON.stringify(emptyChecks))
      await shot(emptyPage, 'ui-H15-empty-states.png')
      await context.close()
    }

    // H16：按名称 / 描述 / URL 搜索，页签计数同步
    {
      await clickTab(page, '链接')
      const search = page.locator('.ts-search input')
      for (const [field, needle] of [['标题', `NAME-${STAMP}`], ['描述', `DESC-${STAMP}`], ['URL', `URL-${STAMP}`]]) {
        await search.fill(needle)
        await page.waitForTimeout(400)
        const cards = await page.locator('.ts-session').count()
        const counts = await page.locator('.ts-tab').evaluateAll(nodes => nodes.map(node => ({
          label: node.querySelector('.ts-tab-label')?.textContent,
          count: Number(node.querySelector('.ts-count')?.textContent ?? -1),
        })))
        const reposCount = counts.find(item => item.label === '链接')?.count
        const othersZero = counts.filter(item => item.label !== '链接').every(item => item.count === 0)
        ok(`H16 按${field}过滤命中 1 条，页签计数同步`, cards === 1 && reposCount === 1 && othersZero,
          JSON.stringify({ cards, counts }))
      }
      ok('H16 搜索命中卡片是正确的测试链接',
        (await page.locator('.ts-session').first().innerText()).includes(searchLink.name))
      await shot(page, 'ui-H16-search.png')
      await search.fill('')
    }

    await page.close()
  } finally {
    await browser.close().catch(() => null)
    await cleanup().catch(error => console.log(`  ! 清理失败：${error.message}`))
    const residual = await api('list').then(data => Object.entries(data.tables ?? {})
      .flatMap(([table, items]) => (items ?? []).map(item => ({ table, item })))
      .filter(({ item }) => [item.name, item.title, item.url].filter(Boolean).join(' ').includes(STAMP))).catch(() => [])
    ok('UI 测试无残留', residual.length === 0, JSON.stringify(residual.map(({ table, item }) => ({ table, name: item.name, title: item.title }))))
  }

  console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 条失败` : '，全部通过'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch(error => {
  console.error('\nUI 回归中断：', error.stack || error.message, '\n')
  cleanup().finally(() => process.exit(1))
})
