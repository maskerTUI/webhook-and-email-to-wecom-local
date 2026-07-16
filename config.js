/**
 * config.js
 * ------------------------------------------------------------------
 * 私有化企业微信「自建应用」凭证配置
 *
 * 使用方法:
 *   1) 复制本文件为一份本地副本（如 config.local.js）
 *   2) 填入真实值
 *   3) 启动时通过 --config 指定；未指定时默认加载 ./config.js
 *
 * 注意:
 *   - corp_secret 切勿提交到代码仓库，建议把 config.js / config.local.js
 *     加入 .gitignore
 *   - apiBase 结尾不要带 /
 *   - web 子命令下，corp 字段允许从同名环境变量回退
 *     (WECOM_API_BASE / WECOM_CORP_ID / WECOM_CORP_SECRET / WECOM_AGENT_ID)
 *   - WECOM_WEBHOOK_TOKEN 同时作为「网页控制台管理员 token」与「webhook 接收端
 *     路由级 code 之外的管理鉴权」，必须在本文件显式配置
 * ------------------------------------------------------------------
 */

'use strict';

module.exports = {
  // 私有化企业微信 API 根地址
  WECOM_API_BASE: 'https://wecom.example.com',

  // 企业 corp_id（"我的企业" -> 企业信息 -> CorpID）
  WECOM_CORP_ID: 'ww0000000000000000',

  // 自建应用 Secret（应用详情页 "Secret"）
  WECOM_CORP_SECRET: 'replace-with-real-secret',

  // 自建应用 AgentId（应用详情页 "AgentId"）
  WECOM_AGENT_ID: '1000002',

  // 网页控制台管理员 token：同时用于
  //   1) 控制台所有写操作需 header X-Admin-Token: <WECOM_WEBHOOK_TOKEN>
  //   2) 启动校验（缺失或用占位值会拒绝启动）
  // 推荐 ≥ 32 字节随机串
  WECOM_WEBHOOK_TOKEN: 'replace-with-a-long-random-string',

  // ===== webhook 接收端（仅 8787 端口，与 3005 管理界面隔离） =====
  // 路由配置页生成的 webhook 接收地址统一走此端口，格式:
  //   POST http(s)://<host>:<WECOM_WEBHOOK_RECV_PORT>/recv/<routeId>[/:code]
  // 该端口只暴露 /recv/ 入站，不提供 UI / /api，便于单独对外网开放、把 3005 留在内网
  WECOM_WEBHOOK_RECV_PORT: 8787,
  // 可选：若 8787 端口外层有反向代理 / 域名，可在此填完整基址（含协议与域名，不含路径）
  // 例如: WECOM_WEBHOOK_RECV_BASE: 'https://hooks.example.com'
  // 留空则前端按「当前访问主机名 + 上述端口」自动拼出地址
  WECOM_WEBHOOK_RECV_BASE: '',

  // ===== 本地内置邮件账号（网页「生成邮箱账号」功能） =====
  // 工具会内置一个 SMTP 服务，接收发往 <local>@<WECOM_MAIL_DOMAIN> 的邮件，
  // 再由 local 路由源推送到企业微信（群聊/单聊）。
  // - WECOM_MAIL_DOMAIN: 本 SMTP 服务认领的域名（外部邮件系统需能解析并路由到本机该端口）
  // - WECOM_MAIL_SMTP_PORT: SMTP 监听端口（默认 2525；25 需 root 权限，生产可反向代理）
  WECOM_MAIL_DOMAIN: 'wecom-mail.local',
  WECOM_MAIL_SMTP_PORT: 2525,
};
