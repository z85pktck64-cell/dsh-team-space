<div align="center">

# 团队空间 · Team Space

**局域网内的 AI 会话共享与委托协作 —— 同事不用装任何东西就能看**

<img src="docs/images/portal.png" alt="团队空间门户页" width="820">

</div>

## 一句话

把 AI 编码会话、SKILL、插件清单、Git 索引放在**局域网的一台机器**上，
同事打开浏览器就能看，配一行 MCP 就能让 Codex 读写——**不需要装客户端**。

## 三种接入方式

| 方式 | 需要装什么 | 能做什么 | 适合谁 |
|---|---|---|---|
| **浏览器** | **什么都不用装** | 看全部内容、复制 SKILL / 安装指令 | 只想看看有什么可用的 |
| **Codex（MCP）** | **什么都不用装**，配一行 url | 读内容 + 发委托 / 认领 / 交结果 | 用 Codex 干活的同事 |
| **DSH 插件** | 装插件 | 全功能：分享会话、认领、回执、安装管理 | 团队里高频协作的人 |

## 快速开始

### 1. 浏览器（零安装）

打开主服务器上的门户页，地址形如：

```
http://<主服务器IP>:8080/api/team-space/portal
```

进去就能看到技能、插件、会话、委托、仓库；每条都有「复制」按钮，点了直接拿到可用内容。

### 2. Codex（零安装，只配一行）

在 `~/.codex/config.toml` 里加：

```toml
[mcp_servers.team-space]
url = "http://<主服务器IP>:8080/api/team-space/mcp"
```

重启 Codex，就有 9 个工具：列技能、取技能正文、看成员、发委托、认领、交结果、看会话。

### 3. DSH 插件（完整体验）

在 DSH 的插件页搜 `dsh-team-space` 安装，或复制页面上的 curl 指令。装完**完全退出 DSH 再启动**。

## 它解决什么问题

AI 会话锁在单机本地磁盘上，换台机器或换个人就接不上。这个项目把
「会话 → 快照 → 别人本机副本 → 结果回执」这条链路做通，**全程局域网**，不依赖公网与云端账号。

## 它不是

不是云同步、不是多人实时协同、不是活会话共享（分享的是快照）。
**不提供身份认证**——`/api/team-space/*` 无鉴权，端口可达即可读写。
**当团队信任环境用，别暴露到公网。**

## 能力一览（Can I…？）

| 想做的事 | 支持 | 怎么做 |
|---|---|---|
| 把一个会话分享给别人继续 | ✅ | DSH 会话行「…」→「分享到团队空间」 |
| 在**另一台机器**上打开别人分享的会话 | ✅ 三段式 | `POST /claim`（主服务器只给快照，不代建）→ 成员本机 `POST /import-session` → `POST /claim/commit` |
| 源会话就在本机时认领 | ✅ 一步 | `POST /claim` 直接返回 `mode:'local'` 的 sessionId，复制完整事件日志 |
| 把做完的结果交回发起人 | ✅ 两段式 | `GET /local-session?since=` 算增量 → `POST /receipt/submit` |
| 给 AI agent 派活并回收结果 | ✅ F-Assign | `handoffs` 状态机 `open → doing → done`（`open` 不能直跳 `done`） |
| 分享 SKILL / 登记插件 / 登记**任意链接** | ✅ | `team_space_share_skill` / `share_plugin` / `share_repo`（`type`：git / doc / wiki / board / other） |
| 安装别人登记的插件 | ✅ 两段确认 | `/install-plugin` 只落盘 → 用户核对 SHA256 → `/plugin/enable {name, checksum}` |
| 防止别人静默覆盖我发布的条目 | ✅ | 换作者需 `baseVersion` + `takeOver=true` |
| 公网访问 / 多租户 / 账号体系 / 实时协同 | ❌ | 不在范围内 |

## 入口

| 入口 | 位置 |
|---|---|
| 「分享到团队空间」 | DSH 每个会话行的「…」菜单，`order: 500` |
| 团队空间页面 | DSH 侧栏图标，`order: 20` |
| **门户页** | 浏览器直开 `http://<IP>:8080/api/team-space/portal` |
| **MCP** | Codex 的 `[mcp_servers.team-space]` |

