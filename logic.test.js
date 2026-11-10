/**
 * Unit testy rezervačnej logiky a ukážkového úložiska. Spustenie: npm test
 * Používa iba vstavaný test runner Node.js (node:test), bez externých balíčkov.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Data = require('../js/data.js');
const Logic = require('../js/booking-logic.js');
const Storage = require('../js/storage.js');

// Nedeľa 11. 10. 2026, 19:55 lokálneho času. Najbližší otvorený deň je pondelok 12. 10.
const NOW = new Date(2026, 9, 11, 19, 55);
const MON = '2026-10-12';
const SAT = '2026-10-17';
const SUN = '2026-10-18';

const CUSTOMER = { name: 'Ján Testovací', email: 'jan@example.com', phone: '0944 123 987' };

function input(overrides) {
  return Object.assign(
    { serviceId: 'panski-strih', barberId: 'michael', date: MON, time: '09:00', note: '' },
    CUSTOMER,
    overrides
  );
}

function serviceWith(backend) {
  return Storage.createBookingService({ backend, now: () => NOW });
}

/* ---------------- Dáta ---------------- */

test('dáta: aspoň 8 služieb a 3 barberi so správnymi poľami', () => {
  assert.ok(Data.SERVICES.length >= 8);
  assert.ok(Data.BARBERS.length >= 3);
  Data.SERVICES.forEach((s) => {
    assert.ok(s.name && s.description, s.id);
    assert.ok(s.duration > 0 && s.price > 0, s.id);
  });
  Data.BARBERS.forEach((b) => {
    assert.ok(b.name && b.bio && b.role, b.id);
    b.services.forEach((id) => assert.ok(Logic.getService(id), `${b.id} ponúka neexistujúcu službu ${id}`));
  });
});

test('otváracie hodiny: Po–Pi 9–19, So 9–14, Ne zatvorené', () => {
  assert.deepEqual(Logic.getOpeningHours(MON), { open: '09:00', close: '19:00' });
  assert.deepEqual(Logic.getOpeningHours('2026-10-16'), { open: '09:00', close: '19:00' }); // piatok
  assert.deepEqual(Logic.getOpeningHours(SAT), { open: '09:00', close: '14:00' });
  assert.equal(Logic.getOpeningHours(SUN), null);
});

/* ---------------- Dátum a čas ---------------- */

test('parseISODate odmieta neplatné dátumy', () => {
  assert.equal(Logic.parseISODate('2026-02-31'), null);
  assert.equal(Logic.parseISODate('12.10.2026'), null);
  assert.equal(Logic.parseISODate(''), null);
  assert.ok(Logic.parseISODate('2026-10-12'));
});

test('timeToMinutes a minutesToTime', () => {
  assert.equal(Logic.timeToMinutes('09:30'), 570);
  assert.equal(Logic.timeToMinutes('25:00'), null);
  assert.equal(Logic.minutesToTime(570), '09:30');
});

/* ---------------- Dostupnosť ---------------- */

test('sloty: pondelok, 30-minútová služba, bez rezervácií = všetko voľné od 9:00 do 18:30', () => {
  const { status, slots } = Logic.getDaySlots({
    date: MON,
    service: Logic.getService('panski-strih'),
    barber: Logic.getBarber('michael'),
    bookings: [],
    now: NOW,
  });
  assert.equal(status, 'ok');
  assert.equal(slots[0].time, '09:00');
  assert.equal(slots[slots.length - 1].time, '18:30');
  assert.ok(slots.every((s) => s.state === 'available'));
});

test('sloty: trvanie služby sa musí zmestiť do otváracích hodín', () => {
  const { slots } = Logic.getDaySlots({
    date: SAT,
    service: Logic.getService('kralovsky'), // 90 min, sobota do 14:00
    barber: Logic.getBarber('michael'),
    bookings: [],
    now: NOW,
  });
  const byTime = Object.fromEntries(slots.map((s) => [s.time, s]));
  assert.equal(byTime['12:30'].state, 'available'); // 12:30–14:00
  assert.equal(byTime['13:00'].state, 'unavailable');
  assert.equal(byTime['13:00'].reason, 'after-closing');
  assert.equal(byTime['13:30'].reason, 'after-closing');
});

test('sloty: existujúca rezervácia blokuje celé svoje trvanie, aj 45-minútová', () => {
  const bookings = [
    { id: 'X1', barberId: 'michael', date: MON, time: '10:00', duration: 45, status: 'confirmed', customer: {} },
  ];
  const get = (serviceId) =>
    Object.fromEntries(
      Logic.getDaySlots({ date: MON, service: Logic.getService(serviceId), barber: Logic.getBarber('michael'), bookings, now: NOW }).slots.map((s) => [s.time, s.state])
    );

  const short = get('panski-strih'); // 30 min
  assert.equal(short['09:30'], 'available'); // 9:30–10:00, nadväzuje bez prekrytia
  assert.equal(short['10:00'], 'booked');
  assert.equal(short['10:30'], 'booked'); // rezervácia trvá do 10:45
  assert.equal(short['11:00'], 'available');

  const long = get('strih-brada'); // 60 min
  assert.equal(long['09:00'], 'available'); // 9:00–10:00
  assert.equal(long['09:30'], 'booked'); // 9:30–10:30 zasahuje do rezervácie
  assert.equal(long['10:30'], 'booked');
  assert.equal(long['11:00'], 'available');
});

test('sloty: rezervácia iného barbera a zrušená rezervácia termín neblokujú', () => {
  const bookings = [
    { id: 'A', barberId: 'tomas', date: MON, time: '10:00', duration: 30, status: 'confirmed', customer: {} },
    { id: 'B', barberId: 'michael', date: MON, time: '11:00', duration: 30, status: 'cancelled', customer: {} },
  ];
  const { slots } = Logic.getDaySlots({ date: MON, service: Logic.getService('panski-strih'), barber: Logic.getBarber('michael'), bookings, now: NOW });
  const byTime = Object.fromEntries(slots.map((s) => [s.time, s.state]));
  assert.equal(byTime['10:00'], 'available');
  assert.equal(byTime['11:00'], 'available');
});

