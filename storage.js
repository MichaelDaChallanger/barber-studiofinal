/**
 * storage.js – ukážkový režim bez servera: ukladanie rezervácií v prehliadači (localStorage
 * s náhradným úložiskom v pamäti), ukážkové dáta a „služba rezervácií“, ktorá spája úložisko
 * s logikou z booking-logic.js.
 *
 * Keď je v data.js vyplnená adresa servera (SHOP.apiUrl), tento súbor sa nepoužije a rezervácie
 * spravuje server (pozri api.js a priečinok server/).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./data.js'), require('./booking-logic.js'));
  } else {
    root.BookingStorage = factory(root.BarberData, root.BookingLogic);
  }
})(typeof self !== 'undefined' ? self : this, function (Data, Logic) {
  'use strict';

  const STORAGE_KEY = 'barberstudio.bookings.v2';

  /* ------------------------------------------------------------------ */
  /* Úložisko                                                            */
  /* ------------------------------------------------------------------ */

  /** Jednoduché úložisko v pamäti so rovnakým rozhraním ako localStorage. */
  function createMemoryBackend() {
    const data = new Map();
    return {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => void data.set(k, String(v)),
      removeItem: (k) => void data.delete(k),
    };
  }

  /** Použije localStorage, ak funguje (napr. v súkromnom režime môže byť zablokovaný). */
  function detectBackend() {
    try {
      const ls = typeof localStorage !== 'undefined' ? localStorage : null;
      if (!ls) return createMemoryBackend();
      const probe = '__barberstudio_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch (err) {
      return createMemoryBackend();
    }
  }

  /** Načíta zoznam rezervácií; null = nič uložené alebo poškodené dáta. */
  function loadList(backend, key) {
    try {
      const raw = backend.getItem(key);
      if (raw === null || raw === undefined) return null;
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : null;
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Ukážkové dáta                                                       */
  /* ------------------------------------------------------------------ */

  const PEOPLE = [
    { name: 'Martin Šimko', email: 'martin.simko@example.com', phone: '+421905111222' },
    { name: 'Jakub Varga', email: 'jakub.varga@example.com', phone: '+421905333444' },
    { name: 'Michal Tóth', email: 'michal.toth@example.com', phone: '+421905555666' },
    { name: 'Adam Baláž', email: 'adam.balaz@example.com', phone: '+421905777888' },
    { name: 'Filip Kollár', email: 'filip.kollar@example.com', phone: '+421905999000' },
    { name: 'Samuel Hudec', email: 'samuel.hudec@example.com', phone: '+421911222333' },
    { name: 'Roman Polák', email: 'roman.polak@example.com', phone: '+421911444555' },
    { name: 'Dávid Urban', email: 'david.urban@example.com', phone: '+421911666777' },
  ];

  /**
   * Plán ukážkových rezervácií: [barber, n-tý pracovný deň barbera od dnes, čas, služba, osoba].
   * "demo" = demo zákazník (demo@example.com). Rezervácie, ktoré by nesedeli do otváracích hodín
   * (napr. v sobotu po 14:00), sa pri generovaní bezpečne preskočia.
   */
  const SEED_PLAN = [
    ['michael', 0, '09:00', 'strih-brada', 0],
    ['michael', 0, '10:30', 'panski-strih', 1],
    ['michael', 0, '14:00', 'kralovsky', 2],
    ['michael', 1, '09:00', 'skin-fade', 3],
    ['michael', 1, '11:00', 'strih-styling', 'demo'],
    ['michael', 1, '16:30', 'uprava-brady', 4],
    ['michael', 2, '10:00', 'panski-strih', 5],
    ['michael', 2, '13:00', 'strih-brada', 6],
    ['tomas', 0, '09:30', 'skin-fade', 7],
    ['tomas', 0, '10:30', 'strih-styling', 0],
    ['tomas', 0, '15:00', 'detsky-strih', 1],
    ['tomas', 1, '09:00', 'strojcek', 2],
    ['tomas', 1, '12:00', 'skin-fade', 3],
    ['tomas', 1, '17:00', 'strih-brada', 4],
    ['tomas', 2, '09:00', 'panski-strih', 5],
    ['tomas', 2, '09:30', 'detsky-strih', 6],
    ['lukas', 0, '11:00', 'holenie-britvou', 7],
    ['lukas', 0, '12:00', 'strih-brada', 0],
    ['lukas', 0, '16:00', 'kralovsky', 1],
    ['lukas', 1, '09:00', 'uprava-brady', 2],
    ['lukas', 1, '10:00', 'farbenie', 3],
    ['lukas', 1, '15:30', 'holenie-britvou', 'demo'],
    ['lukas', 2, '13:00', 'strih-brada', 4],
  ];

  /** n-tý pracovný deň barbera (otvorené + barber pracuje), počítané od dnes. */
  function nthWorkingDay(barber, n, now) {
    let seen = -1;
    let iso = Logic.toISODate(now);
    for (let i = 0; i <= 60; i++, iso = Logic.addDays(iso, 1)) {
      if (Logic.getDateStatus(iso, now, barber) === 'ok') {
        seen++;
        if (seen === n) return iso;
      }
    }
    return null;
  }

  /** Posledný otvorený deň pred dneškom, keď barber pracoval (pre ukážku uplynulej rezervácie). */
  function previousWorkingDay(barber, now) {
    let iso = Logic.addDays(Logic.toISODate(now), -1);
    for (let i = 0; i < 14; i++, iso = Logic.addDays(iso, -1)) {
      if (Logic.getOpeningHours(iso) && Logic.barberWorksOn(barber, iso)) return iso;
    }
    return null;
  }

  /** Vytvorí ukážkové rezervácie vzhľadom na aktuálny čas (vždy v budúcnosti). */
  function buildSeedBookings(now) {
    const bookings = [];
    let counter = 0;
    const idFactory = () => 'BS-DEMO' + String(++counter).padStart(2, '0');

    SEED_PLAN.forEach(([barberId, nth, time, serviceId, person]) => {
      const barber = Logic.getBarber(barberId);
      const date = nthWorkingDay(barber, nth, now);
      if (!date) return;
      const customer = person === 'demo' ? Data.DEMO_CUSTOMER : PEOPLE[person];
      const result = Logic.createBooking(
        {
          serviceId,
          barberId,
          date,
          time,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          note: '',
        },
        bookings,
        now,
        idFactory
      );
      if (result.ok) bookings.push(result.booking);
    });

    // Ukážka histórie demo zákazníka: uskutočnená a zrušená rezervácia.
    const founder = Logic.getBarber('michael');
    const past = previousWorkingDay(founder, now);
    const service = Logic.getService('strih-styling');
    if (past) {
      bookings.push({
        id: 'BS-DEMO90',
        serviceId: service.id,
        serviceName: service.name,
        barberId: founder.id,
        barberName: founder.name,
        date: past,
        time: '10:00',
        endTime: '10:45',
        duration: service.duration,
        price: service.price,
        status: Logic.STATUS.CONFIRMED,
        customer: Object.assign({}, Data.DEMO_CUSTOMER),
        note: '',
        createdAt: now.toISOString(),
      });
    }
    const cancelledDate = nthWorkingDay(founder, 2, now);
    const beard = Logic.getService('uprava-brady');
    if (cancelledDate) {
      bookings.push({
        id: 'BS-DEMO91',
        serviceId: beard.id,
        serviceName: beard.name,
        barberId: founder.id,
        barberName: founder.name,
        date: cancelledDate,
        time: '15:00',
        endTime: '15:30',
        duration: beard.duration,
        price: beard.price,
        status: Logic.STATUS.CANCELLED,
        customer: Object.assign({}, Data.DEMO_CUSTOMER),
        note: '',
        createdAt: now.toISOString(),
        cancelledAt: now.toISOString(),
      });
    }
    return bookings;
  }

  /* ------------------------------------------------------------------ */
  /* Služba rezervácií                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Spája úložisko s logikou. Pri každej operácii sa zoznam načíta znova z úložiska,
   * takže dvojitá rezervácia je vylúčená aj pri dvoch otvorených kartách prehliadača.
   *
   * @param {object} [options]
   * @param {object} [options.backend] úložisko (predvolene localStorage alebo pamäť)
   * @param {function(): Date} [options.now] funkcia vracajúca aktuálny čas
   * @param {string} [options.key] kľúč v úložisku
   */
  function createBookingService(options) {
    const opts = options || {};
    const backend = opts.backend || detectBackend();
    const now = opts.now || (() => new Date());
    const key = opts.key || STORAGE_KEY;

    const read = () => loadList(backend, key) || [];
    const write = (list) => backend.setItem(key, JSON.stringify(list));

    // Prvé spustenie (alebo poškodené dáta): naplní ukážkové dáta.
    if (loadList(backend, key) === null) write(buildSeedBookings(now()));

    return {
      /** Všetky rezervácie (pre kontrolu dostupnosti). */
      getAll: read,

      /** Mriežka termínov pre deň, službu a barbera (alebo Logic.ANY_BARBER) podľa aktuálnych dát. */
      getDaySlots(date, service, barber, ignoreBookingId) {
        return Logic.getDaySlots({ date, service, barber, bookings: read(), now: now(), ignoreBookingId });
      },

      /** Vytvorí a uloží rezerváciu, ak je termín stále voľný. */
      create(input) {
        const list = read();
        const result = Logic.createBooking(input, list, now());
        if (result.ok) {
          list.push(result.booking);
          write(list);
        }
        return result;
      },

      /** Rezervácie podľa e-mailu alebo telefónu. */
      find: (query) => Logic.findBookings(query, read()),

      /** Zruší rezerváciu (termín sa tým uvoľní). */
      cancel(id, contactQuery) {
        const list = read();
        const result = Logic.cancelBooking(id, contactQuery, list, now());
        if (result.ok) {
          write(list.map((b) => (b.id === id ? result.booking : b)));
        }
        return result;
      },

      /** Presunie rezerváciu na iný termín (pôvodný termín sa uvoľní). */
      reschedule(id, contactQuery, change) {
        const list = read();
        const result = Logic.rescheduleBooking(id, contactQuery, change, list, now());
        if (result.ok) {
          write(list.map((b) => (b.id === id ? result.booking : b)));
        }
        return result;
      },

      /** Obnoví pôvodné ukážkové dáta. */
      reset() {
        write(buildSeedBookings(now()));
      },
    };
  }

  return Object.freeze({
    STORAGE_KEY,
    createMemoryBackend,
    detectBackend,
    buildSeedBookings,
    createBookingService,
  });
});
