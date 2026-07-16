'use strict';

// 工具：把多行 / , ; | 分隔的字符串拆成 userid 数组
function splitIds(s) {
  if (!s) return [];
  return String(s)
    .split(/[\n,;|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// 工具：fetch 包装，附 X-Admin-Token
async function api(path, opts = {}) {
  const token = localStorage.getItem('wecomAdminToken') || '';
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) headers['X-Admin-Token'] = token;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body };
}

// 状态显示
function setStatus(elId, kind, text) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.className = 'status ' + (kind || '');
  el.textContent = text || '';
}

// tab 切换
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    // 打开「发送记录」时自动加载，免去手动点「查询」；若 token 缺失会立即提示
    if (btn.dataset.tab === 'sendlog') runSendLogQuery();
  });
});

// token 持久化
const tokenInput = document.getElementById('adminToken');
const fetchTokenBtn = document.getElementById('fetchToken');
tokenInput.value = localStorage.getItem('wecomAdminToken') || '';
document.getElementById('saveToken').addEventListener('click', () => {
  localStorage.setItem('wecomAdminToken', tokenInput.value.trim());
  setStatus('connStatus', 'ok', '已保存');
  ping();
});
tokenInput.addEventListener('input', () => {
  localStorage.setItem('wecomAdminToken', tokenInput.value.trim());
});

// 「获取 Token」按钮：从服务端拉取首次引导 token
// 浏览器与服务端同源（内网/本机）时可用，公网访问需手动粘贴
fetchTokenBtn.addEventListener('click', async () => {
  fetchTokenBtn.disabled = true;
  setStatus('connStatus', 'pending', '拉取中…');
  try {
    const r = await fetch('/api/admin/token', { method: 'GET' });
    const body = await r.json().catch(() => ({}));
    if (r.status === 200 && body && body.ok && body.token) {
      tokenInput.value = body.token;
      localStorage.setItem('wecomAdminToken', body.token);
      setStatus('connStatus', 'ok', '已拉取并保存');
      ping();
    } else if (r.status === 403) {
      setStatus('connStatus', 'err', '获取失败：当前网络不在内网/本机范围（公网访问请在输入框粘贴 WECOM_WEBHOOK_TOKEN 后保存）');
    } else {
      setStatus('connStatus', 'err', '拉取失败: ' + (body && body.errmsg) || (r.status + ''));
    }
  } catch (e) {
    setStatus('connStatus', 'err', '拉取失败: ' + e.message);
  } finally {
    fetchTokenBtn.disabled = false;
  }
});

// 健康检查
async function ping() {
  setStatus('connStatus', 'pending', '检查中…');
  try {
    const r = await api('/api/healthz', { method: 'GET' });
    if (r.status === 200 && r.body && r.body.ok) {
      setStatus('connStatus', 'ok', '服务可达');
    } else {
      setStatus('connStatus', 'err', '服务异常');
    }
  } catch (e) {
    setStatus('connStatus', 'err', '无法连接');
  }
}

// 类型切换：news 时显示 payload
const typeSelect = document.querySelector('#formSend select[name="type"]');
const contentLabel = document.getElementById('contentLabel');
const payloadLabel = document.getElementById('payloadLabel');
typeSelect.addEventListener('change', () => {
  if (typeSelect.value === 'news') {
    contentLabel.hidden = true;
    payloadLabel.hidden = false;
  } else {
    contentLabel.hidden = false;
    payloadLabel.hidden = true;
  }
});

// 应用单聊 tab 的类型切换
const userTypeSelect = document.querySelector('#formUser select[name="type"]');
const userContentLabel = document.getElementById('userContentLabel');
const userPayloadLabel = document.getElementById('userPayloadLabel');
userTypeSelect.addEventListener('change', () => {
  if (userTypeSelect.value === 'news') {
    userContentLabel.hidden = true;
    userPayloadLabel.hidden = false;
  } else {
    userContentLabel.hidden = false;
    userPayloadLabel.hidden = true;
  }
});

