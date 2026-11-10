'use strict';

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const quran = require('./quran');
const qt = require('./quran-text');
const { loadState, saveState, position } = require('./state');
const { loadConfig } = require('./config');
const { openUrl } = require('./open');
const registry = require('./web-registry');
const qurancom = require('./qurancom');

/*
 * The bundled web reader.
 *
 * A terminal grid can't lay out right-to-left Arabic reliably — tmux has no bidi
 * engine and terminals disagree — so the honest place to *read* is a browser,
 * where RTL is a solved problem. This is a zero-dependency local HTTP server
 * that serves the bundled Uthmani text as one quiet page and advances in step
 * with the state file, exactly like the TUI reader.
 *
 * Bound to 127.0.0.1 only. Deduped through web-registry.js: the first
 * `claude --cwq` starts it, later ones reuse it. Shuts itself down once no
 * request has arrived for `idleMs` (i.e. the last browser tab closed).
 */

const DEFAULT_PORT = 7620;
const PORT_SCAN = 16; // ports to try before giving up
const DEFAULT_SPAN = 3; // ayat shown on each side of the current one
const DEFAULT_IDLE_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 5000;

/* ─── data ─────────────────────────────────────────────────────────────── */

/** The current ayah plus `span` neighbours on each side (wraps 114:6 → 1:1). */
function collectAyat(pos, span) {
  const ayat = [];
  for (let d = -span; d <= span; d++) {
    const p =
      d === 0 ? pos : d < 0 ? quran.rewind(pos, -d, true) : quran.advance(pos, d, true);
    // a wrapped duplicate (near the very start/end of the Qur'an) — skip it
    if (d !== 0 && p.surah === pos.surah && p.ayah === pos.ayah) continue;
    ayat.push({
      surah: p.surah,
      ayah: p.ayah,
      ref: `${p.surah}:${p.ayah}`,
      text: qt.ayahText(p.surah, p.ayah),
      transliteration: qt.transliterationOf(p.surah, p.ayah),
      translation: qt.translationOf(p.surah, p.ayah),
      numeral: qt.toArabicDigits(p.ayah),
      current: d === 0,
    });
  }
  return ayat;
}

/** Move the pointer by `delta` ayat (the page's j/k). Returns the new position. */
function move(delta) {
  const st = loadState();
  const from = position(st);
  const step = Math.trunc(Number(delta)) || 0;
  const to =
    step === 0
      ? from
      : step > 0
        ? quran.advance(from, step, loadConfig().loop)
        : quran.rewind(from, -step, loadConfig().loop);
  saveState({ ...st, surah: to.surah, ayah: to.ayah });
  return to;
}

/** Jump the pointer to a reference like "2:255" or "Al-Kahf" (the page's g). */
function goto(ref) {
  const to = quran.parseReference(ref);
  const st = loadState();
  saveState({ ...st, surah: to.surah, ayah: to.ayah });
  return to;
}

/**
 * Everything the page needs for one render, as plain data.
 * Pure — reads the state file, touches nothing else.
 * @param {number} [span]  ayat to include on each side of the current one
 */
function frameData(span = DEFAULT_SPAN) {
  const pos = position(loadState());
  const s = quran.surah(pos.surah);
  const idx = quran.absoluteIndex(pos);

  return {
    position: pos,
    ref: `${pos.surah}:${pos.ayah}`,
    surah: {
      number: s.number,
      name: s.name,
      meaning: s.meaning,
      arabic: s.arabic,
      revelationPlace: s.revelationPlace,
      ayahs: s.ayahs,
    },
    basmalah: pos.ayah === 1 && qt.hasOpeningBasmalah(pos.surah) ? qt.BASMALAH : null,
    ayat: collectAyat(pos, span),
    progress: {
      index: idx,
      total: quran.TOTAL_AYAT,
      percent: Math.round((idx / quran.TOTAL_AYAT) * 1000) / 10,
    },
    credits: CREDITS,
  };
}

/* ─── the page ─────────────────────────────────────────────────────────── */

// The page lives in its own file so it can be edited as HTML. Read once at load.
const PAGE = fs.readFileSync(path.join(__dirname, 'web-page.html'), 'utf8');

/** Where the companion texts come from, shown in the page's reading options. */
const CREDITS = [
  {
    label: 'Arabic',
    source: 'Tanzil Project, Uthmani',
    url: 'https://tanzil.net/',
  },
  {
    label: 'Translation',
    source: 'Saheeh International, QuranEnc v1.1.2',
    url: 'https://quranenc.com/en/browse/english_saheeh/',
  },
  {
    label: 'Transliteration',
    source: 'Quran.com, live (Tanzil Project offline)',
    url: 'https://quran.com/',
  },
];

/* ─── server ───────────────────────────────────────────────────────────── */

/**
 * Build the reader's HTTP server (not yet listening).
 * @param {{ span?: number, onHit?: () => void, fetch?: typeof fetch }} [opts]
 *   `fetch` replaces the network call for the live Quran.com transliteration (tests).
 * @returns {import('http').Server}
 */
