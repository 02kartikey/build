/* ════════════════════════════════════════════════════════════════════
   server.js — NuMind MAPS  |  Node.js 18+ / CommonJS / PM2 cluster

   HTTP server: static files (gzip + ETag + in-memory cache), student
   assessment APIs, OpenAI streaming proxy, AI counsellor auth + chat,
   and /api/dashboard/* (delegated to dashboard-api.js).

   Env vars: PORT, SQLITE_PATH, APP_TOKEN, OPENAI_API_KEY, OPENAI_BASE_URL,
   OPENAI_MODEL, COUNSELLOR_MODEL, ALLOWED_ORIGIN, LOG_LEVEL,
   MAX_CONCURRENT_AI, MAX_CONCURRENT_CHAT, SMTP_HOST/PORT/USER/PASS,
   NOTIFICATION_EMAIL, LISTEN_BACKLOG,
   DATABASE_URL / PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, PG_POOL_MAX, PGSSL
════════════════════════════════════════════════════════════════════ */
'use strict';
const _dotenvResult = require('dotenv').config();
if (_dotenvResult.error) {
  process.stderr.write('[WARN]  [.env] Failed to load: ' + _dotenvResult.error.message + '\n');
  process.stderr.write('[WARN]  [.env] Make sure .env exists at: ' + process.cwd() + '/.env\n');
} else {
  const loaded = Object.keys(_dotenvResult.parsed || {});
  process.stdout.write('[INFO]  [.env] Loaded ' + loaded.length + ' vars from ' + process.cwd() + '/.env\n');
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

const dbModule = require('./db.js');
const cdb      = require('./counsellor-db.js');
const rag      = require('./counsellor-rag.js');
const goals    = require('./counsellor-goals-db.js');
const dashApi  = require('./dashboard-api.js');

const PORT             = parseInt(process.env.PORT            || '3000', 10);
const APP_TOKEN        = process.env.APP_TOKEN                || '';
const OPENAI_KEY       = process.env.OPENAI_API_KEY           || '';
const OPENAI_BASE      = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
const AI_MODEL         = process.env.OPENAI_MODEL             || 'gpt-4o';
const CHAT_MODEL       = process.env.COUNSELLOR_MODEL         || 'gpt-4o-mini';
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN           || '*';
if (ALLOWED_ORIGIN === '*') {
  process.stderr.write('[WARN]  [CORS] ALLOWED_ORIGIN is "*" — set it to your domain in .env before going live.\n');
}
const MAX_CONCURRENT_AI = parseInt(process.env.MAX_CONCURRENT_AI || '20', 10);
const LOG_LEVEL        = (process.env.LOG_LEVEL || 'warn').toLowerCase();

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const _lvl = LOG_LEVELS[LOG_LEVEL] ?? 2;
const log = {
  debug: (...a) => _lvl <= 0 && console.debug('[DEBUG]', ...a),
  info:  (...a) => _lvl <= 1 && console.log  ('[INFO] ', ...a),
  warn:  (...a) => _lvl <= 2 && console.warn ('[WARN] ', ...a),
  error: (...a) =>               console.error('[ERROR]', ...a),
};

process.on('uncaughtException',  err    => log.error('uncaughtException:',  err.message, err.stack));
process.on('unhandledRejection', reason => log.error('unhandledRejection:', reason));

// DB schema init + module wiring happens in _bootstrap() below (async).
let _db = null;

const tls       = require('tls');
const net       = require('net');
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = SMTP_USER || 'no-reply@numind.co.in';
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || SMTP_USER;

/* Returns a Promise that RESOLVES only once the SMTP server has accepted the
   message (the 250 reply to end-of-DATA) and REJECTS on any protocol error,
   socket error, timeout, or premature disconnect. Previously this returned
   undefined synchronously, so `await _sendEmail(...)` awaited nothing and every
   send reported success even when transport failed. Callers can now await it
   and trust the result. */
function _sendEmail({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    if (!SMTP_USER || !SMTP_PASS) { reject(new Error('SMTP not configured')); return; }
    const _san = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
    const safeTo = _san(to); const safeSub = _san(subject);
    if (!safeTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeTo)) {
      log.error('[SMTP] Rejected invalid recipient:', JSON.stringify(safeTo));
      reject(new Error('Invalid recipient')); return;
    }
    const enc  = s => Buffer.from(s).toString('base64');
    const CRLF = '\r\n';
    const msg  =
      `From: NuMind MAPS <${SMTP_FROM}>${CRLF}To: ${safeTo}${CRLF}Subject: ${safeSub}${CRLF}` +
      `MIME-Version: 1.0${CRLF}Content-Type: text/plain; charset=utf-8${CRLF}` +
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}` + enc(text) + CRLF;

    // Settle exactly once — the first of {accept, error, timeout, close} wins.
    let settled = false;
    const _ok  = ()  => { if (!settled) { settled = true; resolve(); } };
    const _err = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };

    if (SMTP_PORT === 587) {
      const socket = net.connect({ host: SMTP_HOST, port: 587 }, () => {
        let stage = 0; let tlsSocket = null;
        const send = s => (tlsSocket || socket).write(s + CRLF);
        const handleData = chunk => {
          const line = chunk.toString('utf8').trim();
          if      (stage === 0 && line.startsWith('220'))     { send('EHLO numind.maps'); stage = 1; }
          else if (stage === 1 && line.includes('250 '))      { send('STARTTLS'); stage = 2; }
          else if (stage === 2 && line.startsWith('220'))     {
            tlsSocket = tls.connect({ socket, host: SMTP_HOST, servername: SMTP_HOST }, () => {
              tlsSocket.on('data', handleData);
              send('EHLO numind.maps'); stage = 3;
            });
            tlsSocket.setTimeout(15000, () => { log.warn('[SMTP] TLS timeout →', safeTo); _err(new Error('SMTP TLS timeout')); tlsSocket.destroy(); });
            tlsSocket.on('error', e => { log.error('[SMTP] TLS socket error:', e.message); _err(e); });
          }
          else if (stage === 3 && line.includes('250 '))      { send('AUTH LOGIN'); stage = 4; }
          else if (stage === 4 && line.startsWith('334'))     { send(enc(SMTP_USER)); stage = 5; }
          else if (stage === 5 && line.startsWith('334'))     { send(enc(SMTP_PASS)); stage = 6; }
          else if (stage === 6 && line.startsWith('235'))     { send(`MAIL FROM:<${SMTP_FROM}>`); stage = 7; }
          else if (stage === 7 && line.startsWith('250'))     { send(`RCPT TO:<${safeTo}>`); stage = 8; }
          else if (stage === 8 && line.startsWith('250'))     { send('DATA'); stage = 9; }
          else if (stage === 9 && line.startsWith('354'))     { (tlsSocket||socket).write(msg + CRLF + '.' + CRLF); stage = 10; }
          else if (stage === 10 && line.startsWith('250'))    { _ok(); send('QUIT'); stage = 11; }
          else if (stage === 11 && line.startsWith('221'))    { (tlsSocket||socket).destroy(); }
          else if (line.startsWith('5') || line.startsWith('4')) { log.error('[SMTP]', line); _err(new Error('SMTP error: ' + line)); (tlsSocket||socket).destroy(); }
        };
        socket.on('data', handleData);
      });
      socket.setTimeout(15000, () => { log.warn('[SMTP] connect timeout →', safeTo); _err(new Error('SMTP connect timeout')); socket.destroy(); });
      socket.on('error', e => { log.error('[SMTP] socket error:', e.message); _err(e); });
      socket.on('close', () => _err(new Error('SMTP connection closed before completion')));
      return;
    }

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
        else if (stage === 8 && line.startsWith('250'))        { _ok(); send('QUIT'); stage = 9; }
        else if (stage === 9 && line.startsWith('221'))        { socket.destroy(); }
        else if (line.startsWith('5') || line.startsWith('4')){ log.error('[SMTP]', line); _err(new Error('SMTP error: ' + line)); socket.destroy(); }
      });
    });
    socket.setTimeout(15000, () => { log.warn('[SMTP] timeout →', safeTo); _err(new Error('SMTP timeout')); socket.destroy(); });
    socket.on('error', e => { log.error('[SMTP] socket error:', e.message); _err(e); });
    socket.on('close', () => _err(new Error('SMTP connection closed before completion')));
  });
}
const _emailFn = (SMTP_USER && SMTP_PASS) ? _sendEmail : null;
if (!_emailFn) log.info('[Email] SMTP_USER/SMTP_PASS not set — email features disabled. Set them in .env to enable OTP and reminders.');

// dashApi.init(...) moved into _bootstrap() (needs async DB ready first).

/* Write queue removed in the PostgreSQL migration: the pg Pool provides real
   concurrent writers, so serialising through a single-writer queue is no longer
   needed. _dbWrite is kept as a thin async passthrough so the ~40 existing
   `await _dbWrite(() => ...)` call sites need no change. QueueOverflowError is
   retained (no longer thrown) so lingering `instanceof` checks stay harmless. */
class QueueOverflowError extends Error {
  constructor() { super('Write queue full'); this.name = 'QueueOverflowError'; }
}

function _dbWrite(fn) { return Promise.resolve().then(fn); }

/* Postgres pool saturation (all connections busy, acquire timed out) should
   surface as a retryable 503 — same contract the old write-queue overflow had —
   not a raw 500. Fires only under extreme load or a mis-sized PG_POOL_MAX. */
function _isDbBusy(err) {
  return !!err && typeof err.message === 'string' &&
         err.message.includes('timeout exceeded when trying to connect');
}


const _httpsAgent = new https.Agent({
  keepAlive:      true,
  keepAliveMsecs: 10000,
  maxSockets:     50,
  maxFreeSockets: 10,
  timeout:        35000,
});

let _aiInFlight   = 0;
const MAX_CONCURRENT_CHAT = parseInt(process.env.MAX_CONCURRENT_CHAT || '40', 10);
let _chatInFlight = 0;

const CACHE_MAX_FILES     = 120;
const CACHE_MAX_FILE_SIZE = 512 * 1024;
const CACHE_TTL_MS        = 30_000;
const _staticCache        = new Map();
const _cachePending       = new Map();

function _cacheEvict() {
  if (_staticCache.size <= CACHE_MAX_FILES) return;
  _staticCache.delete(_staticCache.keys().next().value);
}

const RL_WINDOW = 60 * 60 * 1000;
const IP_WINDOW = 60 * 1000;
// Per-IP request ceiling per minute. 200 suits real traffic (each school/NAT IP
// serves a handful of students); raise via env for single-IP load testing
// (IP_RL_MAX=1000000) or if a large school NATs hundreds of students to one IP.
const IP_RL_MAX = parseInt(process.env.IP_RL_MAX || '200', 10);
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

async function _rlCheckDb(scope, key, limit, windowMs) {
  try { return await cdb.rlCheck(scope, key, limit, windowMs || RL_WINDOW); }
  catch (e) { log.warn('[RL] DB check failed, failing open:', e.message); return { allowed: true }; }
}

function _getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

setInterval(() => {
  const n = Date.now();
  for (const [k, v] of _ipRL)    if (n > v.resetAt) _ipRL.delete(k);
  for (const [k, v] of _loginRL) if (n > v.reset)   _loginRL.delete(k);
}, 5 * 60 * 1000).unref();

setInterval(() => {
  Promise.allSettled([
    cdb.rlPrune(), cdb.pruneTokens(), cdb.pruneOtps(), cdb.pruneOtpStageTokens(),
  ]).catch(() => {});
}, RL_WINDOW).unref();

const ANALYTICS_REFRESH_MS = 5 * 60 * 1000;
setTimeout(() => {
  const _doRefresh = () => {
    _dbWrite(() => require('./dashboard-db.js').refreshAnalyticsCache())
      .catch((e) => log.warn('[Analytics] cache refresh failed:', e.message));
  };
  _doRefresh();
  setInterval(_doRefresh, ANALYTICS_REFRESH_MS).unref();
}, 30 * 1000).unref();

function _openaiReqRaw(endpoint, body) {
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

async function _openaiReq(endpoint, body, _attempt = 0) {
  const upstream = await _openaiReqRaw(endpoint, body);
  if (upstream.statusCode === 429 && _attempt < 3) {
    const delayMs = Math.pow(2, _attempt) * 1000;
    log.warn(`[OpenAI] 429 on attempt ${_attempt + 1} — retrying in ${delayMs}ms`);
    await new Promise(r => { upstream.resume(); upstream.on('end', r); upstream.on('error', r); });
    await new Promise(r => setTimeout(r, delayMs));
    return _openaiReq(endpoint, body, _attempt + 1);
  }
  return upstream;
}

/* ════════════════════════════════════════════════════════════════════
   ARIA CHILD-SAFETY GATE
   The AI counsellor serves minors (~13–17). Every student message is
   screened BEFORE it reaches the model: a deterministic tripwire (instant,
   dependency-free) for the highest-severity categories, plus OpenAI's
   moderation classifier for robust coverage. Harmful/out-of-bounds input
   gets a warm redirect; signs of distress get a caring, resource-forward
   response. This is layered with the scope+safety system prompt.
   ════════════════════════════════════════════════════════════════════ */
const CRISIS_HELPLINE = process.env.CRISIS_HELPLINE || 'Tele-MANAS (India\'s free mental-health helpline) at 14416';

const ARIA_SAFE_REFUSAL =
  "That's outside what I can help you with — I'm your study and career guide, here for your NuMind MAPS results, subjects, and where you're headed. " +
  "But I'd genuinely love to help with that. Want to explore what your assessment says about your strengths, or talk through subjects and careers?";

const ARIA_SAFE_DISTRESS =
  "It sounds like you might be carrying something really heavy right now, and I'm glad you told me. " +
  "I'm only a study-and-career guide, so I'm not the right kind of help for this — but you deserve real support from someone who can be there with you. " +
  "Please reach out to a trusted adult as soon as you can — a parent, a teacher, or your school counsellor. " +
  `If you need someone to talk to right now, you can contact ${CRISIS_HELPLINE}, any time. ` +
  "You are not alone in this. 💛";

// Highest-severity patterns — caught instantly, even if moderation is unavailable.
const _SAFETY_TRIPWIRE = [
  /\b(detonat|grenade|molotov|napalm|\brdx\b|\btnt\b|\bied\b|pipe ?bomb|dirty bomb|ammonium nitrate|nerve agent|sarin|ricin|anthrax|bio ?weapon|gun ?powder|silencer|ghost gun|zip gun)\b/i,
  /\bhow\s+(to|do i|can i|would i)\s+(make|build|create|synthesi[sz]e|manufacture|assemble)\s+(a|an|my|the)?\s*(bomb|explosive|weapon|gun|firearm|poison|meth|cocaine|lsd|drug)\b/i,
  /\b(synthesi[sz]e|manufacture|cook up)\s+(meth|methamphetamine|cocaine|heroin|mdma|lsd|fentanyl)\b/i,
  /\b(porn|pornograph|hentai|\bnsfw\b|nud(?:e|es|ity)|naked pics?|sexual (positions?|acts?)|blow ?job|hand ?job|masturbat|orgasm|sexting)\b/i,
  /\bhow\s+(to|do i|can i)\s+(have sex|lose my virginity|send nudes)\b/i,
];
function _tripwireHit(text) {
  const t = String(text || '');
  return _SAFETY_TRIPWIRE.some(rx => rx.test(t));
}

// OpenAI omni-moderation → 'allow' | 'block' | 'selfharm'. Fails open (the
// tripwire + system prompt still protect) so an outage never breaks chat.
async function _moderateInput(text) {
  if (!OPENAI_KEY) return { action: 'allow' };
  try {
    const up = await _openaiReqRaw('/v1/moderations', {
      model: 'omni-moderation-latest',
      input: String(text || '').slice(0, 4000),
    });
    const bodyStr = await new Promise((resolve, reject) => {
      const c = [];
      up.on('data', d => c.push(d));
      up.on('end', () => resolve(Buffer.concat(c).toString()));
      up.on('error', reject);
    });
    if (up.statusCode !== 200) return { action: 'allow', error: true };
    const r = JSON.parse(bodyStr)?.results?.[0];
    if (!r) return { action: 'allow' };
    const c = r.categories || {};
    // Distress first — a caring response, never a cold refusal.
    if (c['self-harm'] || c['self-harm/intent'] || c['self-harm/instructions']) return { action: 'selfharm' };
    const BLOCK = ['sexual', 'sexual/minors', 'hate', 'hate/threatening',
                   'harassment/threatening', 'illicit', 'illicit/violent',
                   'violence', 'violence/graphic'];
    if (BLOCK.some(k => c[k])) return { action: 'block' };
    return { action: 'allow' };
  } catch (e) {
    log.warn('[moderation] failed (failing open):', e.message);
    return { action: 'allow', error: true };
  }
}

// Send a plain-text safe reply the same way the chat stream does, and record
// the exchange so history stays coherent and staff can see concerning patterns.
async function _ariaSafeReply(res, { email, conversationId, message, reply }) {
  if (!res.headersSent) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
  res.end(reply);
  let sessionId = null;
  try { sessionId = (await cdb.getReportByEmail(email))?.session_id || null; } catch (_) {}
  _dbWrite(() => cdb.saveMessage({ email, sessionId, conversationId, role: 'user',      content: message })).catch(() => {});
  _dbWrite(() => cdb.saveMessage({ email, sessionId, conversationId, role: 'assistant', content: reply   })).catch(() => {});
}

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
    `<meta name="app-token" content=${JSON.stringify(APP_TOKEN)}>\n</head>`);
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
    if (now - cached.checkedAt < CACHE_TTL_MS) {
      return _respondCached(res, req, cached, ext);
    }
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

function _prewarm() {
  const hot = ['index.html', 'styles.css', 'main.js', 'ai-counsellor.js', 'state.js', 'router.js'].map(f => path.join(__dirname, f));
  for (const p of hot) {
    if (!fs.existsSync(p)) continue;
    _serveFromDisk({ writeHead: () => {}, end: () => {} }, p, path.extname(p).toLowerCase(), null);
    log.info('Cache pre-warm:', p);
  }
}

function _readBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let tooLarge = false;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) {
        if (!tooLarge) { tooLarge = true; reject(new Error('body_too_large')); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
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

async function _handleSaveRegistration(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); }
  catch (e) { return _json(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message }); }
  const { student, sessionId } = body || {};
  if (!sessionId) return _json(res, 400, { error: 'sessionId is required' });

  try {
    const reg = await _dbWrite(() => dbModule.saveRegistration(student || {}, sessionId));

    return _json(res, 200, {
      ok: true,
      sessionId: reg.session_id,
      existing: !!reg.existing,
      testTaken: !!reg.testTaken,
      // Journey lock: same-class retakes are blocked; a new class is a new attempt.
      attemptsCount:      reg.attemptsCount || 0,
      attemptedThisClass: !!reg.attemptedThisClass,
      lastAttemptClass:   reg.lastAttemptClass || null,
    });
  } catch (err) {
    if (err instanceof QueueOverflowError || _isDbBusy(err)) {
      // Real 503, never a fake 200 — the write did not happen.
      res.writeHead(503, { 'Retry-After': '3', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'Server is busy — your details were not saved. Please try again in a few seconds.',
        retry_after: 3,
      }));
    }
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

  const studentRow = dbModule.getStudentBySessionId
    ? await dbModule.getStudentBySessionId(sessionId)
    : null;
  if (!studentRow) {
    return _json(res, 404, { error: 'Session not found. Please register first.' });
  }

  try {
    await _dbWrite(() => dbModule.saveSection(sessionId, moduleKey, {
      raw_answers: answers, scores, duration: duration || 0,
    }));
    _json(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof QueueOverflowError || _isDbBusy(err)) {
      res.writeHead(503, { 'Retry-After': '3', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Server is busy — this section was not saved. Please try again.', retry_after: 3 }));
    }
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

  const studentRow = dbModule.getStudentBySessionId
    ? await dbModule.getStudentBySessionId(body.sessionId)
    : null;
  if (!studentRow) return _json(res, 404, { error: 'Session not found.' });

  if (_aiInFlight >= MAX_CONCURRENT_AI) {
    log.warn('[save-report] AI cap hit —', _aiInFlight, '/', MAX_CONCURRENT_AI, 'in flight');
    return _json(res, 429, { error: 'Report generation is busy. Please wait 30 seconds and try again.', retry_after: 30 });
  }
  try {
    await _dbWrite(() => dbModule.saveReport(body));
    if (body?.student?.email) {
      try { cdb._invalidateReportCache(body.student.email); } catch (_) {}
    }
    // Drop the cached RAG static block so a retake's fresh report reaches Aria now.
    try { rag.invalidateRagCache(body.sessionId); } catch (_) {}
    _json(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof QueueOverflowError || _isDbBusy(err)) {
      res.writeHead(503, { 'Retry-After': '5', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Server is busy — your report was not saved. Please try again shortly.', retry_after: 5 }));
    }
    log.error('[save-report]', err.message);
    _json(res, 500, { error: 'Server error' });
  }
}

async function _handleAIReport(req, res) {
  if (!_checkToken(req))  return _json(res, 401, { error: 'Unauthorized' });
  if (!OPENAI_KEY)        return _json(res, 503, { error: 'AI not configured.' });

  if (_aiInFlight >= MAX_CONCURRENT_AI) {
    res.writeHead(503, { 'Retry-After': '10', 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Server busy — please try again in a few seconds.' }));
  }

  const globalRl = await _rlCheckDb('ai-global', 'slots', MAX_CONCURRENT_AI, 60 * 1000);
  if (!globalRl.allowed) {
    res.writeHead(503, { 'Retry-After': String(globalRl.retryAfter || 10), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Server busy — please try again in a few seconds.' }));
  }

  let body;
  try { body = await _readBody(req, 256 * 1024); }
  catch (e) { return _json(res, 400, { error: e.message }); }

  const rawMsgs  = Array.isArray(body?.messages) ? body.messages : [];
  const safeMsgs = rawMsgs
    .filter(m => m && typeof m === 'object' && ['user','assistant'].includes(m.role))
    .map(m => ({ role: m.role, content: String(m.content || '').slice(0, 32000) }));
  if (!safeMsgs.length) return _json(res, 400, { error: 'messages required (user/assistant roles only)' });
  const maxTok  = Math.min(Number(body.max_tokens) || 6000, 8000);
  const rawTemp = Number(body.temperature);
  const temp    = Number.isFinite(rawTemp) ? Math.max(0, Math.min(1, rawTemp)) : 0.65;

  _aiInFlight++;
  let _aiReleased = false;
  const releaseAi = () => { if (!_aiReleased) { _aiReleased = true; _aiInFlight--; } };
  res.on('close', releaseAi);
  try {
    const upstream = await _openaiReq('/v1/chat/completions', {
      model: AI_MODEL, temperature: temp,
      max_tokens: maxTok, stream: true, messages: safeMsgs,
    });
    if (upstream.statusCode !== 200) {
      releaseAi();
      const eb = await new Promise(r => { const c = []; upstream.on('data', d => c.push(d)); upstream.on('end', () => r(Buffer.concat(c).toString())); });
      try { return _json(res, upstream.statusCode, JSON.parse(eb).error || { message: eb }); }
      catch { return _json(res, upstream.statusCode, { error: eb.slice(0, 300) }); }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    upstream.pipe(res);
    const _done = () => { releaseAi(); if (!res.writableEnded) res.end(); };
    upstream.on('end',   _done);
    upstream.on('error', _done);
  } catch (err) {
    releaseAi();
    log.error('[ai-report]', err.message);
    if (!res.headersSent) _json(res, 502, { error: 'AI service error' });
  }
}

/* Send a counsellor OTP email and report whether it was actually delivered
   to SMTP. Awaited so async transport failures can't masquerade as success. */
async function _sendCounsellorOtp(email, purpose, subject, text) {
  if (!_emailFn) return false;
  try {
    const code = await _dbWrite(() => cdb.createOtp(email, purpose));
    await _emailFn({ to: email, subject, text: text.replace('{CODE}', code) });
    return true;
  } catch (err) {
    log.error('[otp-email]', email, purpose, '-', err.message);
    return false;
  }
}

async function _handleCounsellorUnlock(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = String(body?.email || '').toLowerCase().trim();
  if (!email) return _json(res, 400, { error: 'Email is required.' });

  const rl = await _rlCheckDb('unlock', email, 20, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts. Please wait before trying again.' }));
  }

  try {
    const reportObj = await cdb.getReportByEmail(email);
    const hasReport = !!(reportObj && reportObj.report &&
      (reportObj.report.fit_tier != null || reportObj.report.generated_at != null));
    if (!reportObj || !hasReport) {
      return _json(res, 200, { unlocked: false,
        error: 'No report found for this email. Please complete your NuMind MAPS assessment first.' });
    }

    const pinSet = await cdb.hasPinSet(email);

    if (!pinSet) {
      const sent = await _sendCounsellorOtp(email, 'register',
        'Your NuMind MAPS verification code',
        'Welcome to NuMind MAPS!\n\nYour verification code is: {CODE}\n\n' +
        'Enter this code to set up your AI Counsellor PIN. It expires in 10 minutes.\n\n' +
        'If you did not request this, you can ignore this email.');
      if (sent) {
        log.info('[unlock]', email, '| OTP sent (first-time setup)');
        return _json(res, 200, { unlocked: false, step: 'otp-sent', purpose: 'register',
          message: 'We sent a 6-digit code to your email. Enter it to continue.' });
      }
      // Email unavailable — prove identity with registration details instead.
      log.warn('[unlock]', email, '| OTP unavailable — falling back to identity verification');
      return _json(res, 200, { unlocked: false, step: 'verify-identity', purpose: 'register',
        message: 'Confirm your registration details to set up your PIN.' });
    }

    return _json(res, 200, { unlocked: false, step: 'enter-pin',
      message: 'Enter your PIN to continue.' });

  } catch (err) {
    log.error('[counsellor-unlock]', err.message);
    _json(res, 500, { error: 'Server error. Please try again.' });
  }
}

async function _jsonUnlocked(res, email, reportObj) {
  try {
    const hasReport = !!(reportObj && reportObj.report &&
      (reportObj.report.fit_tier != null || reportObj.report.generated_at != null));
    if (!hasReport) {
      return _json(res, 200, { unlocked: false,
        error: 'No report found for this email. Please complete your NuMind MAPS assessment first.' });
    }
    const name    = reportObj.student?.firstName || reportObj.student?.fullName || 'Student';
    const history = await cdb.getHistory(email, { limit: 40 });
    let reportSummary = null;
    if (reportObj?.report) {
      const r = reportObj.report;
      reportSummary = {
        fit_tier: r.fit_tier, fit_score: r.fit_score,
        recommended_primary: r.recommended_primary,
        recommended_alternate: r.recommended_alternate,
        recommended_exploratory: r.recommended_exploratory,
        strong_fit_pathways: r.strong_fit_pathways,
        emerging_fit_pathways: r.emerging_fit_pathways,
        exploratory_pathways: r.exploratory_pathways,
        top3_interests: r.top3_interests,
        top_personality_traits: r.top_personality_traits,
        seaa_status: r.seaa_status,
        personality_status: r.personality_status,
        aptitude_status: r.aptitude_status,
        interest_status: r.interest_status,
        holistic_summary: r.holistic_summary,
        personality_profile: r.personality_profile,
        aptitude_profile: r.aptitude_profile,
        interest_profile: r.interest_profile,
        internal_motivators: r.internal_motivators,
        wellbeing_guidance: r.wellbeing_guidance,
        stream_advice: r.stream_advice,
      };
    }
    const fullScores = {
      personality: reportObj.personality || [],
      aptitude:    reportObj.aptitude    || [],
      interests:   reportObj.interests   || [],
      seaa:        reportObj.seaa        || [],
      careers:     reportObj.careers     || [],
    };
    const conversations   = await cdb.getConversations(email);
    const counsellorToken = await _issueCounsellorToken(email);
    let journey = null;
    try { journey = await cdb.getJourney(email); } catch (_) { /* non-fatal */ }
    _json(res, 200, { unlocked: true, name, email, history, reportSummary, fullScores, conversations, counsellorToken, journey });
  } catch (err) {
    log.error('[_jsonUnlocked]', err.message);
    _json(res, 500, { error: 'Server error while unlocking session.' });
  }
}

async function _handleCounsellorVerifyName(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email    = String(body?.email    || '').toLowerCase().trim();
  const fullName = String(body?.fullName || '').toLowerCase().trim();
  const cls      = String(body?.class    || '').toLowerCase().trim();
  if (!email || !fullName || !cls) return _json(res, 400, { error: 'email, fullName and class are required.' });

  const rl = await _rlCheckDb('verify-name', email, 10, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts. Try again later.' }));
  }

  try {
    const reportObj = await cdb.getReportByEmail(email);
    if (!reportObj) return _json(res, 200, { ok: false, error: 'No account found for this email. Make sure you use the email you registered with.' });

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

  const rl = await _rlCheckDb('otp-verify', email, 10, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts.' }));
  }

  try {
    const valid = await cdb.verifyOtp(email, otp, purpose);
    if (!valid) {
      return _json(res, 200, { ok: false, error: 'Incorrect or expired code. Please try again.' });
    }
    const otpToken = await _dbWrite(() => cdb.issueOtpStageToken(email));

    if (purpose === 'reset') {
      return _json(res, 200, { ok: true, step: 'set-pin', otpToken,
        message: 'Code verified. Set your new PIN.' });
    }
    return _json(res, 200, { ok: true, step: 'set-pin', otpToken,
      message: 'Code verified! Now set a 4-6 digit PIN to use when logging in.' });
  } catch (err) {
    log.error('[counsellor-verify-otp]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

async function _handleCounsellorRequestOtp(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = String(body?.email || '').toLowerCase().trim();
  if (!email) return _json(res, 400, { error: 'Email is required.' });

  const rl = await _rlCheckDb('request-otp', email, 5, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts. Please wait before trying again.' }));
  }

  try {
    const reportObj = await cdb.getReportByEmail(email);
    let sent = false;
    if (reportObj) {
      sent = await _sendCounsellorOtp(email, 'reset',
        'Reset your NuMind MAPS PIN',
        'You asked to reset your AI Counsellor PIN.\n\nYour verification code is: {CODE}\n\n' +
        'Enter this code to set a new PIN. It expires in 10 minutes.\n\n' +
        'If you did not request this, you can safely ignore this email.');
      if (sent) log.info('[request-otp]', email, '| reset OTP sent');
    }
    if (sent) {
      return _json(res, 200, { ok: true, step: 'otp-sent', purpose: 'reset',
        message: 'If an account exists for that email, a reset code has been sent.' });
    }
    // Email unavailable (or unknown account — response is identical either way
    // to avoid enumeration; verification simply fails for unknown emails).
    return _json(res, 200, { ok: true, step: 'verify-identity', purpose: 'reset',
      message: 'Confirm your registration details to reset your PIN.' });
  } catch (err) {
    log.error('[counsellor-request-otp]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

async function _handleCounsellorVerifyIdentity(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email    = String(body?.email    || '').toLowerCase().trim();
  const fullName = String(body?.fullName || '').trim();
  const cls      = String(body?.class    || '').trim();
  if (!email || !fullName || !cls) return _json(res, 400, { error: 'email, fullName and class are required.' });

  // Tight limit — this is a knowledge-based proof, keep guessing expensive.
  const rl = await _rlCheckDb('verify-identity', email, 5, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts. Please wait before trying again.' }));
  }

  try {
    const reportObj = await cdb.getReportByEmail(email);
    const stu = reportObj && reportObj.student;
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const nameOk  = stu && norm(stu.fullName) === norm(fullName);
    const classOk = stu && String(stu.class || '').trim() === cls;
    if (!nameOk || !classOk) {
      log.warn('[verify-identity] failed for', email);
      return _json(res, 200, { ok: false, error: 'Those details do not match our records.' });
    }
    const otpToken = await _dbWrite(() => cdb.issueOtpStageToken(email));
    log.info('[verify-identity]', email, '| verified via registration details');
    return _json(res, 200, { ok: true, step: 'set-pin', otpToken,
      message: 'Identity confirmed. Set your PIN.' });
  } catch (err) {
    log.error('[counsellor-verify-identity]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

async function _handleCounsellorSetPin(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = String(body?.email || '').toLowerCase().trim();
  const pin   = String(body?.pin   || '').trim();
  if (!email || !pin) return _json(res, 400, { error: 'email and pin are required.' });
  if (!/^\d{4,6}$/.test(pin)) return _json(res, 400, { error: 'PIN must be 4–6 digits.' });

  const rl = await _rlCheckDb('set-pin', email, 5, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts.' }));
  }

  {
    // Proof always required: an OTP or identity-verification stage token.
    const otpToken = req.headers['x-counsellor-otp-token'] || (body && body.otpToken) || '';
    if (!(await cdb.verifyOtpStageToken(otpToken, email))) {
      return _json(res, 401, { unlocked: false, step: 'verify-required',
        error: 'Please verify your identity first.' });
    }
  }

  try {
    const reportObj = await cdb.getReportByEmail(email);
    if (!reportObj) return _json(res, 200, { unlocked: false, error: 'No report found for this email.' });

    if ((await cdb.hasPinSet(email)) && !body?.changeOnly) {
      return _json(res, 200, { unlocked: false, step: 'enter-pin',
        error: 'PIN already set. Please enter your existing PIN.' });
    }

    await _dbWrite(() => cdb.setStudentPin(email, pin));
    log.info('[set-pin]', email);
    if (!body?.changeOnly) return _jsonUnlocked(res, email, reportObj);
    _json(res, 200, { ok: true, message: 'PIN updated.' });
  } catch (err) {
    log.error('[counsellor-set-pin]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

async function _handleCounsellorVerifyPin(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = String(body?.email || '').toLowerCase().trim();
  const pin   = String(body?.pin   || '').trim();
  if (!email || !pin) return _json(res, 400, { error: 'email and pin are required.' });

  const rl = await _rlCheckDb('pin-verify', email, 10, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many PIN attempts. Try again later.' }));
  }

  try {
    const valid = await cdb.verifyStudentPin(email, pin);
    if (!valid) {
      return _json(res, 200, { unlocked: false, error: 'Incorrect PIN. Please try again.' });
    }
    const reportObj = await cdb.getReportByEmail(email);
    if (!reportObj) return _json(res, 200, { unlocked: false, error: 'Report not found.' });
    log.info('[unlock]', email, '| verified via: PIN');
    return _jsonUnlocked(res, email, reportObj);
  } catch (err) {
    log.error('[counsellor-verify-pin]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

async function _handleCounsellorResetPin(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  let body;
  try { body = await _readBody(req); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = String(body?.email || '').toLowerCase().trim();
  const pin   = String(body?.pin   || '').trim();
  if (!email || !pin) return _json(res, 400, { error: 'email and pin are required.' });
  if (!/^\d{4,6}$/.test(pin)) return _json(res, 400, { error: 'PIN must be 4–6 digits.' });

  const rl = await _rlCheckDb('reset-pin', email, 5, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many attempts. Try again later.' }));
  }

  {
    // Proof always required: an OTP or identity-verification stage token.
    const otpToken = req.headers['x-counsellor-otp-token'] || (body && body.otpToken) || '';
    if (!(await cdb.verifyOtpStageToken(otpToken, email))) {
      return _json(res, 401, { ok: false, step: 'verify-required',
        error: 'Please verify your identity before resetting your PIN.' });
    }
  }

  try {
    const reportObj = await cdb.getReportByEmail(email);
    if (!reportObj) {
      return _json(res, 200, { ok: false,
        error: 'No report found for this email. Complete your assessment first.' });
    }
    await _dbWrite(() => cdb.setStudentPin(email, pin));
    log.info('[reset-pin]', email);
    return _jsonUnlocked(res, email, reportObj);
  } catch (err) {
    log.error('[counsellor-reset-pin]', err.message);
    _json(res, 500, { error: 'Server error.' });
  }
}

async function _handleCounsellorChat(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  if (!OPENAI_KEY)       return _json(res, 503, { error: 'AI not configured.' });

  let body;
  try { body = await _readBody(req, 128 * 1024); } catch { return _json(res, 400, { error: 'Bad request' }); }

  const email = await _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email to continue.' });
  const message        = String(body.message        || '').trim();
  const conversationId = String(body.conversationId || '').trim() || null;
  if (!message) return _json(res, 400, { error: 'message is required.' });
  if (message.length > 2000) return _json(res, 400, { error: 'Message too long (max 2000 chars).' });

  const rl = await _rlCheckDb('chat', email, 60, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Rate limit reached. Wait ${Math.ceil(rl.retryAfter / 60)} min.` }));
  }

  // ── Child-safety gate: screen the student's message before it reaches the
  //    model. Tripwire (instant) first, then OpenAI moderation. Harmful/out-of
  //    -bounds → warm redirect; distress → caring, resource-forward response.
  let _gate = _tripwireHit(message) ? 'block' : null;
  if (!_gate) {
    const mod = await _moderateInput(message);
    _gate = mod.action; // 'allow' | 'block' | 'selfharm'
  }
  if (_gate === 'block' || _gate === 'selfharm') {
    log.warn(`[aria-safety] ${_gate} — message redirected for ${String(email).slice(0, 3)}***`);
    await _ariaSafeReply(res, {
      email, conversationId, message,
      reply: _gate === 'selfharm' ? ARIA_SAFE_DISTRESS : ARIA_SAFE_REFUSAL,
    });
    return;
  }

  if (_chatInFlight >= MAX_CONCURRENT_CHAT) {
    res.writeHead(503, { 'Retry-After': '5', 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Aria is busy right now — please try again in a few seconds.' }));
  }
  _chatInFlight++;
  let _released = false;
  const release = () => { if (!_released) { _released = true; _chatInFlight--; } };
  res.on('close', release);

  try {
    const reportObj    = await cdb.getReportByEmail(email);
    const summaryRow   = conversationId ? await cdb.getConversationSummary(email, conversationId) : null;
    let journey = null;
    try { journey = await cdb.getJourney(email); } catch (_) { /* non-fatal */ }
    const [customContext, milestones] = await Promise.all([
      goals.getCustomContext(email).catch(() => null),
      goals.getMilestones(email).catch(() => []),
    ]);
    const systemPrompt = rag.buildRagContext(reportObj, summaryRow ? summaryRow.summary : null, journey, { customContext, milestones });
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
      release();
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
      release();
      if (fullText.trim()) {
        _dbWrite(() => cdb.saveMessage({ email, sessionId, conversationId, role: 'user',      content: message  })).catch(e => log.error('[saveMessage user]', e.message));
        _dbWrite(() => cdb.saveMessage({ email, sessionId, conversationId, role: 'assistant', content: fullText })).catch(e => log.error('[saveMessage asst]', e.message));
      }
    });

    upstream.on('error', err => { log.error('[counsellor upstream]', err.message); release(); if (!res.writableEnded) res.end(); });

  } catch (err) {
    log.error('[counsellor-chat]', err.message, err.stack);
    release();
    if (!res.headersSent) _json(res, 502, { error: 'AI service error. Please try again.' });
  }
}

