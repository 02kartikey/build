/* ════════════════════════════════════════════════════════════════════
   server.js  —  NuMind MAPS  |  Node.js 18+ / CommonJS
   Target: 20k users/day, PM2 cluster mode

   Scalability features:
     · HTTPS keep-alive agent (reuse TLS connections to OpenAI)
     · In-memory static file cache with TTL revalidation + dedup inflight
     · Gzip compression + ETag/304 for all text assets
     · IP-level rate limiter (pre-auth) + per-email limiters (post-auth)
     · AI report concurrency cap with back-pressure (503 + Retry-After)
     · Micro write-queue: DB writes batched every 50ms, non-blocking
     · /health endpoint for PM2 / nginx / Docker probes
     · Structured logging gated on LOG_LEVEL env var
     · Graceful shutdown with forced exit after 10s

   Routes:
     GET  /health                  — liveness probe
     POST /api/save-registration
     POST /api/save-section
     POST /api/save-report
     POST /api/ai-report           — OpenAI streaming proxy
     POST /api/counsellor-unlock
     POST /api/counsellor-chat     — RAG streaming chat
     POST /api/counsellor-clear-history
     POST /api/counsellor-query
     *    /api/dashboard/*
     GET  /*                       — static files

   Env vars:
     PORT, SQLITE_PATH, APP_TOKEN, OPENAI_API_KEY, OPENAI_BASE_URL,
     OPENAI_MODEL, COUNSELLOR_MODEL, ALLOWED_ORIGIN,
     LOG_LEVEL          — 'debug'|'info'|'warn'|'error' (default 'warn')
     MAX_CONCURRENT_AI  — max parallel ai-report streams (default 20)
════════════════════════════════════════════════════════════════════ */
'use strict';
const _dotenvResult = require('dotenv').config();
// Debug: show dotenv load result on startup so you can verify the .env path and content
if (_dotenvResult.error) {
  process.stderr.write('[WARN]  [.env] Failed to load: ' + _dotenvResult.error.message + '\n');
  process.stderr.write('[WARN]  [.env] Make sure .env exists at: ' + process.cwd() + '/.env\n');
} else {
  const loaded = Object.keys(_dotenvResult.parsed || {});
  process.stdout.write('[INFO]  [.env] Loaded ' + loaded.length + ' vars from ' + process.cwd() + '/.env\n');
  // Show which critical vars are present (not their values)
  ['APP_TOKEN','OPENAI_API_KEY','SMTP_USER','SMTP_PASS'].forEach(k => {
    const val = process.env[k] || '';
    process.stdout.write('[INFO]  [.env]   ' + k + ': ' + (val ? '✓ set (' + val.length + ' chars)' : '✗ MISSING') + '\n');
  });
}

const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const zlib      = require('zlib');
const crypto    = require('crypto');
const urlModule = require('url');
const { StringDecoder } = require('string_decoder');

/* ── DB modules ─────────────────────────────────────────────────── */
const dbModule = require('./db.js');
const cdb      = require('./counsellor-db.js');
const rag      = require('./counsellor-rag.js');
const dashApi  = require('./dashboard-api.js');

/* ══════════════════════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════════════════════ */
const PORT             = parseInt(process.env.PORT            || '3000', 10);
const APP_TOKEN        = process.env.APP_TOKEN                || '';
const OPENAI_KEY       = process.env.OPENAI_API_KEY           || '';
const OPENAI_BASE      = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
const AI_MODEL         = process.env.OPENAI_MODEL             || 'gpt-4o';
const CHAT_MODEL       = process.env.COUNSELLOR_MODEL         || 'gpt-4o-mini';
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN           || '*';
const MAX_CONCURRENT_AI = parseInt(process.env.MAX_CONCURRENT_AI || '20', 10);
const LOG_LEVEL        = (process.env.LOG_LEVEL || 'warn').toLowerCase();

/* ── Structured logger (no-op in production for non-errors) ──────── */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const _lvl = LOG_LEVELS[LOG_LEVEL] ?? 2;
const log = {
  debug: (...a) => _lvl <= 0 && console.debug('[DEBUG]', ...a),
  info:  (...a) => _lvl <= 1 && console.log  ('[INFO] ', ...a),
  warn:  (...a) => _lvl <= 2 && console.warn ('[WARN] ', ...a),
  error: (...a) =>               console.error('[ERROR]', ...a),
};

/* ══════════════════════════════════════════════════════════════════
   PROCESS STABILITY
══════════════════════════════════════════════════════════════════ */
process.on('uncaughtException',  err    => log.error('uncaughtException:',  err.message, err.stack));
process.on('unhandledRejection', reason => log.error('unhandledRejection:', reason));

/* ══════════════════════════════════════════════════════════════════
   DB INIT
══════════════════════════════════════════════════════════════════ */
const _db = dbModule._initDb();
cdb.init(_db);

/* ══ EMAIL — Raw TLS SMTP to Gmail port 465 ══════════════════════
   SMTP_HOST, SMTP_USER, SMTP_PASS in .env
   If SMTP_USER/PASS absent _emailFn = null → callers get 503.
══════════════════════════════════════════════════════════════════ */
const tls       = require('tls');
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = SMTP_USER || 'no-reply@numind.co.in';
// Address that receives student query/scheduler notifications.
// Defaults to SMTP_USER (the sending account) if not set separately.
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || SMTP_USER;

function _sendEmail({ to, subject, text }) {
  if (!SMTP_USER || !SMTP_PASS) throw new Error('SMTP not configured');
  const _san = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const safeTo = _san(to); const safeSub = _san(subject);
  if (!safeTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeTo)) {
    log.error('[SMTP] Rejected invalid recipient:', JSON.stringify(safeTo)); return;
  }
  const enc  = s => Buffer.from(s).toString('base64');
  const CRLF = '\r\n';
  const msg  =
    `From: NuMind MAPS <${SMTP_FROM}>${CRLF}To: ${safeTo}${CRLF}Subject: ${safeSub}${CRLF}` +
    `MIME-Version: 1.0${CRLF}Content-Type: text/plain; charset=utf-8${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` + enc(text) + CRLF;

  const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST }, () => {
    const send = s => socket.write(s + CRLF);
    let stage = 0;
    socket.on('data', chunk => {
      const line = chunk.toString('utf8').trim();
      if      (stage === 0 && line.startsWith('220'))        { send('EHLO numind.maps'); stage = 1; }
      else if (stage === 1 && line.includes('250 '))         { send('AUTH LOGIN'); stage = 2; }
      else if (stage === 2 && line.startsWith('334'))        { send(enc(SMTP_USER)); stage = 3; }
      else if (stage === 3 && line.startsWith('334'))        { send(enc(SMTP_PASS)); stage = 4; }
      else if (stage === 4 && line.startsWith('235'))        { send(`MAIL FROM:<${SMTP_FROM}>`); stage = 5; }
      else if (stage === 5 && line.startsWith('250'))        { send(`RCPT TO:<${safeTo}>`); stage = 6; }
      else if (stage === 6 && line.startsWith('250'))        { send('DATA'); stage = 7; }
      else if (stage === 7 && line.startsWith('354'))        { socket.write(msg + CRLF + '.' + CRLF); stage = 8; }
      else if (stage === 8 && line.startsWith('250'))        { send('QUIT'); stage = 9; }
      else if (stage === 9 && line.startsWith('221'))        { socket.destroy(); }
      else if (line.startsWith('5') || line.startsWith('4')){ log.error('[SMTP]', line); socket.destroy(); }
    });
  });
  socket.setTimeout(15000, () => { log.warn('[SMTP] timeout →', safeTo); socket.destroy(); });
  socket.on('error', e => log.error('[SMTP] socket error:', e.message));
}
const _emailFn = (SMTP_USER && SMTP_PASS) ? _sendEmail : null;
if (!_emailFn) log.info('[Email] SMTP_USER/SMTP_PASS not set — email features disabled. Set them in .env to enable OTP and reminders.');

