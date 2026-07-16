# 私有化企业微信消息发送脚本（CLI + 群管理 + Webhook + Web 控制台）

零依赖的 Node.js 18+ 脚本，往私有化部署的企业微信「自建应用」推送文本 / 图文 / Markdown 消息。四种使用模式：

| 模式 | 适用 |
| --- | --- |
| **CLI 发送** | 一次性手动发消息、CI 任务、告警脚本 |
| **群管理** | 用 `chat create` / `update` / `get` 建群/拉人/改名/查成员 |
| **Webhook 接收** | 起一个 HTTP 服务，让 AlertManager / Grafana / 自研系统 POST 进来 |
| **Web 控制台** | 浏览器登录就能拉群 + 往群里发消息，零构建 |

收件人按 userid 列表（`|` 分隔）或群 chatid 指定。

---

## 1. 准备环境

- Node.js **18 及以上**（使用了内置 `fetch`）
- 私有化企业微信的 API 根地址（形如 `https://wecom.example.com`）
- 自建应用的 `corp_id` / `corp_secret` / `agent_id`
- 收件人的 userid（可在管理后台「通讯录」查到，或通过接口获取）

## 2. 配置凭证（config.js）

凭证写在 `config.js`（可被 `--config` 覆盖）。仓库自带占位文件，请按下面任一方式覆盖：

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| 直接编辑 | 修改 `config.js` 中的字段 | 个人/内网部署 |
| 多套配置 | 复制为 `config.prod.js` / `config.test.js`，通过 `--config` 切换 | 多环境 |
| webhook / web 部署 | corp 字段也允许从同名环境变量回退 | 容器/Serverless |

字段含义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `WECOM_API_BASE` | 是 | 私有化 API 根地址，例如 `https://wecom.example.com`（结尾不要 `/`） |
| `WECOM_CORP_ID` | 是 | 企业 corp_id |
| `WECOM_CORP_SECRET` | 是 | 自建应用的 secret |
| `WECOM_AGENT_ID` | 是 | 自建应用的 agentid（数字） |
| `WECOM_WEBHOOK_TOKEN` | web 子命令必填 | 网页控制台管理员 token，也是所有写操作 `X-Admin-Token` 鉴权值，推荐 ≥ 32 字节随机串（CLI 模式不读） |
| `WECOM_WEBHOOK_RECV_PORT` | 否 | webhook 接收端监听端口，默认 `8787`。与管理界面（3005）隔离，可单独对外网开放 |
| `WECOM_WEBHOOK_RECV_BASE` | 否 | webhook 接收端对外基址（含协议+域名，如 `https://hooks.example.com`）。留空时前端按「当前访问主机名 + 上述端口」自动拼接收地址 |

任意 corp 字段为空 / 占位值时，脚本立即报错退出，**不会发起请求**。

> ⚠️ `config.js` 包含敏感信息，**不要**提交到代码仓库。建议在仓库根目录添加：
> ```gitignore
> config.js
> config.local.js
> config.*.js
> ```

## 3. CLI 参数

通用参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--config` | 否 | 配置文件路径，默认 `./config.js` |
| `--help` / `-h` | 否 | 打印帮助 |

发送模式参数（默认进入）：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--to` | 与 `--chat-id` 二选一 | 收件人 userid，`\|` 分隔，最多 1000 个 |
| `--chat-id` | 与 `--to` 二选一 | 群 chatid（`wr...` / `wc...`），发群消息时使用 |
| `--type` | 是 | `text` / `news` / `markdown` |
| `--content` | 视 type | 文本/Markdown 消息体 |
| `--payload` | 视 type | 图文消息 JSON 字符串 |
| `--force-chat` | 否 | 群发时强制走原生 `message/send+chatid` 通道（默认走"读群成员后单聊拼接"绕开 82001，需要 corp secret 是「群应用 secret」才用） |

子命令：

| 子命令 | 必填参数 | 说明 |
| --- | --- | --- |
| `chat create` | `--chat-id` `--name` `--owner` `--members` | 创建应用群（owner 与 members 合计 ≥ 2 人） |
| `chat update` | `--chat-id`，外加 `--name` / `--owner` / `--add` / `--del` 至少一个 | 改群名 / 转让群主 / 增删成员 |
| `chat get` | `--chat-id` | 查询群信息 |
| `webhook` | `--port` | 启动 webhook 接收服务；token 优先顺序 `--token` > `WECOM_WEBHOOK_TOKEN` 环境变量 > `config.js` |
| `web` | `--web-port` `--web-root` | 启动 web 管理控制台 + REST API，token 优先顺序 `--admin-token` > `WECOM_WEBHOOK_TOKEN` 环境变量 > `config.js` |

## 4. CLI 用法示例

### 4.1 发送文本

```bash
node send_wecom.js \
  --to "zhangsan|lisi" \
  --type text \
  --content "你好，明天下午 3 点开会。"
```

### 4.2 发送 Markdown

```bash
node send_wecom.js \
  --to "zhangsan" \
  --type markdown \
  --content $'# 通知\n**会议**改到 <font color="warning">3:00 PM</font>'
```

> Markdown 内的换行请用 `\n`（PowerShell 用 `` `n ``），双引号内不会被 shell 吞掉。

### 4.3 发送图文

```bash
node send_wecom.js \
  --to "zhangsan|lisi" \
  --type news \
  --payload '{"articles":[{"title":"版本发布","description":"v1.2.0 已发布","url":"https://example.com/release","picurl":"https://example.com/cover.png"}]}'
