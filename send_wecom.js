#!/usr/bin/env node
/**
 * send_wecom.js
 * ------------------------------------------------------------------
 * 私有化企业微信「自建应用」消息发送脚本（Node.js 18+，无外部依赖）
 *
 * 支持消息类型:
 *   - text      文本
 *   - news      图文（点击可跳链接）
 *   - markdown  富文本 Markdown
 *
 * 凭证来源:
 *   从 ./config.js 读取（可通过 --config 指定其他路径），文件需导出对象
 *   {
 *     WECOM_API_BASE:        'https://wecom.example.com',
 *     WECOM_CORP_ID:         'ww...',
 *     WECOM_CORP_SECRET:     '...',
 *     WECOM_AGENT_ID:        '1000002',
 *     WECOM_WEBHOOK_TOKEN:   'long-random-string'   // 网页控制台管理员 token
 *   }
 *
 * 模式一：CLI 发送
 *   --to <userids> | --chat-id <chatid>      二选一
 *   --type text | news | markdown
 *   --content <text>          用于 text / markdown
 *   --payload '<JSON>'        用于 news
 *
 * 模式二：群管理
 *   node send_wecom.js chat create --chat-id <id> --name <n> --owner <uid> --members <u1|u2>
 *   node send_wecom.js chat update --chat-id <id> [--name <n>] [--owner <uid>] [--add <uids>] [--del <uids>]
 *   node send_wecom.js chat get    --chat-id <id>
 *
 * 模式三：网页控制台（含路由配置 / 邮件账号 / webhook 接收）
 *   node send_wecom.js web --web-port 3005 --web-root ./web
 *   - 管理界面 + REST API 在 3005（需 X-Admin-Token 鉴权）
 *   - webhook 接收端在独立端口（默认 8787，见 config.js WECOM_WEBHOOK_RECV_PORT）
 *     外部系统 POST /recv/<routeId>[/:code]，地址由「路由配置」页生成
 *
 * 退出码:
 *   0  成功
 *   1  参数 / 配置文件错误
 *   2  access_token 获取失败
 *   3  业务接口失败（message/send / appchat/...）
 * ------------------------------------------------------------------
 */

'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');

// 本地内置 SMTP 接收 / 邮件解析依赖（npm i smtp-server mailparser）
let simpleParser = null;
try { simpleParser = require('mailparser').simpleParser; } catch (_) { /* optional */ }

// 本地内置 SMTP 接收服务依赖（npm i smtp-server；缺失时本地邮件账号不可用）
let SMTPServer = null;
try { SMTPServer = require('smtp-server').SMTPServer; } catch (_) { /* optional */ }

// 接收记录持久化依赖（npm i better-sqlite3；缺失时接收记录不落库，仅投递不留存）
// 设计要点：接收到的邮件 / webhook 消息写入 SQLite（二进制库文件，非文本），
// 保留 24 小时，超过即清理；不把接收内容写到任何文本文件，避免存储空间膨胀。
let SqliteDb = null;
try { SqliteDb = require('better-sqlite3'); } catch (_) { /* optional */ }

// ---------------- 参数解析 ----------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function helpText() {
  return [
    '用法:',
    '  # 单聊 / 应用广播',
    '  node send_wecom.js --to <userids> --type text    --content "你好"',
    '  node send_wecom.js --to <userids> --type news    --payload \'<JSON>\'',
    '  node send_wecom.js --to <userids> --type markdown --content "# 标题\\n正文"',
    '',
    '  # 群聊（应用号已在群里）',
    '  node send_wecom.js --chat-id <chatid> --type text --content "群通知"',
    '    # 私有化版默认走"读群成员后单聊拼接"模拟群发（绕开 82001）',
    '    # 想强制走原生 chatid 通道时加 --force-chat',
    '',
    '  # 群管理',
    '  node send_wecom.js chat create --chat-id <id> --name <n> --owner <uid> [--members <u1|u2>]',
    '  node send_wecom.js chat update --chat-id <id> [--name <n>] [--owner <uid>] [--add <u1|u2>] [--del <u1|u2>]',
    '  node send_wecom.js chat get    --chat-id <id>',
    '  node send_wecom.js chat dismiss --chat-id <id>',
    '  node send_wecom.js chat revoke  --chat-id <id> [--jobid <jobid>] [--revokelist <JSON>]',
    '    # revoke 不传 jobid 时，自动取该群最近一次群发的 jobid（来自发送记录库）',
    '',
    '  # 网页控制台（含路由配置 / 邮件账号 / webhook 接收）',
    '  node send_wecom.js web --web-port 3005 --web-root ./web',
    '  #   - 管理界面 / REST API 在 3005 端口（需 X-Admin-Token 鉴权）',
    '  #   - webhook 接收端在独立端口（默认 8787，见 config.js WECOM_WEBHOOK_RECV_PORT）',
    '  #     外部系统 POST /recv/<routeId>[/:code]，地址由「路由配置」页生成',
    '',
    '可选参数: --config <path>   配置文件路径，默认 ./config.js',
    '凭证字段: WECOM_API_BASE / WECOM_CORP_ID / WECOM_CORP_SECRET / WECOM_AGENT_ID',
    '控制台字段: WECOM_WEBHOOK_TOKEN（管理员 token，缺则无法启动 web 子命令）',
  ].join('\n');
}

// ---------------- 凭证加载 ----------------

const PLACEHOLDER_SECRETS = new Set([
  '',
  'PLACEHOLDER_CORP_SECRET',
  'PLACEHOLDER_CORP_ID',
  'PLACEHOLDER_AGENT_ID',
]);

function loadConfig(configPath, { allowEnvFallback = false } = {}) {
  let cfg = {};
  try {
    delete require.cache[require.resolve(configPath)];
    cfg = require(configPath);
  } catch (e) {
    console.error(`加载配置失败: ${configPath}`);
    console.error(e.message);
    console.error('请确认文件存在，并通过 module.exports 导出对象。');
    process.exit(1);
  }
  if (!cfg || typeof cfg !== 'object') {
    console.error(`配置文件 ${configPath} 必须导出对象`);
    process.exit(1);
  }

  // 允许 webhook 子命令从环境变量回退 corp 字段
  const envMap = {
    WECOM_API_BASE: 'WECOM_API_BASE',
    WECOM_CORP_ID: 'WECOM_CORP_ID',
    WECOM_CORP_SECRET: 'WECOM_CORP_SECRET',
    WECOM_AGENT_ID: 'WECOM_AGENT_ID',
  };
  if (allowEnvFallback) {
    for (const [k, envName] of Object.entries(envMap)) {
      if (!cfg[k] || !String(cfg[k]).trim() || PLACEHOLDER_SECRETS.has(String(cfg[k]).trim())) {
        const envVal = process.env[envName];
        if (envVal && envVal.trim() && !PLACEHOLDER_SECRETS.has(envVal.trim())) {
          cfg[k] = envVal;
        }
      }
    }
  }

  const required = [
    'WECOM_API_BASE',
    'WECOM_CORP_ID',
    'WECOM_CORP_SECRET',
    'WECOM_AGENT_ID',
  ];
  const missing = required.filter((k) => {
    const v = cfg[k];
    return (
      v === undefined ||
      v === null ||
      String(v).trim() === '' ||
      PLACEHOLDER_SECRETS.has(String(v).trim())
    );
  });
  if (missing.length) {
    console.error('配置缺失或仍为占位值:', missing.join(', '));
    console.error('请编辑', configPath, '填入真实凭证后再运行。');
    process.exit(1);
  }

  return {
    apiBase: String(cfg.WECOM_API_BASE).replace(/\/+$/, ''),
    corpId: String(cfg.WECOM_CORP_ID).trim(),
    corpSecret: String(cfg.WECOM_CORP_SECRET).trim(),
    agentId: String(cfg.WECOM_AGENT_ID).trim(),
    // webhook 接收端端口（与 3005 管理界面隔离）；默认 8787
    webhookRecvPort: Number(cfg.WECOM_WEBHOOK_RECV_PORT || 8787) || 8787,
    // 可选：webhook 接收端对外基址（含协议+域名），留空则按访问主机名自动拼
    webhookRecvBase: typeof cfg.WECOM_WEBHOOK_RECV_BASE === 'string' ? cfg.WECOM_WEBHOOK_RECV_BASE.trim() : '',
  };
}

// ---------------- 通用 HTTP ----------------

