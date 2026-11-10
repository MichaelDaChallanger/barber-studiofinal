/**
 * Napodobenina prostredia Google Apps Script pre testy servera (server/Code.gs).
 *
 * Nahrádza služby Googlu jednoduchými verziami v pamäti: tabuľka je pole riadkov,
 * e-maily sa iba zapisujú do zoznamu, zámok počíta použitia a hodiny sa dajú nastaviť.
 * Vďaka tomu sa dá otestovať ten istý kód, ktorý sa nasadzuje do Apps Script,
 * bez účtu Google a bez internetu.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const CODE_PATH = path.join(__dirname, '..', '..', 'server', 'Code.gs');

/** Hárok v pamäti. Bunky sú reťazce; úvodný apostrof znamená „text“ a nezobrazuje sa (ako v Tabuľkách Google). */
function createSheet(name) {
  const rows = [];
  const ensure = (r, c) => {
    while (rows.length < r) rows.push([]);
    const row = rows[r - 1];
    while (row.length < c) row.push('');
  };
  const store = (value) => String(value === null || value === undefined ? '' : value).replace(/^'/, '');
  const sheet = {
    rows,
    frozenRows: 0,
    getName: () => name,
    getLastRow: () => rows.length,
    setFrozenRows(n) {
      sheet.frozenRows = n;
    },
    getRange(r, c, numRows = 1, numCols = 1) {
      const range = {
        getDisplayValues() {
          ensure(r + numRows - 1, c + numCols - 1);
          return rows.slice(r - 1, r - 1 + numRows).map((row) => row.slice(c - 1, c - 1 + numCols).map(String));
        },
        setValues(values) {
          if (values.length !== numRows || values.some((v) => v.length !== numCols)) {
            throw new Error('setValues: rozmery údajov nezodpovedajú rozsahu');
          }
          ensure(r + numRows - 1, c + numCols - 1);
          values.forEach((vals, i) => vals.forEach((v, j) => (rows[r - 1 + i][c - 1 + j] = store(v))));
          return range;
        },
        setValue(value) {
          ensure(r, c);
          rows[r - 1][c - 1] = store(value);
          return range;
        },
        setNumberFormat: () => range,
        setFontWeight: () => range,
      };
      return range;
    },
  };
  return sheet;
}

/** Utilities.formatDate pre vzory použité na serveri (yyyy, MM, dd, HH, mm, ss a text v apostrofoch). */
function formatDate(date, timeZone, pattern) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  const map = { yyyy: get('year'), MM: get('month'), dd: get('day'), HH: get('hour'), mm: get('minute'), ss: get('second') };
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g, (token, literal) => (literal !== undefined ? literal : map[token]));
}

/**
 * Vytvorí prostredie a načíta doň server/Code.gs.
 * @param {object} [options]
 * @param {string|Date} [options.now] „aktuálny“ okamih (dá sa meniť cez env.setNow)
 * @param {string} [options.ownerEmail]
 */
function createGasEnvironment(options) {
  const opts = options || {};
  let current = new Date(opts.now || Date.now()).getTime();
  const sheets = new Map();
  const mails = [];
  const logs = [];
  const lock = { acquired: 0, released: 0, held: false, failNext: false };

  // Date, ktorý bez argumentov vracia nastavený okamih
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(current);
      else super(...args);
    }
    static now() {
      return current;
    }
  }

  const sandbox = {
    Date: FakeDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => sheets.get(name) || null,
        insertSheet(name) {
          const sheet = createSheet(name);
          sheets.set(name, sheet);
          return sheet;
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() {
          if (lock.failNext) {
            lock.failNext = false;
            throw new Error('Lock timeout');
          }
          if (lock.held) throw new Error('Zámok je už držaný (test: vnorené zamknutie)');
          lock.held = true;
          lock.acquired++;
        },
        releaseLock() {
          lock.held = false;
          lock.released++;
        },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        const out = { content: text, mimeType: 'text/plain', getContent: () => text };
        out.setMimeType = (type) => {
          out.mimeType = type;
          return out;
        };
        return out;
      },
    },
    MailApp: {
      failNext: false,
      sendEmail(message) {
        if (sandbox.MailApp.failNext) {
          sandbox.MailApp.failNext = false;
          throw new Error('Service invoked too many times for one day: email.');
        }
        mails.push(message);
      },
      getRemainingDailyQuota: () => 100 - mails.length,
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => opts.ownerEmail || 'majitel@example.com' }) },
    Utilities: { formatDate, getUuid: () => crypto.randomUUID() },
    Logger: { log: (message) => logs.push(String(message)) },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context, { filename: 'Code.gs' });

  const parse = (output) => JSON.parse(output.getContent());
  return {
    context,
    sheets,
    mails,
    logs,
    lock,
    /** Nastaví „aktuálny“ okamih (Date alebo ISO reťazec). */
    setNow(value) {
      current = new Date(value).getTime();
    },
    /** GET požiadavka s parametrami. */
    get: (params) => parse(context.doGet({ parameter: params || {} })),
    /** POST požiadavka s telom JSON. */
    post: (body) => parse(context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } })),
    /** Hárok s rezerváciami (vznikne pri prvej požiadavke). */
    sheet: () => sheets.get(context.CONFIG.SHEET_NAME),
    /** Riadky hárka ako objekty podľa názvov stĺpcov. */
    records() {
      const sheet = sheets.get(context.CONFIG.SHEET_NAME);
      if (!sheet) return [];
      return sheet.rows.slice(1).map((row) => Object.fromEntries(context.COLUMNS.map((key, i) => [key, row[i] || ''])));
    },
  };
}

module.exports = { createGasEnvironment, createSheet, formatDate };
