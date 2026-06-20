/* ════════════════════════════════════════════════════════════════════
   ecosystem.config.js  —  PM2 cluster config for NuMind MAPS
   Target: 20 000 users/day, Node.js 18+

   Quick start:
     mkdir -p logs
     pm2 start ecosystem.config.js --env production
     pm2 save
     pm2 startup   ← run the printed command to auto-start on reboot

   Scale rationale:
     • cluster mode forks one process per CPU core
     • each worker has its own SQLite connection
     • WAL mode allows N concurrent readers + 1 writer without lock contention
     • max_memory_restart kills any worker leaking past 512 MB

   Monitoring:
     pm2 monit                  — live CPU/RAM dashboard
     pm2 logs numind-maps       — tail all workers
     pm2 show numind-maps       — full process details
════════════════════════════════════════════════════════════════════ */

const path = require('path');

module.exports = {
  apps: [{
    name:    'numind-maps',
    script:  './server.js',
    cwd:     path.resolve(__dirname),   // always resolve relative to this file

    instances:  'max',       // one per CPU core
    exec_mode:  'cluster',
    watch:      false,

    max_memory_restart: '512M',

    // Signal-based graceful restart
    // server.js emits process.send('ready') after listen() — PM2 waits for it
    wait_ready:     true,
    listen_timeout: 8000,    // ms to wait for 'ready' before marking failed
    kill_timeout:   10000,   // ms to wait for in-flight requests before SIGKILL

    // Base env (always applied — safe defaults)
    env: {
      NODE_ENV:  'development',
      PORT:      3000,
      LOG_LEVEL: 'warn',
    },

    // Production overrides: pm2 start ecosystem.config.js --env production
    env_production: {
      NODE_ENV:          'production',
      PORT:              3000,
      LOG_LEVEL:         'warn',
      MAX_CONCURRENT_AI: 20,
    },

    // Logging — create ./logs/ before first start
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:      './logs/err.log',
    out_file:        './logs/out.log',
    merge_logs:      true,

    // Restart policy
    autorestart:      true,
    max_restarts:     10,
    min_uptime:       '5s',   // don't count as crash if it lives < 5s
    restart_delay:    1000,   // ms between restart attempts
  }],
};