```

> `articles` 数量 1~8，每条 `title`/`url` 必填，`description` 和 `picurl` 可选。

### 4.4 切换配置文件

```bash
node send_wecom.js --config ./config.prod.js --to "zhangsan" --type text --content "prod msg"
```

### 4.5 群聊发消息（应用号已加入群）

```bash
node send_wecom.js \
  --chat-id "wrAaAaAaAaAaAaA" \
  --type markdown \
  --content "# 群通知\n发布窗口 21:00。"
```

> 私有化版坑：当前 corp secret 通常不是「群应用 secret」，原生 `message/send+chatid` 会 82001。
> 脚本默认自动读出群成员，改走单聊拼接 `touser=u1|u2|...` 模拟群发。
> 想强制走原生通道时加 `--force-chat`，但需要 corp secret 是「群应用 secret」才能成功。

### 4.6 创建群 / 拉人 / 改群名

> chatid 建议只含字母数字与 `-`，避开下划线等特殊字符（私有化版校验较严）。

```bash
# 创建
node send_wecom.js chat create \
  --chat-id "proj-release-20260614" \
  --name "项目发布通知" \
  --owner "zhangsan" \
  --members "zhangsan|lisi|wangwu"

# 拉人 / 踢人 / 改名
node send_wecom.js chat update \
  --chat-id "proj-release-20260614" \
  --name "项目发布通知 v2" \
  --add "zhaoliu|qianqi" \
  --del "wangwu"

# 查询群信息（拿 chatid 列表成员）
node send_wecom.js chat get --chat-id "proj-release-20260614"
```

---

## 5. Webhook 接收（路由配置驱动）

### 5.1 概述

webhook 接收端随 `web` 子命令启动，运行在**独立端口**（默认 `8787`，由 `config.js` 的 `WECOM_WEBHOOK_RECV_PORT` 控制），与 3005 管理界面**隔离**：

- 外部系统 `POST /recv/<routeId>[/:code]` 即可推送消息。
- 接收地址由「路由配置」页生成并展示（列表「接收地址」列 + 保存后详情），**不提供其它独立的地址生成接口**。
- 接收内容写入 SQLite（`recv.db`，二进制文件），保留 24 小时后自动清理，不写入任何文本文件。

> 安全收益：把 3005 管理界面留在内网，仅把 8787 端口对外网开放即可——8787 只暴露 `/recv/`，无 UI、无 `/api`，外部系统拿不到任何管理能力。

### 5.2 启动

```bash
node send_wecom.js web --web-port 3005 --web-root ./web
```

启动后日志（节选）：

```
[web] 管理界面 listening on 0.0.0.0:3005
       API:      /api/routes  (路由配置 CRUD)
                 /api/config   (前端取 webhook 接收基址)
[web] webhook 接收端 listening on 0.0.0.0:8787
       POST /recv/<routeId>[/:code]   (地址由「路由配置」页生成)
```

### 5.3 接收地址与协议

- 地址格式：`POST http(s)://<host>:<WECOM_WEBHOOK_RECV_PORT>/recv/<routeId>[/:code]`
  - `routeId`：路由 ID，新建 webhook 路由时由服务端生成。
  - `:code`（可选）：路由配置里填的校验码。建议启用——不填则任何人都能 POST 该地址。
- 请求体：任意 JSON。字段可在路由「模板」里用 `{{field}}` 引用，原始体为 `{{_raw}}`。
- 鉴权：URL 末尾的 `:code` 即鉴权；不匹配返回 `401`。
- body 上限 1 MB，超限返回 `413`。

示例：

```bash
curl -X POST http://<host>:8787/recv/r_a87668d5d619/sec8787 \
  -H "Content-Type: application/json" \
  -d '{ "title": "磁盘告警", "content": "CPU 已用 95%" }'
```

### 5.4 响应

```json
{ "errcode": 0, "errmsg": "ok", ... }
```

错误码透传企业微信原值（`errcode` 字段），HTTP 状态始终 200（除 400/401/404/413/500）；调用方按 `errcode` 判重试。

### 5.5 跟主流告警源对接

| 来源 | 接入方式 |
| --- | --- |
| **AlertManager** | `webhook_config` 的 `url` 指向 `/recv/<routeId>[/:code]`；`custom_payload` 把告警模板渲染成 markdown 塞进 `content` |
| **Grafana Contact Point** | 选 "Webhook" 通道，`URL` 填 `/recv/<routeId>[/:code]`，`Payload` 用 `{{ json . }}` 后在路由模板里做字段映射 |
| **GitHub** | repository webhook 选 `application/json`，回调里取 `repository` / `sender` / `commits` 拼消息 |
| **Zabbix** | 媒介类型选 "脚本"，shell 把 `$1`/`$2` 拼成 JSON 再 `curl` 本地址 |
| **自研系统** | 直接 POST JSON 到 `/recv/<routeId>[/:code]`，字段在路由模板里用 `{{field}}` 引用 |

### 5.6 安全 / 审计（生产化建议）

当前实现的安全机制：

- **端口隔离**：webhook 接收端（8787）只暴露 `/recv/`，无 UI、无 `/api`，可单独对外网开放；管理界面（3005）留在内网。
- **code 鉴权**：URL 末尾的 `:code` 即鉴权，不匹配返回 `401`。
- **body 大小限制**：1 MB 上限，超限返回 `413`。
- **access_token 缓存**：进程内缓存 7000s（7200 - 60s 提前续期），同 corp 字段 5 次发送只调 1 次 `gettoken`。
- **token 失效自动重试**：上游返回 `40001/42001/41001/40014` 时自动失效缓存 + 重取 token + 重发 1 次。