## 四张表

| 表 | 存什么 | 规则 |
|---|---|---|
| 任务 | 会话分享、认领、回执 | 认领复制完整历史；交回生成回执，不写回原会话 |
| todos | 团队待办推荐清单（**页面无 tab**） | 不做版本校验；只由 agent 工具读写，执行仍用 DSH 团队任务板 / `dsh-todo-panel` |
| 插件 | 名称、版本、来源、审计结论、安装命令 | 安装**分两段**：下载落盘 → 用户看着指纹确认 → 才启用（见下） |
| SKILL | 名称、描述、正文 | 内容 sha256 版本；复制到 `~/.dsh/skills/<name>/SKILL.md` |
| Git | 仓库名、URL、描述、维护人、标签、备注、验证时间 | 只存索引，**不存代码**；复制链接或克隆指令 |

创建动作**全部在对话里**，团队空间页面不再提供新建表单：

| 工具 | 作用 |
|---|---|
| `team_space_share_skill` | 分享 skill：给 content，或省略以读 `~/.dsh/skills/<name>/SKILL.md` |
| `team_space_share_plugin` | 登记插件清单：名称、版本、来源、审计结论、安装命令（只登记，不装） |
| `team_space_add_todo` | 添加团队待办推荐条目 |
| `team_space_share_repo` | 登记 git 仓库索引（名称、URL、描述、标签）；不存代码 |

更新仍走页面「编辑」，带 `baseVersion` 校验，与当前不一致会被拒绝。
**换作者 = 接管别人的记录**：除 todos 外，换作者覆盖必须同时带正确的 `baseVersion` 和 `takeOver=true`，
否则一律拒绝——agent 工具不带 author 时由宿主绑定本机身份，不能无作者静默覆盖。

F-Assign（`handoffs`）**不走通用 upsert**：它只能由 `/handoff/{create,claim,complete,cancel,consume}` 改动，
状态机是 `open → doing → done`，另有 `open|doing → cancelled`。`open` 不能直跳 `done`。

## 流程

1. 在任意会话行点「…」→「分享到团队空间」。
2. 宿主读取该会话的完整事件日志，抽成对话文本（用户 / 助手），存进 `$DSH_HOME/storages/team-space.json`。
3. 团队空间页面列出所有被分享的会话：标题、时间、来源目录、正文。
4. 别人点「认领」——**三段式，跨设备必须的**：
   1. `POST /claim`：主服务器只做「标记认领 + 返回快照」，**不建会话**
      （会话文件在分享者机器上，主服务器代建的副本成员 `openSession` 打不开）；
   2. `POST /import-session`：**成员本机**把快照写成一份真会话（`agents.create`，有 announce）；
   3. `POST /claim/commit`：把副本 id 回报主服务器，交回回执时才知道该从哪台机器读。

   源会话就在当前这台机器时（单机 / 主服务器自己分享的），`/claim` 一步返回 `mode:'local'` 的
   sessionId，仍复制完整事件日志（失败才退回“一条用户消息”）。
5. 同事在副本里继续干活，点「交回结果」——同样两段：副本在成员本机时主服务器读不到，
   先由**副本所在机器**用 `GET /local-session?since=…` 算增量文本，再 `POST /receipt/submit` 提交成回执，
   原会话不用被写。

同一会话重复分享会覆盖旧记录；最多保留 200 条。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半：39 条路由（`/list` `/detail` `/share` `/claim` `/handoff/*` `/install-*` `/portal` …） |
| `lib/client.js` | 浏览器半：DSH 内的侧栏页面 |
| `lib/portal.html` | **独立门户页**：浏览器直开，不依赖 DSH 的 UI |
| `lib/guide.html` | 教程页 |
| `dev/mcp-server.mjs` | **Codex MCP 服务**：stdio，9 个工具（读 + 写委托） |
| `dev/install-web-profile.sh` | 把插件装进网页版 profile |
| `dev/selftest.mjs` | 离线自检 |
| `cordis.patch.yml` | 插入 `team-space` 行 |
| `locale/{zh,en}.json` | 插件页标题与描述 |
| `icon.svg` | 插件图标 |

