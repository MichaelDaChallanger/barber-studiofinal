/**
 * Testy servera (server/Code.gs) v napodobenom prostredí Google Apps Script
 * a testy rozhrania api.js. Spustenie: npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Data = require('../js/data.js');
const Logic = require('../js/booking-logic.js');
const Api = require('../js/api.js');
const Storage = require('../js/storage.js');
const { createGasEnvironment } = require('./helpers/gas-mock.js');

// Nedeľa 11. 10. 2026, 19:55 v Bratislave (UTC+2)
const NOW_UTC = '2026-10-11T17:55:00Z';
const MON = '2026-10-12';

const JAN = { name: 'Ján Testovací', email: 'jan@example.com', phone: '0944 123 987' };
const PETER = { name: 'Peter Iný', email: 'peter@example.com', phone: '0900 000 111' };

const booking = (overrides) => Object.assign({ serviceId: 'panski-strih', barberId: 'michael', date: MON, time: '10:00', note: '' }, JAN, overrides);
const create = (env, overrides) => env.post({ action: 'create', booking: booking(overrides) });

/* ---------------- Vytvorenie a zápis do hárka ---------------- */

test('server: prvá požiadavka vytvorí hárok s hlavičkou', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const ping = env.get({});
  assert.equal(ping.ok, true);
  assert.match(ping.time, /^2026-10-11 19:55:00$/); // čas prevádzky, nie UTC

  assert.deepEqual(env.get({ action: 'busy', from: MON, to: MON }), { ok: true, busy: [] });
  const sheet = env.sheet();
  assert.equal(sheet.getName(), 'Rezervácie');
  assert.equal(sheet.rows[0][0], 'Stav');
  assert.equal(sheet.rows[0].length, env.context.COLUMNS.length);
  assert.equal(env.context.HEADERS.length, env.context.COLUMNS.length);
  assert.equal(sheet.frozenRows, 1);
});

test('server: vytvorenie uloží riadok, vráti kód a pošle dva e-maily', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const result = create(env, { serviceId: 'strih-brada', note: 'Prosím kratšie po bokoch' });
  assert.equal(result.ok, true);
  assert.match(result.booking.id, /^BS-[A-Z0-9]{6}$/);
  assert.equal(result.booking.endTime, '11:00');
  assert.equal(result.booking.createdAt, '2026-10-11 19:55:00');
  assert.equal(result.mailed, true);

  const [row] = env.records();
  assert.equal(row.status, 'potvrdená');
  assert.equal(row.date, MON);
  assert.equal(row.time, '10:00');
  assert.equal(row.endTime, '11:00');
  assert.equal(row.serviceName, 'Strih a brada');
  assert.equal(row.barberName, 'Michael Nguyen');
  assert.equal(row.name, 'Ján Testovací');
  assert.equal(row.phone, '+421944123987'); // číslo ostalo textom, nie vzorcom
  assert.equal(row.price, '32');
  assert.equal(row.id, result.booking.id);

  assert.equal(env.mails.length, 2);
  const [customerMail, ownerMail] = env.mails;
  assert.equal(customerMail.to, 'jan@example.com');
  assert.match(customerMail.subject, /Potvrdenie rezervácie: 12\. októbra o 10:00/);
  assert.ok(customerMail.body.includes('Kód rezervácie: ' + result.booking.id));
  assert.ok(customerMail.body.includes('Dátum: pondelok 12. októbra 2026'));
  assert.ok(customerMail.body.includes(Data.SHOP.address));
  assert.equal(ownerMail.to, 'majitel@example.com');
  assert.ok(ownerMail.body.includes('Telefón: +421 944 123 987'));
  assert.ok(ownerMail.body.includes('Poznámka: Prosím kratšie po bokoch'));
  assert.equal(env.lock.acquired, 1);
  assert.equal(env.lock.released, 1);
});