test('sloty: minulosť je nedostupná, zajtrajšok nie', () => {
  const now = new Date(2026, 9, 12, 12, 10); // pondelok 12:10
  const { slots } = Logic.getDaySlots({ date: MON, service: Logic.getService('panski-strih'), barber: Logic.getBarber('michael'), bookings: [], now });
  const byTime = Object.fromEntries(slots.map((s) => [s.time, s]));
  assert.equal(byTime['12:00'].reason, 'past');
  assert.equal(byTime['12:30'].state, 'available');
});

test('stav dátumu: nedeľa, minulosť, príliš ďaleko, barber nepracuje', () => {
  const michael = Logic.getBarber('michael');
  assert.equal(Logic.getDateStatus(SUN, NOW, michael), 'closed');
  assert.equal(Logic.getDateStatus('2026-10-10', NOW, michael), 'past');
  assert.equal(Logic.getDateStatus('2027-03-01', NOW, michael), 'too-far');
  assert.equal(Logic.getDateStatus(SAT, NOW, Logic.getBarber('tomas')), 'barber-off'); // Tomáš v sobotu nepracuje
  assert.equal(Logic.getDateStatus(MON, NOW, michael), 'ok');
  assert.equal(Logic.getDateStatus('blbost', NOW, michael), 'invalid');
});

test('rezervovať je možné najviac 60 dní dopredu (hranica)', () => {
  const last = Logic.addDays(Logic.toISODate(NOW), 60); // 2026-12-10 je štvrtok
  assert.equal(Logic.getDateStatus(last, NOW, null), 'ok');
  assert.equal(Logic.getDateStatus(Logic.addDays(last, 1), NOW, null), 'too-far');
});

/* ---------------- Validácia ---------------- */

test('validácia: prázdny formulár vráti chyby pre všetky povinné polia', () => {
  const { valid, errors } = Logic.validateBookingInput({}, NOW);
  assert.equal(valid, false);
  ['service', 'barber', 'date', 'time', 'name', 'email', 'phone'].forEach((f) => assert.ok(errors[f], 'chýba chyba pre ' + f));
  assert.equal(errors.note, undefined);
});

test('validácia: e-mail', () => {
  const bad = ['abc', 'a@b', 'a@b.', '@b.sk', 'a b@c.sk'];
  bad.forEach((email) => assert.ok(Logic.validateBookingInput(input({ email }), NOW).errors.email, email));
  assert.equal(Logic.validateBookingInput(input({ email: ' Jan@Example.com ' }), NOW).errors.email, undefined);
});

test('telefón: čitateľný zápis slovenského čísla, zahraničné číslo ostáva bez zmeny', () => {
  ['0911 222 333', '+421911222333', '00421 911 222 333', '911222333'].forEach((phone) => {
    assert.equal(Logic.formatPhone(phone), '+421 911 222 333', phone);
  });
  assert.equal(Logic.formatPhone('+420 777 123 456'), '+420777123456');
  assert.equal(Logic.formatPhone(''), '');
});

test('validácia: telefón akceptuje bežné slovenské formáty a odmieta nezmysly', () => {
  ['0911 222 333', '+421 911 222 333', '00421911222333', '911222333', '0911/222-333'].forEach((phone) => {
    const r = Logic.validateBookingInput(input({ phone }), NOW);
    assert.equal(r.errors.phone, undefined, phone);
    assert.equal(r.values.phone, '+421911222333', phone);
  });
  assert.equal(Logic.validateBookingInput(input({ phone: '+420 777 123 456' }), NOW).errors.phone, undefined);
  ['123', 'abcdefghij', '+42', '0911 222', '0911 222 3334'].forEach((phone) => {
    assert.ok(Logic.validateBookingInput(input({ phone }), NOW).errors.phone, phone);
  });
});

test('validácia: meno', () => {
  assert.ok(Logic.validateBookingInput(input({ name: '' }), NOW).errors.name);
  assert.ok(Logic.validateBookingInput(input({ name: 'A' }), NOW).errors.name);
  assert.ok(Logic.validateBookingInput(input({ name: '<script>alert(1)</script>' }), NOW).errors.name);
  assert.ok(Logic.validateBookingInput(input({ name: '12345' }), NOW).errors.name);
  ['Ľubomír Štefánik-Ďurčo', "Anna O'Neil", 'Zoë Žilinská'].forEach((name) =>
    assert.equal(Logic.validateBookingInput(input({ name }), NOW).errors.name, undefined, name)
  );
});

test('validácia: poznámka je voliteľná, najviac 300 znakov', () => {
  assert.equal(Logic.validateBookingInput(input({ note: '' }), NOW).errors.note, undefined);
  assert.equal(Logic.validateBookingInput(input({ note: 'x'.repeat(300) }), NOW).errors.note, undefined);
  assert.ok(Logic.validateBookingInput(input({ note: 'x'.repeat(301) }), NOW).errors.note);
});

test('validácia: barber musí ponúkať vybranú službu', () => {
  // Tomáš neponúka klasické holenie britvou
  const r = Logic.validateBookingInput(input({ barberId: 'tomas', serviceId: 'holenie-britvou' }), NOW);
  assert.ok(r.errors.barber);
});