async function _handleCounsellorSummarise(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  if (!OPENAI_KEY)       return _json(res, 503, { error: 'AI not configured.' });
  let body;
  try { body = await _readBody(req, 64 * 1024); } catch { return _json(res, 400, { error: 'Bad request' }); }
  const email = await _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });
  const conversationId = String(body.conversationId || '').trim();
  const messages       = Array.isArray(body.messages) ? body.messages : [];
  if (!conversationId || !messages.length) return _json(res, 400, { error: 'conversationId and messages required.' });
  try {
    const transcript = messages.map(m => (m.role === 'user' ? 'Student' : 'Aria') + ': ' + m.content).join('\n\n');
    const prompt = 'Compress this counselling conversation into a dense 250-word summary preserving: career decisions, concerns, goals, action items, emotional state.\n\nWrite in third-person.\n\nCONVERSATION:\n' + transcript;
    const upstream = await _openaiReq('/v1/chat/completions', {
      model: AI_MODEL, temperature: 0.3, max_tokens: 400, stream: false,
      messages: [{ role: 'user', content: prompt }],
    });
    const chunks = [];
    await new Promise((resolve, rej) => { upstream.on('data', d => chunks.push(d)); upstream.on('end', resolve); upstream.on('error', rej); });
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
  const email = await _verifyCounsellorToken(req);
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

  const email = await _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });

  if (_chatInFlight >= MAX_CONCURRENT_CHAT) {
    res.writeHead(503, { 'Retry-After': '5', 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Aria is busy right now — please try again in a few seconds.' }));
  }
  _chatInFlight++;
  let _released = false;
  const release = () => { if (!_released) { _released = true; _chatInFlight--; } };
  res.on('close', release);

  try {
    const reportObj    = await cdb.getReportByEmail(email);
    let journey = null;
    try { journey = await cdb.getJourney(email); } catch (_) { /* non-fatal */ }
    const [customContext, milestones] = await Promise.all([
      goals.getCustomContext(email).catch(() => null),
      goals.getMilestones(email).catch(() => []),
    ]);
    const systemPrompt = rag.buildRagContext(reportObj, null, journey, { customContext, milestones });
    const firstName    = reportObj?.student?.firstName
                         || (reportObj?.student?.fullName || '').split(' ')[0]
                         || 'there';
    const primary      = reportObj?.report?.recommended_primary || '';
    const fitTier      = reportObj?.report?.fit_tier || '';
    const seaaStatus   = reportObj?.report?.seaa_status || '';
    const topInterest  = reportObj?.report?.top3_interests?.[0]?.label || '';
    const topTrait     = reportObj?.report?.top_personality_traits?.[0]?.name || '';

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
      release();
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
      release();
      if (fullText.trim() && body.conversationId) {
        const sessionId = reportObj?.session_id || null;
        _dbWrite(() => cdb.saveMessage({
          email, sessionId, conversationId: body.conversationId,
          role: 'assistant', content: fullText,
        })).catch(e => log.error('[Greeting] saveMessage:', e.message));
      }
    });
    upstream.on('error', err => {
      log.error('[Greeting] upstream error:', err.message);
      release();
      if (!res.writableEnded) res.end();
    });

  } catch (err) {
    log.error('[/api/counsellor-greeting]', err.message);
    release();
    if (!res.headersSent) _json(res, 502, { error: 'AI service error.' });
  }
}