async function httpJson(url, options = {}) {
  const res = await fetch(url, options);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(`响应不是 JSON: ${res.status} ${res.statusText}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

// ---------------- access_token ----------------

// 模块级 token 缓存（带过期时间）
// 企业微信 access_token 官方有效期 7200s，私有化版可能不同；保守按 7000s 强制刷新
// 加 60s 提前量是给进程内的请求一些"软过期"缓冲，到点立即续期
const TOKEN_TTL_MS = (7000 - 60) * 1000; // 提前 60s 续期，避免边界过期
const _tokenCache = new Map(); // key: `${apiBase}|${corpId}|${corpSecret}` -> { token, expiresAt }

function _tokenCacheKey(cfg) {
  return `${cfg.apiBase}|${cfg.corpId}|${cfg.corpSecret}`;
}

async function getAccessToken(cfg) {
  const key = _tokenCacheKey(cfg);
  const now = Date.now();
  const hit = _tokenCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.token;
  }
  const url =
    `${cfg.apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}` +
    `&corpsecret=${encodeURIComponent(cfg.corpSecret)}`;
  const data = await httpJson(url, { method: 'GET' });
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`gettoken 失败: errcode=${data.errcode} errmsg=${data.errmsg}`);
  }
  // 写入缓存（同时记录 expires_in 兜底：私有化版若不返回 expires_in 用默认 TTL）
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 7200;
  const ttl = Math.max(60, expiresIn - 60) * 1000;
  _tokenCache.set(key, { token: data.access_token, expiresAt: now + ttl });
  return data.access_token;
}

// 显式失效缓存：用于上游返回 40001/42001/41001 等 token 失效错误时强制重取
function invalidateAccessToken(cfg) {
  _tokenCache.delete(_tokenCacheKey(cfg));
}

// ---------------- 业务封装 ----------------

function withToken(url, token) {
  return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
}

// token 失效 errcode: 40001 (invalid credential) / 42001 (expired) / 41001 (missing)
const TOKEN_INVALID_ERRCODES = new Set([40001, 42001, 41001, 40014]);

function isTokenInvalid(errcode) {
  return TOKEN_INVALID_ERRCODES.has(Number(errcode));
}

async function postJson(cfg, token, pathname, body) {
  const doRequest = async (tk) => httpJson(withToken(`${cfg.apiBase}${pathname}`, tk), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await doRequest(token);
  } catch (e) {
    // 透传 HTTP 错误
    throw e;
  }
  if (data.errcode !== 0) {
    // token 失效时强制失效缓存 + 自动重试 1 次
    if (isTokenInvalid(data.errcode)) {
      invalidateAccessToken(cfg);
      const newToken = await getAccessToken(cfg);
      const data2 = await doRequest(newToken);
      if (data2.errcode !== 0) {
        throw new Error(`${pathname} 失败: errcode=${data2.errcode} errmsg=${data2.errmsg}`);
      }
      return data2;
    }
    throw new Error(`${pathname} 失败: errcode=${data.errcode} errmsg=${data.errmsg}`);
  }
  return data;
}

async function getJson(cfg, token, pathname) {
  const doRequest = async (tk) => httpJson(withToken(`${cfg.apiBase}${pathname}`, tk), { method: 'GET' });
  let data;
  try {
    data = await doRequest(token);
  } catch (e) {
    throw e;
  }
  if (data.errcode !== 0) {
    if (isTokenInvalid(data.errcode)) {
      invalidateAccessToken(cfg);
      const newToken = await getAccessToken(cfg);
      const data2 = await doRequest(newToken);
      if (data2.errcode !== 0) {
        throw new Error(`${pathname} 失败: errcode=${data2.errcode} errmsg=${data2.errmsg}`);
      }
      return data2;
    }
    throw new Error(`${pathname} 失败: errcode=${data.errcode} errmsg=${data.errmsg}`);
  }
  return data;
}

// ---------------- 消息构造 ----------------

function buildMessage(type, content, payload) {
  switch (type) {
    case 'text': {
      if (!content) throw new Error('--type text 时必须传入 --content');
      return { msgtype: 'text', text: { content } };
    }
    case 'news': {
      let data = payload;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          throw new Error('--type news 时 --payload 必须是合法 JSON');
        }
      }
      if (!data || !Array.isArray(data.articles) || data.articles.length === 0) {
        throw new Error('--type news 时 payload 必须包含 articles 数组（1~8 条）');
      }
      if (data.articles.length > 8) {
        throw new Error('图文消息最多 8 条');
      }
      return { msgtype: 'news', news: data };
    }
    case 'markdown': {
      if (!content) throw new Error('--type markdown 时必须传入 --content');
      return { msgtype: 'markdown', markdown: { content } };
    }
    default:
      throw new Error(`不支持的消息类型: ${type}（支持 text / news / markdown）`);
  }
}

// ---------------- 发送：单聊 / 群聊 ----------------

async function sendMessage(cfg, token, msgObj, opts) {
  const { touser, chatId, asUserList, meta } = opts || {};
  // 安全限制：禁止向全体人员发送（touser 为 @all 会群发全公司）
  if (touser && /(^|[|])@all($|[|])/i.test(String(touser))) {
    const err = new Error('禁止向全体人员发送消息（touser 不能为 @all），必须指定具体接收人');
    if (meta) recordSend({ ...meta, targetType: chatId ? 'chat' : 'user', targetId: chatId || touser, msgtype: msgObj.msgtype, content: extractContent(msgObj), jobid: null, errcode: null, errmsg: err.message, success: 0 });
    throw err;
  }
  const body = {
    msgtype: msgObj.msgtype,
    agentid: Number(cfg.agentId),
    ...msgObj,
    safe: 0,
    duplicate_check_interval: 1800,
  };

  // 优先级: asUserList（群发兜底） > chatId（原生群） > touser（单聊）
  if (asUserList && Array.isArray(asUserList) && asUserList.length > 0) {
    // 私有化版坑：当前 corp secret 不是「群应用 secret」时，message/send 走 chatid 会 82001。
    // 解决：把 chatid 对应群的成员读出来，改用单聊 touser=u1|u2|... 模拟群发。
    body.touser = asUserList.join('|');
  } else if (chatId) {
    // 群聊通道：touser / toparty / totag 必须全部留空
    body.chatid = chatId;
  } else if (touser) {
    body.touser = touser;
  } else {
    const err = new Error('未指定收件人：需要 --to 或 --chat-id');
    if (meta) recordSend({ ...meta, targetType: 'unknown', targetId: null, msgtype: msgObj.msgtype, content: extractContent(msgObj), jobid: null, errcode: null, errmsg: err.message, success: 0 });
    throw err;
  }

  const targetType = chatId ? 'chat' : 'user';
  const targetId = chatId || touser || (asUserList ? asUserList.join('|') : null);
  const content = extractContent(msgObj);
  try {
    const result = await postJson(cfg, token, '/cgi-bin/message/send', body);
    if (meta) recordSend({ ...meta, targetType, targetId, msgtype: msgObj.msgtype, content, jobid: (result && result.jobid) || null, errcode: result && result.errcode, errmsg: result && result.errmsg, success: result && result.errcode === 0 ? 1 : 0 });
    return result;
  } catch (e) {
    if (meta) recordSend({ ...meta, targetType, targetId, msgtype: msgObj.msgtype, content, jobid: null, errcode: null, errmsg: e.message, success: 0 });
    throw e;
  }
}

// 以应用身份向群聊会话推送消息（私有化部署专用通道 /cgi-bin/appchat/send）
// 与 appchat/create / appchat/get 同属一套凭证，可正确把消息投递进群聊。
// meta 可选：传入则记录发送日志（含返回的 jobid）。
async function appchatSend(cfg, token, chatid, msgObj, meta) {
  try {
    const result = await postJson(cfg, token, '/cgi-bin/appchat/send', { chatid, ...msgObj });
    if (meta) recordSend({ ...meta, targetType: 'chat', targetId: chatid, msgtype: msgObj.msgtype, content: extractContent(msgObj), jobid: (result && result.jobid) || null, errcode: result && result.errcode, errmsg: result && result.errmsg, success: result && result.errcode === 0 ? 1 : 0 });
    return result;
  } catch (e) {
    if (meta) recordSend({ ...meta, targetType: 'chat', targetId: chatid, msgtype: msgObj.msgtype, content: extractContent(msgObj), jobid: null, errcode: null, errmsg: e.message, success: 0 });
    throw e;
  }
}

// ---------------- 群管理 ----------------

function splitList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function appchatCreate(cfg, token, args) {
  const chatid = (args['chat-id'] || '').toString().trim();
  const name = (args.name || '').toString().trim();
  const owner = (args.owner || '').toString().trim();
  const members = splitList(args.members);
  if (!chatid) throw new Error('chat create 需要 --chat-id');
  if (!name) throw new Error('chat create 需要 --name');
  if (!owner) throw new Error('chat create 需要 --owner（群主 userid）');
  const cErr = validateChatid(chatid);
  if (cErr) throw new Error(cErr);
  // userlist = owner + members（去重）
  const userlist = members.includes(owner) ? members : [owner, ...members];
  if (userlist.length < 2) {
    throw new Error('chat create 至少需要 2 个成员（owner + 至少 1 名其他成员）');
  }
  return postJson(cfg, token, '/cgi-bin/appchat/create', {
    chatid,
    name,
    owner,
    userlist,
  });
}

async function appchatUpdate(cfg, token, args) {
  const chatid = (args['chat-id'] || '').toString().trim();
  if (!chatid) throw new Error('chat update 需要 --chat-id');
  const cErr = validateChatid(chatid);
  if (cErr) throw new Error(cErr);
  const body = { chatid };
  if (args.name) body.name = String(args.name).trim();
  if (args.owner) body.owner = String(args.owner).trim();
  const add = splitList(args.add);
  const del = splitList(args.del);
  if (add.length) body.add_user_list = add;
  if (del.length) body.del_user_list = del;
  if (Object.keys(body).length === 1) {
    throw new Error('chat update 至少需要 --name / --owner / --add / --del 之一');
  }
  return postJson(cfg, token, '/cgi-bin/appchat/update', body);
}

async function appchatGet(cfg, token, args) {
  const chatid = (args['chat-id'] || '').toString().trim();
  if (!chatid) throw new Error('chat get 需要 --chat-id');
  const cErr = validateChatid(chatid);
  if (cErr) throw new Error(cErr);
  return getJson(cfg, token, `/cgi-bin/appchat/get?chatid=${encodeURIComponent(chatid)}`);
}

// 解散群聊（appchat/dismiss）
async function appchatDismiss(cfg, token, args) {
  const chatid = (args['chat-id'] || '').toString().trim();
  if (!chatid) throw new Error('chat dismiss 需要 --chat-id');
  const cErr = validateChatid(chatid);
  if (cErr) throw new Error(cErr);
  return postJson(cfg, token, '/cgi-bin/appchat/dismiss', { chatid });
}

// 撤回应用群聊消息（appchat/revoke）
// 接受 --jobid（由 appchat/send 返回）或 --revokelist（JSON 数组）；
// 两者都不给时，自动从发送记录库取该群最近一次的 jobid。
async function appchatRevoke(cfg, token, args) {
  const chatid = (args['chat-id'] || '').toString().trim();
  if (!chatid) throw new Error('chat revoke 需要 --chat-id');
  const cErr = validateChatid(chatid);
  if (cErr) throw new Error(cErr);
  const jobid = (args.jobid || '').toString().trim();
  let revokelist = null;
  if (args.revokelist) {
    try { revokelist = JSON.parse(String(args.revokelist)); }
    catch (e) { throw new Error('--revokelist 必须是合法 JSON 数组'); }
  }
  const effectiveJobid = jobid || latestJobIdForChat(chatid);
  if (!effectiveJobid && !revokelist) {
    throw new Error('未提供 jobid 且发送记录库中也无该群的最近 jobid（可能从未通过本应用发过群消息）');
  }
  const body = {};
  if (effectiveJobid) body.jobid = effectiveJobid;
  if (revokelist) body.revokelist = revokelist;
  return postJson(cfg, token, '/cgi-bin/appchat/revoke', body);
}

// ---------------- 路由子系统：接收渠道 → 发送渠道 ----------------
//
// 把「接收渠道」(local 本地邮箱 / webhook) 收到的消息，按模板渲染后，经「发送渠道」
// (chat 群聊 / user 单聊) 推送出去。配置持久化在 ./routes.json；邮件已读
// 位点持久化在 ./routes.uid.json。
//
// REST 端点（详见 handleWebApi / handleRecv）:
//   GET    /api/routes            列出
//   POST   /api/routes            新建
//   GET    /api/routes/:id        获取单个
//   PUT    /api/routes/:id        更新
//   DELETE /api/routes/:id        删除
//   POST   /api/routes/:id/test   测试（webhook 校验 / local 检查）
// 入站端点:
//   POST   /recv/:routeId[/:code] 外部系统推送（webhook 源）

const ROUTES_FILE = path.resolve(process.cwd(), 'routes.json');
const ROUTES_UID_FILE = path.resolve(process.cwd(), 'routes.uid.json');

let _routesCache = null;
let _uidState = {};
const _emailStop = new Map();   // routeId -> true(应停止)
const _emailRunning = new Set();

function loadRoutes() {
  try {
    const raw = fs.readFileSync(ROUTES_FILE, 'utf8');
    const arr = JSON.parse(raw);
    _routesCache = Array.isArray(arr) ? arr : [];
  } catch (_) {
    _routesCache = [];
  }
  return _routesCache;
}

function saveRoutes(arr) {
  _routesCache = arr;
  try {
    fs.writeFileSync(ROUTES_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    throw new Error('写入 routes.json 失败: ' + e.message);
  }
}

// 读接口对外隐藏密码 / code（用 ****** 占位），真实值仍在文件里
// 注意：空字符串不算「有值」，不脱敏，避免无校验码路由被错误替换成 /******
function maskSecretRoutes(arr) {
  return (arr || []).map((r) => {
    const c = JSON.parse(JSON.stringify(r));
    if (c.source && typeof c.source.password === 'string' && c.source.password !== '') c.source.password = '******';
    if (c.source && typeof c.source.code === 'string' && c.source.code !== '') c.source.code = '******';
    return c;
  });
}

function loadUidState() {
  try { _uidState = JSON.parse(fs.readFileSync(ROUTES_UID_FILE, 'utf8')); }
  catch (_) { _uidState = {}; }
  return _uidState;
}
function saveUidState() {
  try { fs.writeFileSync(ROUTES_UID_FILE, JSON.stringify(_uidState, null, 2), 'utf8'); } catch (_) {}
}

function genId(prefix) {
  return (prefix || 'r') + '_' + crypto.randomBytes(6).toString('hex');
}

function normalizeRoute(r) {
  r = r || {};
  r.enabled = r.enabled !== false;
  r.source = r.source || {};
  r.target = r.target || {};
  if (typeof r.template !== 'string') r.template = '';
  if (!r.name) r.name = '未命名路由';
  if (r.source.type === 'syslog' && (typeof r.source.syslog !== 'object' || r.source.syslog === null)) {
    r.source.syslog = {};
  }
  return r;
}

function validateRoute(r) {
  // 仅允许两种接收源：已生成的本地邮箱账号（local） / webhook 协议
  if (!r.source || !['local', 'webhook', 'syslog'].includes(r.source.type)) {
    return 'source.type 仅支持 local（已生成的邮箱账号）/ webhook / syslog';
  }
  if (!r.target || !['user', 'chat'].includes(r.target.type)) {
    return 'target.type 必须是 user 或 chat';
  }
  if (r.source.type === 'local') {
    const local = String(r.source.local || '').trim();
    if (!local) return 'local 源缺少 local（本地邮件账号）';
    if (!loadMailAccounts().some((a) => a.local === local)) return 'local 账号不存在: ' + local;
  }
  if (r.target.type === 'user') {
    if (!r.target.userid) return 'target.userid 必填';
  } else if (r.target.type === 'chat') {
    if (!r.target.chatid) return 'target.chatid 必填';
  }
  if (r.source.type === 'syslog') {
    const sys = r.source.syslog || {};
    const port = Number(sys.port);
    if (!port || port < 1 || port > 65535) return 'syslog 源缺少合法 port（1-65535）';
    if (sys.protocol && !['udp', 'tcp'].includes(sys.protocol)) return 'syslog protocol 仅支持 udp 或 tcp';
  }
  return null;
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// {{field}} 或 {{a.b}} 占位替换
function renderTemplate(tpl, vars) {
  if (!tpl || !String(tpl).trim()) return '';
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
    let v = vars;
    for (const part of k.split('.')) {
      if (v && typeof v === 'object' && part in v) v = v[part];
      else { v = undefined; break; }
    }
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function flattenVars(obj, prefix) {
  const out = {};
  for (const [k, val] of Object.entries(obj || {})) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(out, flattenVars(val, prefix ? prefix + '.' + k : k));
    } else {
      out[prefix ? prefix + '.' + k : k] = Array.isArray(val) ? JSON.stringify(val) : val;
    }
  }
  return out;
}

// ---------------- syslog 解析（RFC3164 / RFC5424） ----------------
const SEVERITY_NAMES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

// 解析一条 syslog 报文（UDP/TCP 收到的原始字符串），返回扁平字段供模板引用：
//   facility / severity / severityName / host / appname / procid / msgid / message / timestamp / raw
// 兼容 RFC3164(<PRI>Mmm dd HH:MM:SS host tag: msg) 与 RFC5424(<PRI>1 ...)。
// 纯 JS 实现，无外部依赖。
function parseSyslog(raw) {
  const s = String(raw == null ? '' : raw).replace(/\r?\n+$/, '').trim();
  const out = {
    facility: null, severity: null, severityName: '', host: '',
    appname: '', procid: '', msgid: '', message: s, timestamp: '', raw: s,
  };
  if (!s) return out;
  let rest = s;
  const priM = rest.match(/^<(\d+)>/);
  if (priM) {
    const pri = parseInt(priM[1], 10) || 0;
    out.facility = Math.floor(pri / 8);
    out.severity = pri % 8;
    out.severityName = SEVERITY_NAMES[out.severity] || '';
    rest = rest.slice(priM[0].length);
  }
  // RFC5424：<PRI> 后是版本号（数字）+ 空格，例：<134>1 2026-07-09T...
  if (/^\d+\s/.test(rest)) {
    const m = rest.match(/^\d+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]*)$/);
    if (m) {
      out.timestamp = m[1];
      out.host = m[2];
      out.appname = m[3] === '-' ? '' : m[3];
      out.procid = m[4] === '-' ? '' : m[4];
      out.msgid = m[5] === '-' ? '' : m[5];
      let msg = m[6] || '';
      const sdM = msg.match(/^\s*\[[^\]]*\]/); // 结构化数据 [-] 或 [name ...]
      if (sdM) msg = msg.slice(sdM[0].length);
      else if (/^\s*-\s/.test(msg)) msg = msg.replace(/^\s*-\s/, ''); // RFC5424 空 SD 简写 "-"
      out.message = msg.replace(/^\s+/, '');
    }
  } else {
    // RFC3164：<PRI>Timestamp Host App[PID]: Msg
    // 先抽时间戳（BSD "Mmm dd HH:MM:SS[ 时区]" 或 ISO "YYYY-MM-DDTHH:MM:SS"），剩余再分 host/app/msg
    let rest2 = rest;
    const tsBsd = rest.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+[A-Za-z]{2,5})?)\s+([\s\S]*)$/);
    const tsIso = rest.match(/^(\d{4}-\d{2}-\d{2}T[\d:]+Z?)\s+([\s\S]*)$/);
    if (tsBsd) { out.timestamp = tsBsd[1]; rest2 = tsBsd[2]; }
    else if (tsIso) { out.timestamp = tsIso[1]; rest2 = tsIso[2]; }
    const m = rest2.match(/^(\S+)\s+([^\s:]+?)(?:\[(\d+)\])?:\s*([\s\S]*)$/);
    if (m) {
      out.host = m[1];
      out.appname = m[2];
      out.procid = m[3] || '';
      out.message = m[4];
    } else {
      out.message = rest2;
    }
  }
  return out;
}

async function deliverToTarget(target, msgObj, cfg, meta) {
  if (!target) throw new Error('路由未配置 target');
  const token = await getAccessToken(cfg);
  if (target.type === 'user') {
    const touser = splitList(target.userid || target.touser || '');
    if (!touser.length) throw new Error('target.userid 为空');
    return await sendMessage(cfg, token, msgObj, { touser: touser.join('|'), chatId: '', meta });
  } else if (target.type === 'chat') {
    const chatid = String(target.chatid || '').trim();
    if (!chatid) throw new Error('target.chatid 为空');
    return await appchatSend(cfg, token, chatid, msgObj, meta);
  }
  throw new Error('未知 target.type: ' + target.type);
}

// syslog 接收端 socket 生命周期管理（routeId -> { udp, tcp }）
const _syslogSockets = new Map();

// 依据 routes.json（重新）同步所有 enabled 的收集器
function syncRouteEngine(cfg) {
  // 停止旧的 local 收集器
  for (const id of Array.from(_emailStop.keys())) _emailStop.set(id, true);
  // 关闭旧的 syslog 监听（避免端口残留 / 重复监听）
  for (const [id, sock] of _syslogSockets) {
    try { sock.udp && sock.udp.close(); } catch (_) {}
    try { sock.tcp && sock.tcp.close(); } catch (_) {}
    _syslogSockets.delete(id);
  }
  loadRoutes();
  loadUidState();
  let localN = 0, syslogN = 0;
  const syslogPorts = new Set();
  for (const r of _routesCache) {
    if (!r.enabled || !r.source) continue;
    if (r.source.type === 'local') {
      runLocalMailCollector(r, cfg); localN++;
    } else if (r.source.type === 'syslog') {
      const port = Number((r.source.syslog && r.source.syslog.port) || 0);
      if (!port || syslogPorts.has(port)) {
        console.error(`[syslog] 路由 ${r.id} 端口 ${port} 非法或与其他 syslog 路由冲突，跳过`);
        continue;
      }
      syslogPorts.add(port);
      try { runSyslogCollector(r, cfg); syslogN++; }
      catch (e) { console.error(`[syslog] 路由 ${r.id} 启动失败:`, e.message); }
    }
  }
  console.log(`[routes] 已同步：启动 ${localN + syslogN} 个收集器（local ${localN} + syslog ${syslogN}），共 ${_routesCache.length} 条路由`);
}

// 启动单条 syslog 路由的 UDP/TCP 监听，收到报文后解析 → 模板渲染 → 投递到发送渠道
function runSyslogCollector(route, cfg) {
  const id = route.id;
  const sys = route.source.syslog || {};
  const port = Number(sys.port);
  const protocol = sys.protocol === 'tcp' ? 'tcp' : 'udp';
  const bind = '0.0.0.0';

  function defaultSyslogText(v) {
    const sev = v.severityName ? `[${v.severityName}] ` : '';
    const src = [v.host, v.appname].filter(Boolean).join(' ');
    const prefix = src ? `${src}: ` : '';
    return (`${sev}${prefix}${v.message || ''}`).trim() || v.raw || '(空消息)';
  }

  function handleMessage(rawStr, rinfo) {
    const vars = parseSyslog(rawStr);
    if (rinfo && rinfo.address) vars._srcIp = rinfo.address;
    vars._raw = rawStr;
    let recvText;
    if (route.template && String(route.template).trim()) {
      recvText = renderTemplate(route.template, vars) || defaultSyslogText(vars);
    } else {
      recvText = defaultSyslogText(vars);
    }
    const msgObj = buildMessage('text', recvText);
    recordRecv({
      routeId: id,
      sourceType: 'syslog',
      account: null,
      fromAddr: vars.host || (rinfo && rinfo.address) || null,
      subject: null,
      body: recvText,
      raw: rawStr,
    });
    deliverToTarget(route.target, msgObj, cfg, { sourceType: 'route', routeId: id, routeName: route.name })
      .catch((e) => console.error(`[syslog:${route.name}] 投递失败:`, e.message));
  }

  if (protocol === 'tcp') {
    const net = require('net');
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) handleMessage(line, { address: socket.remoteAddress });
        }
      });
      socket.on('error', () => {});
    });
    server.on('error', (e) => console.error(`[syslog:${route.name}] TCP 错误:`, e.message));
    server.listen(port, bind, () => {
      console.log(`[syslog:${route.name}] TCP 监听 0.0.0.0:${port}`);
    });
    _syslogSockets.set(id, { udp: null, tcp: server });
  } else {
    const dgram = require('dgram');
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try { handleMessage(msg.toString('utf8'), rinfo); }
      catch (e) { console.error(`[syslog:${route.name}] 处理失败:`, e.message); }
    });
    sock.on('error', (e) => console.error(`[syslog:${route.name}] UDP 错误:`, e.message));
    sock.bind(port, bind, () => {
      console.log(`[syslog:${route.name}] UDP 监听 0.0.0.0:${port}`);
    });
    _syslogSockets.set(id, { udp: sock, tcp: null });
  }
}

// 测试：邮件连通性 / webhook 配置校验
async function testRoute(route, cfg) {
  const s = route.source || {};
  if (s.type === 'local') {
    return {
      type: 'local', ok: true, account: s.local,
      example: `发信到 ${s.local}@${cfg.WECOM_MAIL_DOMAIN || 'wecom-mail.local'} 即可触发路由`,
    };
  } else if (s.type === 'webhook') {
    return { type: 'webhook', ok: true };
  } else if (s.type === 'syslog') {
    const sys = s.syslog || {};
    const port = Number(sys.port);
    const proto = sys.protocol === 'tcp' ? 'tcp' : 'udp';
    return {
      type: 'syslog', ok: true, port, protocol: proto,
      example: `向 ${proto}://<本机IP>:${port} 发送 syslog 即可触发路由（如 logger -n <host> -P ${port} "测试消息"）`,
    };
  }
  throw new Error('未知 source.type');
}