test('validácia: dátum v minulosti, nedeľa a barber mimo služby', () => {
  assert.ok(Logic.validateBookingInput(input({ date: '2026-10-09' }), NOW).errors.date);
  assert.match(Logic.validateBookingInput(input({ date: SUN }), NOW).errors.date, /zatvoren/);
  assert.match(Logic.validateBookingInput(input({ date: SAT, barberId: 'tomas' }), NOW).errors.date, /nepracuje/);
});

/* ---------------- Vytvorenie rezervácie ---------------- */

test('vytvorenie: úspešná rezervácia obsahuje všetky údaje', () => {
  const r = Logic.createBooking(input({ serviceId: 'strih-brada', time: '10:00', note: ' bez strojčeka ' }), [], NOW);
  assert.equal(r.ok, true);
  const b = r.booking;
  assert.match(b.id, /^BS-[A-Z0-9]{6}$/);
  assert.equal(b.serviceName, 'Strih a brada');
  assert.equal(b.barberName, 'Michael Nguyen');
  assert.equal(b.date, MON);
  assert.equal(b.time, '10:00');
  assert.equal(b.endTime, '11:00');
  assert.equal(b.duration, 60);
  assert.equal(b.price, 32);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.note, 'bez strojčeka');
  assert.deepEqual(b.customer, { name: 'Ján Testovací', email: 'jan@example.com', phone: '+421944123987' });
});

test('vytvorenie: obsadený termín sa nedá rezervovať (aj čiastočné prekrytie)', () => {
  const first = Logic.createBooking(input({ serviceId: 'strih-brada', time: '10:00' }), [], NOW);
  const bookings = [first.booking]; // Michael 10:00–11:00

  const other = { name: 'Peter Iný', email: 'peter@example.com', phone: '0900 000 111' };
  const same = Logic.createBooking(input(Object.assign({ time: '10:00' }, other)), bookings, NOW);
  assert.equal(same.ok, false);
  assert.equal(same.code, 'SLOT_TAKEN');

  const overlap = Logic.createBooking(input(Object.assign({ time: '10:30' }, other)), bookings, NOW);
  assert.equal(overlap.code, 'SLOT_TAKEN');

  const before = Logic.createBooking(input(Object.assign({ serviceId: 'strih-brada', time: '09:30' }, other)), bookings, NOW);
  assert.equal(before.code, 'SLOT_TAKEN'); // 9:30–10:30 zasahuje do 10:00

  const after = Logic.createBooking(input(Object.assign({ time: '11:00' }, other)), bookings, NOW);
  assert.equal(after.ok, true); // hneď po skončení je voľno

  const otherBarber = Logic.createBooking(input(Object.assign({ time: '10:00', barberId: 'tomas' }, other)), bookings, NOW);
  assert.equal(otherBarber.ok, true);
});

test('vytvorenie: minulosť a čas mimo otváracích hodín', () => {
  const now = new Date(2026, 9, 12, 12, 10);
  assert.equal(Logic.createBooking(input({ time: '12:00' }), [], now).code, 'PAST');
  assert.equal(Logic.createBooking(input({ date: SAT, time: '13:30', serviceId: 'strih-brada' }), [], NOW).code, 'OUTSIDE_HOURS');
  assert.equal(Logic.createBooking(input({ time: '09:10' }), [], NOW).code, 'INVALID_TIME'); // mimo mriežky
  assert.equal(Logic.createBooking(input({ time: '19:00' }), [], NOW).code, 'INVALID_TIME'); // po zatvorení
});

test('vytvorenie: zákazník nemôže mať dve prekrývajúce sa rezervácie', () => {
  const first = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  const second = Logic.createBooking(input({ barberId: 'tomas', time: '10:00' }), [first], NOW);
  assert.equal(second.code, 'CUSTOMER_OVERLAP');
  const third = Logic.createBooking(input({ barberId: 'tomas', time: '11:00' }), [first], NOW);
  assert.equal(third.ok, true);
});