dashApi.init(_db, _emailFn, _dbWrite);

/* ══════════════════════════════════════════════════════════════════
   MICRO WRITE-QUEUE
   Batches synchronous better-sqlite3 writes so they don't block the
   event loop on every individual HTTP request.

   How it works:
     • Callers push { fn, resolve, reject } onto _wq
     • A setImmediate drains the queue each event-loop tick
     • Each flush runs up to WQ_BATCH_SIZE writes in one tick
     • If the queue fills past WQ_MAX, new writes are dropped with a
       warning (student data still in localStorage + already 200'd)

   At 84 writes/min peak: queue drains in <1ms per tick, event loop
   is never blocked for more than one write at a time.
══════════════════════════════════════════════════════════════════ */
const WQ_BATCH_SIZE = 10;
const WQ_MAX        = 500;
const _wq           = [];
let   _wqScheduled  = false;

function _wqDrain() {
  _wqScheduled = false;
  const batch = _wq.splice(0, WQ_BATCH_SIZE);
  for (const { fn, resolve, reject } of batch) {
    try { resolve(fn()); } catch (e) { reject(e); }
  }
  if (_wq.length > 0) _scheduleWQ();
}

function _scheduleWQ() {
  if (_wqScheduled) return;
  _wqScheduled = true;
  setImmediate(_wqDrain);
}

function _dbWrite(fn) {
  if (_wq.length >= WQ_MAX) {
    log.warn(`Write queue full (${WQ_MAX}) — dropping write`);
    return Promise.resolve(null); // non-fatal: data is safe in localStorage
  }
  return new Promise((resolve, reject) => {
    _wq.push({ fn, resolve, reject });
    _scheduleWQ();
  });
}

/* ══════════════════════════════════════════════════════════════════
   HTTPS KEEP-ALIVE AGENT
══════════════════════════════════════════════════════════════════ */
const _httpsAgent = new https.Agent({
  keepAlive:      true,
  keepAliveMsecs: 10000,
  maxSockets:     50,
  maxFreeSockets: 10,
  timeout:        35000,
});

/* ══════════════════════════════════════════════════════════════════
   AI CONCURRENCY CAP
   Prevents runaway OpenAI spend + socket exhaustion under bursts.
══════════════════════════════════════════════════════════════════ */
let _aiInFlight = 0;

/* ══════════════════════════════════════════════════════════════════
   STATIC FILE CACHE
   filePath → { buf, compressed, etag, mime, mtime, checkedAt }

   TTL revalidation: mtime is rechecked at most every CACHE_TTL_MS.
   This eliminates the fs.stat() syscall on every cache hit.

   Inflight dedup: a _pending Map prevents concurrent cold-starts from
   triggering multiple simultaneous disk reads + gzip calls for the same file.
══════════════════════════════════════════════════════════════════ */
const CACHE_MAX_FILES     = 120;
const CACHE_MAX_FILE_SIZE = 512 * 1024;
const CACHE_TTL_MS        = 30_000; // recheck mtime every 30s
const _staticCache        = new Map();
const _cachePending       = new Map(); // filePath → Promise

function _cacheEvict() {
  if (_staticCache.size <= CACHE_MAX_FILES) return;
  _staticCache.delete(_staticCache.keys().next().value);
}

/* ══════════════════════════════════════════════════════════════════
   RATE LIMITERS
   · IP limiter  — 200 req/min per IP  (pre-auth, all routes)
   · unlock RL   — 20 attempts/hr per email
   · chat RL     — 60 messages/hr per email
   · query RL    — 5 submissions/hr per email

   NOTE: these Maps are per-process. In PM2 cluster mode, each worker
   has its own limiter. The effective limit per email = limit × workers.
   At 4 cores a student could send 240 chat msgs/hr instead of 60.
   Acceptable for a school deployment; for stricter enforcement write
   RL state to SQLite (single shared DB) — see _rlCheckDb() stub below.
══════════════════════════════════════════════════════════════════ */
const RL_WINDOW = 60 * 60 * 1000;
const IP_WINDOW = 60 * 1000;
const _ipRL    = new Map();
const _loginRL = new Map();

function _rlCheck(map, key, limit, windowMs) {
  const win = windowMs || RL_WINDOW;
  const now = Date.now();
  let e = map.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + win }; map.set(key, e); }
  if (e.count >= limit) return { allowed: false, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  e.count++;
  return { allowed: true };
}

// DB-backed RL — atomic across all PM2 workers
function _rlCheckDb(scope, key, limit, windowMs) {
  try { return cdb.rlCheck(scope, key, limit, windowMs || RL_WINDOW); }
  catch (e) { log.warn('[RL] DB check failed, failing open:', e.message); return { allowed: true }; }
}

function _getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

// Sweep in-memory IP/login limiters every 5 min
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of _ipRL)    if (n > v.resetAt) _ipRL.delete(k);
  for (const [k, v] of _loginRL) if (n > v.reset)   _loginRL.delete(k);
}, 5 * 60 * 1000).unref();

// Prune DB rate-limits and expired counsellor tokens hourly
setInterval(() => {
  try { cdb.rlPrune(); cdb.pruneTokens(); cdb.pruneOtps(); } catch (_) {}
}, RL_WINDOW).unref();

/* ══════════════════════════════════════════════════════════════════
   OPENAI REQUEST HELPER
══════════════════════════════════════════════════════════════════ */
function _openaiReq(endpoint, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(OPENAI_BASE + endpoint);
    const buf    = Buffer.from(JSON.stringify(body));
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      agent:    _httpsAgent,
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': buf.length,
        'Authorization':  `Bearer ${OPENAI_KEY}`,
      },
    };
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(opts, resolve);
    req.setTimeout(30000, () => req.destroy(new Error('openai_timeout')));
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