async function _handleCounsellorConversations(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  const email = await _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });
  try {
    const convs = await cdb.getConversations(email);
    _json(res, 200, { conversations: convs });
  } catch (err) {
    log.error('[/api/counsellor-conversations]', err.message);
    _json(res, 500, { error: 'Server error' });
  }
}

async function _handleCounsellorHistory(req, res) {
  if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });
  const qs             = urlModule.parse(req.url, true).query;
  const email          = await _verifyCounsellorToken(req);
  if (!email) return _json(res, 401, { error: 'Session expired. Please re-enter your email.' });
  const conversationId = String(qs.conversationId || '').trim();
  if (!conversationId) return _json(res, 400, { error: 'conversationId required' });
  try {
    const messages = await cdb.getHistory(email, { conversationId, limit: 100 });
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
  const rl = await _rlCheckDb('query', String(email).toLowerCase().trim(), 5, RL_WINDOW);
  if (!rl.allowed) {
    res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many submissions. Please try again later.' }));
  }
  try {
    const id = await _dbWrite(() => cdb.saveQuery({ name, email, message, preferredDate, preferredTime }));
    log.info(`[counsellor-query] ${email} id=${id}`);

    if (_emailFn && NOTIFICATION_EMAIL) {
      // Fire-and-forget: the student's submit must not block on the admin
      // notification. A rejected promise is caught here so it never surfaces
      // as an unhandled rejection now that _emailFn is promise-returning.
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
      }).catch(emailErr => log.warn('[counsellor-query] notification email failed:', emailErr.message));
    }

    if (_emailFn) {
      // Fire-and-forget confirmation to the student; same rejection handling.
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
      }).catch(emailErr => log.warn('[counsellor-query] confirmation email failed:', emailErr.message));
    }

    _json(res, 200, { ok: true, id });
  } catch (err) {
    log.error('[counsellor-query]', err.message);
    _json(res, 500, { error: 'Server error. Please try again.' });
  }
}