test('vytvorenie: neplatný vstup sa neuloží a nemení pole rezervácií', () => {
  const bookings = [];
  const r = Logic.createBooking(input({ email: 'zle' }), bookings, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VALIDATION');
  assert.equal(bookings.length, 0);
});

/* ---------------- Vyhľadanie a zrušenie ---------------- */

test('vyhľadanie podľa e-mailu aj telefónu (rôzne formáty zápisu)', () => {
  const a = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  const b = Logic.createBooking(input({ time: '15:00' }), [a], NOW).booking;
  const c = Logic.createBooking(input({ time: '09:00', name: 'Iný Človek', email: 'iny@example.com', phone: '0900 555 666' }), [a, b], NOW).booking;
  const all = [a, b, c];

  assert.deepEqual(Logic.findBookings('JAN@example.com', all).map((x) => x.time), ['10:00', '15:00']);
  assert.equal(Logic.findBookings('0944 123 987', all).length, 2);
  assert.equal(Logic.findBookings('+421944123987', all).length, 2);
  assert.equal(Logic.findBookings('00421 944 123 987', all).length, 2);
  assert.equal(Logic.findBookings('iny@example.com', all).length, 1);
  assert.equal(Logic.findBookings('nikto@example.com', all).length, 0);
  assert.equal(Logic.findBookings('', all).length, 0);
  assert.equal(Logic.findBookings('nezmysel', all).length, 0);
});

test('zrušenie: zmení stav a termín sa uvoľní', () => {
  const booking = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  const slotState = (list) =>
    Logic.getDaySlots({ date: MON, service: Logic.getService('panski-strih'), barber: Logic.getBarber('michael'), bookings: list, now: NOW }).slots.find((s) => s.time === '10:00').state;

  assert.equal(slotState([booking]), 'booked');
  const result = Logic.cancelBooking(booking.id, 'jan@example.com', [booking], NOW);
  assert.equal(result.ok, true);
  assert.equal(result.booking.status, 'cancelled');
  assert.equal(slotState([result.booking]), 'available');
});

test('zrušenie: cudziu rezerváciu, neexistujúcu, zrušenú a minulú nemožno zrušiť', () => {
  const booking = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  assert.equal(Logic.cancelBooking(booking.id, 'cudzi@example.com', [booking], NOW).code, 'FORBIDDEN');
  assert.equal(Logic.cancelBooking('BS-NEEXIS', 'jan@example.com', [booking], NOW).code, 'NOT_FOUND');
  const cancelled = Object.assign({}, booking, { status: 'cancelled' });
  assert.equal(Logic.cancelBooking(booking.id, 'jan@example.com', [cancelled], NOW).code, 'ALREADY_CANCELLED');
  const later = new Date(2026, 9, 12, 10, 30);
  assert.equal(Logic.cancelBooking(booking.id, 'jan@example.com', [booking], later).code, 'PAST');
});

test('zobrazený stav: potvrdená, uskutočnená, zrušená', () => {
  const b = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  assert.equal(Logic.getDisplayStatus(b, NOW), 'confirmed');
  assert.equal(Logic.getDisplayStatus(b, new Date(2026, 9, 12, 10, 31)), 'completed');
  assert.equal(Logic.getDisplayStatus(Object.assign({}, b, { status: 'cancelled' }), NOW), 'cancelled');
});

/* ---------------- Najbližší voľný termín ---------------- */

test('najbližší voľný termín preskočí obsadené sloty a nedeľu', () => {
  const next = Logic.findNextAvailable({ service: Logic.getService('panski-strih'), bookings: [], now: NOW });
  assert.equal(next.date, MON);
  assert.equal(next.time, '09:00');

  // obsadíme pondelok 9:00 u všetkých barberov, ktorí pracujú (Michael, Tomáš; Lukáš v pondelok nepracuje)
  const block = ['michael', 'tomas'].map((barberId, i) => ({ id: 'B' + i, barberId, date: MON, time: '09:00', duration: 30, status: 'confirmed', customer: {} }));
  const next2 = Logic.findNextAvailable({ service: Logic.getService('panski-strih'), bookings: block, now: NOW });
  assert.equal(next2.date, MON);
  assert.equal(next2.time, '09:30');
});

/* ---------------- Ukážkové dáta a úložisko ---------------- */

test('ukážkové dáta: platné, bez prekrytí, všetky v budúcnosti', () => {
  const seeds = Storage.buildSeedBookings(NOW);
  assert.ok(seeds.length >= 15, 'málo ukážkových rezervácií: ' + seeds.length);

  const active = seeds.filter((b) => b.status === 'confirmed' && Logic.getDisplayStatus(b, NOW) === 'confirmed');
  active.forEach((b) => {
    assert.ok(Logic.parseISODate(b.date) && b.date >= Logic.toISODate(NOW), 'minulý termín ' + b.id);
    const hours = Logic.getOpeningHours(b.date);
    assert.ok(hours, 'zatvorený deň ' + b.id);
    assert.ok(Logic.timeToMinutes(b.time) >= Logic.timeToMinutes(hours.open));
    assert.ok(Logic.timeToMinutes(b.endTime) <= Logic.timeToMinutes(hours.close), 'po zatvorení ' + b.id);
    assert.ok(Logic.barberWorksOn(Logic.getBarber(b.barberId), b.date), 'barber nepracuje ' + b.id);
  });

  // žiadne dve aktívne rezervácie jedného barbera sa neprekrývajú
  active.forEach((a, i) =>
    active.slice(i + 1).forEach((b) => {
      if (a.barberId !== b.barberId || a.date !== b.date) return;
      const as = Logic.timeToMinutes(a.time), ae = Logic.timeToMinutes(a.endTime);
      const bs = Logic.timeToMinutes(b.time), be = Logic.timeToMinutes(b.endTime);
      assert.ok(!(as < be && ae > bs), `prekrytie ${a.id} a ${b.id}`);
    })
  );

  // demo zákazník má potvrdené, uskutočnenú aj zrušenú rezerváciu
  const demo = Logic.findBookings(Data.DEMO_CUSTOMER.email, seeds).map((b) => Logic.getDisplayStatus(b, NOW));
  ['confirmed', 'completed', 'cancelled'].forEach((s) => assert.ok(demo.includes(s), 'demo nemá stav ' + s));
});

test('ukážkové dáta: platné aj pri sobotnom "dnes" (krátke otváracie hodiny)', () => {
  const sat = new Date(2026, 9, 17, 8, 0); // sobota ráno
  const seeds = Storage.buildSeedBookings(sat);
  seeds
    .filter((b) => b.status === 'confirmed' && b.date >= '2026-10-17')
    .forEach((b) => assert.ok(Logic.timeToMinutes(b.endTime) <= Logic.timeToMinutes(Logic.getOpeningHours(b.date).close), b.id));
});

test('služba rezervácií: vytvorenie sa uloží a obsadí termín, zrušenie ho uvoľní', () => {
  const backend = Storage.createMemoryBackend();
  const service = serviceWith(backend);
  const seedCount = service.getAll().length;
  assert.ok(seedCount > 0);

  // 1) vytvorenie rezervácie
  const created = service.create(input({ barberId: 'tomas', serviceId: 'skin-fade', time: '13:00' }));
  assert.equal(created.ok, true);
  assert.equal(service.getAll().length, seedCount + 1);

  // 2) obsadený termín sa nedá rezervovať druhýkrát
  const dup = service.create(input({ barberId: 'tomas', serviceId: 'skin-fade', time: '13:00', name: 'Iný Zákazník', email: 'iny@example.com', phone: '0900 111 222' }));
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'SLOT_TAKEN');
  assert.equal(service.getAll().length, seedCount + 1);

  // 3) hľadanie
  assert.equal(service.find('jan@example.com').length, 1);
  assert.equal(service.find('0944123987').length, 1);

  // 4) zrušenie uvoľní termín
  const day = () => service.getDaySlots(MON, Logic.getService('skin-fade'), Logic.getBarber('tomas')).slots.find((s) => s.time === '13:00').state;
  assert.equal(day(), 'booked');
  assert.equal(service.cancel(created.booking.id, 'jan@example.com').ok, true);
  assert.equal(day(), 'available');
  assert.equal(service.create(input({ barberId: 'tomas', serviceId: 'skin-fade', time: '13:00', name: 'Iný Zákazník', email: 'iny@example.com', phone: '0900 111 222' })).ok, true);
});