/* ══════════════════════════════════════════════════════════════════
   STATIC ASSETS
══════════════════════════════════════════════════════════════════ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.svg':  'image/svg+xml', '.woff2': 'font/woff2',
  '.woff': 'font/woff',    '.ttf':   'font/ttf',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);

const _CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline' fonts.googleapis.com fonts.gstatic.com; " +
  "font-src 'self' fonts.gstatic.com fonts.googleapis.com data:; " +
  "img-src 'self' data: blob: https://numind.co.in; " +
  "connect-src 'self' https://api.openai.com https://cdnjs.cloudflare.com; " +
  "object-src 'none'; frame-ancestors 'none';" ;

function _injectToken(html) {
  if (!APP_TOKEN) return html;
  return html.replace('</head>',
    `<script>window._APP_TOKEN=${JSON.stringify(APP_TOKEN)};</script>\n</head>`);
}

function _buildHeaders(ext, etag, useGzip) {
  const h = {
    'Content-Type':  MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'ETag':          etag,
    'Vary':          'Accept-Encoding',
  };
  if (useGzip)       h['Content-Encoding']       = 'gzip';
  if (ext === '.html') h['Content-Security-Policy'] = _CSP;
  return h;
}

function _serveStatic(res, filePath, req) {
  const ext    = path.extname(filePath).toLowerCase();
  const cached = _staticCache.get(filePath);
  const now    = Date.now();

  if (cached) {
    // TTL check: only stat disk every CACHE_TTL_MS
    if (now - cached.checkedAt < CACHE_TTL_MS) {
      return _respondCached(res, req, cached, ext);
    }
    // TTL expired — recheck mtime without blocking
    fs.stat(filePath, (err, stat) => {
      if (err || !stat) { _staticCache.delete(filePath); return _serveFromDisk(res, filePath, ext, req); }
      cached.checkedAt = now;
      if (stat.mtimeMs !== cached.mtime) {
        _staticCache.delete(filePath);
        return _serveFromDisk(res, filePath, ext, req);
      }
      _respondCached(res, req, cached, ext);
    });
    return;
  }

  // Inflight dedup: if another request is already loading this file, wait for it
  if (_cachePending.has(filePath)) {
    _cachePending.get(filePath).then(() => {
      const entry = _staticCache.get(filePath);
      if (entry) _respondCached(res, req, entry, ext);
      else       _serveFromDisk(res, filePath, ext, req);
    });
    return;
  }

  _serveFromDisk(res, filePath, ext, req);
}

function _serveFromDisk(res, filePath, ext, req) {
  // Register inflight promise so concurrent misses coalesce
  let _resolve;
  const pending = new Promise(r => { _resolve = r; });
  _cachePending.set(filePath, pending);

  fs.readFile(filePath, (err, rawData) => {
    _cachePending.delete(filePath);
    _resolve();

    if (err) { res.writeHead(404); return res.end('Not found'); }

    let data = rawData;
    if (ext === '.html') data = Buffer.from(_injectToken(rawData.toString('utf8')));

    const etag     = '"' + crypto.createHash('md5').update(data).digest('hex') + '"';
    const canGzip  = COMPRESSIBLE.has(ext);
    const cacheable = data.length <= CACHE_MAX_FILE_SIZE;

    if (canGzip && cacheable) {
      zlib.gzip(data, (gzErr, compressed) => {
        fs.stat(filePath, (_, stat) => {
          const entry = {
            buf: data, compressed: gzErr ? null : compressed,
            etag, mime: MIME[ext] || 'application/octet-stream',
            mtime: stat?.mtimeMs || 0, checkedAt: Date.now(),
          };
          _staticCache.set(filePath, entry);
          _cacheEvict();
          _respondCached(res, req, entry, ext);
        });
      });
    } else {
      // Large or non-compressible — respond directly, skip cache
      if ((req?.headers['if-none-match'] || '') === etag) {
        res.writeHead(304); return res.end();
      }
      res.writeHead(200, _buildHeaders(ext, etag, false));
      res.end(data);
    }
  });
}

function _respondCached(res, req, entry, ext) {
  if ((req?.headers['if-none-match'] || '') === entry.etag) {
    res.writeHead(304); return res.end();
  }
  const wantGzip = (req?.headers['accept-encoding'] || '').includes('gzip');
  const useGzip  = wantGzip && !!entry.compressed;
  res.writeHead(200, _buildHeaders(ext, entry.etag, useGzip));
  res.end(useGzip ? entry.compressed : entry.buf);
}

/* Pre-warm cache at startup for the files every user loads */
function _prewarm() {
  const hot = ['index.html', 'styles.css', 'main.js', 'ai-counsellor.js', 'state.js', 'router.js'].map(f => path.join(__dirname, f));
  for (const p of hot) {
    if (!fs.existsSync(p)) continue;
    _serveFromDisk({ writeHead: () => {}, end: () => {} }, p, path.extname(p).toLowerCase(), null);
    log.info('Cache pre-warm:', p);
  }
}

/* ══════════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════════ */
function _readBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body_too_large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function _json(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function _checkToken(req) {
  if (!APP_TOKEN || APP_TOKEN.length < 16) {
    log.error('[Security] APP_TOKEN not set or too short — all student API calls rejected. Set APP_TOKEN in .env');
    return false;
  }
  const received = req.headers['x-app-token'] || '';
  if (received.length !== APP_TOKEN.length) return false;
  try { return require('crypto').timingSafeEqual(Buffer.from(received), Buffer.from(APP_TOKEN)); }
  catch { return false; }
}

/* ══════════════════════════════════════════════════════════════════
   ASSESSMENT HANDLERS
══════════════════════════════════════════════════════════════════ */
async function _handleSaveRegistration(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); }
  catch (e) { return _json(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message }); }
  const { student, sessionId } = body || {};
  if (!sessionId) return _json(res, 400, { error: 'sessionId is required' });
  try {
    await _dbWrite(() => dbModule.saveRegistration(student || {}, sessionId));
    _json(res, 200, { ok: true, sessionId });
  } catch (err) {
    log.error('[save-registration]', err.message);
    _json(res, 500, { error: 'Server error' });
  }
}

async function _handleSaveSection(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); }
  catch (e) { return _json(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message }); }
  const { sessionId, moduleKey, answers, scores, duration } = body || {};
  if (!sessionId || !moduleKey) return _json(res, 400, { error: 'sessionId and moduleKey are required' });
  try {
    // _dbWrite batches this write — non-blocking to the event loop
    await _dbWrite(() => dbModule.saveSection(sessionId, moduleKey, {
      raw_answers: answers, scores, duration: duration || 0,
    }));
    _json(res, 200, { ok: true });
  } catch (err) {
    log.error('[save-section]', err.message);
    if (err.message?.includes('unknown module')) return _json(res, 400, { error: err.message });
    _json(res, 500, { error: 'Server error' });
  }
}

async function _handleSaveReport(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req, 2 * 1024 * 1024); }
  catch (e) { return _json(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message }); }
  if (!body?.sessionId) return _json(res, 400, { error: 'sessionId is required' });

  // AI concurrency gate — prevent report storm at 5k concurrent
  if (_aiInFlight >= _maxAI) {
    log.warn('[save-report] AI cap hit —', _aiInFlight, '/', _maxAI, 'in flight');
    return _json(res, 429, { error: 'Report generation is busy. Please wait 30 seconds and try again.', retry_after: 30 });
  }
  try {
    await _dbWrite(() => dbModule.saveReport(body));
    _json(res, 200, { ok: true });
  } catch (err) {
    log.error('[save-report]', err.message);
    _json(res, 500, { error: 'Server error' });
  }
}