// ---------------- 本地内置邮件账号 + SMTP 接收 ----------------
// 让网页能「生成邮箱账号」：账号地址形如 <local>@<WECOM_MAIL_DOMAIN>，
// 工具内置 SMTP 服务接收发往这些地址的邮件，统一写入 recv.db（见下方“接收记录持久化”），
// 再由 local 路由源读取并推送到企业微信（群聊/单聊）。
const MAIL_DIR = path.resolve(process.cwd(), 'mail');

function mailAccountDir(local) {
  const safe = String(local).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(MAIL_DIR, safe);
}
function loadMailAccounts() {
  try { return JSON.parse(fs.readFileSync(path.join(MAIL_DIR, 'accounts.json'), 'utf8')) || []; }
  catch (_) { return []; }
}
function saveMailAccounts(arr) {
  try { fs.mkdirSync(MAIL_DIR, { recursive: true }); } catch (_) {}
  fs.writeFileSync(path.join(MAIL_DIR, 'accounts.json'), JSON.stringify(arr, null, 2), 'utf8');
}
function genLocalPart() {
  const adj = ['alert', 'ops', 'dev', 'sec', 'mail', 'notice', 'sys', 'log', 'team', 'bot', 'support', 'hr'];
  let base;
  do { base = adj[Math.floor(Math.random() * adj.length)] + Math.floor(Math.random() * 9000 + 1000); }
  while (loadMailAccounts().some((a) => a.local === base));
  return base;
}
function genPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