test('služba rezervácií: dve inštancie nad rovnakým úložiskom nedovolia dvojitú rezerváciu (dve karty prehliadača)', () => {
  const backend = Storage.createMemoryBackend();
  const tabA = serviceWith(backend);
  const tabB = serviceWith(backend);
  const a = tabA.create(input({ time: '16:00' }));
  const b = tabB.create(input({ time: '16:00', name: 'Iný Zákazník', email: 'iny@example.com', phone: '0900 111 222' }));
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'SLOT_TAKEN');
});

test('služba rezervácií: dáta prežijú nový "reload" a poškodené dáta sa obnovia', () => {
  const backend = Storage.createMemoryBackend();
  serviceWith(backend).create(input({ time: '16:00' }));
  assert.equal(serviceWith(backend).find('jan@example.com').length, 1);

  backend.setItem(Storage.STORAGE_KEY, '{nie je json');
  const recovered = serviceWith(backend);
  assert.ok(recovered.getAll().length > 0);
  assert.equal(recovered.find('jan@example.com').length, 0);
});

test('služba rezervácií: reset vráti pôvodné ukážkové dáta', () => {
  const service = serviceWith(Storage.createMemoryBackend());
  const initial = service.getAll().length;
  service.create(input({ time: '16:00' }));
  service.reset();
  assert.equal(service.getAll().length, initial);
});

/* ---------------- Kalendár ---------------- */

test('buildICS vytvorí platný súbor kalendára', () => {
  const booking = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  const ics = Logic.buildICS(booking, NOW);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261012T100000/);
  assert.match(ics, /DTEND:20261012T103000/);
  assert.match(ics, /END:VCALENDAR$/);
});

/* ---------------- Ktorýkoľvek barber ---------------- */

const busy = (barberId, time, duration, extra) =>
  Object.assign({ id: 'B-' + barberId + time, barberId, date: MON, time, duration, status: 'confirmed', customer: {} }, extra);

test('ktorýkoľvek barber: termín je voľný, ak ho má voľný aspoň jeden barber', () => {
  const service = Logic.getService('panski-strih');
  const slotsWith = (bookings) =>
    Object.fromEntries(Logic.getDaySlots({ date: MON, service, barber: Logic.ANY_BARBER, bookings, now: NOW }).slots.map((s) => [s.time, s]));

  // v pondelok robia pánsky strih Michael a Tomáš (Lukáš nepracuje)
  const one = slotsWith([busy('michael', '09:00', 30)]);
  assert.equal(one['09:00'].state, 'available');
  assert.deepEqual(one['09:00'].barberIds, ['tomas']);
  assert.deepEqual(one['09:30'].barberIds, ['michael', 'tomas']);

  const both = slotsWith([busy('michael', '09:00', 30), busy('tomas', '09:00', 30)]);
  assert.equal(both['09:00'].state, 'booked');
  assert.equal(both['09:30'].state, 'available');
});

test('ktorýkoľvek barber: minulosť a presah cez zatvorenie ostávajú nedostupné', () => {
  const now = new Date(2026, 9, 12, 12, 10);
  const day = Logic.getDaySlots({ date: MON, service: Logic.getService('strih-brada'), barber: Logic.ANY_BARBER, bookings: [], now });
  const byTime = Object.fromEntries(day.slots.map((s) => [s.time, s]));
  assert.equal(byTime['12:00'].reason, 'past');
  assert.equal(byTime['18:30'].reason, 'after-closing');
  assert.equal(byTime['18:00'].state, 'available');
});

test('ktorýkoľvek barber: služba, ktorú robí jediný barber, sa riadi jeho dňami', () => {
  // holenie britvou robia Michael a Lukáš; skin fade Michael a Tomáš; všetci v nedeľu nepracujú
  const fade = Logic.getService('skin-fade');
  assert.deepEqual(Logic.eligibleBarbers(fade, SAT).map((b) => b.id), ['michael']);
  assert.deepEqual(Logic.eligibleBarbers(fade, MON).map((b) => b.id), ['michael', 'tomas']);
  assert.equal(Logic.getDaySlots({ date: SUN, service: fade, barber: Logic.ANY_BARBER, bookings: [], now: NOW }).status, 'closed');
});

test('ktorýkoľvek barber: termín dostane menej vyťažený barber, pri zhode prvý v zozname', () => {
  const service = Logic.getService('panski-strih');
  const pick = (bookings, time) => Logic.pickBarberForSlot({ date: MON, time, service, bookings, now: NOW }).id;

  assert.equal(pick([], '12:00'), 'michael'); // zhoda (0 a 0 minút)
  assert.equal(pick([busy('michael', '09:00', 60)], '12:00'), 'tomas'); // Michael má viac práce
  assert.equal(pick([busy('michael', '09:00', 30), busy('tomas', '10:00', 90)], '12:00'), 'michael');
  assert.equal(pick([busy('tomas', '12:00', 30)], '12:00'), 'michael'); // voľný je iba Michael
  assert.equal(Logic.pickBarberForSlot({ date: MON, time: '12:00', service, bookings: [busy('michael', '12:00', 30), busy('tomas', '12:00', 30)], now: NOW }), null);
});

