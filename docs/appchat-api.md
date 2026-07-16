# 企业微信应用群聊 API 文档（appchat）

> 适用范围：私有化企业微信（`wecom.example.com` 部署），需企业自建应用调用。
> 本文档整合官方接口规格 + 本项目（`send_wecom.js`）实际实现对照，重点说明「拉人 / 踢人」所属的接口。

---

## 0. 拉人 / 踢人 归属说明（重点）

「拉人入群」与「踢人出群」**不是独立接口**，而是「修改群聊」接口 `appchat/update` 的两个可选参数：

| 操作 | 参数 | 含义 |
|---|---|---|
| 拉人入群 | `add_user_list` | 要**添加**的成员 userid 列表 |
| 踢人出群 | `del_user_list` | 要**移出**的成员 userid 列表 |

- 二者同属 `POST /cgi-bin/appchat/update`。
- 一次请求可同时包含 `add_user_list` 与 `del_user_list`（先加后减）。
- 本项目中，网页「查看群」标签页的 **拉人入群 / 踢人出群** 两个表单，底层都打这个接口（见 §5）。

> 注意：只有**当前应用创建的群聊**才能被本应用修改；群主不可被移除；应用自身通常也不能把自己移除。

---

## 1. 概述

| 项 | 说明 |
|---|---|
| 接口族 | `appchat`（应用群聊会话） |
| 基础地址 | `https://wecom.example.com/cgi-bin/appchat/<action>?access_token=ACCESS_TOKEN` |
| 本项目基址配置 | 由 `WECOM_API_BASE` 决定（默认私有化地址），所有 `/cgi-bin/appchat/*` 共用同一套 access_token |
| 调用方 | 仅企业自建应用 |
| 鉴权 | URL 参数 `access_token`（由 corp id / secret 换取） |

**通用限制（全部接口适用）**

- 只能操作在「当前应用可见范围」内的成员。
- 只有当前应用创建的群聊，当前应用才可以操作。
- 群成员人数不可超过管理端配置的「群成员人数上限」（通用上限，最大 2000）。

**返回码约定**

- `errcode: 0` → 成功；非 0 → 异常，具体原因见 `errmsg`。
- 常见异常：`86003`（chatid 不存在）、`82001`（本应用无该群操作权限）等。

---

## 2. 完整接口清单（官方 6 个）

| # | 功能 | 方法 | 官方地址 | 本项目是否实现 |
|---|---|---|---|---|
| 1 | 创建群聊 | POST | `/cgi-bin/appchat/create` | ✅ 已实现 |
| 2 | 修改群聊（含拉人/踢人） | POST | `/cgi-bin/appchat/update` | ✅ 已实现 |
| 3 | 获取群聊会话 | GET | `/cgi-bin/appchat/get` | ✅ 已实现 |
| 4 | 解散群聊 | POST | `/cgi-bin/appchat/dismiss` | ✅ 已实现 |
| 5 | 推送应用消息 | POST | `/cgi-bin/appchat/send` | ✅ 已实现 |
| 6 | 撤回应用群聊消息 | POST | `/cgi-bin/appchat/revoke` | ✅ 已实现 |

> 另：本项目额外提供 `GET /cgi-bin/appchat/list`（列出本应用可见的群），属私有化部署扩展，官方文档未单列。
> 另：本项目提供 `GET /api/send-log`（查询发送记录，见 §7），属运维审计扩展。

---

## 7. 发送记录与限制（本项目扩展）

### 7.1 发送记录（send-log）

每次通过 `appchat/send` 或 `message/send` 外发，都会把一条记录写入 SQLite（与接收记录同库 `recv.db` 的 `send_log` 表，保留 90 天）。字段：