## 三个消费方（改动必须同步）

团队空间现在有**三个独立前端**在消费同一份数据，任何一侧的改动都要问另外两侧：

| 消费方 | 入口 | 能力 | 代码 |
|---|---|---|---|
| **DSH 客户端** | 侧栏「团队空间」 | 全功能（读写、安装、认领、分享） | `lib/client.js` |
| **Codex** | `~/.codex/config.toml` 的 `[mcp_servers.team-space]` | 9 个工具，读 + 发委托/认领/交结果 | `dev/mcp-server.mjs` |
| **浏览器** | `http://<IP>:8080/api/team-space/portal` | 只读 + 复制指令（身份为本地名字） | `lib/portal.html` |

### 改动检查清单

**加了新字段 / 新条目类型**：
- [ ] 宿主 `/list` 的投影带上它（`slim`）
- [ ] DSH 客户端渲染
- [ ] 门户页 `renderItem` / `badgeOf` 渲染
- [ ] MCP 的 `briefXxx` 是否要带出

**加了新接口**：
- [ ] 判断属于哪个消费方：只给 DSH / 也给 MCP / 也给门户页
- [ ] MCP 加工具时同步 `TOOLS` 与 `HANDLERS`（两个数组要一一对应）
- [ ] 门户页用完记得「不用展开就能点」（行内按钮）

**排序 / 过滤规则**：
- [ ] 服务端 `/list` **不排序**，排序在各前端
- [ ] DSH 客户端与门户页都用 `updatedAt ?? createdAt` 降序，两处要一致

### 版本发布（两个 profile + 分发包 + git）

改完代码后**四件事一起做**，少一件就会出现「有人看到旧版」：

```sh
sh dev/release.sh 2.7.54 "改了什么"
```

它做四步：
1. bump `package.json` 与 `lib/client.js` 里的版本号
2. 打包 `dsh-team-space-<版本>.tgz`（排除 `.git` / `node_modules` / `.bak-*`）
3. 复制到 `~/.dsh/storages/team-space-dist/` 并更新 `team-space.json` 里的 `plugins` 记录
4. `git add -A && commit && push`

**网页版（web profile）是另一个坑**：它不读 desktop 的 `node_modules`，
装插件要跑 `dev/install-web-profile.sh`（幂等）。

## 测试通道（实测不污染真实数据）

成员连的是**主服务器那一份**数据：在 Neo 的客户端里点一次「认领」、加一条链接，写进去的就是所有人共用的列表，企微群还会收到通知。所以验功能必须能开一条**测试通道**。

| 端 | 怎么进测试通道 | 进去以后的样子 |
|---|---|---|
| **DSH 客户端** | 点头像 → 「通道」→ 切到「测试通道」 | 标题旁出现橙色「测试通道」徽标，点徽标一键退回 |
| **浏览器门户** | 地址后面加 `?channel=test` | 顶部橙色横幅「以下是实测数据」 |
| **Codex / MCP** | `env = { TEAM_SPACE_CHANNEL = "test" }` | 该进程的写操作全部落测试通道 |

规则：

- 测试通道**看得到全部**（真实 + 测试）——真实数据当背景，才验得出「列表里少了一条」这类问题
- 测试通道新建的记录带 `channel: "test"`，**不进真实列表**
- 测试通道**改不动也删不掉真实记录**，直接 403：在测试通道点「认领」绝不等于真的认领
- 测试通道**不发企业微信通知**
- 切回真实通道后测试数据自然看不见，但**没有被删**（还在 store 里，方便复查）

服务端在 `lib/index.js` 收口，三层：`requestChannel()` 认请求通道 → `route()` 用 `AsyncLocalStorage` 开作用域（新路由不写通道也自动正确）→ `mutateStore()` 落盘前比对真实记录指纹，有改动就整体回退。前端三处（客户端 / 门户 / MCP）只是把通道带上来。