test('server: obsadený termín odmietne a nič nezapíše', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  assert.equal(create(env, { serviceId: 'strih-brada' }).ok, true); // 10:00–11:00
  const clash = create(env, Object.assign({ time: '10:30' }, PETER));
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'SLOT_TAKEN');
  assert.equal(env.records().length, 1);
  assert.equal(env.mails.length, 2); // za odmietnutú rezerváciu sa e-mail neposiela
  assert.equal(create(env, Object.assign({ time: '11:00' }, PETER)).ok, true);
  assert.equal(env.lock.held, false);
});

test('server: neplatný vstup, minulosť, limit a pasca na roboty', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const invalid = create(env, { email: 'zle', phone: '123' });
  assert.equal(invalid.code, 'VALIDATION');
  assert.ok(invalid.errors.email && invalid.errors.phone);
  assert.equal(create(env, { date: '2026-10-09' }).code, 'VALIDATION');
  assert.equal(create(env, { date: '2026-10-18' }).code, 'VALIDATION'); // nedeľa
  assert.equal(create(env, { website: 'http://spam.example' }).code, 'SPAM');
  assert.equal(env.records().length, 0);

  ['09:00', '11:00', '13:00'].forEach((time) => assert.equal(create(env, { time }).ok, true, time));
  assert.equal(create(env, { time: '15:00' }).code, 'CUSTOMER_LIMIT');
  assert.equal(env.records().length, 3);

  // čas na serveri sa posunie: pondelok 12:10, termín o 12:00 je už minulosť
  env.setNow('2026-10-12T10:10:00Z');
  assert.equal(create(env, Object.assign({ time: '12:00' }, PETER)).code, 'PAST');
  assert.equal(create(env, Object.assign({ time: '12:30' }, PETER)).ok, true);
});

test('server: ktorýkoľvek barber dostane konkrétne meno', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const first = create(env, { barberId: 'any', time: '12:00' });
  const second = create(env, Object.assign({ barberId: 'any', time: '12:00' }, PETER));
  assert.equal(first.booking.barberId, 'michael');
  assert.equal(second.booking.barberId, 'tomas');
  assert.equal(env.records()[0].barberAuto, 'áno');
  const third = create(env, { barberId: 'any', time: '12:00', name: 'Tretí Zákazník', email: 'treti@example.com', phone: '0900 000 222' });
  assert.equal(third.code, 'SLOT_TAKEN');
});

test('server: nebezpečný text v poznámke sa uloží ako text, nie ako vzorec', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const stored = [];
  const result = create(env, { note: '=HYPERLINK("http://zle.example";"klik")' });
  assert.equal(result.ok, true);
  // čo presne server poslal do tabuľky: vzorec musí mať pred sebou apostrof
  const sheet = env.sheet();
  const original = env.context.bookingToRow(Object.assign({}, result.booking));
  original.forEach((cell) => stored.push(cell));
  assert.ok(stored.includes('\'=HYPERLINK("http://zle.example";"klik")'));
  assert.ok(stored.includes("'+421944123987"));
  assert.equal(env.records()[0].note, '=HYPERLINK("http://zle.example";"klik")');
  assert.equal(sheet.rows.length, 2);
});

/* ---------------- Obsadenosť ---------------- */

test('server: obsadenosť neobsahuje osobné údaje a rešpektuje rozsah', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  create(env, { serviceId: 'strih-styling', time: '10:00' });
  create(env, Object.assign({ barberId: 'tomas', date: '2026-10-13', time: '09:00' }, PETER));

  const all = env.get({ action: 'busy', from: '2026-10-11', to: '2026-12-10' });
  assert.deepEqual(all.busy, [
    { barberId: 'michael', date: MON, time: '10:00', duration: 45 },
    { barberId: 'tomas', date: '2026-10-13', time: '09:00', duration: 30 },
  ]);
  const text = JSON.stringify(all);
  ['jan@example.com', 'Ján', '+421944123987', 'BS-'].forEach((secret) => assert.ok(!text.includes(secret), secret));

  assert.equal(env.get({ action: 'busy', from: '2026-10-13', to: '2026-10-13' }).busy.length, 1);
  // nezmyselný rozsah sa oreže na povolené obdobie
  assert.equal(env.get({ action: 'busy', from: '1999-01-01', to: '2099-01-01' }).busy.length, 2);
  assert.equal(env.get({ action: 'busy' }).busy.length, 2);
});