// ---------------- 接收记录持久化（SQLite，保留 24h） ----------------
// 接收到的邮件 / webhook 消息统一写入 recv.db（二进制库文件），不写任何文本文件。
// 超过 24 小时的记录由后台定时器清理，避免长期占用存储。
// 注意：数据库路径锚定到“脚本所在目录”，而非 process.cwd()。
// 否则用 pm2 / systemd / 绝对路径从非项目目录启动时，cwd 指向别处，会在错误位置
// 新建一个空 recv.db，表现为“消息能发但发送记录查不到”。
const RECV_DB_FILE = process.env.WECOM_RECV_DB_FILE
  ? path.resolve(process.env.WECOM_RECV_DB_FILE)
  : path.resolve(__dirname, 'recv.db');
const RECV_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 小时
let _recvDb = null;
let _recvDbError = '';
let _recvPurgeTimer = null;

function initRecvDb() {
  if (_recvDb) return _recvDb;
  if (!SqliteDb) {
    const hint = 'better-sqlite3 未安装或加载失败：请在部署机项目目录执行 `npm install better-sqlite3`（需与原平台/Node 版本一致，勿跨机器复制 node_modules）';
    console.error('[recv] ' + hint);
    _recvDbError = hint;
    return null;
  }
  try {
    // 自动创建父目录，避免“目录不存在”导致打开失败
    const dir = path.dirname(RECV_DB_FILE);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* 已存在或无权创建时交给下方打开逻辑报错 */ }
    _recvDb = new SqliteDb(RECV_DB_FILE);
    _recvDb.pragma('journal_mode = WAL');
    // 启用增量收缩：auto_vacuum 只能对空库直接生效，已有表的库需先 VACUUM 一次使设置写入文件头。
    // 设成 INCREMENTAL 后，purge 删除旧记录再 incremental_vacuum 才能让 .db 文件真正变小，避免无限增长。
    // 首次启动（或升级后）auto_vacuum 仍是 NONE(0) 时执行一次 VACUUM；之后为 INCREMENTAL(2) 即跳过。
    try {
      const avRow = _recvDb.pragma('auto_vacuum');
      const av = Array.isArray(avRow) ? (avRow[0] && avRow[0].auto_vacuum) : avRow;
      if (av !== 2) {
        _recvDb.pragma('auto_vacuum = INCREMENTAL');
        _recvDb.exec('VACUUM'); // 让 auto_vacuum 设置对已有表生效（一次性，开销可接受）
      }
    } catch (e) {
      // VACUUM/设置失败不应阻断 DB 初始化（最坏情况：文件不自动收缩，业务照常）
      console.error('[recv] 初始化 auto_vacuum 失败（不影响收发，仅文件可能不自动收缩）:', e.message);
    }
    console.log('[recv] 已打开数据库:', RECV_DB_FILE);
    _recvDb.exec(`CREATE TABLE IF NOT EXISTS recv_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id    TEXT,
      source_type TEXT    NOT NULL,
      account     TEXT,
      from_addr   TEXT,
      subject     TEXT,
      body        TEXT,
      raw         TEXT,
      received_at INTEGER NOT NULL,
      delivered   INTEGER NOT NULL DEFAULT 0
    )`);
    // 发送记录：每次通过 appchat/send 或 message/send 外发都落库，便于按时间回溯
    // （源方式 / 目的方式 / 内容 / jobid / 状态）。jobid 来自 appchat/send 返回。
    _recvDb.exec(`CREATE TABLE IF NOT EXISTS send_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at     INTEGER NOT NULL,
      source_type TEXT    NOT NULL,
      route_id    TEXT,
      target_type TEXT    NOT NULL,
      target_id   TEXT,
      msgtype     TEXT,
      content     TEXT,
      jobid       TEXT,
      errcode     INTEGER,
      errmsg      TEXT,
      success     INTEGER NOT NULL DEFAULT 1
    )`);
    // 为按时间范围清理/查询的字段建索引，避免每 10 分钟一次 DELETE 扫描全表（数据量大时尤其明显）
    _recvDb.exec('CREATE INDEX IF NOT EXISTS idx_recv_messages_received_at ON recv_messages(received_at)');
    _recvDb.exec('CREATE INDEX IF NOT EXISTS idx_send_log_sent_at ON send_log(sent_at)');
    startRecvPurge();
    _recvDbError = '';
  } catch (e) {
    console.error('[recv] 初始化失败:', e.message);
    _recvDbError = e.message;
    _recvDb = null;
  }
  return _recvDb;
}

// 写入一条接收记录，返回自增 id（失败返回 null）
function recordRecv(opts) {
  const db = initRecvDb();
  if (!db) return null;
  const o = opts || {};
  try {
    const info = db.prepare(
      `INSERT INTO recv_messages
         (route_id, source_type, account, from_addr, subject, body, raw, received_at, delivered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      o.routeId || null,
      o.sourceType || 'unknown',
      o.account || null,
      o.fromAddr || null,
      o.subject || null,
      o.body || null,
      o.raw != null ? String(o.raw) : null,
      Date.now()
    );
    return info.lastInsertRowid;
  } catch (e) {
    console.error('[recv] 写入失败:', e.message);
    return null;
  }
}

// 取某本地邮箱账号尚未投递的邮件（按 id 升序）
function getPendingLocalMail(local) {
  const db = initRecvDb();
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT * FROM recv_messages WHERE source_type='email' AND account=? AND delivered=0 ORDER BY id ASC`
    ).all(local);
  } catch (e) {
    console.error('[recv] 查询待投递失败:', e.message);
    return [];
  }
}

// 标记一批记录为已投递（避免重复推送）
function markDelivered(ids) {
  const db = initRecvDb();
  if (!db || !ids || !ids.length) return;
  try {
    const stmt = db.prepare('UPDATE recv_messages SET delivered=1 WHERE id=?');
    const tx = db.transaction((arr) => { for (const id of arr) stmt.run(id); });
    tx(ids);
  } catch (e) {
    console.error('[recv] 标记已投递失败:', e.message);
  }
}

// 清理超过 24 小时的记录
function purgeOldRecv() {
  const db = initRecvDb();
  if (!db) return;
  const cutoff = Date.now() - RECV_RETENTION_MS;
  try {
    const info = db.prepare('DELETE FROM recv_messages WHERE received_at < ?').run(cutoff);
    if (info.changes > 0) console.log(`[recv] 已清理 ${info.changes} 条超过 24h 的接收记录`);
  } catch (e) {
    console.error('[recv] 清理失败:', e.message);
  }
  // 发送记录保留更久（90 天），仅做体积保护，不频繁清理
  const sendCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  try {
    const info2 = db.prepare('DELETE FROM send_log WHERE sent_at < ?').run(sendCutoff);
    if (info2.changes > 0) console.log(`[send] 已清理 ${info2.changes} 条超过 90d 的发送记录`);
  } catch (e) {
    console.error('[send] 清理失败:', e.message);
  }
  // auto_vacuum=INCREMENTAL 下，DELETE 仅把页移入 freelist 而不归还 OS；
  // 此处增量回收空闲页，让 .db 文件体积真正回落（防无限增长）
  try {
    db.pragma('incremental_vacuum');
  } catch (e) {
    console.error('[recv] 增量回收失败:', e.message);
  }
}

function startRecvPurge() {
  if (_recvPurgeTimer) return;
  purgeOldRecv();
  _recvPurgeTimer = setInterval(purgeOldRecv, 10 * 60 * 1000); // 每 10 分钟扫描一次
  if (_recvPurgeTimer && _recvPurgeTimer.unref) _recvPurgeTimer.unref();
}

// 从消息对象里抽一条可读的内容摘要（落库用）
function extractContent(msgObj) {
  if (!msgObj || typeof msgObj !== 'object') return '';
  const t = msgObj.msgtype;
  try {
    if (t === 'text' && msgObj.text) return String(msgObj.text.content || '');
    if (t === 'markdown' && msgObj.markdown) return String(msgObj.markdown.content || '');
    if (t === 'news' && msgObj.news && Array.isArray(msgObj.news.articles)) {
      return msgObj.news.articles.map((a) => a.title || '').join(' | ');
    }
    if (t === 'mpnews' && msgObj.mpnews && Array.isArray(msgObj.mpnews.articles)) {
      return msgObj.mpnews.articles.map((a) => a.title || '').join(' | ');
    }
    // 其它类型：序列化关键字段
    return JSON.stringify(msgObj).slice(0, 500);
  } catch (e) {
    return '';
  }
}

// 判断 body 是否为标准企微消息结构（webhook 透传时自动「只发 content 部分」）
function looksLikeWecomMessage(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const t = b.msgtype;
  if (t === 'text') return !!(b.text && typeof b.text.content === 'string');
  if (t === 'markdown') return !!(b.markdown && typeof b.markdown.content === 'string');
  if (t === 'textcard') return !!(b.textcard && typeof b.textcard.description === 'string');
  if (t === 'news' || t === 'mpnews') return !!(b[t] && Array.isArray(b[t].articles) && b[t].articles.length > 0);
  if (['image', 'voice', 'file', 'video'].includes(t)) return !!b[t];
  return false;
}