| 字段 | 说明 |
|---|---|
| sent_at | 发送时间戳（毫秒） |
| source_type | **源方式**：`web`（网页控制台）/ `route`（路由触发）/ `cli`（命令行） |
| route_id | 若是路由触发，记录路由 id |
| target_type | **目的方式**：`chat`（群聊）/ `user`（单聊） |
| target_id | 群 chatid 或 userid 列表 |
| msgtype | 消息类型（text / markdown / news …） |
| content | 消息内容摘要（落库可读文本） |
| jobid | `appchat/send` 返回的 jobid（单聊无，存 `null`） |
| errcode / errmsg / success | 发送结果 |

**查询接口**：`GET /api/send-log?from=<ms>&to=<ms>&limit=<n>`（需 `X-Admin-Token`）。`from`/`to` 为毫秒时间戳，不传则不限。

**网页**：「发送记录」标签页，按时间范围查询，表格展示 **时间 / 源方式 / 目的方式 / 内容 / jobid / 状态**。

### 7.2 撤回消息自动取 jobid

`POST /api/chats/:chatid/revoke` 接受 `jobid` 或 `revokelist`；两者都不传时，**自动从 `send_log` 取该群（`target_type=chat` 且 `target_id=chatid`）最近一次成功群发的 jobid**。CLI：`node send_wecom.js chat revoke --chat-id <id> [--jobid <jobid>] [--revokelist <JSON>]`。

### 7.3 禁发全员限制

所有发送链路（网页 / 路由 / CLI）禁止向全体人员发送：

- `touser` 为 `@all`（或含 `@all`）时直接拒绝，返回 `禁止向全体人员发送消息（touser 不能为 @all），必须指定具体接收人`；
- 未指定任何接收人（无 `--to`、无 `--chat-id`、路由无 target）时拒绝，避免误发全体。

> CLI 子命令：`node send_wecom.js chat dismiss --chat-id <id>`、`node send_wecom.js chat revoke --chat-id <id>`。

---

## 3. 各接口详情

### 3.1 创建群聊 — `POST /cgi-bin/appchat/create`

请求包体：

```json
{
  "name": "应用群聊",
  "owner": "user1",
  "userlist": ["user1", "user2"],
  "chatid": ""
}
```

| 参数 | 必填 | 说明 |
|---|---|---|
| name | 否 | 群聊名，最多 50 个 utf8 字符，超过截断 |
| owner | 否 | 指定群主 id；不指定则系统从 userlist 随机选一人 |
| userlist | 是 | 群成员 id 列表，至少 2 人、至多 2000 人（owner 也需在列表中） |
| chatid | 否 | 群唯一标志，不可重复；仅允许 `0-9` 与 `a-zA-Z`，最长 32 字符；不填则系统随机生成 |

返回：

```json
{ "errcode": 0, "errmsg": "ok", "chatid": "Chat_Id" }
```

> 注意：刚创建的群若未下发消息，客户端不会出现该群。

---

### 3.2 修改群聊（含拉人 / 踢人） — `POST /cgi-bin/appchat/update`

**这是「拉人入群」和「踢人出群」所属的接口。**

请求包体：

```json
{
  "chatid": "Chat_Id",
  "name": "Name",
  "owner": "user1",
  "add_user_list": ["user2", "user3"],
  "del_user_list": ["user4", "user5"]
}
```

| 参数 | 必填 | 说明 |
|---|---|---|
| chatid | 是 | 要修改的群聊 ID |
| name | 否 | 新群名，不需更新则忽略；最多 50 utf8 字符 |
| owner | 否 | 新群主 id，不需更新则忽略 |
| add_user_list | 否 | **要添加的成员 id 列表 → 拉人入群** |
| del_user_list | 否 | **要移出的成员 id 列表 → 踢人出群** |

返回：

```json
{ "errcode": 0, "errmsg": "ok" }
```

---

### 3.3 获取群聊会话 — `GET /cgi-bin/appchat/get`

请求：`GET /cgi-bin/appchat/get?access_token=ACCESS_TOKEN&chatid=CHAT_Id`

| 参数 | 必填 | 说明 |
|---|---|---|
| chatid | 是 | 要查询的群聊 ID |

返回：