/* ---------------- Vyhľadanie, zrušenie, presun ---------------- */

test('server: vyhľadanie vráti rezervácie bez kódu a bez kontaktu', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const a = create(env, { time: '10:00' }).booking;
  create(env, Object.assign({ time: '11:00' }, PETER));

  const byMail = env.post({ action: 'find', query: 'JAN@example.com' });
  assert.equal(byMail.ok, true);
  assert.equal(byMail.bookings.length, 1);
  assert.equal(byMail.bookings[0].ref, 2);
  assert.equal(byMail.bookings[0].time, '10:00');
  const text = JSON.stringify(byMail);
  [a.id, 'jan@example.com', '+421944123987', 'Ján'].forEach((secret) => assert.ok(!text.includes(secret), secret));

  assert.equal(env.post({ action: 'find', query: '00421 944 123 987' }).bookings.length, 1);
  assert.equal(env.post({ action: 'find', query: 'nikto@example.com' }).bookings.length, 0);
  assert.equal(env.post({ action: 'find', query: 'nezmysel' }).code, 'VALIDATION');
});

test('server: zrušenie vyžaduje správny kód aj kontakt a uvoľní termín', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const mine = create(env, { time: '10:00' }).booking;
  const other = create(env, Object.assign({ time: '11:00' }, PETER)).booking;
  env.mails.length = 0;

  const cancel = (data) => env.post(Object.assign({ action: 'cancel', ref: 2, contact: 'jan@example.com', code: mine.id }, data));
  assert.equal(cancel({ code: '' }).code, 'CODE_MISMATCH');
  assert.equal(cancel({ code: 'BS-AAAAAA' }).code, 'CODE_MISMATCH');
  assert.equal(cancel({ code: other.id }).code, 'CODE_MISMATCH'); // kód inej rezervácie
  assert.equal(cancel({ ref: 99 }).code, 'CODE_MISMATCH');
  assert.equal(cancel({ contact: 'peter@example.com' }).code, 'FORBIDDEN');
  assert.equal(env.records()[0].status, 'potvrdená');
  assert.equal(env.mails.length, 0);

  // kód sa dá napísať malými písmenami aj bez predpony
  const ok = cancel({ code: ' ' + mine.id.slice(3).toLowerCase() + ' ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.booking.status, 'cancelled');
  assert.equal(env.records()[0].status, 'zrušená');
  assert.equal(env.records()[0].cancelledAt, '2026-10-11 19:55:00');
  assert.equal(env.mails.length, 2);
  assert.match(env.mails[0].subject, /Rezervácia zrušená/);

  assert.equal(cancel({}).code, 'ALREADY_CANCELLED');
  assert.deepEqual(env.get({ action: 'busy' }).busy.map((b) => b.time), ['11:00']);
  assert.equal(create(env, { time: '10:00', name: 'Nový Zákazník', email: 'novy@example.com', phone: '0900 000 333' }).ok, true);
});

test('server: presun zapíše nový termín a pôvodný uvoľní', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const mine = create(env, { serviceId: 'strih-brada', time: '10:00' }).booking;
  create(env, Object.assign({ time: '13:00' }, PETER));
  env.mails.length = 0;

  const move = (data) => env.post(Object.assign({ action: 'reschedule', ref: 2, contact: '0944 123 987', code: mine.id, date: MON, time: '14:00' }, data));
  assert.equal(move({ code: 'BS-ZZZZZZ' }).code, 'CODE_MISMATCH');
  assert.equal(move({ time: '12:30' }).code, 'SLOT_TAKEN'); // 12:30–13:30 zasahuje do 13:00
  assert.equal(move({ time: '10:00' }).code, 'SAME_TIME');
  assert.equal(move({ date: '2026-10-18' }).code, 'INVALID_DATE');

  const ok = move({});
  assert.equal(ok.ok, true);
  assert.equal(ok.booking.time, '14:00');
  assert.equal(ok.booking.endTime, '15:00');
  const row = env.records()[0];
  assert.deepEqual([row.date, row.time, row.endTime, row.status], [MON, '14:00', '15:00', 'potvrdená']);
  assert.equal(row.rescheduledAt, '2026-10-11 19:55:00');
  assert.equal(env.mails.length, 2);
  assert.ok(env.mails[0].body.includes('Pôvodný termín: 12. októbra o 10:00.'));
  assert.deepEqual(env.get({ action: 'busy' }).busy.map((b) => b.time).sort(), ['13:00', '14:00']);
});

