/**
 * ecosystem.config.cjs
 * ------------------------------------------------------------------
 * pm2 4.x 部署配置示例
 *
 * `web` 子命令会同时拉起:
 *   - 管理界面（默认 3005）
 *   - webhook 接收端（默认 8787，端口由 WECOM_WEBHOOK_RECV_PORT 控制）
 * 因此只需一个进程即可。
 *
 * 使用:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart wecom-web
 *   pm2 logs wecom-web
 *   pm2 save && pm2 startup
 * ------------------------------------------------------------------
 */

'use strict';

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
      // 建议通过 env 注入敏感字段，config.js 中保持占位
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
        // 可选：显式指定接收记录数据库文件位置（默认 recv.db 位于脚本同级目录）。
        // 仅当需要从非项目目录启动、或要把库放到独立磁盘/路径时使用。
        // WECOM_RECV_DB_FILE: '/path/to/recv.db',
      },
    },
  ],
};