未实现（生产化建议补齐）：

- **限流**：滑动窗口，超限返回 `429`。当前未实现，靠 Nginx / API Gateway 层做。
- **可观测**：暴露 `/metrics`（Prometheus 文本格式）。当前未实现。
- **审计日志**：把每次 webhook 的入参 + 企业微信 errcode 落到 `logs/`，至少保留 7 天。当前未实现。

生产建议：前面套一层 Nginx / Caddy，启用 HTTPS + mTLS 或 IP 白名单。
## 6. Web 管理控制台

`web` 子命令同时起一个静态页面和一组 REST API，用浏览器就能完成「拉群 + 往群里发消息」两件事。零依赖、零构建。

### 6.1 启动

```bash
# 1) 编辑 config.js，填好 WECOM_API_BASE / WECOM_CORP_ID / WECOM_CORP_SECRET / WECOM_AGENT_ID / WECOM_WEBHOOK_TOKEN
# 2) 启动（默认端口 8788，可任意改；本仓库 pm2 部署用 3005）
node send_wecom.js web --web-port 3005 --web-root ./web
```

启动后，管理后台的网页入口被刻意藏到 `web/` 下的一个随机子目录中（例如 `web/<secret>/index.html`），根路径 `http://your-host:3005/` 会返回 404。请用部署时实际生成的子目录名访问，例如 `http://your-host:3005/<secret>/`（注意尾部斜杠，页面会自动补）。在右上角输入 `WECOM_WEBHOOK_TOKEN` 点「保存」即可使用。

> 想更换隐藏路径：直接重命名 `web/` 下那个子目录即可，无需改代码或重启外的其它配置（改名后刷新页面用新路径访问）。

> 注意：管理界面（3005）处理浏览器 UI 与 `/api/*` REST；路由系统的 webhook 入站端点 `/recv/:routeId[/:code]` 运行在**独立端口 8787**（见 §5、§6.6），与管理界面隔离。
> 在 3005 上直接 POST `/recv/` 会被拒（返回 404，提示迁到 8787）；其它非 GET 请求因缺少 `X-Admin-Token` 也会失败。

### 6.2 页面功能

| Tab | 干什么 | 调用的 API |
| --- | --- | --- |
| 拉群 | 填 chatid / 群名 / 群主 / 成员，提交 | `POST /api/chats` → `appchat/create` |
| 往群里发消息 | 选 chatid + 消息类型 + 内容，提交 | `POST /api/chats/:chatid/messages` → `appchat/send`（私有化部署群发专用通道，消息真正进群） |
| 给指定用户发单聊 | 填 userid + 消息类型 + 内容，提交 | `POST /api/users/:userid/messages` → `message/send`（单聊通道） |
| 查看群 | 填 chatid 查询 | `GET /api/chats/:chatid` → `appchat/get`；列出本应用可见的群 → `GET /api/chats` → `appchat/list` |
| 路由配置 | 把「接收渠道」(邮件/webhook) 收到的消息按模板渲染后，经「发送渠道」(群聊/用户) 推送；可增删改查、启用停用、测试 | `GET/POST/PUT/DELETE /api/routes`；入站 `POST /recv/:routeId[/:code]` |

### 6.3 REST API 总览

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/healthz` | 存活探针 | 否 |
| GET | `/` `GET /style.css` `GET /app.js` | 静态资源 | 否 |
| GET | `/api/admin/token` | 本机/内网引导 token（放行 `127.0.0.1` / `::1` 及私有网段） | 否 |
| POST | `/api/chats` | 创建群（拉群），body: `{chatid, name, owner, members[]}` | X-Admin-Token |
| GET | `/api/chats/:chatid` | 查询群信息 | X-Admin-Token |
| PATCH | `/api/chats/:chatid` | 改群名 / 转让群主 / 增删成员，body: `{name?, owner?, add_user_list?, del_user_list?}` | X-Admin-Token |
| GET | `/api/chats` | 列出本应用可见的群（部分私有化版本不支持） | X-Admin-Token |
| POST | `/api/chats/:chatid/messages` | 往群里发消息，body: `{type, content?, payload?}`；走 `appchat/send` 通道，消息真正进群 | X-Admin-Token |
| POST | `/api/users/:userid/messages` | 给指定用户发单聊，userid 支持 `\|` `,` `;` 分隔，body: `{type, content?, payload?}` | X-Admin-Token |
| GET | `/api/routes` | 列出全部路由（密码/code 以 `******` 掩码返回） | X-Admin-Token |
| POST | `/api/routes` | 新建路由，body: 见 §6.6 | X-Admin-Token |
| GET | `/api/routes/:id` | 获取单条路由 | X-Admin-Token |
| PUT | `/api/routes/:id` | 更新路由，body 同新建；密码/code 传 `******` 或空表示保留原值 | X-Admin-Token |
| DELETE | `/api/routes/:id` | 删除路由 | X-Admin-Token |
| POST | `/api/routes/:id/test` | 测试路由：webhook 则校验配置（local 源无需测试） | X-Admin-Token |
| POST | `/recv/:routeId[/:code]` | 外部系统推进入站（webhook 源专用），body 为任意 JSON | 路由级 code（URL 末尾） |
| GET | `/api/mail-accounts` | 列出本地邮箱账号（含域名/端口） | X-Admin-Token |
| POST | `/api/mail-accounts` | 生成账号，body 可选 `{local?, password?}` | X-Admin-Token |
| DELETE | `/api/mail-accounts/:local` | 删除账号（同时停用引用它的路由） | X-Admin-Token |

请求 / 响应统一 JSON。`X-Admin-Token` 等于 `config.js` 中的 `WECOM_WEBHOOK_TOKEN`。

响应里的 `errcode` 来自企业微信（透传），HTTP 状态码一律 `200`（包括业务错误）以方便前端直接展示；只有鉴权 / 路由错才返回 4xx/5xx。

`/api/chats/:chatid/messages` 走私有化部署的 `appchat/send` 通道，消息真正进入群聊（不再是单聊拼接）。群不存在时直接报 `86003`，不做兜底。

### 6.4 用 curl 直接调 API

```bash
TOKEN=replace-with-a-long-random-string
BASE=http://127.0.0.1:3005