### 已知的兼容边界

| 项 | 限制 |
|---|---|
| 门户页身份 | 浏览器本地名字，**不防冒充**（填谁就是谁） |
| 门户页拿不到真实 IP | 8080 前面是 remote-access 代理，不透传 `X-Forwarded-For` |
| 跨源 localStorage | DSH 客户端与门户页**不同源**，身份天然不共享 |
| 跨设备认领 | 原会话不在主服务器上时只有文本快照，不是完整历史 |
| Codex 侧 | 需要先配 `[mcp_servers.team-space]` 并重启 Codex，工具才出现 |

## 安装 / 更新

`plugin_manager` 的 `install_bundle`（`target` 填本目录绝对路径）。
**改过宿主半（`lib/index.js`）后需要重启 App**：模块已被加载，HMR 只替换浏览器半。

### 它自己装插件时的信任边界

页面点「安装」**不会**直接让插件跑起来：

1. `/install-plugin`（或 `/install`）只把包放进 `node_modules`，返回 `path` + `checksum`，
   **不写** profile 的 `package.json`，也**不写** `cordis.patch.yml`；
2. 页面把来源、路径、SHA256 弹出来让用户确认；
3. 用户确认后 `POST /plugin/enable { name, checksum }` 才登记依赖并写 loader 行；
   同时按已安装 `package.json` 的真实包名把当前目录固化为
   `~/.dsh/plugins/<短名>-<版本>.tgz`，并同步 profile 依赖与 `pnpm-lock.yaml`，
   避免后续 `pnpm install` 按旧 tgz 把版本静默回退；
4. 重启 DSH 后加载。

所以「同事发个链接 → 你点一下 → 重启后它就在你机器上跑代码」这条链断在第 2 步。
安装记录留在 `~/.dsh/storages/team-space-installs.json`，`GET /plugin/audit` 可查。

## 验证

```sh
# 端到端自检（读写、F-Assign 状态流转、状态机护栏、安装链路护栏、
#             认领三段式、回执两段式、列表契约、作者护栏、并发写）
node dev/selftest.mjs
```

> 自检会在本机建一条「自检分享」会话用于验证 import-session，跑完自动清理记录（会话本身留在本机）。

```sh
# 认领/回执链路的离线验证：mock 宿主 + 真 HTTP，不用重启 App
node dev/mock-host.mjs
```

`dev/mock-host.mjs` 用假的 `ctx` 加载宿主半，覆盖跨设备认领（主服务器只给快照）、
本机认领（源会话在这台机器上）、回执两段式、增量读取、脏事件清洗、
认领按设备分别存、F-Assign 状态机收口（`open → done` 直跳 / 通用 upsert 绕状态机）、
作者护栏（无 author / 只带 baseVersion / takeOver）、安装链路护栏（域名白名单、分支顺序、启用前置）。

> 宿主半（`lib/index.js`）改过要先重启 App 再跑，否则测的还是旧模块。

```sh
# 分享一个真实会话（sessionId 取自 ~/.dsh/sessions 下的会话首行）
curl -sS -X POST http://127.0.0.1:<端口>/api/team-space/share \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-…","title":"测试"}'

curl -sS http://127.0.0.1:<端口>/api/team-space/list
```

## 局域网访问

1. 起 bridge：`node dev/lan/bridge.mjs 8080 <GUI 端口>`（0.0.0.0:8080 → 127.0.0.1:端口）。
2. 取带 token 的链接：`GET /api/team-space/lan-link?base=http://<局域网IP>:8080`。
3. 同事浏览器打开链接 → 换 cookie → 看到同一个 GUI。
4. profile 的 `cordis.patch.yml` 里给 `connection` 配了 `trustedHosts` 才允许这个 authority。

App 重启后端口会变，bridge 要用新端口重启；链接里的 token 是进程级的，重启后失效。

## 边界