```json
{
  "errcode": 0,
  "errmsg": "ok",
  "chat_info": {
    "chatid": "Chat_Id",
    "name": "Name",
    "owner": "user1",
    "userlist": ["user1", "user2"]
  },
  "custom_user_list": [
    { "userid": "user1", "nickname": "user1name", "order": 0 },
    { "userid": "user2", "nickname": "user2name", "order": 1 }
  ]
}
```

---

### 3.4 解散群聊 — `POST /cgi-bin/appchat/dismiss`

> 本项目**已实现**。

请求包体：`{ "chatid": "Chat_Id" }`

返回：`{ "errcode": 0, "errmsg": "ok" }`

---

### 3.5 推送应用消息 — `POST /cgi-bin/appchat/send`

以应用身份向群聊推送消息，支持 text / image / voice / video / file / textcard / news / mpnews / markdown。

请求包体（以 text 为例）：

```json
{
  "chatid": "Chat_Id",
  "msgtype": "text",
  "text": { "content": "消息内容" }
}
```

返回：

```json
{ "errcode": 0, "errmsg": "ok", "jobid": "4_1603337930_170948" }
```

消息类型定义见 §6。

---

### 3.6 撤回应用群聊消息 — `POST /cgi-bin/appchat/revoke`

> 本项目**已实现**。不传 `jobid` 时自动从 `send_log` 取该群最近一次群发的 jobid（见 §7.2）。

请求包体：

```json
{
  "jobid": "4_1603337930_170948",
  "revokelist": [
    { "userid": "evan001", "msgid": ["CAASLHd3b3Blbm1zZ..."] },
    { "userid": "test1",   "msgid": ["CAASLHd3b3Blbm1zZ..."] }
  ]
}
```

| 参数 | 说明 |
|---|---|
| jobid | 应用推送消息的任务 ID（由 §3.5 返回）；与 revokelist 二选一，填了 jobid 则忽略 revokelist |
| revokelist | 需要撤回的成员及消息 ID 列表，限制 2000 人 |
| msgid | 消息 ID，由异步任务结果查询接口返回 |

返回：`{ "errcode": 0, "errmsg": "ok" }`

---

## 4. 本项目接口对照（重要）

本项目把上述官方接口封装为 **Web API（`/api/chats`，管理界面 3005 端口）** 与 **CLI 子命令** 两种入口：

| 官方接口 | 本项目 Web API | CLI 子命令 | 备注 |
|---|---|---|---|
| 创建群聊 `appchat/create` | `POST /api/chats`（body: `chatid,name,owner,members`） | `node send_wecom.js chat create --chat-id ... --name ... --owner ... --members ...` | 三者必填，成员≥2 |
| 修改群聊 `appchat/update` | `PATCH /api/chats/:chatid`（body 见 §5） | `node send_wecom.js chat update --chat-id ... --add ... --del ...` | **拉人/踢人走这里** |
| 获取群聊会话 `appchat/get` | `GET /api/chats/:chatid` | `node send_wecom.js chat get --chat-id ...` | — |
| 推送应用消息 `appchat/send` | `POST /api/chats/:chatid/messages` | `node send_wecom.js --chat-id ... --type text --content ...` | 主发送流程（`runSend`）；每次发送落库 `send_log` 并记录 `jobid` |
| 解散群聊 `appchat/dismiss` | `POST /api/chats/:chatid/dismiss` | `node send_wecom.js chat dismiss --chat-id ...` | 仅限本应用创建的群 |
| 撤回应用群聊消息 `appchat/revoke` | `POST /api/chats/:chatid/revoke`（可带 `jobid`，缺省自动取最近一次） | `node send_wecom.js chat revoke --chat-id ... [--jobid ...]` | 自动取 jobid 来自 `send_log` |
| 发送记录查询 | `GET /api/send-log?from=&to=&limit=`（需 `X-Admin-Token`） | — | 运维审计扩展，见 §7.1 |
| 列出可见群 `appchat/list` | `GET /api/chats` | — | 私有化扩展；前端已移除该按钮 |

