#!/usr/bin/env node
/**
 * Miestna napodobenina nasadenej webovej aplikácie Google Apps Script.
 *
 * Spustí ten istý kód, ktorý sa nasadzuje na Google (server/Code.gs), v napodobenom prostredí
 * (tests/helpers/gas-mock.js) a sprístupní ho cez HTTP. Vďaka tomu sa dá ostrý režim stránky
 * vyskúšať v prehliadači bez účtu Google a bez internetu.
 *
 * Správa sa ako skutočná služba:
 *  - odpoveď prichádza cez presmerovanie (302) na inú adresu, tak ako pri Apps Script,
 *  - povolené sú iba „jednoduché“ požiadavky (GET a POST s text/plain); predbežnú kontrolu
 *    CORS (OPTIONS) server odmietne, rovnako ako Apps Script.
 *
 * Použitie:
 *   node tests/mock-backend.js [--port 8787] [--now 2026-10-11T17:55:00Z]
 *   potom v prehliadači:  index.html  s  window.BARBER_CONFIG = { apiUrl: 'http://127.0.0.1:8787/exec' }
 *
 * Adresy /__test/… slúžia iba testom (nastavenie času, výpadok, nahliadnutie do tabuľky a pošty).
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { createGasEnvironment } = require('./helpers/gas-mock.js');

function parseArgs(argv) {
  const args = { port: 8787, now: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--now') args.now = argv[++i];
  }
  return args;
}

function createMockBackend(options) {
  const opts = options || {};
  let env = createGasEnvironment({ now: opts.now || undefined });
  let offline = false;
  /** Odpovede čakajúce na vyzdvihnutie po presmerovaní. */
  const pending = new Map();

  const cors = { 'Access-Control-Allow-Origin': '*' };
  const send = (res, status, body, headers) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors, headers || {}));
    res.end(text);
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  /** Uloží výsledok a presmeruje na adresu, kde si ho prehliadač vyzdvihne (ako script.googleusercontent.com). */
  const redirectWith = (res, result) => {
    const key = crypto.randomUUID();
    pending.set(key, result);
    res.writeHead(302, Object.assign({ Location: '/macros/echo?user_content_key=' + key }, cors));
    res.end();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      /* --- pomocné adresy pre testy --- */
      if (url.pathname === '/__test/state') {
        return send(res, 200, { records: env.records(), mails: env.mails, logs: env.logs, lock: env.lock, offline });
      }
      if (url.pathname === '/__test/now' && req.method === 'POST') {
        env.setNow(JSON.parse(await readBody(req)).now);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__test/offline' && req.method === 'POST') {
        offline = !!JSON.parse(await readBody(req)).offline;
        return send(res, 200, { ok: true, offline });
      }
      if (url.pathname === '/__test/fail-mail' && req.method === 'POST') {
        env.context.MailApp.failNext = true;
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__test/reset' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        env = createGasEnvironment({ now: body.now || opts.now || undefined });
        offline = false;
        pending.clear();
        return send(res, 200, { ok: true });
      }

      /* --- webová aplikácia --- */
      if (offline) return send(res, 503, 'Service Unavailable', { 'Content-Type': 'text/plain' });

      if (url.pathname === '/macros/echo') {
        const key = url.searchParams.get('user_content_key');
        if (!pending.has(key)) return send(res, 404, { ok: false });
        const result = pending.get(key);
        pending.delete(key);
        return send(res, 200, result);
      }

      if (url.pathname === '/exec') {
        if (req.method === 'GET') {
          return redirectWith(res, env.get(Object.fromEntries(url.searchParams)));
        }
        if (req.method === 'POST') {
          const type = String(req.headers['content-type'] || '');
          // Apps Script nevie odpovedať na predbežnú kontrolu, preto musí stránka posielať text/plain
          if (!type.startsWith('text/plain')) return send(res, 400, { ok: false, message: 'Očakáva sa text/plain' });
          return redirectWith(res, env.post(await readBody(req)));
        }
        // OPTIONS a ostatné metódy: bez hlavičiek CORS, prehliadač požiadavku zablokuje
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('Method Not Allowed');
      }

      return send(res, 404, { ok: false, message: 'Neznáma adresa' });
    } catch (err) {
      return send(res, 500, { ok: false, message: String(err && err.message ? err.message : err) });
    }
  });

  return {
    server,
    /** Spustí server; port 0 = ľubovoľný voľný port. Vráti skutočný port. */
    listen: (port) =>
      new Promise((resolve) => {
        server.listen(port || 0, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
    env: () => env,
  };
}

module.exports = { createMockBackend };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const backend = createMockBackend({ now: args.now });
  backend.listen(args.port).then((port) => {
    // Tento riadok čakajú testy v prehliadači, preto ho nemeňte.
    console.log('LISTENING http://127.0.0.1:' + port + '/exec');
  });
}