test('ktorýkoľvek barber: rezervácia sa uloží s konkrétnym barberom a obsadený čas sa odmietne', () => {
  const first = Logic.createBooking(input({ barberId: 'any', time: '12:00' }), [], NOW);
  assert.equal(first.ok, true);
  assert.equal(first.booking.barberId, 'michael');
  assert.equal(first.booking.barberName, 'Michael Nguyen');
  assert.equal(first.booking.barberAuto, true);

  const other = { name: 'Peter Iný', email: 'peter@example.com', phone: '0900 000 111' };
  const second = Logic.createBooking(input(Object.assign({ barberId: 'any', time: '12:00' }, other)), [first.booking], NOW);
  assert.equal(second.ok, true);
  assert.equal(second.booking.barberId, 'tomas'); // Michael je už obsadený

  const third = Logic.createBooking(
    input({ barberId: 'any', time: '12:00', name: 'Tretí Zákazník', email: 'treti@example.com', phone: '0900 000 222' }),
    [first.booking, second.booking],
    NOW
  );
  assert.equal(third.ok, false);
  assert.equal(third.code, 'SLOT_TAKEN');

  // konkrétny barber sa do rezervácie neoznačuje ako automaticky priradený
  assert.equal(Logic.createBooking(input({ time: '15:00' }), [], NOW).booking.barberAuto, undefined);
});

/* ---------------- Presun rezervácie ---------------- */

test('presun: rezervácia dostane nový termín, pôvodný sa uvoľní', () => {
  const booking = Logic.createBooking(input({ serviceId: 'strih-brada', time: '10:00' }), [], NOW).booking; // 10:00–11:00
  const moved = Logic.rescheduleBooking(booking.id, 'jan@example.com', { date: '2026-10-13', time: '14:00' }, [booking], NOW);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.previous, { date: MON, time: '10:00' });
  assert.equal(moved.booking.id, booking.id);
  assert.equal(moved.booking.date, '2026-10-13');
  assert.equal(moved.booking.time, '14:00');
  assert.equal(moved.booking.endTime, '15:00');
  assert.equal(moved.booking.status, 'confirmed');
  assert.ok(moved.booking.rescheduledAt);

  const state = (list, date, time) =>
    Logic.getDaySlots({ date, service: Logic.getService('panski-strih'), barber: Logic.getBarber('michael'), bookings: list, now: NOW }).slots.find((s) => s.time === time).state;
  assert.equal(state([moved.booking], MON, '10:00'), 'available');
  assert.equal(state([moved.booking], '2026-10-13', '14:30'), 'booked');
});

test('presun: posun o pol hodiny v rámci vlastného termínu je možný', () => {
  const booking = Logic.createBooking(input({ serviceId: 'strih-brada', time: '10:00' }), [], NOW).booking; // 10:00–11:00
  const moved = Logic.rescheduleBooking(booking.id, '0944 123 987', { date: MON, time: '10:30' }, [booking], NOW);
  assert.equal(moved.ok, true);
  assert.equal(moved.booking.endTime, '11:30');
});

test('presun: obsadený, rovnaký a neplatný termín sa odmietne', () => {
  const mine = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  const other = Logic.createBooking(input({ time: '11:00', name: 'Iný Človek', email: 'iny@example.com', phone: '0900 555 666' }), [mine], NOW).booking;
  const all = [mine, other];
  const move = (change, list, now) => Logic.rescheduleBooking(mine.id, 'jan@example.com', change, list || all, now || NOW);

  assert.equal(move({ date: MON, time: '11:00' }).code, 'SLOT_TAKEN');
  assert.equal(move({ date: MON, time: '10:00' }).code, 'SAME_TIME');
  assert.equal(move({ date: SUN, time: '10:00' }).code, 'INVALID_DATE');
  assert.match(move({ date: SUN, time: '10:00' }).message, /zatvoren/);
  assert.equal(move({ date: MON, time: '10:10' }).code, 'INVALID_TIME');
  assert.equal(move({ date: MON, time: '19:00' }).code, 'INVALID_TIME');
  assert.equal(move({ date: '2026-10-09', time: '10:00' }).code, 'INVALID_DATE');
  assert.equal(move({ date: '', time: '' }).code, 'INVALID_DATE');
});

test('presun: cudziu, neexistujúcu, zrušenú a už začatú rezerváciu nemožno presunúť', () => {
  const booking = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  const change = { date: MON, time: '12:00' };
  assert.equal(Logic.rescheduleBooking(booking.id, 'cudzi@example.com', change, [booking], NOW).code, 'FORBIDDEN');
  assert.equal(Logic.rescheduleBooking('BS-NEEXIS', 'jan@example.com', change, [booking], NOW).code, 'NOT_FOUND');
  const cancelled = Object.assign({}, booking, { status: 'cancelled' });
  assert.equal(Logic.rescheduleBooking(booking.id, 'jan@example.com', change, [cancelled], NOW).code, 'ALREADY_CANCELLED');
  const later = new Date(2026, 9, 12, 10, 5);
  assert.equal(Logic.rescheduleBooking(booking.id, 'jan@example.com', change, [booking], later).code, 'PAST');
});

test('presun: zákazník si nemôže presunúť termín cez svoju inú rezerváciu', () => {
  const a = Logic.createBooking(input({ time: '10:00' }), [], NOW).booking;
  const b = Logic.createBooking(input({ barberId: 'tomas', time: '12:00' }), [a], NOW).booking;
  const clash = Logic.rescheduleBooking(a.id, 'jan@example.com', { date: MON, time: '12:00' }, [a, b], NOW);
  assert.equal(clash.code, 'CUSTOMER_OVERLAP');
});