# 拉群
curl -X POST $BASE/api/chats \
  -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"chatid":"proj-release-20260614","name":"项目发布通知","owner":"zhangsan","members":["zhangsan","lisi","wangwu"]}'

# 往群里发消息
curl -X POST $BASE/api/chats/proj-release-20260614/messages \
  -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"markdown","content":"**发布完成** v1.2.0 已上线"}'

# 给用户发单聊（多人用 | 分隔）
curl -X POST $BASE/api/users/YOUR_USERID/messages \
  -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"text","content":"你好"}'

# 查群
curl $BASE/api/chats/proj-release-20260614 -H "X-Admin-Token: $TOKEN"

# 拉人进群
curl -X PATCH $BASE/api/chats/proj-release-20260614 \
  -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"add_user_list":["zhaoliu"]}'
```

### 6.5 安全提示

- Web 页面把 token 存到 `localStorage`，**仅适合内网 / 受控环境**。如果对外暴露，请前面套一层 Nginx basic auth 或 SSO。
- 静态资源 1 MB body 上限（与 webhook 一致）。
- 路径遍历已用 `path.resolve` 拦截，命中越界返回 403。
- `/api/admin/token` 放行本机与内网私有地址请求；公网调用方需用 `X-Admin-Token` 鉴权（或在网页粘贴 `WECOM_WEBHOOK_TOKEN`）。
- 实际部署时强烈建议：**HTTPS + IP 白名单 + 反向代理**。

### 6.6 路由配置（接收渠道 → 发送渠道）

把「接收渠道」收到的消息，按模板渲染后，经「发送渠道」推送出去。配置持久化在 `routes.json`。**接收渠道仅支持两种源**（新增路由时只允许选这两类）：`local`（已生成的本地邮箱账号）与 `webhook`（外部推送）。所有 `enabled` 的 **local** 路由从内置 SMTP 服务收到的邮件投递；**webhook** 路由通过 `POST /recv/:routeId` 接收外部推送。`web` 启动时会同时拉起一个**本地 SMTP 服务**（默认 `0.0.0.0:2525`，认领域名 `wecom-mail.local`），用于接收「本地邮箱账号」的邮件。

> **webhook 地址仅由「路由配置」页面生成**：接收地址 `POST /recv/:routeId[/:code]` 在新建 / 编辑路由时由页面生成并展示（列表「接收地址」列 + 保存后详情），不提供其它独立的地址生成接口，测试接口也不再返回示例地址。该地址的端口为**独立的 8787**（见 §5），与管理界面 3005 隔离，可单独对外网开放。

> **接收内容存储**：接收到的邮件 / webhook 消息统一写入 SQLite 库 `recv.db`（二进制文件，**不写入任何文本文件**），保留 **24 小时**，超过即由后台定时器自动清理，避免存储空间膨胀。邮件已读位点仍记在 `routes.uid.json`。

#### 接收渠道

| type | 说明 |
| --- | --- |
| `local` | **本地内置 SMTP 接收**：网页「邮件账号」页生成的账号（地址 `<local>@<WECOM_MAIL_DOMAIN>`），发往该地址的邮件会被内置 SMTP 收下、写入 `recv.db`，再由对应路由投到发送渠道。无需外部 IMAP/密码 |
| `webhook` | 外部系统 `POST /recv/:routeId[/:code]` 推送 JSON，body 字段可用 `{{field}}` 引用；可选 `code` 鉴权（URL 末尾）。**webhook 接收地址仅由「路由配置」页面生成与展示**：列表「接收地址」列显示完整地址并支持一键复制 / 显示，新建或编辑保存后也会在表单下方展示；不提供其它独立的地址生成接口 |

#### 本地邮箱账号（网页生成 + 内置 SMTP）

`web` 控制台「邮件账号」Tab 可生成仅供本工具接收用的邮箱账号：

- 地址形如 `<账号>@<WECOM_MAIL_DOMAIN>`（默认域名 `wecom-mail.local`，端口 `2525`，见 `config.js` 的 `WECOM_MAIL_DOMAIN` / `WECOM_MAIL_SMTP_PORT`）。
- 任何能连到本机该端口的邮件系统（或脚本），把信发到这些地址，工具就会收下、写入 SQLite（`recv.db`，保留 24 小时），再由 `local` 路由源推送出去。
- 账号信息存 `./mail/accounts.json`；删除账号会同时清空其邮件存储并停用引用它的路由。
- 内置 SMTP 服务只接受本域、且已存在的账号；未知收件人返回 `550`。
- **SMTP 认证（AUTH）已启用**：生成的每个账号都带密码（创建时在返回里给出）。外部系统若要求 SMTP 登录发信，可用本系统生成的账号做「认证邮箱」——用户名填 `<账号>` 或 `<账号>@<WECOM_MAIL_DOMAIN>`，密码填该账号密码（LOGIN/PLAIN 两种机制）。认证失败返回 `535 Authentication failed`。**认证非强制**：不登录也能发（只要收件人是本域已存在账号），向后兼容原有无认证用法。
- ⚠️ AUTH 在**明文连接**上开启（`allowInsecureAuth`，未启用 STARTTLS），仅适合内网/可信网络。请勿把 `2525` 端口暴露到公网；如需公网，请另行套 TLS 反向代理。

> 生产环境若要让公网/其它邮件系统投递，需把 `WECOM_MAIL_DOMAIN` 配置为真实可解析域名，并将该域的 MX / 转发指向本机 `WECOM_MAIL_SMTP_PORT`（25 端口需 root 权限，可用反向代理或改端口）。

邮件账号 REST：

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/mail-accounts` | 列出账号（含域名/端口） | X-Admin-Token |
| POST | `/api/mail-accounts` | 生成账号，body 可选 `{local?, password?}` | X-Admin-Token |
| DELETE | `/api/mail-accounts/:local` | 删除账号 | X-Admin-Token |