function createServer(opts = {}) {
  const span = opts.span || DEFAULT_SPAN;
  const server = http.createServer((req, res) => {
    if (opts.onHit) opts.onHit();
    const [pathname, query = ''] = (req.url || '/').split('?');
    const json = (code, obj) => {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(obj));
    };
    const frame = () => {
      const m = query.match(/(?:^|&)span=(\d+)/);
      return frameData(m ? Math.max(0, Math.min(6, parseInt(m[1], 10))) : span);
    };

    if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/transliteration') {
      const m = query.match(/(?:^|&)surah=(\d+)/);
      const n = m ? parseInt(m[1], 10) : 0;
      if (n < 1 || n > quran.TOTAL_SURAHS) return json(400, { error: 'bad surah' });
      qurancom
        .surahTransliteration(n, { ayahs: quran.surah(n).ayahs, fetch: opts.fetch })
        .then((ayat) => json(200, { surah: n, source: 'quran.com', ayat }))
        // 200 with no ayat: the page keeps the bundled Tanzil text (no console noise offline)
        .catch((err) => json(200, { surah: n, source: 'tanzil', ayat: null, error: String(err && err.message) }));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/surahs') {
      json(200, quran.SURAHS.map(({ number, name, meaning, arabic, ayahs }) => ({
        number,
        name,
        meaning,
        arabic,
        ayahs,
      })));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/frame') {
      try {
        json(200, frame());
      } catch (err) {
        json(500, { error: String(err && err.message) });
      }
      return;
    }
    // writes: page-driven navigation (j/k/g). localhost only, same-origin only.
    if (req.method === 'POST' && (pathname === '/api/move' || pathname === '/api/goto')) {
      if (!sameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      try {
        if (pathname === '/api/move') {
          const m = query.match(/(?:^|&)d=(-?\d+)/);
          move(m ? parseInt(m[1], 10) : 0);
        } else {
          const m = query.match(/(?:^|&)ref=([^&]+)/);
          if (!m) return json(400, { error: 'missing ref' });
          goto(decodeURIComponent(m[1]));
        }
        json(200, frame());
      } catch (err) {
        json(400, { error: String(err && err.message) });
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  return server;
}

/** Reject a cross-site write (a stray page poking 127.0.0.1). Missing Origin = a
 *  direct/programmatic call, allowed. A present Origin must be loopback, or the
 *  same host the request was addressed to (the page opened through a proxy such
 *  as `tailscale serve`, which forwards to 127.0.0.1). A cross-site page can't
 *  forge Host or X-Forwarded-Host, so this still refuses it. */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o)) return true;
  let host;
  try {
    host = new URL(o).host;
  } catch {
    return false;
  }
  const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  return host === req.headers.host || (fwd !== '' && host === fwd);
}

/** Listen on the first free port at/above `start`. Resolves { server, port }. */
function listen(server, start, tries = PORT_SCAN) {
  return new Promise((resolve, reject) => {
    let port = start;
    let left = tries;
    const attempt = () => {
      server.removeAllListeners('error');
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && --left > 0) {
          port += 1;
          attempt();
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve({ server, port });
      });
    };
    attempt();
  });
}

/**
 * Run the reader in the foreground (used by `code-with-quran serve`).
 * Resolves when the server stops (idle shutdown, SIGTERM, or SIGINT).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.open]      open the browser once bound (default true)
 * @param {number}  [opts.port]      preferred port (default 7620, scans upward)
 * @param {number}  [opts.span]      ayat per side (default 3)
 * @param {number}  [opts.idleMs]    stop after this long with no request (default 3m)
 * @param {(msg:string)=>void} [opts.log]  progress line sink (default: stderr)
 * @returns {Promise<{ reused: boolean, url: string, port: number }>}
 */
async function serve(opts = {}) {
  const wantOpen = opts.open !== false;
  const log = opts.log || ((m) => process.stderr.write(m + '\n'));

  const live = registry.current();
  if (live) {
    if (wantOpen) openUrl(live.url, {});
    log(`web reader already running — ${live.url}`);
    return { reused: true, url: live.url, port: live.port };
  }

  let lastHit = Date.now();
  const server = createServer({ span: opts.span, onHit: () => (lastHit = Date.now()) });

  const { port } = await listen(server, opts.port || DEFAULT_PORT);
  server.on('error', () => server.close()); // a late socket error: shut down, don't crash
  const url = `http://127.0.0.1:${port}/`;
  const heartbeat = registry.announce(port);

  const hb = setInterval(heartbeat.beat, HEARTBEAT_MS);
  const idleMs = opts.idleMs || DEFAULT_IDLE_MS;
  const idle = setInterval(() => {
    if (Date.now() - lastHit > idleMs) server.close();
  }, Math.min(idleMs, 15_000));
  hb.unref();
  idle.unref();

  log(`web reader on ${url}`);
  if (wantOpen) openUrl(url, {});

  return new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(hb);
      clearInterval(idle);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      heartbeat.clear();
      server.close();
      resolve({ reused: false, url, port });
    };
    server.once('close', stop);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

/**
 * Make sure a web reader is up, without blocking. Spawns `serve` detached (which
 * binds a port and opens the browser once) when nothing is running; a live
 * server is left alone so its open tab isn't disturbed. Called at session start
 * (`start`) and as a safety net on each advance (`open`).
 * @returns {{ running: boolean, spawned: boolean, url: string|null }}
 */
function ensureServer() {
  const live = registry.current();
  if (live) return { running: true, spawned: false, url: live.url };
  const bin = path.join(__dirname, '..', 'bin', 'code-with-quran.js');
  try {
    const child = spawn(process.execPath, [bin, 'serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
    return { running: false, spawned: true, url: null };
  } catch {
    return { running: false, spawned: false, url: null };
  }
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_SPAN,
  frameData,
  move,
  goto,
  createServer,
  listen,
  serve,
  ensureServer,
  PAGE,
};