test('presun: barber musí v nový deň pracovať', () => {
  const booking = Logic.createBooking(input({ barberId: 'tomas', time: '10:00' }), [], NOW).booking;
  const sat = Logic.rescheduleBooking(booking.id, 'jan@example.com', { date: SAT, time: '10:00' }, [booking], NOW);
  assert.equal(sat.code, 'INVALID_DATE');
  assert.match(sat.message, /Tomáš Kováč v tento deň nepracuje/);
});

/* ---------------- Sviatky a voľno ---------------- */

test('sviatky: v zatvorený deň nie sú otváracie hodiny ani termíny', () => {
  const december = new Date(2026, 11, 1, 10, 0);
  assert.deepEqual(Logic.getClosure('2026-12-24'), { name: 'Štedrý deň' });
  assert.equal(Logic.getClosure('2026-12-23'), null);
  assert.equal(Logic.getOpeningHours('2026-12-24'), null); // štvrtok, inak otvorené
  assert.equal(Logic.getDateStatus('2026-12-24', december, null), 'holiday');
  assert.equal(Logic.getDateStatus('2027-01-01', december, null), 'holiday');
  assert.equal(Logic.getDateStatus('2026-12-23', december, null), 'ok');
  assert.match(Logic.validateBookingInput(input({ date: '2026-12-24' }), december).errors.date, /Štedrý deň/);
  assert.equal(Logic.createBooking(input({ date: '2026-12-24' }), [], december).code, 'VALIDATION');
  assert.ok(!Logic.listOpenDates(new Date(2026, 11, 23, 20, 0), 3, null).includes('2026-12-24'));
  assert.deepEqual(Logic.listOpenDates(new Date(2026, 11, 23, 20, 0), 2, null), ['2026-12-28', '2026-12-29']);
});

test('voľno barbera: v daných dňoch nepracuje a možnosť „ktorýkoľvek“ ho vynechá', () => {
  const onLeave = Object.assign({}, Logic.getBarber('tomas'), { timeOff: [{ from: '2026-10-12', to: '2026-10-13' }] });
  assert.equal(Logic.barberWorksOn(onLeave, '2026-10-12'), false);
  assert.equal(Logic.barberWorksOn(onLeave, '2026-10-13'), false);
  assert.equal(Logic.barberWorksOn(onLeave, '2026-10-14'), true);
  assert.equal(Logic.getDateStatus('2026-10-12', NOW, onLeave), 'barber-off');
});

/* ---------------- Limit rezervácií a ochrana pred robotmi ---------------- */

test('limit: jeden zákazník môže mať najviac tri nadchádzajúce rezervácie', () => {
  assert.equal(Data.RULES.maxActivePerCustomer, 3);
  const list = [];
  ['09:00', '11:00', '13:00'].forEach((time) => {
    const r = Logic.createBooking(input({ time }), list, NOW);
    assert.equal(r.ok, true, time);
    list.push(r.booking);
  });
  const fourth = Logic.createBooking(input({ time: '15:00' }), list, NOW);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.code, 'CUSTOMER_LIMIT');
  assert.match(fourth.message, /\(3\)/);

  // rovnaký telefón s iným e-mailom je stále ten istý zákazník
  assert.equal(Logic.createBooking(input({ time: '15:00', email: 'iny@example.com' }), list, NOW).code, 'CUSTOMER_LIMIT');

  // zrušená a už uskutočnená rezervácia sa do limitu nepočíta
  const withCancelled = [list[0], list[1], Object.assign({}, list[2], { status: 'cancelled' })];
  assert.equal(Logic.createBooking(input({ time: '15:00' }), withCancelled, NOW).ok, true);
  const afterFirst = new Date(2026, 9, 12, 9, 45);
  assert.equal(Logic.createBooking(input({ time: '15:00' }), list, afterFirst).ok, true);

  // iný zákazník limit nemá
  assert.equal(Logic.createBooking(input({ time: '15:00', name: 'Iný Človek', email: 'iny@example.com', phone: '0900 555 666' }), list, NOW).ok, true);
});