#### 发送渠道

| type | 说明 |
| --- | --- |
| `chat` | 以应用身份经 `appchat/send` 推送到群聊（消息真正进群） |
| `user` | 经 `message/send` 单聊推送给 userid（支持 `\|` 分隔多人） |

#### 路由数据结构（routes.json 一条）

```json
{
  "id": "r_cb22c7c90625",
  "name": "告警webhook→技术群",
  "enabled": true,
  "source": {
    "type": "webhook",
    "code": "abc123"            // 仅 webhook 有；留空不校验
  },
  "target": {
    "type": "chat",
    "chatid": "YOUR_CHATID"
  },
  "template": "🔔 告警\n标题: {{title}}\n详情: {{content}}",
  "createdAt": "2026-07-07T10:34:51.601Z",
  "updatedAt": "2026-07-07T10:34:51.601Z"
}
```

#### 模板变量

- 本地邮件（local 源）：`{{from}}` `{{to}}` `{{subject}}` `{{date}}` `{{body}}`（正文纯文本）`{{messageId}}`。
- webhook：`{{任意body字段}}`，原始 JSON 为 `{{_raw}}`。
- 留空模板则用默认格式（`📧 新邮件\n来自: …\n主题: …\n\n正文`）。

#### 本地邮箱账号 / local 路由的依赖

- **本地邮箱账号 / local 路由** 用 `smtp-server` + `mailparser`（非 Node 内置）。安装：

  ```bash
  npm install smtp-server mailparser
  ```

  依赖缺失时，内置 SMTP 服务无法启动，`local` 路由自动失效并打印告警。

#### 用 curl 操作路由

```bash
TOKEN=replace-with-a-long-random-string
BASE=http://127.0.0.1:3005

# 新建 webhook 路由
curl -X POST $BASE/api/routes -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" -d '{
  "name":"告警→技术群",
  "enabled":true,
  "source":{"type":"webhook","code":"abc123"},
  "target":{"type":"chat","chatid":"YOUR_CHATID"},
  "template":"🔔 告警\n标题: {{title}}\n详情: {{content}}"
}'

# 外部系统推送（URL 末尾带 code）
curl -X POST $BASE/recv/<routeId>/abc123 -H "Content-Type: application/json" \
  -d '{"title":"磁盘空间不足","content":"node-7 已用 95%"}'

# 测试（webhook 校验配置；local 源无需测试）
curl -X POST $BASE/api/routes/<routeId>/test -H "X-Admin-Token: $TOKEN"

# 列出 / 更新 / 删除
curl $BASE/api/routes -H "X-Admin-Token: $TOKEN"
curl -X PUT $BASE/api/routes/<routeId> -H "X-Admin-Token: $TOKEN" -H "Content-Type: application/json" -d '{...}'
curl -X DELETE $BASE/api/routes/<routeId> -H "X-Admin-Token: $TOKEN"
```

> 路由含敏感信息（邮箱密码 / webhook code），`GET /api/routes` 会把它们以 `******` 掩码返回；更新时传 `******` 或空即表示保留原值。

---

仓库附带 `ecosystem.config.cjs` 示例（pm2 4.x+）。`web` 子命令会**同时**拉起管理界面（3005）与 webhook 接收端（8787）两个监听端口，因此只需一个进程。

> ⚠️ **迁移提示**：旧版本用 `wecom-webhook`（跑 `webhook --port 8787`）和 `wecom-web` 两个进程。自 webhook 地址统一迁到 8787 端口后，`webhook` 子命令已删除，**`wecom-webhook` 进程不再存在**。升级部署时请先清掉旧定义，否则该进程会反复重启报错：
> ```bash
> pm2 delete wecom-webhook wecom-web
> ```
> 再按下方单进程配置重新 `pm2 start ecosystem.config.cjs`。

```js
// ecosystem.config.cjs（仓库实际内容）
module.exports = {
  apps: [
    {
      name: 'wecom-web',
      script: 'send_wecom.js',
      args: 'web --web-port 3005 --web-root ./web',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        WECOM_API_BASE: 'https://wecom.example.com',
        WECOM_CORP_ID: 'ww0000000000000000',
        WECOM_CORP_SECRET: 'replace-with-real-secret',
        WECOM_AGENT_ID: '1000002',
        WECOM_WEBHOOK_TOKEN: 'replace-with-a-long-random-string',
        // 可选：webhook 接收端端口（默认 8787），如需变更改这里
        // WECOM_WEBHOOK_RECV_PORT: 8787,
        // 可选：反向代理基址（如 https://hook.example.com），用于拼接接收地址
        // WECOM_WEBHOOK_RECV_BASE: '',
      },
    },
  ],
};
```