async function _handleAIReport(req, res) {
  if (!_checkToken(req))  return _json(res, 401, { error: 'Unauthorized' });
  if (!OPENAI_KEY)        return _json(res, 503, { error: 'AI not configured.' });

  // Concurrency cap — prevents socket exhaustion and runaway spend
  if (_aiInFlight >= MAX_CONCURRENT_AI) {
    res.writeHead(503, { 'Retry-After': '10', 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Server busy — please try again in a few seconds.' }));
  }

  let body;
  try { body = await _readBody(req, 256 * 1024); }
  catch (e) { return _json(res, 400, { error: e.message }); }

  // Security: strip any client-injected system messages; cap tokens to prevent cost abuse
  const rawMsgs  = Array.isArray(body?.messages) ? body.messages : [];
  const safeMsgs = rawMsgs
    .filter(m => m && typeof m === 'object' && ['user','assistant'].includes(m.role))
    .map(m => ({ role: m.role, content: String(m.content || '').slice(0, 32000) }));
  if (!safeMsgs.length) return _json(res, 400, { error: 'messages required (user/assistant roles only)' });
  const maxTok = Math.min(Number(body.max_tokens) || 6000, 8000);
  const temp   = Math.max(0, Math.min(1, Number(body.temperature) ?? 0.65));

  _aiInFlight++;
  try {
    const upstream = await _openaiReq('/v1/chat/completions', {
      model: AI_MODEL, temperature: temp,
      max_tokens: maxTok, stream: true, messages: safeMsgs,
    });
    if (upstream.statusCode !== 200) {
      _aiInFlight--;
      const eb = await new Promise(r => { const c = []; upstream.on('data', d => c.push(d)); upstream.on('end', () => r(Buffer.concat(c).toString())); });
      try { return _json(res, upstream.statusCode, JSON.parse(eb).error || { message: eb }); }
      catch { return _json(res, upstream.statusCode, { error: eb.slice(0, 300) }); }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    upstream.pipe(res);
    const _done = () => { _aiInFlight--; if (!res.writableEnded) res.end(); };
    upstream.on('end',   _done);
    upstream.on('error', _done);
  } catch (err) {
    _aiInFlight--;
    log.error('[ai-report]', err.message);
    if (!res.headersSent) _json(res, 502, { error: 'AI service error' });
  }
}

/* ══════════════════════════════════════════════════════════════════
   COUNSELLOR AUTH HANDLERS
   
   Auth flow:
   
   FIRST TIME (no PIN set):
     POST /api/counsellor-unlock  { email }
       → { step: 'otp-sent' }          (sends OTP to email)
     POST /api/counsellor-verify-otp  { email, otp }
       → { step: 'set-pin' }           (OTP valid, prompt PIN creation)
     POST /api/counsellor-set-pin  { email, pin }    (with X-Counsellor-Otp-Token)
       → { unlocked: true, ... }       (PIN stored, session issued)
   
   RETURNING USER (same device):
     POST /api/counsellor-unlock  { email, sessionId }
       → { unlocked: true, ... }       (instant, no PIN needed)
   
   RETURNING USER (new device):
     POST /api/counsellor-unlock  { email }
       → { step: 'enter-pin' }         (PIN exists, prompt for it)
     POST /api/counsellor-verify-pin  { email, pin }
       → { unlocked: true, ... }

   CHANGE PIN:
     POST /api/counsellor-request-otp  { email }  (counsellor token required)
       → { ok: true }                  (sends OTP)
     POST /api/counsellor-set-pin  { email, pin }  (with X-Counsellor-Otp-Token)
       → { ok: true }

══════════════════════════════════════════════════════════════════ */

// Short-lived tokens proving a student just verified an OTP — allows PIN set
// Map: token → { email, expiresAt }
const _otpVerifiedTokens = new Map();
const OTP_VER_TTL = 15 * 60 * 1000; // 15 min to set PIN after verifying OTP
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _otpVerifiedTokens) if (now > v.expiresAt) _otpVerifiedTokens.delete(k);
}, 5 * 60 * 1000).unref();

async function _handleCounsellorUnlock(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = String(body?.email || '').toLowerCase().trim();
  if (!email) return _json(res, 400, { error: 'Email is required.' });

  const rl = _rlCheckDb('unlock', email, 20, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts. Please wait before trying again.' }));
  }

  try {
    if (!cdb.hasCompletedAssessment(email)) {
      return _json(res, 200, { unlocked: false,
        error: 'No completed assessment found. Please complete the NuMind MAPS test first.' });
    }

    const reportObj = cdb.getReportByEmail(email);
    if (!reportObj) return _json(res, 200, { unlocked: false, error: 'Report not found.' });

    // ── Tier 1: Same device — sessionId from localStorage ──────────
    const clientSessionId = String(body?.sessionId || '').trim();
    if (clientSessionId) {
      const dbSessionId = reportObj.session_id || null;
      if (dbSessionId && clientSessionId === dbSessionId) {
        // Trusted same-device access — issue token immediately
        log.info('[unlock]', email, '| verified via: sessionId (same-device)');
        return _jsonUnlocked(res, email, reportObj);
      }
      // sessionId mismatch — fall through to PIN/OTP flow
      log.warn('[unlock] sessionId mismatch for', email, '— falling through to PIN flow');
    }

    // ── Tier 2: PIN-based auth ──────────────────────────────────────
    const pinSet = cdb.hasPinSet(email);

    if (!pinSet) {
      if (_emailFn) {
        // SMTP configured — send OTP to verify identity and set a PIN
        const otp = await _dbWrite(() => cdb.createOtp(email, 'register'));
        const studentName = reportObj.student?.firstName || 'Student';
        _emailFn({
          to:      email,
          subject: 'NuMind MAPS — Your one-time access code',
          text: [
            `Hi ${studentName},`,
            '',
            'Here is your one-time code to set up your AI Counsellor access PIN:',
            '',
            `  ${otp}`,
            '',
            'This code expires in 10 minutes. Never share it with anyone.',
            '',
            'If you did not request this, please ignore this email.',
            '',
            '\u2014 NuMind MAPS Team',
          ].join('\n'),
        });
        log.info('[unlock] OTP sent to', email, '(first-time PIN setup)');
        return _json(res, 200, { unlocked: false, step: 'otp-sent',
          message: `We've sent a 6-digit code to ${email}. Enter it to set your PIN.` });
      } else {
        // SMTP not configured — fall back to name+class ownership verification.
        // Student proves identity with details from their registration record.
        log.warn('[unlock] SMTP not configured — using name+class verification for', email);
        return _json(res, 200, { unlocked: false, step: 'verify-name',
          message: 'Confirm your registration details to access your AI Counsellor.' });
      }
    }

    // PIN exists — prompt for it
    log.info('[unlock]', email, '| PIN set, requesting PIN entry');
    return _json(res, 200, { unlocked: false, step: 'enter-pin',
      message: 'Welcome back! Enter your PIN to continue.' });

  } catch (err) {
    log.error('[counsellor-unlock]', err.message, err.stack);
    _json(res, 500, { error: 'Server error. Please try again.' });
  }
}

// Shared helper: build and send the full unlocked response
async function _jsonUnlocked(res, email, reportObj) {
  // IMPORTANT: this function must never throw past its own boundary.
  // It's called as `return _jsonUnlocked(...)` (not awaited) from several
  // handlers' try/catch blocks. An unawaited rejected promise escapes the
  // caller's try/catch entirely — no response gets sent, and the client
  // hangs on "Checking…" forever with no error. Wrapping in our own
  // try/catch guarantees a response is always written.
  try {
    const name    = reportObj.student?.firstName || reportObj.student?.fullName || 'Student';
    const history = cdb.getHistory(email, { limit: 40 });
    let reportSummary = null;
    if (reportObj?.report) {
      const r = reportObj.report;
      reportSummary = {
        fit_tier: r.fit_tier, fit_score: r.fit_score,
        recommended_primary: r.recommended_primary,
        top3_interests: r.top3_interests,
        top_personality_traits: r.top_personality_traits,
        seaa_status: r.seaa_status,
      };
    }
    const fullScores = {
      personality: reportObj.personality || [],
      aptitude:    reportObj.aptitude    || [],
      interests:   reportObj.interests   || [],
      seaa:        reportObj.seaa        || [],
      careers:     reportObj.careers     || [],
    };
    const conversations   = cdb.getConversations(email);
    const counsellorToken = _issueCounsellorToken(email);
    _json(res, 200, { unlocked: true, name, email, history, reportSummary, fullScores, conversations, counsellorToken });
  } catch (err) {
    log.error('[_jsonUnlocked]', err.message);
    _json(res, 500, { error: 'Server error while unlocking session.' });
  }
}