- **没有身份**：谁打开页面谁就是 owner；「谁分享的」不记录，也无法记录。
- **API 无鉴权**：`/api/team-space/*` 挂在 webServer 上，端口可达就能读写。
- **默认只在本机**：要同事访问，宿主必须绑定非 loopback 地址，这一步不在插件里做。
- 分享的是**文本快照**，不是活会话；原会话后续变化不会同步。
- 认领是**幂等**的：同一台设备再认领就复用同一份副本；换设备不复用（那份副本在别人机器上），
  确实要再来一份走「…」→「再领一份（新建副本）」。
  认领走 `agents.create`（有 announce），只写盘的会话浏览器端不认识，`openSession` 打不开。
- 跨设备认领时，主服务器只有分享时留下的**文本快照**（它没有别人的会话文件），
  拿到的副本是「一条含全文的用户消息」而不是完整事件流；源会话在主服务器本机时才是完整事件副本。
- 导入的事件会做清洗（只留 `type/seq/time/data/surfaceOp`、限条数与体积），不会把网络来的脏数据原样写进本机会话。
- 复制时把事件里等于源 sessionId 的字符串换成新 id；**只改这一处**，delivery marker / job owner 未改写。
- 分享是快照：源会话之后的变化不会同步；「已落后」需要重新分享。
- **表有上限**（默认 200 条/表）：写满后新增会挤掉最旧的，页面顶部会提示；接口返回 `dropped` 标明挤掉了几条。
- 插件安装只接受 https；明文 http 只放行 **IPv4 字面量**且落在 127/10/172.16-31/192.168/169.254
  （`10.evil.com` 是域名不是 10/8，会被拒）。下载逐跳校验重定向目标、边读边限 50MB，
  解压前扫 tar 条目拒绝绝对路径 / `..` / 符号链接。
  地址白名单、体积上限这些校验只在 **tgz 分支**生效——页面分支顺序是先 tgz、失败才回退 npm。
- 安装**不自动启用**：装完要拿着 checksum 确认一次（`/plugin/enable`）才写 loader 配置。
- `.bak-<时间戳>` 备份只保留最近 5 份；客户端日志超过 2MB 只留最后 500 行。
- store 的 `load → 改 → save` 整体在文件锁里，锁带 pid+token，只删自己的锁；
  拿不到锁超过 3 秒就报错，不再基于过期快照覆盖。
- 认领按设备分别存（`item.claims[deviceId]`）：两个人各自认领各有各的副本，
  不会第二个人拿到第一个人机器上那份打不开的 sessionId。
- 「认领人是不是本机」**不看请求来源地址**：成员请求经局域网网关代理进来，源地址一律是 `127.0.0.1`，
  按地址判断会把成员误判成本机，给出一个在他机器上打不开的 sessionId。
  现在由浏览器上报它连着的那台 DSH 的 `hostId`，两边一致才复制完整历史，否则只给快照、
  由成员本机的 `/import-session` 建会话。老客户端不带 `hostId` 时回落到按回环地址判断。
- 作者名按归一化比较（去空白 + 忽略大小写）：`Xinzhan` 与 `xinzhan` 是同一个人，
  不会把本人更新误判成「换作者接管」而逼着带 `takeOver`。真的换人仍然要显式确认。
- 回执只取副本里上次交回之后的消息（水位 `claim.since`），不写回原会话（避免抢写锁）。
  副本不在当前机器上时，交回要在「副本所在机器」上做，或由发起方本机提交。
- 系统注入的 `<system-reminder>` 块会被丢掉（重启后生效）。

## 自检

```sh
node dev/mock-host.mjs        # 假 ctx 起真 HTTP，不用重启 DSH（覆盖认领/回执/护栏）
node dev/selftest.mjs         # 打真机 API；结束后自动扫尾，清掉自己的测试条目
node dev/cleanup-selftest.mjs # 单独清理历史残留（自检中途失败留下的假 sessionId）
```

## 回滚

```sh
# 插件页卸载 dsh-team-space（或删 profile 里的 team-space 行），再删数据
rm -f ~/.dsh/storages/team-space.json
```