// 应用单聊：往指定用户发消息
document.getElementById('formUser').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const userids = splitIds(fd.get('userids'));
  if (userids.length === 0) {
    setStatus('userStatus', 'err', '请至少填一个 userid');
    return;
  }
  if (userids.length > 1000) {
    setStatus('userStatus', 'err', '最多 1000 个 userid，当前 ' + userids.length);
    return;
  }
  const type = (fd.get('type') || 'text').toString();
  const body = { type };
  if (type === 'news') {
    try {
      body.payload = JSON.parse((fd.get('payload') || '{}').toString());
    } catch (err) {
      setStatus('userStatus', 'err', 'payload 不是合法 JSON');
      return;
    }
  } else {
    body.content = (fd.get('content') || '').toString();
  }
  setStatus('userStatus', 'pending', '发送中…');
  // URL 里的 userid 取第一个；剩余在 body.touser 里追加，用 | 分隔
  const first = encodeURIComponent(userids[0]);
  body.touser = userids.join('|');
  try {
    const r = await api('/api/users/' + first + '/messages', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (r.body && r.body.errcode === 0) {
      const tag = r.body.invaliduser ? `（invaliduser=${r.body.invaliduser}）` : '';
      setStatus('userStatus', 'ok', '已发送: ' + userids.length + ' 人' + tag);
    } else {
      setStatus('userStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
  } catch (err) {
    setStatus('userStatus', 'err', '请求失败: ' + err.message);
  }
});

// 拉群
document.getElementById('formCreate').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    chatid: (fd.get('chatid') || '').toString().trim(),
    name: (fd.get('name') || '').toString().trim(),
    owner: (fd.get('owner') || '').toString().trim(),
    members: splitIds(fd.get('members')),
  };
  setStatus('createStatus', 'pending', '拉群中…');
  try {
    const r = await api('/api/chats', { method: 'POST', body: JSON.stringify(body) });
    if (r.body && r.body.errcode === 0) {
      setStatus('createStatus', 'ok', '已创建: ' + r.body.chatid);
    } else {
      setStatus('createStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
  } catch (err) {
    setStatus('createStatus', 'err', '请求失败: ' + err.message);
  }
});