启动 / 重启 / 看日志：

```bash
pm2 start ecosystem.config.cjs
pm2 restart wecom-web
pm2 logs --lines 200
pm2 save
pm2 startup
```

### 9.1 防止 pm2 日志无限增长（必做）

本系统自身**不写任何日志文件**，所有 `console.log` 输出只进 stdout/stderr；但 pm2 默认会把每个进程的 stdout/stderr 落盘到 `~/.pm2/logs/wecom-web-out.log` 与 `wecom-web-error.log`，**且默认不轮转、会随运行时间无限增长**。生产部署务必开启 pm2 自带的日志轮转模块：

```bash
# 安装 pm2-logrotate 模块（一次性）
pm2 install pm2-logrotate

# 配置：单文件超过 50MB 轮转，最多保留 30 个（约 1.5GB 上限），压缩旧日志
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'   # 也可按天定时轮转

# 验证当前配置与模块状态
pm2 conf pm2-logrotate
pm2 module:list
```

> 轮转后旧的 `wecom-web-out__YYYY-MM-DD.log.gz` 由 pm2 自动管理，无需手工清理。
> 若部署机磁盘紧张，可进一步把 `retain` 调小（如 10），或把 `max_size` 降到 10M。
> 注意：此模块只管 pm2 自己的日志文件；业务数据（`recv.db`）的清理与体积回收由系统内置机制负责，见 §10.1。

`pm2 save` 之后，管理界面的 `GET /api/healthz` 与 webhook 接收端的 `GET /recv/<routeId>`（或任意 404 路径）都可作为存活探针接入 k8s `livenessProbe` / 阿里云 SLB 健康检查。生产环境建议把 3005 留在内网、仅向外暴露 8787（接收端只暴露 `/recv/`，无 UI、无 `/api`）。

## 8. 退出码

| Code | 含义 |
| --- | --- |
| 0 | 发送成功 |
| 1 | 参数 / 配置文件缺失或字段不全 |
| 2 | 获取 `access_token` 失败 |
| 3 | 业务接口失败（`message/send` / `appchat/*`） |

> `message/send` 调用成功（`errcode=0`）只代表消息进入了微信发送队列；最终是否送达收件人需结合应用可见范围、收件人状态判断。

> **注意**：CLI 每次启动是独立进程，**进程内的 access_token 缓存只在 webhook / web 长进程里生效**。
> CLI 模式下不会享受 token 缓存，每次都重新调 `gettoken`。
> 私有化版若对 `gettoken` 有频率限制，CLI 频繁调用会触发限流。

## 9. 常见错误码

| errcode | 含义 | 处理 |
| --- | --- | --- |
| 40001 | 不合法的 access_token | 检查 corp_secret 是否过期、被禁用 |
| 40014 | 不合法的 access_token | 重新调用 `gettoken` |
| 42001 | access_token 过期 | 重新调用 `gettoken` |
| 40029 | 不合法的 corpsecret | 确认 secret 对应自建应用 |
| 60011 | 部门/成员无可见权限 | 在「应用可见范围」中加入 userid |
| 60020 | 应用不在群内 / 无权发群消息 | 先把应用拉进群，或改用 `chat create` |
| 82001 | chatid 无效或 corp secret 非群应用 | 脚本默认走单聊拼接兜底绕开；若必须用 chatid 通道，请向企业微信管理员申请群应用 secret |
| 86003 | 不合法的 userid / chatid | 单聊检查 userid；群聊检查 chatid（`wr...`/`wc...`） |
| 86004 | userid 列表 / chatid 非法组合 | 单聊最多 1000 userid；群聊不要同时填 `touser` |
| 301002 | 无应用访问权限 | 自建应用未授权给该 userid 所在部门 |

## 10. 部署到新环境：消息能发但「发送记录」查不到（DB 未连接）

「发送记录」页若显示 `DB[未连接(写入/查询均不生效)]: <路径>`，说明 SQLite 库初始化失败，消息照常发送但不落库。

**先确认路径是否正确**：`<路径>` 应指向项目目录下的 `recv.db`。若路径正确仍 `未连接`，按下面顺序排查：

1. **`better-sqlite3` 原生模块没装上 / 加载失败（最常见）**
   该模块是原生二进制，必须**在部署机本地** `npm install`，不能把别的机器（尤其不同系统/Node 版本）的 `node_modules` 直接复制过去。
   在部署机项目目录执行：
   ```bash
   cd /path/to/your-project   # 你的项目目录
   node -e "require('better-sqlite3'); console.log('better-sqlite3 OK')"
   ```
   - 报错 `Cannot find module 'better-sqlite3'` 或原生绑定错误 → 执行 `npm install better-sqlite3`（必要时 `npm rebuild better-sqlite3 --build-from-source`）。
   - 若部署机是 NAS / arm / 非 glibc 等小众平台，可能缺少预编译包与编译工具，需自行评估是否可编译。
2. **数据库文件所在目录无写权限**：库会在该目录生成 `recv.db` / `recv.db-wal` / `recv.db-shm`，需保证进程用户对项目目录有读写权限。
3. **数据库路径被启动目录带偏**（旧版本问题）：新版已将路径锚定到脚本目录（`path.resolve(__dirname,'recv.db')`），并通过 `WECOM_RECV_DB_FILE` 可显式指定；如仍混乱，设该环境变量指向绝对路径后重启。