/* ---------------- Odolnosť ---------------- */

test('server: zlyhanie e-mailu rezerváciu nezruší', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  env.context.MailApp.failNext = true;
  const result = create(env, {});
  assert.equal(result.ok, true);
  assert.equal(result.mailed, false);
  assert.equal(env.records().length, 1);
  assert.ok(env.logs.some((l) => l.includes('E-mail sa nepodarilo odoslať')));
});

test('server: vypnuté e-maily a vlastná adresa prevádzky', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  env.context.CONFIG.OWNER_EMAIL = 'salon@example.com';
  create(env, {});
  assert.equal(env.mails[1].to, 'salon@example.com');
  assert.equal(env.mails[0].replyTo, 'salon@example.com');

  env.context.CONFIG.SEND_EMAILS = false;
  const silent = create(env, Object.assign({ time: '12:00' }, PETER));
  assert.equal(silent.ok, true);
  assert.equal(silent.mailed, false);
  assert.equal(env.mails.length, 2);
});

test('server: keď sa nepodarí získať zámok, požiadavka slušne zlyhá', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  env.lock.failNext = true;
  const result = create(env, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUSY');
  assert.equal(env.sheet(), undefined);
  assert.equal(create(env, {}).ok, true); // ďalší pokus prejde
});

test('server: nezrozumiteľná požiadavka a neznáma akcia', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  assert.equal(env.post('{toto nie je json').code, 'BAD_REQUEST');
  assert.equal(env.post({ action: 'zmaz-vsetko' }).code, 'BAD_REQUEST');
  assert.equal(env.post({}).code, 'BAD_REQUEST');
});

test('server: ručne dopísaný riadok (telefonická rezervácia) obsadí termín', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  env.get({ action: 'busy' }); // vytvorí hárok
  const sheet = env.sheet();
  const cols = env.context.COLUMNS;
  const manual = (values) => cols.map((key) => values[key] || '');
  sheet.rows.push(manual({ status: 'potvrdená', date: '12.10.2026', time: '9:30', serviceName: 'Strih a brada', barberName: 'Tomáš', name: 'Pán z telefónu' }));
  sheet.rows.push(manual({ status: 'zrušená', date: MON, time: '15:00', serviceName: 'Pánsky strih', barberName: 'Tomáš Kováč' }));
  sheet.rows.push(manual({ status: 'potvrdená', date: 'zajtra', time: '10:00', serviceName: 'Pánsky strih', barberName: 'Tomáš Kováč' })); // nečitateľný dátum
  sheet.rows.push(manual({})); // prázdny riadok

  const busy = env.get({ action: 'busy' }).busy;
  assert.deepEqual(busy, [{ barberId: 'tomas', date: MON, time: '09:30', duration: 60 }]);
  assert.equal(create(env, { barberId: 'tomas', time: '10:00' }).code, 'SLOT_TAKEN');
  assert.equal(create(env, { barberId: 'tomas', time: '10:30' }).ok, true);
  assert.equal(create(env, Object.assign({ barberId: 'tomas', time: '15:00' }, PETER)).ok, true); // zrušený riadok neblokuje
});