test('pasca na roboty: vyplnené skryté pole rezerváciu zastaví', () => {
  const r = Logic.createBooking(input({ website: 'http://spam.example' }), [], NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SPAM');
  assert.equal(Logic.createBooking(input({ website: '  ' }), [], NOW).ok, true);
});

/* ---------------- Čas prevádzky a zápis dátumu ---------------- */

test('čas prevádzky: prepočet na časové pásmo Europe/Bratislava (letný aj zimný čas)', () => {
  const summer = Logic.nowInTimeZone('Europe/Bratislava', new Date(Date.UTC(2026, 9, 11, 17, 55, 30))); // UTC+2
  assert.deepEqual(
    [summer.getFullYear(), summer.getMonth(), summer.getDate(), summer.getHours(), summer.getMinutes(), summer.getSeconds()],
    [2026, 9, 11, 19, 55, 30]
  );
  const winter = Logic.nowInTimeZone('Europe/Bratislava', new Date(Date.UTC(2026, 11, 31, 23, 30, 0))); // UTC+1, už ďalší deň
  assert.deepEqual([winter.getFullYear(), winter.getMonth(), winter.getDate(), winter.getHours(), winter.getMinutes()], [2027, 0, 1, 0, 30]);
  // neznáme pásmo nespôsobí chybu
  assert.ok(Logic.nowInTimeZone('Neexistuje/Pasmo', new Date()) instanceof Date);
});

test('zápis dátumu po slovensky', () => {
  assert.equal(Logic.formatDate(MON, 'long'), 'pondelok 12. októbra 2026');
  assert.equal(Logic.formatDate('2027-01-06', 'long'), 'streda 6. januára 2027');
  assert.equal(Logic.formatDate(MON, 'mid'), '12. októbra');
  assert.equal(Logic.formatDate(SUN, 'weekday'), 'nedeľa');
  assert.equal(Logic.formatDate('nezmysel', 'long'), '');
});

test('najbližšie dni: nedeľa sa vynechá a dnešok sa ponúkne, len kým sa dá stihnúť', () => {
  assert.deepEqual(Logic.listOpenDates(NOW, 3, null), [MON, '2026-10-13', '2026-10-14']);
  assert.deepEqual(Logic.listOpenDates(NOW, 2, Logic.getBarber('lukas')), ['2026-10-13', '2026-10-14']);
  assert.deepEqual(Logic.listOpenDates(NOW, 2, Logic.ANY_BARBER, Logic.getService('skin-fade')), [MON, '2026-10-13']);
  assert.equal(Logic.listOpenDates(new Date(2026, 9, 12, 18, 10), 1, null)[0], MON);
  assert.equal(Logic.listOpenDates(new Date(2026, 9, 12, 18, 30), 1, null)[0], '2026-10-13');
});

/* ---------------- Údaje pre server ---------------- */

test('údaje pre server neobsahujú osobné údaje zákazníkov', () => {
  const a = Logic.createBooking(input({ time: '10:00', note: 'tajná poznámka' }), [], NOW).booking;
  const b = Object.assign({}, Logic.createBooking(input({ time: '12:00' }), [a], NOW).booking, { status: 'cancelled' });
  const publicBusy = Logic.publicBusy([a, b], MON, MON);
  assert.deepEqual(publicBusy, [{ barberId: 'michael', date: MON, time: '10:00', duration: 30 }]);
  assert.deepEqual(Logic.publicBusy([a], '2026-10-13', '2026-10-20'), []);

  const view = Logic.publicView(a, 7);
  const text = JSON.stringify(view);
  ['jan@example.com', '+421944123987', 'Ján Testovací', 'tajná poznámka', a.id].forEach((secret) => assert.ok(!text.includes(secret), secret));
  assert.equal(view.ref, 7);
  assert.equal(view.serviceName, 'Pánsky strih');

  // obsadenosť zo servera sa dá použiť priamo vo výpočte termínov
  const cache = Logic.busyToBookings(publicBusy);
  const slots = Logic.getDaySlots({ date: MON, service: Logic.getService('panski-strih'), barber: Logic.getBarber('michael'), bookings: cache, now: NOW }).slots;
  assert.equal(slots.find((s) => s.time === '10:00').state, 'booked');
  assert.equal(slots.find((s) => s.time === '10:30').state, 'available');
});

test('zhrnutie rezervácie pre e-mail', () => {
  const b = Logic.createBooking(input({ serviceId: 'strih-brada', time: '09:00' }), [], NOW).booking;
  assert.deepEqual(Logic.bookingSummaryLines(b), [
    'Služba: Strih a brada',
    'Barber: Michael Nguyen',
    'Dátum: pondelok 12. októbra 2026',
    'Čas: 9:00 – 10:00',
    'Cena na mieste: 32 €',
  ]);
});

/* ---------------- Obsah ---------------- */

test('dáta: kategórie, ikony a odporúčaná služba sú konzistentné', () => {
  const categories = Data.CATEGORIES.map((c) => c.id);
  Data.SERVICES.forEach((s) => {
    assert.ok(categories.includes(s.category), s.id + ' má neznámu kategóriu');
    assert.ok(s.icon, s.id + ' nemá ikonu');
  });
  categories.forEach((id) => assert.ok(Data.SERVICES.some((s) => s.category === id), 'prázdna kategória ' + id));
  assert.ok(Logic.getService(Data.FEATURED_SERVICE));
  assert.equal(new Set(Data.SERVICES.map((s) => s.id)).size, Data.SERVICES.length);
  assert.equal(new Set(Data.BARBERS.map((b) => b.id)).size, Data.BARBERS.length);
  // každú službu robí aspoň jeden barber v každý otvorený deň týždňa
  Data.SERVICES.forEach((s) => {
    [MON, '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', SAT].forEach((iso) =>
      assert.ok(Logic.eligibleBarbers(s, iso).length > 0, s.id + ' nemá barbera ' + iso)
    );
  });
});

test('dáta: časté otázky vychádzajú z pravidiel', () => {
  const text = Data.FAQ.map((f) => f.q + ' ' + f.a).join(' ');
  assert.ok(Data.FAQ.length >= 5);
  assert.ok(text.includes(Data.RULES.maxDaysAhead + ' dní'));
  assert.ok(text.includes('najviac ' + Data.RULES.maxActivePerCustomer + ' '));
});

/* ---------------- Služba rezervácií: presun ---------------- */

test('služba rezervácií: presun sa uloží a prejaví v obsadenosti', () => {
  const service = serviceWith(Storage.createMemoryBackend());
  const created = service.create(input({ barberId: 'tomas', serviceId: 'skin-fade', time: '13:00' })).booking; // 13:00–13:45
  const state = (time) => service.getDaySlots(MON, Logic.getService('skin-fade'), Logic.getBarber('tomas')).slots.find((s) => s.time === time).state;
  assert.equal(state('13:00'), 'booked');

  const moved = service.reschedule(created.id, 'jan@example.com', { date: MON, time: '16:00' });
  assert.equal(moved.ok, true);
  assert.equal(state('13:00'), 'available');
  assert.equal(state('16:00'), 'booked');
  assert.equal(service.find('jan@example.com')[0].time, '16:00');
  // pri presune sa vlastný pôvodný termín neberie ako prekážka
  assert.equal(service.getDaySlots(MON, Logic.getService('skin-fade'), Logic.getBarber('tomas'), created.id).slots.find((s) => s.time === '16:00').state, 'available');
  assert.equal(service.reschedule(created.id, 'cudzi@example.com', { date: MON, time: '17:00' }).code, 'FORBIDDEN');
});