// 写入一条发送记录（失败不影响主流程）
function recordSend(o) {
  const db = initRecvDb();
  if (!db) return null;
  const x = o || {};
  try {
    const info = db.prepare(
      `INSERT INTO send_log
         (sent_at, source_type, route_id, target_type, target_id, msgtype, content, jobid, errcode, errmsg, success)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      Date.now(),
      x.sourceType || 'unknown',
      x.routeId || null,
      x.targetType || 'unknown',
      x.targetId != null ? String(x.targetId) : null,
      x.msgtype || null,
      x.content != null ? String(x.content) : null,
      x.jobid != null ? String(x.jobid) : null,
      x.errcode != null ? Number(x.errcode) : null,
      x.errmsg != null ? String(x.errmsg) : null,
      x.success ? 1 : 0
    );
    return info.lastInsertRowid;
  } catch (e) {
    console.error('[send] 写入记录失败:', e.message);
    return null;
  }
}

// 按时间范围查询发送记录（降序）
function querySendLog({ fromMs, toMs, limit } = {}) {
  const db = initRecvDb();
  if (!db) return [];
  const where = [];
  const params = [];
  if (fromMs != null) { where.push('sent_at >= ?'); params.push(fromMs); }
  if (toMs != null) { where.push('sent_at <= ?'); params.push(toMs); }
  const sql = `SELECT * FROM send_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY sent_at DESC LIMIT ?`;
  params.push(Number(limit) || 200);
  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    console.error('[send] 查询记录失败:', e.message);
    return [];
  }
}

// 取某个群（target_type='chat' 且 target_id=chatid）最近一次成功发送返回的 jobid
function latestJobIdForChat(chatid) {
  const db = initRecvDb();
  if (!db) return null;
  try {
    const row = db.prepare(
      `SELECT jobid FROM send_log WHERE target_type='chat' AND target_id=? AND success=1 AND jobid IS NOT NULL ORDER BY sent_at DESC LIMIT 1`
    ).get(chatid);
    return row && row.jobid ? row.jobid : null;
  } catch (e) {
    console.error('[send] 查 jobid 失败:', e.message);
    return null;
  }
}

// 兼容旧调用：storeMail(local, vars) → 写入一条 email 类型接收记录
function storeMail(local, data) {
  const d = data || {};
  return recordRecv({
    routeId: null,
    sourceType: 'email',
    account: local,
    fromAddr: d.from || null,
    subject: d.subject || null,
    body: d.body || null,
    raw: JSON.stringify(d),
  });
}
// 兼容旧调用：readPendingMail → 取待投递的本地邮件
function readPendingMail(local /* , afterUid */) {
  return getPendingLocalMail(local);
}
// 兼容旧调用：deleteMail → 已通过 markDelivered 统一处理；保留空实现以免旧调用报错
function deleteMail(local /* , uid */) { /* no-op */ }

function runSmtpServer(cfg) {
  if (!SMTPServer) { console.error('[mail] smtp-server 未安装，本地邮件账号不可用（npm i smtp-server）'); return; }
  if (!simpleParser) { console.error('[mail] mailparser 未安装，无法解析邮件'); return; }
  const domain = String(cfg.WECOM_MAIL_DOMAIN || 'wecom-mail.local').toLowerCase();
  const port = Number(cfg.WECOM_MAIL_SMTP_PORT || 2525);
  const server = new SMTPServer({
    secure: false,
    hideSize: true,
    // 启用 SMTP 认证（AUTH）：允许外部系统用「本系统生成的邮箱账号」做登录发信。
    // 保留 STARTTLS 禁用（内网明文即可）；allowInsecureAuth 允许在非 TLS 连接上做 AUTH；
    // authMethods 仅留 LOGIN/PLAIN，便于服务端用明文密码比对。
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['LOGIN', 'PLAIN'],
    onConnect(session, cb) { cb(); },
    onAuth(authOptions, session, cb) {
      const user = String((authOptions && authOptions.username) || '').trim();
      const pass = String((authOptions && authOptions.password) || '');
      // 用户名支持「完整地址」或「仅 local 部分」
      const local = user.includes('@') ? user.split('@')[0].toLowerCase() : user.toLowerCase();
      const acc = loadMailAccounts().find((a) => a.local.toLowerCase() === local);
      if (acc && acc.password && acc.password === pass) {
        return cb(null, { user: acc.local });
      }
      return cb(new Error('Authentication failed'));
    },
    onMailFrom(address, session, cb) { cb(); },
    onRcptTo(address, session, cb) {
      const m = /^(.+?)@(.+?)$/.exec((address.address || '').trim());
      const rcptDomain = m ? m[2].toLowerCase() : '';
      const rcptLocal = m ? m[1].toLowerCase() : '';
      if (rcptDomain !== domain) return cb(new Error('550 本服务器只接收域名 ' + domain + ' 的邮件'));
      if (!loadMailAccounts().some((a) => a.local.toLowerCase() === rcptLocal)) {
        return cb(new Error('550 收件人不存在: ' + address.address));
      }
      cb();
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks);
        simpleParser(raw).then((parsed) => {
          const fromObj = (parsed.from && parsed.from.value && parsed.from.value[0]) || null;
          const fromStr = fromObj ? `${fromObj.name || ''} <${fromObj.address || ''}>`.trim()
            : (parsed.from ? parsed.from.text : '');
          const toStr = (parsed.to && parsed.to.value && parsed.to.value.length)
            ? parsed.to.value.map((x) => x.address).join(', ') : (parsed.to ? parsed.to.text : '');
          const vars = {
            from: fromStr,
            to: toStr,
            subject: parsed.subject || '',
            date: parsed.date ? new Date(parsed.date).toISOString() : '',
            text: parsed.text || '',
            html: parsed.html || '',
            body: parsed.text || stripHtml(parsed.html) || '',
            messageId: parsed.messageId || '',
          };
          for (const rcpt of (session.envelope && session.envelope.rcptTo) || []) {
            const m = /^(.+?)@(.+?)$/.exec((rcpt.address || '').trim());
            const local = m ? m[1].toLowerCase() : null;
            if (!local) continue;
            try {
              const uid = storeMail(local, vars);
              console.log(`[mail] 收到邮件 -> ${local}@${domain} uid=${uid} 主题=${(parsed.subject || '').slice(0, 40)}`);
            } catch (e) {
              console.error(`[mail] 存储失败 ${local}: ${e.message}`);
            }
          }
          cb(null, 'message stored');
        }).catch((err) => {
          console.error('[mail] 解析邮件失败:', err.message);
          cb(err);
        });
      });
      stream.on('error', (err) => {
        console.error('[mail] 数据流错误:', err.message);
        cb(err);
      });
    },
  });
  server.on('error', (e) => console.error('[mail] SMTP 错误:', e.message));
  server.listen(port, '0.0.0.0', () => {
    console.log(`[mail] 本地 SMTP 服务已启动 0.0.0.0:${port} (域名 ${domain})`);
  });
}

// local 路由源收集器：轮询 SQLite 中该账号待投递的邮件并推送到企微
async function runLocalMailCollector(route, cfg) {
  const id = route.id;
  const local = String((route.source && route.source.local) || '').toLowerCase();
  if (!local) { console.error(`[route:${route.name}] local 源缺少 local 账号`); return; }
  _emailStop.set(id, false);
  _emailRunning.add(id);
  console.log(`[route:${route.name}] 本地邮件收集器启动 (账号 ${local})`);
  while (true) {
    if (_emailStop.get(id)) break;
    const deliveredIds = [];
    try {
      const pending = readPendingMail(local);
      for (const row of pending) {
        if (_emailStop.get(id)) break;
        const vars = {
          from: row.from_addr || '', to: '', subject: row.subject || '',
          date: new Date(row.received_at).toISOString(), text: row.body || '', html: '',
          body: row.body || '', messageId: '',
        };
        const text = renderTemplate(route.template, vars)
          || `📧 新邮件\n来自: ${vars.from}\n主题: ${vars.subject}\n\n${vars.body}`;
        try {
          await deliverToTarget(route.target, buildMessage('text', text), cfg, { sourceType: 'route', routeId: route.id, routeName: route.name });
          console.log(`[route:${route.name}] 已推送本地邮件 id=${row.id} -> ${route.target.type}:${route.target.type === 'chat' ? route.target.chatid : route.target.userid}`);
          deliveredIds.push(row.id);
        } catch (e) {
          console.error(`[route:${route.name}] 推送失败 id=${row.id}: ${e.message}`);
        }
      }
      if (deliveredIds.length) markDelivered(deliveredIds);
    } catch (e) {
      console.error(`[route:${route.name}] 本地邮件轮询异常: ${e.message}`);
    }
    const interval = Math.max(2, Number((route.source && route.source.pollInterval)) || 5);
    for (let i = 0; i < interval; i++) {
      if (_emailStop.get(id)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  _emailRunning.delete(id);
  _emailStop.delete(id);
  console.log(`[route:${route.name}] 本地邮件收集器已停止`);
}

// ---------------- web 子命令：API + 静态页面 ----------------
//
// 仅复用现有凭证与业务函数，不重复实现 access_token / 消息构造。
//
// REST 端点:
//   GET  /api/healthz                  存活探针
//   GET  /api/chats/:chatid            查询群详情
//   POST /api/chats                    创建群（拉群）
//   PATCH /api/chats/:chatid           改群信息 / 增删成员（含拉人/踢人）
//   GET  /api/chats                    列出本应用可见的群（部分私有化版本不支持）
//   POST /api/chats/:chatid/messages   发送群消息
//   POST /api/chats/:chatid/dismiss    解散群聊
//   POST /api/chats/:chatid/revoke     撤回群消息（可带 jobid，或自动取该群最近一次群发的 jobid）
//   GET  /api/send-log                 查询发送记录（需 X-Admin-Token；支持 from / to 时间戳与 limit）
//
// 所有写操作要求 header X-Admin-Token: <WECOM_WEBHOOK_TOKEN>

const fs = require('fs');
const url = require('url');

function jsonRes(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return readBody(req, maxBytes).then((raw) => {
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch (e) {
      const err = new Error('invalid JSON body');
      err.status = 400;
      throw err;
    }
  });
}

function requireAdmin(req, res, adminToken) {
  const t = req.headers['x-admin-token'];
  if (!adminToken) {
    jsonRes(res, 500, { errcode: 500, errmsg: 'admin token not configured' });
    return false;
  }
  if (t !== adminToken) {
    jsonRes(res, 401, { errcode: 401, errmsg: 'invalid token' });
    return false;
  }
  return true;
}

// chatid 规则：实测私有化企业微信仅接受纯字母数字（不含下划线）、长度 1-32
// 上游 `errcode=86001 contain invalid char` 的触发条件是含 `_` / `-` / 空格 / 中文等
const CHATID_RE = /^[A-Za-z0-9]{1,32}$/;
function validateChatid(chatid) {
  if (!chatid) return 'chatid 不能为空';
  if (typeof chatid !== 'string') return 'chatid 必须为字符串';
  if (!CHATID_RE.test(chatid)) {
    return 'chatid 不合法：仅允许字母/数字（不能含 -、_、空格、中文等），长度 1-32';
  }
  return null;
}
function rejectInvalidChatid(res, chatid) {
  const err = validateChatid(chatid);
  if (err) {
    jsonRes(res, 400, { errcode: 400, errmsg: err });
    return true;
  }
  return false;
}

function serveStatic(req, res, webRoot) {
  const urlObj = url.parse(req.url);
  let pathname = decodeURIComponent(urlObj.pathname || '/');
  if (pathname === '/') pathname = '/index.html';
  // 防路径遍历
  const resolved = path.resolve(webRoot, '.' + pathname);
  if (!resolved.startsWith(path.resolve(webRoot))) {
    jsonRes(res, 403, { errcode: 403, errmsg: 'forbidden' });
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    return false;
  }
  if (stat.isDirectory()) {
    const idx = path.join(resolved, 'index.html');
    try {
      fs.statSync(idx);
      return serveFile(res, idx);
    } catch (_) {
      return false;
    }
  }
  return serveFile(res, resolved);
}

function serveFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
  };
  const ctype = types[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function handleWebApi(req, res, ctx) {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const m = req.method;

  // 存活
  if (m === 'GET' && (p === '/api/healthz' || p === '/api/healthz/')) {
    return jsonRes(res, 200, { ok: true });
  }

  // 前端取 webhook 接收基址（用于展示/复制完整接收地址，无需鉴权）
  if (m === 'GET' && (p === '/api/config' || p === '/api/config/')) {
    let base = ctx.cfg.webhookRecvBase || '';
    if (!base) {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
      const hostHeader = String(req.headers.host || '');
      const host = hostHeader.split(':')[0] || 'localhost';
      base = `${proto}://${host}:${ctx.cfg.webhookRecvPort || 8787}`;
    }
    return jsonRes(res, 200, { errcode: 0, webhookRecvBase: base, webhookRecvPort: ctx.cfg.webhookRecvPort || 8787 });
  }

  // 判断来源是否为本机或内网私有地址（用于放行 /api/admin/token）
  const isLanAddress = (ip) => {
    if (!ip) return true; // 空（Unix socket 等）视为本机
    ip = ip.replace(/^::ffff:/, ''); // IPv4-mapped IPv6
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (m) {
      const a = +m[1], b = +m[2];
      if (a === 10) return true;                       // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true;         // 192.168.0.0/16
      if (a === 169 && b === 254) return true;         // 169.254.0.0/16
      if (a === 127) return true;                      // 127.0.0.0/8
      return false;
    }
    // IPv6 唯一本地 / 链路本地
    return /^fc|^fd|^fe[89ab]/.test(ip) || ip === '::1';
  };

  // 特例: 首次引导，浏览器在拿到 token 之前需要先拿到 token
  // 安全策略: 仅允许本机 / 内网私有地址访问 (127.0.0.1 / ::1 / 192.168.x / 10.x / 172.16-31.x / 169.254.x)
  // 即「内网范围」可用；若需公网暴露，请在前置 nginx 限制来源 IP 或关闭该端点
  if (m === 'GET' && (p === '/api/admin/token' || p === '/api/admin/token/')) {
    const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const allowed = isLanAddress(remote);
    if (!allowed) {
      return jsonRes(res, 403, { errcode: 403, errmsg: 'admin token 仅允许本机或内网地址获取（如从公网访问请在网页输入框粘贴 WECOM_WEBHOOK_TOKEN）' });
    }
    if (!ctx.adminToken) {
      return jsonRes(res, 500, { errcode: 500, errmsg: 'admin token 未配置' });
    }
    return jsonRes(res, 200, { ok: true, token: ctx.adminToken });
  }

  // 写操作要求鉴权
  if (m !== 'GET' && !requireAdmin(req, res, ctx.adminToken)) return;

  // 路由: POST /api/chats                  拉群
  //       PATCH /api/chats/:chatid         改群
  //       GET  /api/chats/:chatid          查群
  //       GET  /api/chats                  列群
  //       POST /api/chats/:chatid/messages 发群消息
  if (m === 'POST' && (p === '/api/chats' || p === '/api/chats/')) {
    const body = await readJsonBody(req).catch((e) => {
      jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message });
      return null;
    });
    if (!body) return;
    const chatid = String(body.chatid || body.chat_id || '').trim();
    const name = String(body.name || '').trim();
    const owner = String(body.owner || '').trim();
    const rawMembers = splitList(body.members || body.userlist || body.user_list || []);
    // 把 owner 合并到 userlist（如未在 members 中）
    const userlist = rawMembers.includes(owner) ? rawMembers : [owner, ...rawMembers];
    if (!chatid || !name || !owner) {
      return jsonRes(res, 400, { errcode: 400, errmsg: 'chatid / name / owner 必填' });
    }
    if (rejectInvalidChatid(res, chatid)) return;
    if (userlist.length < 2) {
      return jsonRes(res, 400, { errcode: 400, errmsg: '群至少需要 2 人（owner + 至少 1 名其他成员）；当前 members=' + rawMembers.length });
    }
    try {
      const token = await getAccessToken(ctx.cfg);
      const result = await postJson(ctx.cfg, token, '/cgi-bin/appchat/create', {
        chatid, name, owner, userlist,
      });
      return jsonRes(res, 200, { errcode: 0, ...result });
    } catch (e) {
      const m2 = /errcode=(\d+)/.exec(e.message);
      return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: e.message });
    }
  }

  // /api/chats/:chatid(/messages)?
  const reChat = /^\/api\/chats\/([^\/]+)\/?$/;
  const reMsg = /^\/api\/chats\/([^\/]+)\/messages\/?$/;
  let chatid = '';
  if (reChat.test(p)) chatid = decodeURIComponent(reChat.exec(p)[1]);
  if (reMsg.test(p)) chatid = decodeURIComponent(reMsg.exec(p)[1]);

  if (chatid && m === 'GET' && reChat.test(p)) {
    if (rejectInvalidChatid(res, chatid)) return;
    try {
      const token = await getAccessToken(ctx.cfg);
      const result = await getJson(ctx.cfg, token, `/cgi-bin/appchat/get?chatid=${encodeURIComponent(chatid)}`);
      return jsonRes(res, 200, { errcode: 0, ...result });
    } catch (e) {
      const m2 = /errcode=(\d+)/.exec(e.message);
      return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: e.message });
    }
  }

  if (chatid && m === 'PATCH' && reChat.test(p)) {
    if (rejectInvalidChatid(res, chatid)) return;
    const body = await readJsonBody(req).catch((e) => {
      jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message });
      return null;
    });
    if (!body) return;
    const patch = { chatid };
    if (body.name) patch.name = String(body.name).trim();
    if (body.owner) patch.owner = String(body.owner).trim();
    const add = splitList(body.add || body.add_user_list || body.add_user || []);
    const del = splitList(body.del || body.del_user_list || body.del_user || []);
    if (add.length) patch.add_user_list = add;
    if (del.length) patch.del_user_list = del;
    if (Object.keys(patch).length === 1) {
      return jsonRes(res, 400, { errcode: 400, errmsg: '至少需要 name / owner / add / del 之一' });
    }
    try {
      const token = await getAccessToken(ctx.cfg);
      const result = await postJson(ctx.cfg, token, '/cgi-bin/appchat/update', patch);
      return jsonRes(res, 200, { errcode: 0, ...result });
    } catch (e) {
      const m2 = /errcode=(\d+)/.exec(e.message);
      return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: e.message });
    }
  }

  if (chatid && m === 'POST' && reMsg.test(p)) {
    if (rejectInvalidChatid(res, chatid)) return;
    const body = await readJsonBody(req).catch((e) => {
      jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message });
      return null;
    });
    if (!body) return;
    const type = String(body.type || body.msgtype || 'text').toLowerCase();
    const content = body.content !== undefined ? String(body.content) : undefined;
    const payload = body.payload !== undefined ? body.payload : null;
    let msgObj;
    try {
      msgObj = buildMessage(type, content, payload);
    } catch (e) {
      return jsonRes(res, 400, { errcode: 400, errmsg: e.message });
    }
    try {
      const token = await getAccessToken(ctx.cfg);

      // 先确认群是否存在：appchat/send 在群不存在时错误信息不直观，
      // 先查一次 appchat/get，群不存在时直接给出准确的错误，不做任何兜底。
      try {
        await getJson(ctx.cfg, token, `/cgi-bin/appchat/get?chatid=${encodeURIComponent(chatid)}`);
      } catch (getErr) {
        const m2 = /errcode=(\d+)/.exec(getErr.message);
        return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: getErr.message });
      }

      // 私有化部署群发专用通道：/cgi-bin/appchat/send（以应用身份推送到群聊会话），
      // 与 appchat/create / appchat/get 同套凭证，不再使用会报 82001 的 message/send+chatid。
      const result = await appchatSend(ctx.cfg, token, chatid, msgObj, { sourceType: 'web' });
      return jsonRes(res, 200, { errcode: 0, channel: 'chat', ...result });
    } catch (e) {
      const m2 = /errcode=(\d+)/.exec(e.message);
      return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: e.message });
    }
  }

  // 解散群聊：POST /api/chats/:chatid/dismiss  →  appchat/dismiss
  const reDismiss = /^\/api\/chats\/([^\/]+)\/dismiss\/?$/;
  if (m === 'POST' && reDismiss.test(p)) {
    const cid = decodeURIComponent(reDismiss.exec(p)[1]);
    if (rejectInvalidChatid(res, cid)) return;
    try {
      const token = await getAccessToken(ctx.cfg);
      const result = await postJson(ctx.cfg, token, '/cgi-bin/appchat/dismiss', { chatid: cid });
      return jsonRes(res, 200, { errcode: 0, ...result });
    } catch (e) {
      const m2 = /errcode=(\d+)/.exec(e.message);
      return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: e.message });
    }
  }

  // 撤回群消息：POST /api/chats/:chatid/revoke  →  appchat/revoke
  // body 可带 jobid / revokelist；都不带时自动从发送记录库取该群最近一次 jobid。
  const reRevoke = /^\/api\/chats\/([^\/]+)\/revoke\/?$/;
  if (m === 'POST' && reRevoke.test(p)) {
    const cid = decodeURIComponent(reRevoke.exec(p)[1]);
    if (rejectInvalidChatid(res, cid)) return;
    const body = await readJsonBody(req).catch((e) => {
      jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message });
      return null;
    });
    if (!body) return;
    let revokelist = null;
    if (body.revokelist) {
      if (!Array.isArray(body.revokelist)) {
        return jsonRes(res, 400, { errcode: 400, errmsg: 'revokelist 必须是数组' });
      }
      revokelist = body.revokelist;
    }
    const jobid = (body.jobid || '').toString().trim() || latestJobIdForChat(cid);
    if (!jobid && !revokelist) {
      return jsonRes(res, 400, { errcode: 400, errmsg: '未提供 jobid，且发送记录库中也无该群最近一次群发的 jobid（可能从未通过本应用发过群消息）' });
    }
    try {
      const token = await getAccessToken(ctx.cfg);
      const b = {};
      if (jobid) b.jobid = jobid;
      if (revokelist) b.revokelist = revokelist;
      const result = await postJson(ctx.cfg, token, '/cgi-bin/appchat/revoke', b);
      return jsonRes(res, 200, { errcode: 0, ...result });
    } catch (e) {
      const m2 = /errcode=(\d+)/.exec(e.message);
      return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: e.message });
    }
  }

  // 发送记录查询（含敏感内容 / jobid，需鉴权；GET 默认不要求 admin，这里显式拦截）
  if (p === '/api/send-log' || p === '/api/send-log/') {
    if (!requireAdmin(req, res, ctx.adminToken)) return;
    const urlObj = url.parse(req.url, true);
    const q = urlObj.query || {};
    let fromMs = null, toMs = null;
    if (q.from) { const n = Number(q.from); if (!isNaN(n)) fromMs = n; }
    if (q.to) { const n = Number(q.to); if (!isNaN(n)) toMs = n; }
    const rows = querySendLog({ fromMs, toMs, limit: Number(q.limit) || 500 });
    return jsonRes(res, 200, {
      errcode: 0,
      total: rows.length,
      logs: rows,
      _db: { file: RECV_DB_FILE, connected: !!_recvDb, error: _recvDb ? '' : _recvDbError },
    });
  }

  if (m === 'GET' && (p === '/api/chats' || p === '/api/chats/')) {
    try {
      const token = await getAccessToken(ctx.cfg);
      const result = await postJson(ctx.cfg, token, '/cgi-bin/appchat/list', {});
      return jsonRes(res, 200, { errcode: 0, ...result });
    } catch (e) {
      const m2 = /errcode=(\d+)/.exec(e.message);
      return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: e.message });
    }
  }

  // 路由: POST /api/users/:userid/messages  给指定用户发单聊
  //       :userid 可以是单个 userid，也可以是 | , ; 分隔的多人
  const reUserMsg = /^\/api\/users\/([^\/]+)\/messages\/?$/;
  if (m === 'POST' && reUserMsg.test(p)) {
    const useridRaw = decodeURIComponent(reUserMsg.exec(p)[1]);
    const body = await readJsonBody(req).catch((e) => {
      jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message });
      return null;
    });
    if (!body) return;
    // URL 里的 userid 优先；body 里的 touser 兜底；支持多 userid
    const useridStr = String(body.touser || body.to || useridRaw).trim();
    const touser = splitList(useridStr);
    if (touser.length === 0) {
      return jsonRes(res, 400, { errcode: 400, errmsg: 'userid 必填' });
    }
    if (touser.length > 1000) {
      return jsonRes(res, 400, { errcode: 400, errmsg: '单次最多 1000 个 userid' });
    }
    const type = String(body.type || body.msgtype || 'text').toLowerCase();
    const content = body.content !== undefined ? String(body.content) : undefined;
    const payload = body.payload !== undefined ? body.payload : null;
    let msgObj;
    try {
      msgObj = buildMessage(type, content, payload);
    } catch (e) {
      return jsonRes(res, 400, { errcode: 400, errmsg: e.message });
    }
    try {
      const token = await getAccessToken(ctx.cfg);
      const result = await sendMessage(ctx.cfg, token, msgObj, { touser: touser.join('|'), chatId: '', meta: { sourceType: 'web' } });
      return jsonRes(res, 200, { errcode: 0, ...result });
    } catch (e) {
      const m2 = /errcode=(\d+)/.exec(e.message);
      return jsonRes(res, 200, { errcode: m2 ? Number(m2[1]) : 500, errmsg: e.message });
    }
  }

  // ---------------- 路由 CRUD ----------------
  // 路由含敏感信息（邮箱密码 / webhook code），读也需要 admin 鉴权
  if (p.startsWith('/api/routes')) {
    if (!requireAdmin(req, res, ctx.adminToken)) return;
  }

  // 测试
  const reRoutesTest = /^\/api\/routes\/([^\/]+)\/test\/?$/;
  if (reRoutesTest.test(p) && m === 'POST') {
    const id = decodeURIComponent(reRoutesTest.exec(p)[1]);
    const route = loadRoutes().find((r) => r.id === id);
    if (!route) return jsonRes(res, 404, { errcode: 404, errmsg: 'route not found' });
    try {
      const result = await testRoute(route, ctx.cfg);
      return jsonRes(res, 200, { errcode: 0, ...result });
    } catch (e) {
      return jsonRes(res, 200, { errcode: 500, errmsg: e.message });
    }
  }

  const reRoutesOne = /^\/api\/routes\/([^\/]+)\/?$/;
  if (p === '/api/routes' || p === '/api/routes/') {
    if (m === 'GET') {
      return jsonRes(res, 200, { routes: maskSecretRoutes(loadRoutes()) });
    }
    if (m === 'POST') {
      const body = await readJsonBody(req).catch((e) => { jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message }); return null; });
      if (!body) return;
      const route = normalizeRoute({
        id: genId('r'),
        name: String(body.name || ''),
        enabled: body.enabled !== false,
        source: body.source || {},
        target: body.target || {},
        template: String(body.template || ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const verr = validateRoute(route);
      if (verr) return jsonRes(res, 400, { errcode: 400, errmsg: verr });
      const routes = loadRoutes();
      routes.push(route);
      saveRoutes(routes);
      syncRouteEngine(ctx.cfg);
      return jsonRes(res, 200, { errcode: 0, route });
    }
    return jsonRes(res, 405, { errcode: 405, errmsg: 'method not allowed' });
  }

  if (reRoutesOne.test(p)) {
    const id = decodeURIComponent(reRoutesOne.exec(p)[1]);
    const routes = loadRoutes();
    const idx = routes.findIndex((r) => r.id === id);
    if (idx < 0) return jsonRes(res, 404, { errcode: 404, errmsg: 'route not found' });
    if (m === 'GET') {
      // 单条读取返回真实 code（仅列表概览脱敏），供网页在本地拼出完整 webhook 地址
      return jsonRes(res, 200, { errcode: 0, route: routes[idx] });
    }
    if (m === 'PUT') {
      const body = await readJsonBody(req).catch((e) => { jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message }); return null; });
      if (!body) return;
      const existing = routes[idx];
      const merged = normalizeRoute(Object.assign({}, existing, body, { id, updatedAt: new Date().toISOString() }));
      // 敏感字段：前端传回 '******' 或空 → 保留原值
      if (merged.source && existing.source) {
        if (merged.source.password === '******' || merged.source.password === '') {
          merged.source.password = existing.source.password;
        }
        if (merged.source.code === '******' || merged.source.code === '') {
          merged.source.code = existing.source.code;
        }
      }
      const verr = validateRoute(merged);
      if (verr) return jsonRes(res, 400, { errcode: 400, errmsg: verr });
      routes[idx] = merged;
      saveRoutes(routes);
      syncRouteEngine(ctx.cfg);
      return jsonRes(res, 200, { errcode: 0, route: merged });
    }
    if (m === 'DELETE') {
      routes.splice(idx, 1);
      saveRoutes(routes);
      syncRouteEngine(ctx.cfg);
      return jsonRes(res, 200, { errcode: 0, ok: true });
    }
    return jsonRes(res, 405, { errcode: 405, errmsg: 'method not allowed' });
  }

  // ---------------- 本地邮件账号管理 ----------------
  // 生成/列出/删除本地邮箱账号（账号密码敏感，读也需 admin 鉴权）
  if (p.startsWith('/api/mail-accounts')) {
    if (!requireAdmin(req, res, ctx.adminToken)) return;
    const domain = String(ctx.cfg.WECOM_MAIL_DOMAIN || 'wecom-mail.local');
    const smtpPort = Number(ctx.cfg.WECOM_MAIL_SMTP_PORT || 2525);
    const reAccOne = /^\/api\/mail-accounts\/([^\/]+)\/?$/;
    if (p === '/api/mail-accounts' || p === '/api/mail-accounts/') {
      if (m === 'GET') {
        const accounts = loadMailAccounts().map((a) => ({
          local: a.local,
          address: a.local + '@' + domain,
          createdAt: a.createdAt,
        }));
        return jsonRes(res, 200, { domain, smtpPort, accounts });
      }
      if (m === 'POST') {
        const body = await readJsonBody(req).catch((e) => {
          jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message });
          return null;
        });
        if (!body) return;
        const local = String(body.local || '').trim().toLowerCase() || genLocalPart();
        if (!/^[a-z0-9_.-]+$/.test(local)) {
          return jsonRes(res, 400, { errcode: 400, errmsg: 'local 只能含字母数字 _ . -' });
        }
        const accs = loadMailAccounts();
        if (accs.find((a) => a.local === local)) {
          return jsonRes(res, 400, { errcode: 400, errmsg: '账号已存在: ' + local });
        }
        const password = String(body.password || '').trim() || genPassword();
        const acc = { local, password, createdAt: new Date().toISOString() };
        accs.push(acc);
        saveMailAccounts(accs);
        return jsonRes(res, 200, {
          errcode: 0,
          account: { local: acc.local, address: acc.local + '@' + domain, password, createdAt: acc.createdAt },
        });
      }
      return jsonRes(res, 405, { errcode: 405, errmsg: 'method not allowed' });
    }
    if (reAccOne.test(p)) {
      const local = decodeURIComponent(reAccOne.exec(p)[1]);
      const accs = loadMailAccounts();
      const idx = accs.findIndex((a) => a.local === local);
      if (idx < 0) return jsonRes(res, 404, { errcode: 404, errmsg: '账号不存在' });
      if (m === 'DELETE') {
        accs.splice(idx, 1);
        saveMailAccounts(accs);
        try { fs.rmSync(mailAccountDir(local), { recursive: true, force: true }); } catch (_) {}
        // 停用引用该账号的路由，避免收集器空转
        const routes = loadRoutes();
        let changed = false;
        for (const r of routes) {
          if (r.source && r.source.type === 'local' && r.source.local === local) { r.enabled = false; changed = true; }
        }
        if (changed) { saveRoutes(routes); syncRouteEngine(ctx.cfg); }
        return jsonRes(res, 200, { errcode: 0, ok: true });
      }
      return jsonRes(res, 405, { errcode: 405, errmsg: 'method not allowed' });
    }
  }

  return jsonRes(res, 404, { errcode: 404, errmsg: `no route: ${m} ${p}` });
}