const _startTime = Date.now();

async function _handleRequest(req, res) {
  const isImport = (req.url || '').includes('/students/import');
  req.setTimeout(isImport ? 120000 : 15000, () => {
    req.destroy();
    if (!res.headersSent) { res.writeHead(408); res.end('Request timeout'); }
  });

  const parsed   = urlModule.parse(req.url || '/');
  const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
  const method   = req.method || 'GET';

  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token, X-Session-ID, Authorization, X-Counsellor-Token, X-Counsellor-Otp-Token');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (method === 'GET' && pathname === '/health') {
    let dbOk = true;
    try { dbOk = await require('./pg-core.js').ping(); } catch { dbOk = false; }
    const payload = { ok: dbOk, uptime: Math.floor((Date.now() - _startTime) / 1000), aiInFlight: _aiInFlight, wqLength: 0 };
    res.writeHead(dbOk ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(payload));
  }

  const ip   = _getIP(req);
  const ipRl = _rlCheck(_ipRL, ip, IP_RL_MAX, IP_WINDOW);
  if (!ipRl.allowed) {
    res.writeHead(429, { 'Retry-After': String(ipRl.retryAfter), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
  }

  try {
    const _STREAMING = new Set(['/api/counsellor-chat','/api/counsellor-greeting','/api/ai-report','/api/counsellor-summarise']);
    if (_STREAMING.has(pathname)) res.setTimeout(90000);

    if (method === 'POST' && pathname === '/api/counsellor-greeting')      return await _handleCounsellorGreeting(req, res);
    if (method === 'GET'  && pathname === '/api/counsellor-conversations') return await _handleCounsellorConversations(req, res);
    if (method === 'GET'  && pathname === '/api/counsellor-history')       return await _handleCounsellorHistory(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-unlock')        return await _handleCounsellorUnlock(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-verify-otp')    return await _handleCounsellorVerifyOtp(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-verify-name')   return await _handleCounsellorVerifyName(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-request-otp')   return await _handleCounsellorRequestOtp(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-verify-identity') return await _handleCounsellorVerifyIdentity(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-verify-pin')   return await _handleCounsellorVerifyPin(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-set-pin')      return await _handleCounsellorSetPin(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-reset-pin')    return await _handleCounsellorResetPin(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-chat')          return await _handleCounsellorChat(req, res);
    if (method === 'GET'    && pathname === '/api/counsellor-context')    return await goalRoutes.getContext(req, res);
    if (method === 'PUT'    && pathname === '/api/counsellor-context')    return await goalRoutes.putContext(req, res);
    if (method === 'GET'    && pathname === '/api/counsellor-milestones') return await goalRoutes.listMilestones(req, res);
    if (method === 'POST'   && pathname === '/api/counsellor-milestones') return await goalRoutes.addMilestone(req, res);
    if (method === 'PATCH'  && pathname === '/api/counsellor-milestones') return await goalRoutes.patchMilestone(req, res);
    if (method === 'DELETE' && pathname === '/api/counsellor-milestones') return await goalRoutes.deleteMilestone(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-clear-history') return await _handleCounsellorClearHistory(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-summarise')     return await _handleCounsellorSummarise(req, res);
    if (method === 'POST' && pathname === '/api/counsellor-query')         return await _handleCounsellorQuery(req, res);
    if (method === 'POST' && pathname === '/api/save-registration')        return await _handleSaveRegistration(req, res);
    if (method === 'POST' && pathname === '/api/save-section')             return await _handleSaveSection(req, res);
    if (method === 'POST' && pathname === '/api/save-report')              return await _handleSaveReport(req, res);
    if (method === 'POST' && pathname === '/api/ai-report')                return await _handleAIReport(req, res);
    if (method === 'POST' && pathname === '/api/dashboard/login') {
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
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (pathname === '/') return _serveStatic(res, path.join(__dirname, 'index.html'), req);

    const rel      = pathname.slice(1);
    const filePath = path.resolve(__dirname, rel);
    const root     = path.resolve(__dirname);
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403); return res.end('Forbidden');
    }

    if (!fs.existsSync(filePath)) {
      const base = path.join(__dirname, path.basename(filePath));
      if (base !== filePath && fs.existsSync(base)) {
        return _serveStatic(res, base, req);
      }
    }
    return _serveStatic(res, filePath, req);

  } catch (err) {
    if (_isDbBusy(err)) {
      log.warn('[Server] DB pool saturated — replying 503:', err.message);
      if (!res.headersSent) {
        res.writeHead(503, { 'Retry-After': '3', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server is busy. Please try again in a few seconds.', retry_after: 3 }));
      }
      return;
    }
    log.error('[Server] Unhandled:', err.message, err.stack);
    if (!res.headersSent) _json(res, 500, { error: 'Internal server error' });
  }
}

async function _handleDashboardInsights(req, res) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return _json(res, 401, { error: 'Unauthorized' });

  const dashUser = await require('./dashboard-db.js').verifyToken(token);
  if (!dashUser) return _json(res, 401, { error: 'Unauthorized' });

  if (!OPENAI_KEY) return _json(res, 503, { error: 'OpenAI not configured on this server.' });

  let body;
  try { body = await _readBody(req, 32 * 1024); }
  catch { return _json(res, 400, { error: 'Bad request' }); }

  const { prompt } = body || {};
  if (!prompt || typeof prompt !== 'string') return _json(res, 400, { error: 'prompt required' });

  try {
    const upstream = await _openaiReq('/v1/chat/completions', {
      model: AI_MODEL, max_tokens: 900, temperature: 0.4,
      messages: [
        { role: 'system', content: 'You are a concise education analyst. Respond ONLY with valid JSON — no markdown, no backticks, no preamble.' },
        { role: 'user', content: prompt },
      ],
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

async function _issueCounsellorToken(email) { return cdb.issueToken(email); }
async function _verifyCounsellorToken(req) {
  const token = (req.headers['x-counsellor-token'] || '').trim();
  return token ? cdb.verifyToken(token) : null;
}

const goalRoutes = require('./counsellor-goals-routes.js')({
  json:                  _json,
  readBody:              _readBody,
  verifyCounsellorToken: _verifyCounsellorToken,
  checkToken:            _checkToken,
});

const server = http.createServer(_handleRequest);

server.headersTimeout   = 10000;
server.requestTimeout   = 30000;
server.keepAliveTimeout = 65000;

// Raised accept-queue backlog (Node default 511) — avoids ECONNRESET bursts
// when the event loop is briefly blocked by synchronous SQLite writes.
const LISTEN_BACKLOG = parseInt(process.env.LISTEN_BACKLOG || '2048', 10);

/* Async bootstrap: create the PostgreSQL schema and wire the DB modules
   BEFORE accepting connections. _db is the shared pg-core module handle
   (kept named "_db" so dashApi.init's signature is unchanged). */
async function _bootstrap() {
  _db = await dbModule._initDb();      // runs pg-core.initSchema() once
  await cdb.init(_db);                 // idempotent; ensures schema ready
  await require('./dashboard-db.js').init(_db); // seeds first-boot accounts
  dashApi.init(_db, _emailFn, _dbWrite);
}

_bootstrap().then(() => {
server.listen(PORT, LISTEN_BACKLOG, () => {
  process.stdout.write(
    `\n✅  NuMind MAPS  →  http://localhost:${PORT}\n` +
    `    Listen backlog: ${LISTEN_BACKLOG}\n` +
    `    PostgreSQL  : ${process.env.DATABASE_URL ? '*** (DATABASE_URL)' : (process.env.PGHOST || '127.0.0.1') + ':' + (process.env.PGPORT || '5432') + '/' + (process.env.PGDATABASE || 'numind')}\n` +
    `    Token       : ${APP_TOKEN ? '*** (set)' : '(not set — open access)'}\n` +
    `    AI models   : ${AI_MODEL} / chat: ${CHAT_MODEL}\n` +
    `    OpenAI      : ${OPENAI_KEY ? '*** (set)' : '(not set — AI disabled)'}\n` +
    `    CORS        : ${ALLOWED_ORIGIN}\n` +
    `    Max AI      : ${MAX_CONCURRENT_AI} concurrent streams\n` +
    `    Log level   : ${LOG_LEVEL}\n\n`
  );
  _prewarm();
  require('./counsellor-goals-reminders.js').startReminderScheduler({ emailFn: _emailFn, log });
  if (typeof process.send === 'function') process.send('ready');
});
}).catch(err => { log.error('[Server] Bootstrap failed:', err.message, err.stack); process.exit(1); });

server.on('error', err => { log.error('[Server] Fatal:', err.message); process.exit(1); });

function _gracefulShutdown() {
  log.error('[Server] Shutting down…');
  server.close(() => {
    Promise.resolve()
      .then(() => dbModule.close && dbModule.close())
      .then(() => cdb.close && cdb.close())
      .catch(() => {})
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', _gracefulShutdown);
process.on('SIGINT',  _gracefulShutdown);

module.exports = server;