**新版已支持错误自诊断**：`/api/send-log` 响应新增 `_db.error` 字段，前端在查不到记录时会把失败原因直接显示在状态栏（如 `原因: Cannot find module 'better-sqlite3'`）。拉最新代码、重启服务后再点一次「查询」即可看到精确原因。

### 10.1 接收记录库（recv.db）的存储与防无限增长

`recv.db` 是唯一的业务数据落盘点（邮件/ webhook / syslog 接收记录 + 每次外发记录），其余配置（路由、账号）均为小体量 JSON、受实体数约束，无增长风险。

- **记录自动清理（已内置）**：`recv_messages` 表保留 **24 小时**（每 10 分钟扫描一次，删除 `received_at` 更早的记录）；`send_log` 表保留 **90 天**（仅做体积保护，低频清理）。数据量级稳定后即停在各自窗口上限附近。
- **文件体积小回收（已内置，`auto_vacuum=INCREMENTAL`）**：SQLite 默认 `DELETE` 只把页标记为可复用、**不会让 .db 文件缩小**。本系统已在初始化时设置 `auto_vacuum=INCREMENTAL`（首启会对已有库执行一次 `VACUUM` 使设置生效），并在每次清理后调用 `incremental_vacuum`，把空闲页真正归还操作系统，使 `.db` 文件体积随清理回落，从根上避免「流量突增后文件永久变大」。
- **查询/清理索引（已内置）**：`recv_messages(received_at)`、`send_log(sent_at)` 建了索引，避免每 10 分钟一次的全表扫描。
- **WAL 日志有界**：`journal_mode=WAL`，WAL 文件由 SQLite 自动 checkpoint（默认 1000 页后回写），常态有界，不会无限增长。

> 升级到含上述加固的版本后，首次启动会在打开库时执行一次 `VACUUM`（首启会有极短开销，之后跳过）。若希望手动回收，可在进程停机后执行：
> ```bash
> node -e "const D=require('better-sqlite3'); const db=new D('recv.db'); db.pragma('incremental_vacuum'); console.log('reclaimed');"
> ```

## 11. webhook 接收：只发 content 部分（而非整段 JSON）

外部系统 `POST /recv/<routeId>` 时，消息正文默认的处理优先级如下：

1. **路由模板非空** → 按模板渲染（精确控制）。例：模板填 `{{text.content}}` 即只取 `text.content` 字段；`{{text.content}} 来自 {{source}}` 可加前后缀。
2. **路由模板为空 + body 是标准企微消息结构** → **自动透传，只发 content 部分**（不再把整段 `{"msgtype":...}` 当文本发出）。
   识别的消息类型：`text`（`text.content`）、`markdown`（`markdown.content`）、`textcard`（`textcard.description`）、`news`/`mpnews`（`articles[].title`）、`image`/`voice`/`file`/`video`（对应媒体字段）。
   - 例：外部 POST `{"msgtype":"text","text":{"content":"[提示事件]AOC-DC03...Trunk口成员数变化"}}`，群里收到的就是 `[提示事件]AOC-DC03...Trunk口成员数变化`（纯 content，不含外层 JSON 包装）。
3. **模板为空 + body 不是标准企微消息**（如 `{foo:"bar"}`、纯字符串）→ 兜底：原样把整段 JSON / 文本作为消息发出（保持旧行为，避免静默丢消息）。

> 即：**什么都不用配**，只要外部系统发的是企微消息 JSON，就会自动「只发 content 部分」。如需进一步去掉 `[提示事件]` 这类前缀标签，再用模板做二次加工（如配合代码内的前缀剥离规则）。

## 12. webhook 自定义模板：把任意外部系统的字段映射到企微消息

当外部系统 `POST /recv/<routeId>` 的 body **不是**标准企微消息结构（没有 `msgtype`/`text.content`），就需要用「消息模板」把它的字段拼成你要发的内容。模板非空时，**优先**按模板渲染（见 §11 优先级 1），不再走自动透传 / 兜底。

### 12.1 在哪填
Web 后台 →「路由配置」→ 新建 / 编辑路由，接收渠道选 `webhook`，在「消息模板」框里填写（占位提示见页面）。

### 12.2 占位符语法
- `{{字段名}}`：引用 body 顶层字段，如 `{{title}}`。
- `{{a.b}}`：引用嵌套字段。body 会被**拍平**为点号路径：`{"alarm":{"level":"high"}}` → 可用 `{{alarm.level}}`。
- `{{_raw}}`：原始 JSON 字符串（整段 body），兜底 / 调试用。
- 不存在的字段渲染为空串；数组 / 对象字段会 `JSON.stringify` 后代入（**模板尽量只引用叶子字符串字段**）。

### 12.3 示例
外部系统 POST：
```json
{"event":"trunk_change","device":"AOC-DC03-YW","detail":"Trunk口成员数变化","level":"warning"}
```
模板填：
```
🔔 [{{level}}] 网络告警
设备: {{device}}
事件: {{event}}
详情: {{detail}}
```
群内收到：
```
🔔 [warning] 网络告警
设备: AOC-DC03-YW
事件: trunk_change
详情: Trunk口成员数变化
```

嵌套示例（body `{"alarm":{"level":"high","msg":"核心链路抖动"}}`）：
```
告警等级: {{alarm.level}}
{{alarm.msg}}
```