// 外部系统 → 接收渠道（webhook 源）入站端点
//   POST /recv/:routeId[/:code]
async function handleRecv(req, res, ctx) {
  if (req.method !== 'POST') return jsonRes(res, 405, { errcode: 405, errmsg: 'method not allowed' });
  const parsed = url.parse(req.url, true);
  const parts = parsed.pathname.split('/').filter(Boolean); // ['recv', routeId, code?]
  if (parts.length < 2) return jsonRes(res, 400, { errcode: 400, errmsg: 'bad path' });
  const routeId = parts[1];
  const code = parts[2] || '';
  const route = loadRoutes().find((r) => r.id === routeId);
  if (!route) return jsonRes(res, 404, { errcode: 404, errmsg: 'route not found' });
  if (!route.enabled) return jsonRes(res, 403, { errcode: 403, errmsg: 'route disabled' });
  if (route.source.type !== 'webhook') return jsonRes(res, 400, { errcode: 400, errmsg: 'route source 不是 webhook' });
  const wantCode = route.source.code || '';
  if (wantCode && code !== wantCode) return jsonRes(res, 401, { errcode: 401, errmsg: 'invalid code' });
  // 读取原始 body（兼容非 JSON 的 webhook 源，如 HFish 发送纯文本）
  const rawStr = await readBody(req).catch((e) => { jsonRes(res, e.status || 400, { errcode: e.status || 400, errmsg: e.message }); return null; });
  if (rawStr === null) return;
  let body;
  let isRawText = false;
  if (!rawStr.trim()) {
    body = {};
  } else {
    try {
      body = JSON.parse(rawStr);
    } catch (e) {
      // 非 JSON：按纯文本处理，包装为 { text, content } 供模板使用
      isRawText = true;
      body = { text: rawStr, content: rawStr };
    }
  }
  const vars = flattenVars(typeof body === 'object' && body ? body : {});
  vars._raw = isRawText ? rawStr : JSON.stringify(body);

  let msgObj;
  let recvText;
  if (route.template && String(route.template).trim()) {
    // 显式模板优先：精确控制输出（如 {{text}} 取纯文本内容）
    recvText = renderTemplate(route.template, vars) || (isRawText ? rawStr : JSON.stringify(body));
    msgObj = buildMessage('text', recvText);
  } else if (!isRawText && looksLikeWecomMessage(body)) {
    // 未配模板且 body 是标准企微消息：直接透传，自动「只发 content 部分」
    msgObj = body;
    recvText = extractContent(body);
  } else if (isRawText) {
    // 纯文本 webhook（如 HFish）：直接把原文作为消息内容
    recvText = rawStr;
    msgObj = buildMessage('text', recvText);
  } else {
    // 兜底：原样转发整段 JSON
    recvText = JSON.stringify(body);
    msgObj = buildMessage('text', recvText);
  }

  // 持久化接收记录（SQLite，保留 24h），与投递成功与否无关
  recordRecv({
    routeId,
    sourceType: 'webhook',
    account: null,
    fromAddr: null,
    subject: null,
    body: recvText,
    raw: isRawText ? rawStr : JSON.stringify(body),
  });
  try {
    const result = await deliverToTarget(route.target, msgObj, ctx.cfg, { sourceType: 'route', routeId: route.id, routeName: route.name });
    return jsonRes(res, 200, { errcode: 0, errmsg: 'ok', ...result });
  } catch (e) {
    return jsonRes(res, 200, { errcode: 500, errmsg: e.message });
  }
}