test('server: prevádzka zruší rezerváciu prepísaním stavu v tabuľke', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  create(env, {});
  const statusIndex = env.context.COLUMNS.indexOf('status');
  env.sheet().rows[1][statusIndex] = 'Zrušená';
  assert.deepEqual(env.get({ action: 'busy' }).busy, []);
  assert.equal(env.post({ action: 'find', query: 'jan@example.com' }).bookings[0].status, 'cancelled');
});

test('server: kódy rezervácií sú jedinečné a v správnom tvare', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const codes = new Set();
  for (let i = 0; i < 300; i++) {
    const code = env.context.makeCode();
    assert.match(code, /^BS-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size >= 299);
  assert.equal(env.context.normalizeCode(' bs-7k2m9x '), 'BS-7K2M9X');
  assert.equal(env.context.normalizeCode('7K2M9X'), 'BS-7K2M9X');
  assert.equal(env.context.normalizeCode(''), '');
});

test('server: používa rovnaké dáta a pravidlá ako stránka', () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  assert.deepEqual(JSON.parse(JSON.stringify(env.context.BarberData.SERVICES)), JSON.parse(JSON.stringify(Data.SERVICES)));
  assert.deepEqual(JSON.parse(JSON.stringify(env.context.BarberData.RULES)), JSON.parse(JSON.stringify(Data.RULES)));
  assert.deepEqual(Object.keys(env.context.BookingLogic).sort(), Object.keys(Logic).sort());
});

/* ---------------- api.js: ukážkový režim ---------------- */

test('api (ukážkový režim): rovnaké rozhranie, výsledky cez Promise', async () => {
  const now = () => new Date(2026, 9, 11, 19, 55);
  const api = Api.createApi({ now, backend: Storage.createMemoryBackend() });
  assert.equal(api.mode, 'local');
  assert.equal(api.requiresCode, false);
  assert.equal(api.isReady(), true);
  const seedCount = api.snapshot().length;
  assert.ok(seedCount > 0);

  const created = await api.create(booking({ barberId: 'tomas', time: '13:00' }));
  assert.equal(created.ok, true);
  assert.equal(api.snapshot().length, seedCount + 1);

  const found = await api.find('jan@example.com');
  assert.equal(found.ok, true);
  assert.equal(found.bookings.length, 1);
  assert.equal(found.bookings[0].ref, created.booking.id);

  const moved = await api.reschedule(found.bookings[0].ref, 'jan@example.com', { date: MON, time: '16:00' });
  assert.equal(moved.ok, true);
  const cancelled = await api.cancel(found.bookings[0].ref, 'jan@example.com');
  assert.equal(cancelled.ok, true);
  await api.reset();
  assert.equal(api.snapshot().length, seedCount);
});

/* ---------------- api.js: ostrý režim proti serveru ---------------- */

/** fetch, ktorý volá napodobený server priamo (bez siete). */
function fetchInto(env, log) {
  return async (url, init) => {
    const u = new URL(url);
    if (log) log.push({ url, init });
    const data = init.method === 'GET' ? env.get(Object.fromEntries(u.searchParams)) : env.post(init.body);
    return { ok: true, status: 200, json: async () => data };
  };
}