### 12.4 注意
- 字面大括号无需转义，只有 `{{...}}` 会被替换；多行直接换行，企微 text 消息支持换行。
- 配置后可用路由「测试」按钮，或让外部系统发一条，到「发送记录」核对渲染结果。
- 想「只发某个字段」又不想要模板框架：模板直接填 `{{该字段}}` 即可（如 `{{text.content}}` 只发 content 部分）。

## 13. webhook 入站常见错误码（外部系统侧 400/401/403/404 排查）

外部系统 `POST /recv/<routeId>[/:code]` 时，服务端返回的 `errcode` + `errmsg` 与含义：

| errcode | errmsg | 含义 / 排查 |
|---|---|---|
| 400 | `bad path` | URL 路径不对：缺 routeId（如 `POST /recv/`）、前缀错误（如 `/api/recv/...`）、或发到了错误端口。用「路由配置」页复制的完整地址（`http://<host>:8787/recv/<routeId>[/code]`） |
| 400 | `route source 不是 webhook` | 该 routeId 对应的是「本地邮箱(local)」路由，不是 webhook。确认用的是 source=webhook 的路由 |
| 400 | `bad path` / `route source 不是 webhook` | 见上两行（路径 / 源类型问题）。**注：自 v-2026-07-09 起，`invalid JSON body` 已不再出现**——webhook 接收端改为「先尝试 JSON.parse，失败则把 body 当作纯文本处理」，因此 HFish 等发送纯文本的源现在能正常转发（默认直接把原文作为消息内容；也可在路由模板里用 `{{text}}` / `{{_raw}}` 拼装）。空 body 仍当 `{}`，超过 1MB 返回 413 |
| 401 | `invalid code` | URL 末尾的 code 与路由配置的 code 不一致（或路由要求 code 但请求没带） |
| 403 | `route disabled` | 该路由被停用（enable 开关关了） |
| 404 | `route not found` | routeId 不存在（复制错了 / 路由已删除） |
| 405 | `method not allowed` | 用了非 POST 方法（如 GET） |

> 最快定位：抓外部系统收到的响应体，`errmsg` 字段已直接说明原因；服务端日志也会打印对应路由的接收情况。

> 修复后需**彻底重启**服务进程（杀干净旧进程再起），否则仍沿用旧的未连接状态。

## 14. syslog 接收协议

把网络设备 / 服务器的 syslog 报文转发到企业微信（群聊 / 单聊）。每条 syslog 路由**独立监听一个 UDP（或 TCP）端口**，设备把 syslog 指向该端口即触发路由——与 webhook「每条路由一个 `/recv/<routeId>` 端点」模型一致，只是 syslog 用端口区分而非 URL 路径。

### 14.1 配置步骤
1. Web 后台 →「路由配置」→ 新建路由
2. 接收渠道选 `syslog`
3. 填监听端口（如 `1514`，范围 1-65535，**多条路由端口不能重复**）、协议（udp / tcp，默认 udp）
4. 发送渠道选群聊 / 用户
5. （可选）消息模板：用 `{{message}}` `{{host}}` `{{appname}}` `{{severityName}}` 等拼装；留空则使用默认日志格式 `[severity] host appname: message`
6. 保存 → 服务端**立即**在该端口起监听（无需重启）；列表「接收地址」列显示 `udp://<host>:<port>`
7. 设备侧把 syslog 指向 `udp://<本机IP>:<port>`，例如：
   - `logger -n <host> -P 1514 "测试消息"`
   - rsyslog：`*.* @<host>:1514`
   - 交换机 / 防火墙：在 syslog 服务器地址填 `<host>`，端口填 `1514`，协议 UDP

### 14.2 模板变量（syslog）
| 变量 | 含义 |
|---|---|
| `{{message}}` | 报文正文 |
| `{{host}}` | 来源主机名（从报文解析） |
| `{{appname}}` | 应用名（如 `sshd`、`nginx`） |
| `{{procid}}` | 进程 id |
| `{{msgid}}` | 消息 id（RFC5424） |
| `{{severity}}` | 等级数字 0-7 |
| `{{severityName}}` | 等级名：`emerg`/`alert`/`crit`/`err`/`warning`/`notice`/`info`/`debug` |
| `{{facility}}` | facility 编号 |
| `{{timestamp}}` | 时间戳 |
| `{{_srcIp}}` | 来源 IP（UDP/TCP 真实地址） |
| `{{_raw}}` | 原始报文 |

兼容 RFC3164（BSD）与 RFC5424（`<PRI>1 ...`）。空 body 不会报错，缺失字段渲染为空串。

### 14.3 示例
设备发来：`<134>Jul 9 21:00:00 gw01 sshd[1234]: Failed password for root`
模板填：
```
🔐 [{{severityName}}] {{host}} / {{appname}}
{{message}}
```
群内收到：
```
🔐 [err] gw01 / sshd
Failed password for root
```

### 14.4 与 webhook 的差异
- **空模板行为不同**：webhook 空模板 + 标准企微结构 → 自动透传 content；syslog 空模板 → 走默认日志格式（syslog 报文不是企微消息结构，不会透传整段）。
- **路由区分方式不同**：syslog 用端口区分；webhook 用 URL 路径（`/recv/<routeId>`）区分。
- **端口独立**：syslog 监听端口独立于管理界面（3005）/ webhook（8787），需确保防火墙放通该 UDP/TCP 端口。

### 14.5 端口冲突
两条 syslog 路由端口相同 → 后者启动失败，服务端打印 `[syslog] 路由 <id> 端口 <port> 非法或与其他 syslog 路由冲突，跳过`，改端口即可。修改端口保存后，`syncRouteEngine` 会先关闭旧监听再重绑，无需手动重启进程。