async function runWeb(cfg, args) {
  const port = Number(args['web-port'] || args.port || 8788);
  if (!port || port < 1 || port > 65535) {
    console.error('web 子命令需要 --web-port <1-65535>');
    process.exit(1);
  }

  // token 优先顺序: --admin-token > 环境变量 > config.js
  let adminToken = '';
  try {
    const raw = require(path.resolve((args.config || './config.js').toString()));
    if (raw && typeof raw === 'object') adminToken = String(raw.WECOM_WEBHOOK_TOKEN || '').trim();
  } catch (_) { /* ignore */ }
  if (!adminToken) adminToken = String(process.env.WECOM_WEBHOOK_TOKEN || '').trim();
  if (args['admin-token']) adminToken = String(args['admin-token']).trim();

  if (!adminToken || PLACEHOLDER_SECRETS.has(adminToken)) {
    console.error('缺少 admin token：');
    console.error('  - 在 config.js 配 WECOM_WEBHOOK_TOKEN');
    console.error('  - 或用环境变量 WECOM_WEBHOOK_TOKEN=xxx');
    console.error('  - 或 --admin-token xxx');
    process.exit(1);
  }

  const webRoot = path.resolve((args['web-root'] || './web').toString());
  try {
    fs.statSync(webRoot);
  } catch (e) {
    console.error(`web 静态目录不存在: ${webRoot}`);
    console.error('请先把 HTML 放到该目录，或 --web-root 指定。');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      handleWebApi(req, res, { cfg, adminToken }).catch((e) => {
        try { jsonRes(res, 500, { errcode: 500, errmsg: e.message }); } catch (_) {}
      });
      return;
    }
    if (req.url.startsWith('/recv/')) {
      jsonRes(res, 404, {
        errcode: 404,
        errmsg: 'webhook 接收端不在本端口',
        hint: `webhook 接收端运行在独立端口 ${cfg.webhookRecvPort}，请 POST 到该端口的 /recv/<routeId>[/:code]`,
      });
      return;
    }
    if (req.method !== 'GET') {
      jsonRes(res, 405, {
        errcode: 405,
        errmsg: 'method not allowed',
        hint: '本端口是管理界面（UI / API）。webhook 接收端在独立端口（默认 8787），外部系统 POST /recv/<routeId> 到该端口',
      });
      return;
    }
    if (serveStatic(req, res, webRoot)) return;
    jsonRes(res, 404, { errcode: 404, errmsg: 'not found' });
  });

  // webhook 接收端：独立端口（默认 8787），仅暴露 /recv/，便于单独对外网开放、
  // 把 3005 管理界面留在内网，提升安全性
  const recvPort = cfg.webhookRecvPort || 8787;
  const recvServer = http.createServer((req, res) => {
    if (req.url.startsWith('/recv/')) {
      handleRecv(req, res, { cfg, adminToken }).catch((e) => {
        try { jsonRes(res, 500, { errcode: 500, errmsg: e.message }); } catch (_) {}
      });
      return;
    }
    jsonRes(res, 404, { errcode: 404, errmsg: 'not found' });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[web] 管理界面 listening on 0.0.0.0:${port}`);
    console.log(`       Static:   ${webRoot}/`);
    console.log(`       API:      /api/chats  /api/chats/:id  /api/chats/:id/messages`);
    console.log(`                 /api/users/:userid/messages`);
    console.log(`                 /api/routes  (路由配置 CRUD)`);
    console.log(`                 /api/mail-accounts  (本地邮箱账号 生成/管理)`);
    console.log(`                 /api/admin/token   (仅本机)`);
    console.log(`                 /api/config   (前端取 webhook 接收基址)`);
    console.log(`       Health:   /api/healthz`);
    console.log(`       Admin:    X-Admin-Token: <WECOM_WEBHOOK_TOKEN>`);
    // 初始化接收记录库（SQLite，保留 24h），并启动清理定时器
    try { initRecvDb(); } catch (e) { console.error('[recv] 初始化失败:', e.message); }
    // 启动本地 SMTP 接收服务（生成邮箱账号时启用）
    try { runSmtpServer(cfg); } catch (e) { console.error('[mail] SMTP 启动失败:', e.message); }
    // 启动邮件接收渠道（基于 routes.json 中 enabled 的 local 路由）
    try { syncRouteEngine(cfg); } catch (e) { console.error('[routes] 启动失败:', e.message); }
  });

  recvServer.listen(recvPort, '0.0.0.0', () => {
    console.log(`[web] webhook 接收端 listening on 0.0.0.0:${recvPort}`);
    console.log(`       POST /recv/<routeId>[/:code]   (地址由「路由配置」页生成)`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[web] ${sig} received, shutting down`);
      server.close(() => process.exit(0));
      try { recvServer.close(() => {}); } catch (_) {}
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
}