---

## 5. 拉人 / 踢人 在本项目的调用方式

### 5.1 Web API

```
PATCH /api/chats/:chatid
Header: X-Admin-Token: <WECOM_WEBHOOK_TOKEN>
Content-Type: application/json
```

请求体（标准字段）：

```json
{
  "add_user_list": ["user2", "user3"],
  "del_user_list": ["user4"]
}
```

本项目对字段名做了兼容别名，下列写法等价：

| 语义 | 接受的字段名 |
|---|---|
| 拉人 | `add_user_list` / `add_user_list` / `add` / `add_user` |
| 踢人 | `del_user_list` / `del_user_list` / `del` / `del_user` |
| 改名 | `name` |
| 换群主 | `owner` |

> 至少需携带 `name` / `owner` / `add*` / `del*` 之一，否则返回 `400`。

示例（curl）：

```bash
TOKEN="你的管理员token"
# 拉人入群
curl -s -X PATCH http://localhost:3005/api/chats/Chat_Id \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $TOKEN" \
  -d '{"add_user_list":["user2","user3"]}'

# 踢人出群
curl -s -X PATCH http://localhost:3005/api/chats/Chat_Id \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $TOKEN" \
  -d '{"del_user_list":["user4"]}'
```

### 5.2 网页控制台

「查看群」标签页提供：

1. **查看群信息**：`GET /api/chats/:chatid`，返回群主与成员列表（便于先看清当前成员）。
2. **拉人入群**：填 chatid + 成员 userid（多个用逗号 / 换行 / 分号分隔）→ 发送 `add_user_list`。
3. **踢人出群**：填 chatid + 成员 userid → 发送 `del_user_list`。

> 群主不可被移除；非本应用创建的群会返回权限类错误（按返回的 `errcode` 判断）。

---

## 6. 消息类型定义（推送 / 撤回用）

### 6.1 图文消息（mpnews）

内容存储在本地；多次发送会被视为不同图文，阅读/点赞统计分开。

```json
{
  "chatid": "Chat_Id",
  "msgtype": "mpnews",
  "mpnews": {
    "articles": [
      {
        "title": "地球一小时",
        "thumb_media_id": "1G6nrLmr5EC3MMb_-zK1dDdzmd0p7cNliYu9V5w7o8K0",
        "author": "Author",
        "content_source_url": "https://wecom.example.com",
        "content": "3月24日20:30-21:30 办公区将关闭照明一小时，请各部门同事相互转告",
        "digest": "3月24日20:30-21:30 办公区将关闭照明一小时"
      }
    ]
  }
}
```

| 参数 | 必填 | 说明 |
|---|---|---|
| articles | 是 | 1~8 条图文 |
| title | 是 | 不超过 128 字节，超长截断 |
| thumb_media_id | 是 | 缩略图 media_id（素材管理接口获取） |
| author | 否 | 作者，不超过 64 字节 |
| content_source_url | 否 | 点击「阅读原文」跳转链接 |
| content | 是 | 内容，支持 html，不超过 666K 字节 |
| digest | 否 | 描述，不超过 512 字节，超长截断 |

### 6.2 markdown 消息

仅支持 markdown 语法子集。

```json
{
  "chatid": "CHATID",
  "msgtype": "markdown",
  "markdown": {
    "content": "您的会议室已经预定，稍后会同步到`邮箱`\n>**事项详情**\n>事 项：<font color=\"info\">开会</font>\n>组织者：@miglioguan\n>参与者：@miglioguan、@kunliu\n>\n>会议室：<font color=\"info\">广州TIT 1楼 301</font>\n>日 期：<font color=\"warning\">2018年5月18日</font>\n>时 间：<font color=\"comment\">上午9:00-11:00</font>"
  }
}
```

| 参数 | 必填 | 说明 |
|---|---|---|
| chatid | 是 | 群聊 id |
| msgtype | 是 | 固定 `markdown` |
| content | 是 | markdown 内容，最长 2048 字节，utf8 编码 |