// 发消息
document.getElementById('formSend').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const chatid = (fd.get('chatid') || '').toString().trim();
  const type = (fd.get('type') || 'text').toString();
  const body = { type };
  if (type === 'news') {
    try {
      body.payload = JSON.parse((fd.get('payload') || '{}').toString());
    } catch (err) {
      setStatus('sendStatus', 'err', 'payload 不是合法 JSON');
      return;
    }
  } else {
    body.content = (fd.get('content') || '').toString();
  }
  setStatus('sendStatus', 'pending', '发送中…');
  try {
    const r = await api('/api/chats/' + encodeURIComponent(chatid) + '/messages', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (r.body && r.body.errcode === 0) {
      setStatus('sendStatus', 'ok', '已发到群聊 ✅');
    } else {
      setStatus('sendStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
  } catch (err) {
    setStatus('sendStatus', 'err', '请求失败: ' + err.message);
  }
});

// 查群
document.getElementById('formGet').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const chatid = (fd.get('chatid') || '').toString().trim();
  setStatus('getStatus', 'pending', '查询中…');
  document.getElementById('getResult').textContent = '';
  try {
    const r = await api('/api/chats/' + encodeURIComponent(chatid), { method: 'GET' });
    if (r.body && r.body.errcode === 0) {
      setStatus('getStatus', 'ok', 'OK');
    } else {
      setStatus('getStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
    document.getElementById('getResult').textContent = JSON.stringify(r.body, null, 2);
  } catch (err) {
    setStatus('getStatus', 'err', '请求失败: ' + err.message);
  }
});

// 拉人入群：PATCH /api/chats/:chatid  { add_user_list: [...] }
document.getElementById('formAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const chatid = (fd.get('chatid') || '').toString().trim();
  const userids = splitIds(fd.get('userids'));
  setStatus('addStatus', 'pending', '提交中…');
  document.getElementById('addResult').textContent = '';
  if (!userids.length) { setStatus('addStatus', 'err', '请填写至少一个成员 userid'); return; }
  try {
    const r = await api('/api/chats/' + encodeURIComponent(chatid), {
      method: 'PATCH',
      body: JSON.stringify({ add_user_list: userids }),
    });
    if (r.body && r.body.errcode === 0) {
      setStatus('addStatus', 'ok', '已拉入 ' + userids.length + ' 人');
    } else {
      setStatus('addStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
    document.getElementById('addResult').textContent = JSON.stringify(r.body, null, 2);
  } catch (err) {
    setStatus('addStatus', 'err', '请求失败: ' + err.message);
  }
});

// 踢人出群：PATCH /api/chats/:chatid  { del_user_list: [...] }
document.getElementById('formDel').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const chatid = (fd.get('chatid') || '').toString().trim();
  const userids = splitIds(fd.get('userids'));
  setStatus('delStatus', 'pending', '提交中…');
  document.getElementById('delResult').textContent = '';
  if (!userids.length) { setStatus('delStatus', 'err', '请填写至少一个成员 userid'); return; }
  try {
    const r = await api('/api/chats/' + encodeURIComponent(chatid), {
      method: 'PATCH',
      body: JSON.stringify({ del_user_list: userids }),
    });
    if (r.body && r.body.errcode === 0) {
      setStatus('delStatus', 'ok', '已移出 ' + userids.length + ' 人');
    } else {
      setStatus('delStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
    document.getElementById('delResult').textContent = JSON.stringify(r.body, null, 2);
  } catch (err) {
    setStatus('delStatus', 'err', '请求失败: ' + err.message);
  }
});

// 解散群聊：POST /api/chats/:chatid/dismiss
document.getElementById('formDismiss').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const chatid = (fd.get('chatid') || '').toString().trim();
  setStatus('dismissStatus', 'pending', '解散中…');
  document.getElementById('dismissResult').textContent = '';
  try {
    const r = await api('/api/chats/' + encodeURIComponent(chatid) + '/dismiss', { method: 'POST' });
    if (r.body && r.body.errcode === 0) {
      setStatus('dismissStatus', 'ok', '已解散 ✅');
    } else {
      setStatus('dismissStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
    document.getElementById('dismissResult').textContent = JSON.stringify(r.body, null, 2);
  } catch (err) {
    setStatus('dismissStatus', 'err', '请求失败: ' + err.message);
  }
});

// 撤回群消息：POST /api/chats/:chatid/revoke（jobid 可选，缺省自动取最近一次）
document.getElementById('formRevoke').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const chatid = (fd.get('chatid') || '').toString().trim();
  const jobid = (fd.get('jobid') || '').toString().trim();
  setStatus('revokeStatus', 'pending', '撤回中…');
  document.getElementById('revokeResult').textContent = '';
  const body = {};
  if (jobid) body.jobid = jobid;
  try {
    const r = await api('/api/chats/' + encodeURIComponent(chatid) + '/revoke', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (r.body && r.body.errcode === 0) {
      setStatus('revokeStatus', 'ok', '已撤回 ✅');
    } else {
      setStatus('revokeStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
    document.getElementById('revokeResult').textContent = JSON.stringify(r.body, null, 2);
  } catch (err) {
    setStatus('revokeStatus', 'err', '请求失败: ' + err.message);
  }
});

// ---------------- 发送记录 ----------------

// datetime-local → 毫秒时间戳（本地时区）
function dtLocalToMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

function renderSendLog(rows) {
  const body = document.getElementById('sendLogBody');
  const empty = document.getElementById('sendLogEmpty');
  body.innerHTML = '';
  if (!rows || !rows.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const row of rows) {
    const tr = document.createElement('tr');
    const time = new Date(row.sent_at).toLocaleString();
    const ok = row.success === 1;
    const statusTxt = ok ? ('成功' + (row.errcode != null ? ' (' + row.errcode + ')' : '')) : ('失败: ' + (row.errmsg || ''));
    tr.innerHTML =
      '<td>' + escapeHtml(time) + '</td>' +
      '<td>' + escapeHtml(row.source_type) + (row.route_id ? ' (' + escapeHtml(row.route_id) + ')' : '') + '</td>' +
      '<td>' + escapeHtml(row.target_type) + (row.target_id ? ': ' + escapeHtml(String(row.target_id)) : '') + '</td>' +
      '<td class="log-content">' + escapeHtml(row.content || '') + '</td>' +
      '<td>' + (row.jobid ? escapeHtml(row.jobid) : '<span class="muted">—</span>') + '</td>' +
      '<td class="' + (ok ? 'ok' : 'err') + '">' + escapeHtml(statusTxt) + '</td>';
    body.appendChild(tr);
  }
}

// 查询发送记录（提交表单与打开标签页时共用）
async function runSendLogQuery() {
  const fd = new FormData(document.getElementById('formSendLog'));
  const from = dtLocalToMs(fd.get('from'));
  const to = dtLocalToMs(fd.get('to'));
  const limit = (fd.get('limit') || '200').toString().trim();
  const params = [];
  if (from != null) params.push('from=' + from);
  if (to != null) params.push('to=' + to);
  params.push('limit=' + encodeURIComponent(limit));
  setStatus('sendLogStatus', 'pending', '查询中…');
  try {
    const r = await api('/api/send-log?' + params.join('&'), { method: 'GET' });
    if (r.status === 200 && r.body && r.body.errcode === 0) {
      renderSendLog(r.body.logs || []);
      let msg = '共 ' + (r.body.logs ? r.body.logs.length : 0) + ' 条';
      // 显示数据库诊断信息，便于排查“能发消息但查不到记录”（多为 recv.db 路径/cwd 问题）
      if (r.body._db) {
        const db = r.body._db;
        const dbOk = db.connected ? '已连接' : '未连接(写入/查询均不生效)';
        msg += ' ｜ DB[' + dbOk + ']: ' + (db.file || '?');
        if (!db.connected && db.error) msg += ' 原因: ' + db.error;
      }
      setStatus('sendLogStatus', r.body.logs && r.body.logs.length ? 'ok' : 'err', msg);
    } else if (r.status === 401) {
      setStatus('sendLogStatus', 'err', '未登录或无权限（请在右上角填入并保存 Admin Token 后再查）');
    } else {
      setStatus('sendLogStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
  } catch (err) {
    setStatus('sendLogStatus', 'err', '请求失败: ' + err.message);
  }
}

document.getElementById('formSendLog').addEventListener('submit', (e) => {
  e.preventDefault();
  runSendLogQuery();
});

// ---------------- 路由配置 ----------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function srcLabel(r) {
  if (r.source.type === 'local') return `本地邮箱 ${escapeHtml(r.source.local || '')}`;
  if (r.source.type === 'webhook') return `webhook${r.source.code ? ' (code)' : ''}`;
  if (r.source.type === 'syslog') {
    const sp = (r.source.syslog && r.source.syslog.port) || '?';
    const proto = (r.source.syslog && r.source.syslog.protocol) || 'udp';
    return `syslog:${sp}/${proto}`;
  }
  return r.source.type || '?';
}
function tgtLabel(r) {
  if (r.target.type === 'chat') return `群聊 ${escapeHtml(r.target.chatid || '')}`;
  if (r.target.type === 'user') return `用户 ${escapeHtml(r.target.userid || '')}`;
  return r.target.type || '?';
}

// webhook 接收端基址（由 /api/config 返回，默认 http(s)://<host>:8787）。地址生成统一走此基址
let RECV_BASE = '';
async function loadRecvBase() {
  try {
    const r = await api('/api/config', { method: 'GET' });
    if (r.body && r.body.errcode === 0 && r.body.webhookRecvBase) RECV_BASE = r.body.webhookRecvBase;
  } catch (_) { /* 失败则回退当前源 */ }
  if (!RECV_BASE && window.location && window.location.origin) RECV_BASE = window.location.origin;
}

// 拼出 webhook 路由的完整接收地址（绝对 URL，基于接收端基址）
function webhookUrl(route) {
  const base = RECV_BASE || (window.location && window.location.origin) || '';
  const code = (route.source && route.source.code) ? '/' + route.source.code : '';
  return `${base}/recv/${encodeURIComponent(route.id)}${code}`;
}

// 通用复制：任意带 data-copy 的按钮（邮件账号 / 保存后详情框）
async function copyText(text, btn, doneMsg) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const old = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = old; }, 1500); }
    return true;
  } catch (_) {
    if (btn) btn.textContent = '复制失败';
    return false;
  }
}
// 网页是 webhook 地址的唯一生成与展示入口：复制/显示时读取单条路由（含真实 code），在本地拼出完整地址
async function fetchWebhookUrl(routeId) {
  try {
    const r = await api(`/api/routes/${encodeURIComponent(routeId)}`, { method: 'GET' });
    const route = r.body && r.body.route;
    if (route && route.source && route.source.type === 'webhook') {
      const code = route.source.code ? '/' + route.source.code : '';
      const base = RECV_BASE || (window.location.origin || '');
      return base + '/recv/' + encodeURIComponent(route.id) + code;
    }
    return null;
  } catch (_) { return null; }
}
document.addEventListener('click', async (e) => {
  // 1) webhook 列表「显示」：内联揭示真实地址
  const revealBtn = e.target.closest('button.reveal[data-route-id]');
  if (revealBtn) {
    const url = await fetchWebhookUrl(revealBtn.dataset.routeId);
    const cell = revealBtn.closest('.recv-cell');
    const urlEl = cell && cell.querySelector('.recv-url');
    if (url && urlEl) { urlEl.textContent = url; revealBtn.textContent = '已显示'; revealBtn.disabled = true; }
    else setStatus('routesStatus', 'err', '获取地址失败');
    return;
  }
  // 2) webhook 列表「复制」：先取真实地址再复制
  const routeCopyBtn = e.target.closest('button.copy[data-route-id]');
  if (routeCopyBtn) {
    const url = await fetchWebhookUrl(routeCopyBtn.dataset.routeId);
    if (url) {
      const ok = await copyText(url, routeCopyBtn);
      setStatus('routesStatus', ok ? 'ok' : 'err', ok ? '已复制完整接收地址（含校验码）' : '复制失败，请手动选择');
    } else {
      setStatus('routesStatus', 'err', '获取地址失败');
    }
    return;
  }
  // 3) 其它带 data-copy 的复制（邮件账号 / 保存后详情框）
  const plain = e.target.closest('button.copy[data-copy]');
  if (plain) {
    const ok = await copyText(plain.dataset.copy, plain);
    setStatus('routesStatus', ok ? 'ok' : 'err', ok ? '已复制' : '复制失败，请手动选择');
    return;
  }
});