// ---------------- webhook 接收 ----------------

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        const err = new Error('payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}


// ---------------- 入口 ----------------

async function runSend(cfg, args) {
  const type = (args.type || '').toString().toLowerCase();
  if (!type) {
    console.error('缺少 --type 参数');
    console.error(helpText());
    process.exit(1);
  }

  let msgObj;
  try {
    msgObj = buildMessage(type, args.content, args.payload);
  } catch (e) {
    console.error('参数错误:', e.message);
    process.exit(1);
  }

  const chatId = (args['chat-id'] || '').toString().trim();
  const touser = (args.to || '').toString().trim();
  const forceChat = args['force-chat'] === true || args['force-chat'] === 'true';

  if (chatId && touser) {
    console.error('--to 与 --chat-id 互斥，请只使用其中一个');
    process.exit(1);
  }
  if (!chatId) {
    if (!touser) {
      console.error('缺少收件人：需要 --to 或 --chat-id');
      process.exit(1);
    }
    if (touser.split('|').length > 1000) {
      console.error('--to 最多支持 1000 个 userid');
      process.exit(1);
    }
  }

  const token = await getAccessToken(cfg).catch((e) => {
    console.error('[ERROR] 获取 access_token 失败:', e.message);
    process.exit(2);
  });

  // 私有化版群发兜底：默认把群成员读出来，改走单聊 touser 模拟群发。
  // 想要原生的 message/send+chatid 通道，加 --force-chat。
  let asUserList = null;
  let effectiveChatId = chatId;
  if (chatId && !forceChat) {
    try {
      const info = await getJson(cfg, token, `/cgi-bin/appchat/get?chatid=${encodeURIComponent(chatId)}`);
      const list = (info.chat_info && Array.isArray(info.chat_info.userlist)) ? info.chat_info.userlist : [];
      if (list.length === 0) {
        console.error(`[WARN] 群 ${chatId} 没有成员，回退到原生 chatid 通道（可能 82001）`);
      } else {
        asUserList = list;
        effectiveChatId = ''; // 走单聊拼接，不再带 chatid
        console.log(`[INFO] 群发走单聊拼接，共 ${list.length} 人（私有化版 message/send+chatid 当前 corp secret 不可用）`);
      }
    } catch (e) {
      console.error(`[WARN] 读取群成员失败，回退到 chatid 通道: ${e.message}`);
    }
  }

  try {
    const result = await sendMessage(cfg, token, msgObj, { touser, chatId: effectiveChatId, asUserList, meta: { sourceType: 'cli' } });
    console.log('[OK] 发送成功');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('[ERROR] 发送失败:', e.message);
    process.exit(3);
  }
}

async function runChat(cfg, args) {
  const sub = (args._[0] === 'chat' ? (args._[1] || '') : (args._[0] || '')).toString();
  const handler = {
    create: appchatCreate,
    update: appchatUpdate,
    get: appchatGet,
    dismiss: appchatDismiss,
    revoke: appchatRevoke,
  }[sub];
  if (!handler) {
    console.error('未知子命令: chat', sub || '(空)');
    console.error('可选: create / update / get / dismiss / revoke');
    process.exit(1);
  }
  const token = await getAccessToken(cfg).catch((e) => {
    console.error('[ERROR] 获取 access_token 失败:', e.message);
    process.exit(2);
  });
  try {
    const result = await handler(cfg, token, args);
    console.log('[OK] 操作成功');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('[ERROR] 操作失败:', e.message);
    process.exit(3);
  }
}

(async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(helpText());
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve((args.config || './config.js').toString());
  const sub = (args._[0] || '').toString();
  // web 模式允许 corp 字段从环境变量回退，方便纯 web 服务部署
  const allowEnv = sub === 'web';
  const cfg = loadConfig(configPath, { allowEnvFallback: allowEnv });

  if (sub === 'web') {
    await runWeb(cfg, args);
  } else if (sub === 'chat') {
    await runChat(cfg, args);
  } else {
    await runSend(cfg, args);
  }
})();