test('api (ostrý režim): načíta obsadenosť, vytvorí, nájde, presunie a zruší rezerváciu', async () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  create(env, Object.assign({ time: '09:00' }, PETER));
  const log = [];
  const now = () => new Date(2026, 9, 11, 19, 55);
  const api = Api.createApi({ apiUrl: 'https://script.example/macros/s/TEST/exec', fetch: fetchInto(env, log), now });
  assert.equal(api.mode, 'remote');
  assert.equal(api.requiresCode, true);
  assert.equal(api.isReady(), false);
  assert.deepEqual(api.snapshot(), []);

  assert.deepEqual(await api.refresh(), { ok: true });
  assert.equal(api.isReady(), true);
  assert.equal(log[0].init.method, 'GET');
  assert.match(log[0].url, /\/exec\?action=busy&from=2026-10-11&to=2026-12-10$/);

  const slots = () => Logic.getDaySlots({ date: MON, service: Logic.getService('panski-strih'), barber: Logic.getBarber('michael'), bookings: api.snapshot(), now: now() }).slots;
  const state = (time) => slots().find((s) => s.time === time).state;
  assert.equal(state('09:00'), 'booked');
  assert.equal(state('10:00'), 'available');

  const created = await api.create(booking({ time: '10:00' }));
  assert.equal(created.ok, true);
  assert.equal(state('10:00'), 'booked'); // prejaví sa hneď
  const post = log.find((l) => l.init.method === 'POST');
  assert.equal(post.init.headers['Content-Type'], 'text/plain;charset=utf-8'); // bez predbežnej kontroly CORS
  assert.equal(JSON.parse(post.init.body).action, 'create');

  const taken = await api.create(booking(Object.assign({ time: '10:00' }, { name: 'Tretí Zákazník', email: 'treti@example.com', phone: '0900 000 222' })));
  assert.equal(taken.code, 'SLOT_TAKEN');

  const found = await api.find('jan@example.com');
  assert.equal(found.bookings.length, 1);
  assert.equal(found.bookings[0].id, undefined);
  const ref = found.bookings[0].ref;

  assert.equal((await api.reschedule(ref, 'jan@example.com', { date: MON, time: '15:00' }, 'BS-AAAAAA')).code, 'CODE_MISMATCH');
  const moved = await api.reschedule(ref, 'jan@example.com', { date: MON, time: '15:00' }, created.booking.id);
  assert.equal(moved.ok, true);
  await api.refresh();
  assert.equal(state('10:00'), 'available');
  assert.equal(state('15:00'), 'booked');

  assert.equal((await api.cancel(ref, 'jan@example.com', '')).code, 'CODE_MISMATCH');
  assert.equal((await api.cancel(ref, 'jan@example.com', created.booking.id)).ok, true);
  await api.refresh();
  assert.equal(state('15:00'), 'available');
});

test('api (ostrý režim): výpadok siete, chyba servera a nezmyselná odpoveď vrátia zrozumiteľnú chybu', async () => {
  const cases = [
    async () => {
      throw new TypeError('Failed to fetch');
    },
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, json: async () => 'nie je objekt' }),
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  ];
  for (const fetch of cases) {
    const api = Api.createRemoteApi({ apiUrl: 'https://script.example/exec', fetch });
    const refreshed = await api.refresh();
    assert.equal(refreshed.ok, false);
    assert.equal(refreshed.code, 'NETWORK');
    assert.equal(api.isReady(), false);
    const created = await api.create(booking({}));
    assert.equal(created.ok, false);
    assert.equal(created.code, 'NETWORK');
    assert.ok(created.message.includes(Data.SHOP.phone));
    assert.equal((await api.find('jan@example.com')).code, 'NETWORK');
  }
});

test('api (ostrý režim): súbežné načítania sa spoja do jednej požiadavky', async () => {
  const env = createGasEnvironment({ now: NOW_UTC });
  const log = [];
  const api = Api.createRemoteApi({ apiUrl: 'https://script.example/exec', fetch: fetchInto(env, log), now: () => new Date(2026, 9, 11, 19, 55) });
  await Promise.all([api.refresh(), api.refresh(), api.refresh()]);
  assert.equal(log.length, 1);
  await api.refresh();
  assert.equal(log.length, 2);
});