async function loadRoutes() {
  if (!RECV_BASE) { try { await loadRecvBase(); } catch (_) {} }
  setStatus('routesStatus', 'pending', '加载中…');
  try {
    const r = await api('/api/routes', { method: 'GET' });
    if (r.body && Array.isArray(r.body.routes)) {
      renderRoutes(r.body.routes);
      setStatus('routesStatus', 'ok', `共 ${r.body.routes.length} 条`);
    } else {
      setStatus('routesStatus', 'err', '返回格式异常');
    }
  } catch (e) {
    setStatus('routesStatus', 'err', '请求失败: ' + e.message);
  }
}

function renderRoutes(list) {
  const body = document.getElementById('routesBody');
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#86909c">暂无路由，点击「新建路由」添加</td></tr>';
    return;
  }
  body.innerHTML = list.map((r) => {
    // webhook 列表里的 code 已被脱敏成 ******，这里只做展示；复制/显示走服务端按需取真实地址
    const hasCode = !!(r.source && r.source.code);
    const displayPath = '/recv/' + encodeURIComponent(r.id) + (hasCode ? '/••••••' : '');
  let recvCell;
  if (r.source && r.source.type === 'webhook') {
    recvCell = `<code class="recv-url">${escapeHtml(((RECV_BASE || window.location.origin || '') ) + displayPath)}</code>`
      + `<button class="copy" data-route-id="${escapeHtml(r.id)}">复制</button>`
      + `<button class="reveal" data-route-id="${escapeHtml(r.id)}">显示</button>`;
  } else if (r.source && r.source.type === 'syslog') {
    const sp = (r.source.syslog && r.source.syslog.port) || '?';
    const proto = (r.source.syslog && r.source.syslog.protocol) || 'udp';
    const host = (window.location && window.location.hostname) || 'localhost';
    recvCell = `<code class="recv-url">${escapeHtml(proto + '://' + host + ':' + sp)}</code>`;
  } else {
    recvCell = '<span style="color:#86909c">—（本地邮箱无需地址）</span>';
  }
    return `
    <tr>
      <td>${escapeHtml(r.name || '')}</td>
      <td><code>${srcLabel(r)}</code></td>
      <td><code>${tgtLabel(r)}</code></td>
      <td><span class="badge ${r.enabled ? 'on' : 'off'}">${r.enabled ? '启用' : '停用'}</span></td>
      <td class="recv-cell">${recvCell}</td>
      <td>
        <div class="route-ops">
          <button data-act="edit" data-id="${escapeHtml(r.id)}">编辑</button>
          <button data-act="test" data-id="${escapeHtml(r.id)}">测试</button>
          <button data-act="toggle" data-id="${escapeHtml(r.id)}">${r.enabled ? '停用' : '启用'}</button>
          <button class="del" data-act="del" data-id="${escapeHtml(r.id)}">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// 源/目标字段显隐
function syncRouteFormFields() {
  const st = document.querySelector('#formRoute select[name="sourceType"]').value;
  document.getElementById('localFields').hidden = st !== 'local';
  document.getElementById('webhookFields').hidden = st !== 'webhook';
  document.getElementById('syslogFields').hidden = st !== 'syslog';
  const tt = document.querySelector('#formRoute select[name="targetType"]').value;
  document.getElementById('targetChatWrap').hidden = tt !== 'chat';
  document.getElementById('targetUserWrap').hidden = tt !== 'user';
  updateWebhookHint();
}

// webhook 表单内的接收地址预览（新建时提示「保存后生成」；编辑已有路由时显示真实地址）
function updateWebhookHint() {
  const hint = document.getElementById('webhookUrlHint');
  if (!hint) return;
  const st = document.querySelector('#formRoute select[name="sourceType"]').value;
  if (st !== 'webhook') { hint.hidden = true; return; }
  hint.hidden = false;
  const code = (document.querySelector('#formRoute input[name="webhookCode"]').value || '').trim();
  const editingId = document.getElementById('formRoute').rid.value;
  if (editingId) {
    // 编辑时直接读取单条路由（含真实 code）展示真实地址
    hint.innerHTML = '获取接收地址中…';
    fetchWebhookUrl(editingId).then((url) => {
      hint.innerHTML = url
        ? `完整接收地址：<code>${escapeHtml(url)}</code>`
        : `完整接收地址：<code>${escapeHtml(((RECV_BASE || window.location.origin || '') + '/recv/' + encodeURIComponent(editingId) + (code ? '/' + code : '')))}</code>`;
    });
  } else {
    hint.innerHTML = `保存后这里会生成完整接收地址：<code>POST /recv/&lt;routeId&gt;${code ? '/' + escapeHtml(code) : ''}</code>`;
  }
}

function openRouteForm(route) {
  const f = document.getElementById('formRoute');
  f.hidden = false;
  f.reset();
  const r = route || {};
  f.rid.value = r.id || '';
  f.name.value = r.name || '';
  const st = (r.source && r.source.type) || 'local';
  const tt = (r.target && r.target.type) || 'chat';
  f.sourceType.value = st;
  f.targetType.value = tt;
  // webhook 字段：单条路由读取返回的是真实 code（仅列表概览脱敏），直接回填
  f.webhookCode.value = (r.source && r.source.code) || '';
  // syslog 字段：端口 / 协议
  f.syslogPort.value = (r.source && r.source.syslog && r.source.syslog.port) || '';
  f.syslogProtocol.value = (r.source && r.source.syslog && r.source.syslog.protocol) || 'udp';
  // 本地邮箱字段
  f.localAccount.value = (r.source && r.source.local) || '';
  // 目标
  f.targetChatid.value = (r.target && r.target.chatid) || '';
  f.targetUserid.value = (r.target && r.target.userid) || '';
  // 模板
  f.template.value = (r.template) || '';
  syncRouteFormFields();
  setStatus('routeFormStatus', '', '');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildRoutePayload() {
  const f = document.getElementById('formRoute');
  const sourceType = f.sourceType.value;
  const targetType = f.targetType.value;
  const source = { type: sourceType };
  if (sourceType === 'local') {
    source.local = f.localAccount.value.trim();
  } else if (sourceType === 'webhook') {
    source.code = f.webhookCode.value.trim();
  } else if (sourceType === 'syslog') {
    source.syslog = { port: Number(f.syslogPort.value.trim()) || 0, protocol: f.syslogProtocol.value || 'udp' };
  } else {
    // 仅允许 local / webhook / syslog 三种源，其余一律拒绝
    return null;
  }
  const target = { type: targetType };
  if (targetType === 'chat') target.chatid = f.targetChatid.value.trim();
  else target.userid = f.targetUserid.value.trim();
  return {
    name: f.name.value.trim() || '未命名路由',
    enabled: true,
    source,
    target,
    template: f.template.value,
  };
}

document.getElementById('btnNewRoute').addEventListener('click', () => openRouteForm(null));
document.getElementById('btnCancelRoute').addEventListener('click', () => { document.getElementById('formRoute').hidden = true; setStatus('routeFormStatus', '', ''); });
document.querySelector('#formRoute select[name="sourceType"]').addEventListener('change', syncRouteFormFields);
document.querySelector('#formRoute select[name="targetType"]').addEventListener('change', syncRouteFormFields);
document.querySelector('#formRoute input[name="webhookCode"]').addEventListener('input', updateWebhookHint);
document.getElementById('btnRefreshRoutes').addEventListener('click', loadRoutes);

document.getElementById('formRoute').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = document.getElementById('formRoute');
  const payload = buildRoutePayload();
  if (!payload) {
    setStatus('routeFormStatus', 'err', '接收渠道类型无效，仅支持「已生成的邮箱账号」或「webhook」');
    return;
  }
  const id = f.rid.value;
  setStatus('routeFormStatus', 'pending', '保存中…');
  try {
    const r = await api(id ? `/api/routes/${encodeURIComponent(id)}` : '/api/routes', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    if (r.body && r.body.errcode === 0) {
      const saved = r.body.route || {};
      f.hidden = true;
      setStatus('routeFormStatus', 'ok', '已保存');
      const detail = document.getElementById('routeDetail');
      if (saved.source && saved.source.type === 'webhook') {
        const url = webhookUrl(saved);
        detail.hidden = false;
        detail.innerHTML =
          `✅ 已保存。外部系统请 <b>POST JSON</b> 到以下地址（完整 webhook 地址）：<br>` +
          `<code>${escapeHtml(url)}</code> <button class="copy" data-copy="${escapeHtml(url)}">复制</button>`;
      } else {
        detail.hidden = true;
      }
      loadRoutes();
    } else {
      setStatus('routeFormStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
  } catch (err) {
    setStatus('routeFormStatus', 'err', '请求失败: ' + err.message);
  }
});

// 表格内按钮事件委托
document.getElementById('routesBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === 'edit') {
    const r = await api(`/api/routes/${encodeURIComponent(id)}`, { method: 'GET' });
    if (r.body && r.body.route) openRouteForm(r.body.route);
    else setStatus('routesStatus', 'err', '读取失败');
  } else if (act === 'del') {
    if (!confirm('确认删除该路由？此操作不可恢复。')) return;
    const r = await api(`/api/routes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setStatus('routesStatus', r.body && r.body.errcode === 0 ? 'ok' : 'err',
      (r.body && r.body.errcode === 0) ? '已删除' : 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    loadRoutes();
  } else if (act === 'test') {
    setStatus('routesStatus', 'pending', '测试中…');
    const r = await api(`/api/routes/${encodeURIComponent(id)}/test`, { method: 'POST' });
    if (r.body && r.body.errcode === 0) {
      const info = r.body.type === 'local'
        ? `本地邮箱 ${escapeHtml(r.body.account || '')} 路由就绪，发信即触发`
        : `webhook 配置有效（接收地址见列表「接收地址」列）`;
      setStatus('routesStatus', 'ok', info);
    } else {
      setStatus('routesStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
  } else if (act === 'toggle') {
    const r = await api(`/api/routes/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!r.body || !r.body.route) { setStatus('routesStatus', 'err', '读取失败'); return; }
    const cur = r.body.route;
    cur.enabled = !cur.enabled;
    const r2 = await api(`/api/routes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(cur) });
    setStatus('routesStatus', r2.body && r2.body.errcode === 0 ? 'ok' : 'err',
      (r2.body && r2.body.errcode === 0) ? (cur.enabled ? '已启用' : '已停用') : '操作失败');
    loadRoutes();
  }
});

// ---------------- 邮件账号（本地内置 SMTP） ----------------

// 把账号列表填充到「路由表单」的本地邮箱下拉框
async function loadMailAccountsIntoSelect() {
  const sel = document.querySelector('#formRoute select[name="localAccount"]');
  if (!sel) return;
  try {
    const r = await api('/api/mail-accounts', { method: 'GET' });
    const accounts = (r.body && r.body.accounts) || [];
    sel.innerHTML = accounts.length
      ? accounts.map((a) => `<option value="${escapeHtml(a.local)}">${escapeHtml(a.address)}</option>`).join('')
      : '<option value="">（暂无账号，请先到「邮件账号」页生成）</option>';
  } catch (_) {
    sel.innerHTML = '<option value="">（加载失败）</option>';
  }
}

async function loadMailAccounts() {
  setStatus('mailStatus', 'pending', '加载中…');
  try {
    const r = await api('/api/mail-accounts', { method: 'GET' });
    if (r.body) {
      document.getElementById('mailDomain').textContent = r.body.domain || 'wecom-mail.local';
      document.getElementById('mailPort').textContent = r.body.smtpPort || 2525;
      const accounts = r.body.accounts || [];
      const body = document.getElementById('mailBody');
      if (!accounts.length) {
        body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#86909c">暂无账号，点击「+ 生成邮箱账号」创建</td></tr>';
      } else {
        body.innerHTML = accounts.map((a) => `
          <tr>
            <td><code>${escapeHtml(a.address)}</code></td>
            <td><button class="copy" data-copy="${escapeHtml(a.address)}">复制地址</button></td>
            <td>${escapeHtml((a.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
            <td><button class="del" data-del="${escapeHtml(a.local)}">删除</button></td>
          </tr>`).join('');
      }
      setStatus('mailStatus', 'ok', `共 ${accounts.length} 个账号`);
    } else {
      setStatus('mailStatus', 'err', '返回异常');
    }
  } catch (e) {
    setStatus('mailStatus', 'err', '请求失败: ' + e.message);
  }
}

document.getElementById('btnGenMail').addEventListener('click', async () => {
  setStatus('mailStatus', 'pending', '生成中…');
  try {
    const r = await api('/api/mail-accounts', { method: 'POST', body: JSON.stringify({}) });
    if (r.body && r.body.errcode === 0 && r.body.account) {
      const a = r.body.account;
      setStatus('mailStatus', 'ok', `已生成 ${a.address}（密码 ${a.password}）`);
      const detail = document.getElementById('mailDetail');
      detail.hidden = false;
      detail.textContent =
        `邮箱地址: ${a.address}\n` +
        `密码: ${a.password}\n` +
        `SMTP: 本机 :${document.getElementById('mailPort').textContent} (域名 ${document.getElementById('mailDomain').textContent})\n` +
        `用任意邮件客户端/脚本把信发到 ${a.address} 即可被本工具接收并推送到企业微信。`;
      loadMailAccounts();
      loadMailAccountsIntoSelect();
    } else {
      setStatus('mailStatus', 'err', 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    }
  } catch (e) {
    setStatus('mailStatus', 'err', '请求失败: ' + e.message);
  }
});

document.getElementById('btnRefreshMail').addEventListener('click', loadMailAccounts);

// 删除 事件委托（复制由全局 handler 接管）
document.getElementById('mailBody').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('button.del');
  if (delBtn) {
    if (!confirm('确认删除该邮箱账号？其邮件与引用它的路由都会失效。')) return;
    setStatus('mailStatus', 'pending', '删除中…');
    const r = await api(`/api/mail-accounts/${encodeURIComponent(delBtn.dataset.del)}`, { method: 'DELETE' });
    setStatus('mailStatus', r.body && r.body.errcode === 0 ? 'ok' : 'err',
      (r.body && r.body.errcode === 0) ? '已删除' : 'errcode=' + (r.body && r.body.errcode) + ' ' + (r.body && r.body.errmsg));
    loadMailAccounts();
    loadMailAccountsIntoSelect();
  }
});

// 打开路由表单时同步本地账号下拉
const _openRouteForm = openRouteForm;
openRouteForm = function (route) {
  _openRouteForm(route);
  loadMailAccountsIntoSelect();
};

// 切到「邮件账号」tab 时自动加载
document.querySelector('.tab-btn[data-tab="mail"]').addEventListener('click', loadMailAccounts);

// 启动时 ping
ping();
// 预先取 webhook 接收端基址（8787 端口），确保路由地址显示正确
loadRecvBase().catch(() => {});