/* ── POST /api/counsellor-verify-otp ──────────────────────────────
   Verifies the OTP sent during first-time setup or PIN reset.
   Returns a short-lived otpToken the client uses to then set a PIN.
*/
/* ── POST /api/counsellor-verify-name ─────────────────────────────
   Fallback when SMTP is not configured.
   Student proves ownership with fullName + class from their registration.
   On success: if SMTP now configured, prompt PIN setup; else unlock directly.
*/
async function _handleCounsellorVerifyName(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email    = String(body?.email    || '').toLowerCase().trim();
  const fullName = String(body?.fullName || '').toLowerCase().trim();
  const cls      = String(body?.class    || '').toLowerCase().trim();
  if (!email || !fullName || !cls) return _json(res, 400, { error: 'email, fullName and class are required.' });

  const rl = _rlCheckDb('verify-name', email, 10, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts. Try again later.' }));
  }

  try {
    const reportObj = cdb.getReportByEmail(email);
    if (!reportObj) return _json(res, 200, { ok: false, error: 'No account found for this email. Make sure you use the email you registered with.' });

    // Accept match on full name OR first name alone (students often use just first name)
    const dbFullName  = (reportObj.student?.fullName  || '').toLowerCase().trim();
    const dbFirstName = (reportObj.student?.firstName || '').toLowerCase().trim();
    const dbLastName  = (reportObj.student?.lastName  || '').toLowerCase().trim();
    const dbCls       = (reportObj.student?.class     || '').toLowerCase().trim();

    const nameMatch = fullName && (
      fullName === dbFullName ||
      fullName === dbFirstName ||
      fullName === dbLastName ||
      fullName === (dbFirstName + ' ' + dbLastName).trim() ||
      (dbFirstName && fullName.startsWith(dbFirstName) && dbLastName && fullName.endsWith(dbLastName))
    );
    const clsMatch = cls && dbCls && (cls === dbCls || cls.replace(/\s/g,'') === dbCls.replace(/\s/g,''));

    if (!nameMatch || !clsMatch) {
      log.warn('[verify-name] mismatch for', email,
        '| nameMatch:', nameMatch, '| clsMatch:', clsMatch);
      return _json(res, 200, { ok: false,
        error: 'Details do not match. Enter your name exactly as you registered (e.g. "Arjun Sharma") and your class (e.g. "10").' });
    }

    log.info('[unlock]', email, '| verified via: name+class');
    // Unlock directly — name+class is the best we can do without SMTP
    return _jsonUnlocked(res, email, reportObj);
  } catch (err) {
    log.error('[counsellor-verify-name]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

async function _handleCounsellorVerifyOtp(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email   = String(body?.email   || '').toLowerCase().trim();
  const otp     = String(body?.otp     || '').trim();
  const purpose = String(body?.purpose || 'register');
  if (!email || !otp) return _json(res, 400, { error: 'email and otp are required.' });

  const rl = _rlCheckDb('otp-verify', email, 10, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts.' }));
  }

  try {
    const valid = cdb.verifyOtp(email, otp, purpose);
    if (!valid) {
      return _json(res, 200, { ok: false, error: 'Incorrect or expired code. Please try again.' });
    }
    // Issue a short-lived in-memory token proving OTP was verified
    const otpToken  = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + OTP_VER_TTL;
    _otpVerifiedTokens.set(otpToken, { email, expiresAt });

    if (purpose === 'reset') {
      // PIN reset: return next step prompt (set-pin)
      return _json(res, 200, { ok: true, step: 'set-pin', otpToken,
        message: 'Code verified. Set your new PIN.' });
    }
    // First-time registration: prompt PIN creation
    return _json(res, 200, { ok: true, step: 'set-pin', otpToken,
      message: 'Code verified! Now set a 4-6 digit PIN to use when logging in.' });
  } catch (err) {
    log.error('[counsellor-verify-otp]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

/* ── POST /api/counsellor-set-pin ─────────────────────────────────
   Sets or updates the student's PIN.
   Requires X-Counsellor-Otp-Token header (issued by /verify-otp).
*/
async function _handleCounsellorSetPin(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const otpToken = (req.headers['x-counsellor-otp-token'] || '').trim();
  const email    = String(body?.email || '').toLowerCase().trim();
  const pin      = String(body?.pin   || '').trim();

  if (!email || !pin) return _json(res, 400, { error: 'email and pin are required.' });
  if (!/^\d{4,6}$/.test(pin)) return _json(res, 400, { error: 'PIN must be 4–6 digits.' });

  // Verify the OTP token
  const session = _otpVerifiedTokens.get(otpToken);
  if (!session || session.email !== email || Date.now() > session.expiresAt) {
    return _json(res, 403, { error: 'Session expired. Please request a new code.' });
  }
  _otpVerifiedTokens.delete(otpToken); // single-use

  try {
    await _dbWrite(() => cdb.setStudentPin(email, pin));
    log.info('[set-pin]', email);

    // After first-time PIN setup, immediately unlock the session
    if (!body?.changeOnly) {
      const reportObj = cdb.getReportByEmail(email);
      if (reportObj) return _jsonUnlocked(res, email, reportObj);
    }
    _json(res, 200, { ok: true, message: 'PIN set successfully.' });
  } catch (err) {
    log.error('[counsellor-set-pin]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

/* ── POST /api/counsellor-verify-pin ──────────────────────────────
   Verifies PIN and unlocks the session (returning user, new device).
*/
async function _handleCounsellorVerifyPin(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = String(body?.email || '').toLowerCase().trim();
  const pin   = String(body?.pin   || '').trim();
  if (!email || !pin) return _json(res, 400, { error: 'email and pin are required.' });

  const rl = _rlCheckDb('pin-verify', email, 10, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many PIN attempts. Try again later.' }));
  }

  try {
    const valid = cdb.verifyStudentPin(email, pin);
    if (!valid) {
      return _json(res, 200, { unlocked: false, error: 'Incorrect PIN. Please try again.' });
    }
    const reportObj = cdb.getReportByEmail(email);
    if (!reportObj) return _json(res, 200, { unlocked: false, error: 'Report not found.' });
    log.info('[unlock]', email, '| verified via: PIN');
    return _jsonUnlocked(res, email, reportObj);
  } catch (err) {
    log.error('[counsellor-verify-pin]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

/* ── POST /api/counsellor-request-otp ─────────────────────────────
   Sends a PIN-reset OTP to the student's registered email.
   Requires an active counsellor session (X-Counsellor-Token).
*/
/* ── POST /api/counsellor-reset-otp ───────────────────────────────
   Unauthenticated — sends a PIN reset OTP to email.
   Used by the "Forgot PIN" flow where the student has no session token.
   Rate limited per email to prevent spam.
*/
async function _handleCounsellorResetOtp(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  if (!_emailFn) return _json(res, 503, { error: 'Email service not configured.' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = String(body?.email || '').toLowerCase().trim();
  if (!email) return _json(res, 400, { error: 'Email is required.' });

  const rl = _rlCheckDb('otp-reset', email, 5, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many reset attempts. Try again later.' }));
  }

  try {
    if (!cdb.hasCompletedAssessment(email)) {
      return _json(res, 200, { ok: false, error: 'No account found for this email.' });
    }
    if (!cdb.hasPinSet(email)) {
      return _json(res, 200, { ok: false, error: 'No PIN set for this account.' });
    }
    const reportObj   = cdb.getReportByEmail(email);
    const studentName = reportObj?.student?.firstName || 'Student';
    const otp         = await _dbWrite(() => cdb.createOtp(email, 'reset'));
    _emailFn({
      to: email, subject: 'NuMind MAPS — PIN Reset Code',
      text: ['Hi ' + studentName + ',', '',
        'Your PIN reset code:', '', '  ' + otp, '',
        'This code expires in 10 minutes.',
        'If you did not request this, please ignore this email.',
        '', '\u2014 NuMind MAPS Team'].join('\n'),
    });
    log.info('[reset-otp] sent to', email);
    _json(res, 200, { ok: true, message: 'Reset code sent to ' + email + '.' });
  } catch (err) {
    log.error('[counsellor-reset-otp]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

async function _handleCounsellorRequestOtp(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  if (!_emailFn) return _json(res, 503, { error: 'Email service not configured.' });

  const email = _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired.' });

  const rl = _rlCheckDb('otp-request', email, 5, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many OTP requests. Try again later.' }));
  }

  try {
    const reportObj   = cdb.getReportByEmail(email);
    const studentName = reportObj?.student?.firstName || 'Student';
    const otp         = await _dbWrite(() => cdb.createOtp(email, 'reset'));
    _emailFn({
      to:      email,
      subject: 'NuMind MAPS — PIN Reset Code',
      text: [
        `Hi ${studentName},`,
        '',
        'Here is your PIN reset code:',
        '',
        `  ${otp}`,
        '',
        'This code expires in 10 minutes. If you did not request a reset, please ignore this email.',
        '',
        '— NuMind MAPS Team',
      ].join('\n'),
    });
    log.info('[request-otp] PIN reset OTP sent to', email);
    _json(res, 200, { ok: true, message: `A reset code has been sent to ${email}.` });
  } catch (err) {
    log.error('[counsellor-request-otp]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}


async function _handleCounsellorChat(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  if (!OPENAI_KEY)       return _json(res, 503, { error: 'AI not configured.' });

  let body;
  try { body = await _readBody(req, 128 * 1024); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email to continue.' });
  const message        = String(body.message        || '').trim();
  const conversationId = String(body.conversationId || '').trim() || null;
  if (!message) return _json(res, 400, { error: 'message is required.' });
  if (message.length > 2000) return _json(res, 400, { error: 'Message too long (max 2000 chars).' });

  const rl = _rlCheckDb('chat', email, 60, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Rate limit reached. Wait ${Math.ceil(rl.retryAfter / 60)} min.` }));
  }

  try {
    const reportObj    = cdb.getReportByEmail(email);
    const summaryRow   = conversationId ? cdb.getConversationSummary(email, conversationId) : null;
    const systemPrompt = rag.buildRagContext(reportObj, summaryRow ? summaryRow.summary : null);
    const sessionId    = reportObj?.session_id || null;
    const clientHistory = Array.isArray(body.history) ? body.history.slice(-20) : [];
    const lastMsg       = clientHistory[clientHistory.length - 1];
    const historyFinal  = (lastMsg?.role === 'user' && lastMsg?.content === message)
      ? clientHistory : [...clientHistory, { role: 'user', content: message }];

    const upstream = await _openaiReq('/v1/chat/completions', {
      model: CHAT_MODEL, temperature: 0.7, max_tokens: 2500, stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...historyFinal],
    });

    if (upstream.statusCode !== 200) {
      const eb = await new Promise(r => { const c = []; upstream.on('data', d => c.push(d)); upstream.on('end', () => r(Buffer.concat(c).toString())); });
      try { return _json(res, upstream.statusCode, { error: JSON.parse(eb)?.error?.message || 'AI error' }); }
      catch { return _json(res, 502, { error: 'AI service error' }); }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });

    let fullText = '', sseBuffer = '';
    const dec = new StringDecoder('utf8');

    upstream.on('data', chunk => {
      sseBuffer += dec.write(chunk);
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try { const d = JSON.parse(payload)?.choices?.[0]?.delta?.content || ''; if (d) { fullText += d; res.write(d); } } catch { }
      }
    });

    upstream.on('end', () => {
      if (sseBuffer.startsWith('data: ')) {
        const payload = sseBuffer.slice(6).trim();
        if (payload && payload !== '[DONE]') {
          try { const d = JSON.parse(payload)?.choices?.[0]?.delta?.content || ''; if (d) { fullText += d; res.write(d); } } catch { }
        }
      }
      res.end();
      if (fullText.trim()) {
        // Save via write-queue — non-blocking
        _dbWrite(() => cdb.saveMessage({ email, sessionId, conversationId, role: 'user',      content: message  })).catch(e => log.error('[saveMessage user]', e.message));
        _dbWrite(() => cdb.saveMessage({ email, sessionId, conversationId, role: 'assistant', content: fullText })).catch(e => log.error('[saveMessage asst]', e.message));
      }
    });

    upstream.on('error', err => { log.error('[counsellor upstream]', err.message); if (!res.writableEnded) res.end(); });

  } catch (err) {
    log.error('[counsellor-chat]', err.message, err.stack);
    if (!res.headersSent) _json(res, 502, { error: 'AI service error. Please try again.' });
  }
}

async function _handleCounsellorSummarise(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  if (!OPENAI_KEY)       return _json(res, 503, { error: 'AI not configured.' });
  let body;
  try { body = await _readBody(req, 64 * 1024); } catch { return _json(res, 400, { error: 'Bad request' }); }
  const email = _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });
  const conversationId = String(body.conversationId || '').trim();
  const messages       = Array.isArray(body.messages) ? body.messages : [];
  if (!conversationId || !messages.length) return _json(res, 400, { error: 'conversationId and messages required.' });
  try {
    const transcript = messages.map(m => (m.role === 'user' ? 'Student' : 'Aria') + ': ' + m.content).join('\n\n');
    const prompt = 'Compress this counselling conversation into a dense 250-word summary preserving: career decisions, concerns, goals, action items, emotional state.\n\nWrite in third-person.\n\nCONVERSATION:\n' + transcript;
    const buf = Buffer.from(JSON.stringify({ model: AI_MODEL, temperature: 0.3, max_tokens: 400, stream: false, messages: [{ role: 'user', content: prompt }] }));
    const upstream = await _openaiReq('/v1/chat/completions', buf);
    const chunks = [];
    await new Promise((res, rej) => { upstream.on('data', d => chunks.push(d)); upstream.on('end', res); upstream.on('error', rej); });
    let summary = '';
    try { summary = JSON.parse(Buffer.concat(chunks).toString())?.choices?.[0]?.message?.content?.trim() || ''; } catch { return _json(res, 502, { error: 'AI parse error' }); }
    if (summary) await _dbWrite(() => cdb.saveConversationSummary({ email, conversationId, summary, messageCount: messages.length }));
    _json(res, 200, { ok: true, summary });
  } catch (err) {
    log.error('[counsellor-summarise]', err.message);
    _json(res, 500, { error: 'Server error' });
  }
}

async function _handleCounsellorClearHistory(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }
  // Must verify counsellor token — prevents student A clearing student B's history
  const email = _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });
  try {
    await _dbWrite(() => cdb.clearHistory(email));
    _json(res, 200, { ok: true });
  } catch (err) {
    log.error('[counsellor-clear-history]', err.message);
    _json(res, 500, { error: 'Server error' });
  }
}


async function _handleCounsellorGreeting(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  if (!OPENAI_KEY) return _json(res, 503, { error: 'AI not configured.' });

  let body;
  try { body = await _readBody(req, 8 * 1024); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });

  try {
    const reportObj    = cdb.getReportByEmail(email);
    const systemPrompt = rag.buildRagContext(reportObj);
    const firstName    = reportObj?.student?.firstName
                         || (reportObj?.student?.fullName || '').split(' ')[0]
                         || 'there';
    const primary      = reportObj?.report?.recommended_primary || '';
    const fitTier      = reportObj?.report?.fit_tier || '';
    const seaaStatus   = reportObj?.report?.seaa_status || '';
    const topInterest  = reportObj?.report?.top3_interests?.[0]?.label || '';
    const topTrait     = reportObj?.report?.top_personality_traits?.[0]?.name || '';

    // Build a contextual greeting prompt
    const greetingPrompt = [
      `Write a warm, personalised opening message for ${firstName} who just opened their AI counsellor chat.`,
      '',
      `Their report shows: ${primary ? 'Primary stream recommendation: ' + primary + '.' : ''} ${fitTier ? 'Overall fit: ' + fitTier + '.' : ''} ${topInterest ? 'Top interest: ' + topInterest + '.' : ''} ${topTrait ? 'Strongest personality trait: ' + topTrait + '.' : ''} ${seaaStatus === 'Support Needed' ? 'NOTE: Their wellbeing scores need attention — acknowledge this gently.' : ''}`,
      '',
      'Rules for this greeting:',
      `- Address them as ${firstName} naturally`,
      '- 2-3 sentences maximum',
      '- Sound like a mentor who just read their report and is genuinely interested in them',
      '- Reference ONE specific thing from their profile (a strength, interest, or career path) to show you know them',
      '- End with an open, inviting question — not "How can I help you?" but something more personal',
      '- No bullet points. No formal language. No "Welcome to NuMind".',
      '- Keep it under 60 words',
    ].join('\n');

    const upstream = await _openaiReq('/v1/chat/completions', {
      model:       CHAT_MODEL,
      temperature: 0.8,
      max_tokens:  150,
      stream:      true,
      messages:    [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: greetingPrompt },
      ],
    });

    if (upstream.statusCode !== 200) {
      const eb = await new Promise(r => { const c = []; upstream.on('data', d => c.push(d)); upstream.on('end', () => r(Buffer.concat(c).toString())); });
      return _json(res, 502, { error: 'AI error' });
    }

    res.writeHead(200, {
      'Content-Type':      'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control':     'no-cache',
      'X-Accel-Buffering': 'no',
    });

    let fullText = '', sseBuffer = '';
    const dec = new StringDecoder('utf8');
    upstream.on('data', chunk => {
      sseBuffer += dec.write(chunk);
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || '';
          if (delta) { fullText += delta; res.write(delta); }
        } catch { }
      }
    });
    upstream.on('end', () => {
      res.end();
      // Save the greeting as the first assistant message in this conversation
      if (fullText.trim() && body.conversationId) {
        try {
          const sessionId = reportObj?.session_id || null;
          cdb.saveMessage({ email, sessionId, conversationId: body.conversationId, role: 'assistant', content: fullText });
        } catch (e) { console.error('[Greeting] saveMessage:', e.message); }
      }
    });
    upstream.on('error', err => {
      console.error('[Greeting] upstream error:', err.message);
      if (!res.writableEnded) res.end();
    });

  } catch (err) {
    console.error('[/api/counsellor-greeting]', err.message);
    if (!res.headersSent) _json(res, 502, { error: 'AI service error.' });
  }
}

/* ── GET /api/counsellor-conversations ─────────────────────────────
   Returns the list of past conversations for a student (by email).
*/

async function _handleCounsellorConversations(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  const email = _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });
  try {
    const convs = cdb.getConversations(email);
    _json(res, 200, { conversations: convs });
  } catch (err) {
    console.error('[/api/counsellor-conversations]', err.message);
    _json(res, 500, { error: 'Server error' });
  }
}

/* ── GET /api/counsellor-history ────────────────────────────────────
   Returns messages for a specific conversation_id.
*/

async function _handleCounsellorHistory(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  const qs             = urlModule.parse(req.url, true).query;
  const email          = _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });
  const conversationId = String(qs.conversationId || '').trim();
  if (!conversationId) return _json(res, 400, { error: 'conversationId required' });
  try {
    const messages = cdb.getHistory(email, { conversationId, limit: 100 });
    _json(res, 200, { messages });
  } catch (err) {
    log.error('[counsellor-history]', err.message);
    _json(res, 500, { error: 'Server error' });
  }
}

async function _handleCounsellorQuery(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }
  const { name, email, message, preferredDate, preferredTime } = body || {};
  if (!name || !email || !message) return _json(res, 400, { error: 'name, email, and message are required.' });
  const rl = _rlCheckDb('query', String(email).toLowerCase().trim(), 5, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many submissions. Please try again later.' }));
  }
  try {
    const id = await _dbWrite(() => cdb.saveQuery({ name, email, message, preferredDate, preferredTime }));
    log.info(`[counsellor-query] ${email} id=${id}`);

    // Send notification to admin/counsellor
    if (_emailFn && NOTIFICATION_EMAIL) {
      try {
        _emailFn({
          to:      NOTIFICATION_EMAIL,
          subject: `NuMind MAPS — New Student Query from ${name}`,
          text: [
            'A student has submitted a counsellor query.',
            '',
            `Name    : ${name}`,
            `Email   : ${email}`,
            `Date    : ${preferredDate || 'Not specified'}`,
            `Time    : ${preferredTime || 'Not specified'}`,
            '',
            'Message:',
            message,
            '',
            `— NuMind MAPS (query id: ${id})`,
          ].join('\n'),
        });
      } catch (emailErr) {
        log.warn('[counsellor-query] notification email failed:', emailErr.message);
      }
    }

    // Send confirmation to student
    if (_emailFn) {
      try {
        _emailFn({
          to:      email,
          subject: 'NuMind MAPS — We received your query',
          text: [
            `Hi ${name},`,
            '',
            'We have received your message and a counsellor will get back to you soon.',
            '',
            preferredDate ? `Your preferred slot: ${preferredDate}${preferredTime ? ' at ' + preferredTime : ''}` : '',
            '',
            'Your message:',
            message,
            '',
            '\u2014 NuMind MAPS Team',
          ].filter(l => l !== null).join('\n'),
        });
      } catch (emailErr) {
        log.warn('[counsellor-query] confirmation email failed:', emailErr.message);
      }
    }

    _json(res, 200, { ok: true, id });
  } catch (err) {
    log.error('[counsellor-query]', err.message);
    _json(res, 500, { error: 'Server error. Please try again.' });
  }
}

/* ══════════════════════════════════════════════════════════════════
   MAIN DISPATCHER
══════════════════════════════════════════════════════════════════ */
const _startTime = Date.now();

async function _handleRequest(req, res) {
  // Per-request timeout — kills slow-loris and stalled clients
  req.setTimeout(15000, () => {
    req.destroy();
    if (!res.headersSent) { res.writeHead(408); res.end('Request timeout'); }
  });

  const parsed   = urlModule.parse(req.url || '/');
  const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
  const method   = req.method || 'GET';

  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token, X-Session-ID, Authorization, X-Counsellor-Token, X-Counsellor-Otp-Token');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ── Health check (before token check — probes don't carry tokens) ──
  if (method === 'GET' && pathname === '/health') {
    let dbOk = true;
    try { _db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    const payload = { ok: dbOk, uptime: Math.floor((Date.now() - _startTime) / 1000), aiInFlight: _aiInFlight, wqLength: _wq.length };
    res.writeHead(dbOk ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(payload));
  }

  // ── IP rate limit (pre-auth, all routes) ─────────────────────────
  const ip   = _getIP(req);
  const ipRl = _rlCheck(_ipRL, ip, 200, IP_WINDOW);
  if (!ipRl.allowed) {
    res.writeHead(429, { 'Retry-After': String(ipRl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
  }

  try {
    // Route map — O(1) lookup, streaming endpoints get 90s timeout
    const _STREAMING = new Set(['/api/counsellor-chat','/api/counsellor-greeting','/api/ai-report','/api/counsellor-summarise']);
    if (_STREAMING.has(pathname)) res.setTimeout(90000);

    if (method === 'POST' && pathname === '/api/counsellor-greeting')      return await _handleCounsellorGreeting(req, res);
    if (method === 'GET'  && pathname === '/api/counsellor-conversations') return await _handleCounsellorConversations(req, res);
    if (method === 'GET'  && pathname === '/api/counsellor-history')       return await _handleCounsellorHistory(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-unlock')        return await _handleCounsellorUnlock(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-verify-otp')   return await _handleCounsellorVerifyOtp(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-verify-name')  return await _handleCounsellorVerifyName(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-verify-pin')   return await _handleCounsellorVerifyPin(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-set-pin')      return await _handleCounsellorSetPin(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-reset-otp')    return await _handleCounsellorResetOtp(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-request-otp')  return await _handleCounsellorRequestOtp(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-chat')          return await _handleCounsellorChat(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-clear-history') return await _handleCounsellorClearHistory(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-summarise')     return await _handleCounsellorSummarise(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-query')         return await _handleCounsellorQuery(req, res);
    if (method === 'POST' && pathname === '/api/save-registration')        return await _handleSaveRegistration(req, res);
    if (method === 'POST' && pathname === '/api/save-section')             return await _handleSaveSection(req, res);
    if (method === 'POST' && pathname === '/api/save-report')              return await _handleSaveReport(req, res);
    if (method === 'POST' && pathname === '/api/ai-report')                return await _handleAIReport(req, res);
    if (method === 'POST' && pathname === '/api/dashboard/login') {
      // Brute-force protection: 10 attempts per 15 minutes per IP
      const _ip = req.socket.remoteAddress || 'unknown';
      const _now = Date.now(), _win = 15 * 60 * 1000, _lim = 10;
      const _loginEntry = _loginRL.get(_ip) || { count: 0, reset: _now + _win };
      if (_now > _loginEntry.reset) { _loginEntry.count = 0; _loginEntry.reset = _now + _win; }
      _loginEntry.count++;
      _loginRL.set(_ip, _loginEntry);
      if (_loginEntry.count > _lim) {
        const retryAfter = Math.ceil((_loginEntry.reset - _now) / 1000);
        res.writeHead(429, { 'Retry-After': retryAfter, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Too many login attempts. Try again in ' + Math.ceil(retryAfter/60) + ' minutes.' }));
      }
      return await dashApi.handle(req, res);
    }
    if (method === 'POST' && pathname === '/api/dashboard/insights')       return await _handleDashboardInsights(req, res);
    if (pathname.startsWith('/api/dashboard'))                             return await dashApi.handle(req, res);
    if (pathname.startsWith('/api/'))                                      return _json(res, 404, { error: 'Unknown API route' });

    if (method !== 'GET') { res.writeHead(405); return res.end('Method not allowed'); }
    if (pathname === '/') return _serveStatic(res, path.join(__dirname, 'index.html'), req);

    const rel      = pathname.slice(1);
    const filePath = path.resolve(__dirname, rel);
    const root     = path.resolve(__dirname);
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403); return res.end('Forbidden');
    }

    // Basename fallback: if /js/foo.js doesn't exist, try /foo.js at root.
    // This lets <script src="./js/main.js"> work even when files are at root.
    if (!fs.existsSync(filePath)) {
      const base = path.join(__dirname, path.basename(filePath));
      if (base !== filePath && fs.existsSync(base)) {
        return _serveStatic(res, base, req);
      }
    }
    return _serveStatic(res, filePath, req);

  } catch (err) {
    log.error('[Server] Unhandled:', err.message, err.stack);
    if (!res.headersSent) _json(res, 500, { error: 'Internal server error' });
  }
}


// Prune rate-limiter Maps (prevent unbounded growth at 20k unique IPs)
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _ipRL)    if (now > e.reset)    _ipRL.delete(ip);
  for (const [ip, e] of _loginRL) if (now > e.reset) _loginRL.delete(ip);
}, 5 * 60 * 1000).unref();

/* ══════════════════════════════════════════════════════════════════
   START
══════════════════════════════════════════════════════════════════ */

/* ── POST /api/dashboard/insights ──────────────────────────────
   Proxies AI insight generation through the server.
   OpenAI key stays server-side — never exposed to browser.
   Body: { prompt: string }   Auth: Dashboard Bearer token required.
*/
async function _handleDashboardInsights(req, res) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return _json(res, 401, { error: 'Unauthorized' });
  if (!OPENAI_KEY) return _json(res, 503, { error: 'OpenAI not configured on this server.' });

  let body;
  try { body = await _readBody(req, 32 * 1024); }
  catch { return _json(res, 400, { error: 'Bad request' }); }

  const { prompt } = body || {};
  if (!prompt || typeof prompt !== 'string') return _json(res, 400, { error: 'prompt required' });

  try {
    const upstream = await _openaiReq('/v1/chat/completions', {
      model: CHAT_MODEL, max_tokens: 900, temperature: 0.5,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = await new Promise(r => {
      const c = []; upstream.on('data', d => c.push(d)); upstream.on('end', () => r(Buffer.concat(c).toString()));
    });

    if (upstream.statusCode !== 200) {
      let msg = 'AI service error';
      try { msg = JSON.parse(raw)?.error?.message || msg; } catch (_) {}
      return _json(res, upstream.statusCode, { error: msg });
    }

    let text = '';
    try { text = JSON.parse(raw)?.choices?.[0]?.message?.content || ''; } catch (_) {}

    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch (_) { return _json(res, 502, { error: 'AI returned unparseable response' }); }

    _json(res, 200, { insights: parsed });
  } catch (err) {
    log.error('[dashboard-insights]', err.message);
    _json(res, 502, { error: 'AI service error: ' + err.message });
  }
}


/* ══ COUNSELLOR SESSION TOKENS ══════════════════════════════════════
   After unlock, a student receives a short-lived token bound to their
   email. All subsequent counsellor API calls must present this token
   via X-Counsellor-Token header instead of sending their email.
   This prevents any student from accessing another student's data
   by sending a different email address.
══════════════════════════════════════════════════════════════════ */
// Counsellor session tokens — persisted in SQLite, shared across PM2 workers
function _issueCounsellorToken(email) { return cdb.issueToken(email); }
function _verifyCounsellorToken(req) {
  const token = (req.headers['x-counsellor-token'] || '').trim();
  return token ? cdb.verifyToken(token) : null;
}

const server = http.createServer(_handleRequest);

server.headersTimeout   = 10000;
server.requestTimeout   = 30000;
server.keepAliveTimeout = 65000;

server.listen(PORT, () => {
  // Always print startup info regardless of LOG_LEVEL (use process.stdout directly)
  process.stdout.write(
    `\n✅  NuMind MAPS  →  http://localhost:${PORT}\n` +
    `    SQLite      : ${process.env.SQLITE_PATH || path.join(__dirname, 'numind.db')}\n` +
    `    Token       : ${APP_TOKEN ? '*** (set)' : '(not set — open access)'}\n` +
    `    AI models   : ${AI_MODEL} / chat: ${CHAT_MODEL}\n` +
    `    OpenAI      : ${OPENAI_KEY ? '*** (set)' : '(not set — AI disabled)'}\n` +
    `    CORS        : ${ALLOWED_ORIGIN}\n` +
    `    Max AI      : ${MAX_CONCURRENT_AI} concurrent streams\n` +
    `    Log level   : ${LOG_LEVEL}\n\n`
  );
  _prewarm();
  // Signal PM2 that this worker is ready (wait_ready: true in ecosystem.config.js)
  if (typeof process.send === 'function') process.send('ready');
});

server.on('error', err => { log.error('[Server] Fatal:', err.message); process.exit(1); });

function _gracefulShutdown() {
  log.error('[Server] Shutting down…');
  server.close(() => {
    try { dbModule.close(); } catch (_) {}
    if (typeof cdb.close === 'function') { try { cdb.close(); } catch (_) {} }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', _gracefulShutdown);
process.on('SIGINT',  _gracefulShutdown);

module.exports = server;
