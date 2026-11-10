/**
 * api.js – jednotné rozhranie k rezerváciám pre používateľské rozhranie (app.js).
 *
 * Stránka vie pracovať v dvoch režimoch s rovnakým rozhraním:
 *  - 'local'  – ukážkový režim, dáta sú v prehliadači (storage.js),
 *  - 'remote' – ostrý režim, dáta sú na serveri (Google Apps Script + Google Tabuľka, priečinok server/).
 *
 * Čítanie obsadenosti je synchrónne zo záznamu v pamäti (snapshot), zápisy vracajú Promise.
 * V ostrom režime má posledné slovo vždy server: aj keby mal prehliadač neaktuálne dáta,
 * server termín pred uložením znova overí.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./data.js'), require('./booking-logic.js'), require('./storage.js'));
  } else {
    root.BookingApi = factory(root.BarberData, root.BookingLogic, root.BookingStorage);
  }
})(typeof self !== 'undefined' ? self : this, function (Data, Logic, Storage) {
  'use strict';

  const NETWORK_MESSAGE =
    'Rezervačný systém je teraz nedostupný. Skúste to o chvíľu znova alebo nám zavolajte na ' + Data.SHOP.phone + '.';

  /* ------------------------------------------------------------------ */
  /* Ukážkový režim (prehliadač)                                         */
  /* ------------------------------------------------------------------ */

  function createLocalApi(service) {
    const done = (value) => Promise.resolve(value);
    const view = (b) => Object.assign({ ref: b.id }, b);
    return {
      mode: 'local',
      /** V ukážkovom režime sú dáta v prehliadači zákazníka, kód rezervácie sa pri zmenách nevyžaduje. */
      requiresCode: false,
      isReady: () => true,
      /** Rezervácie pre výpočet obsadenosti. */
      snapshot: () => service.getAll(),
      refresh: () => done({ ok: true }),
      create: (input) => done(service.create(input)),
      find: (query) => done({ ok: true, bookings: service.find(query).map(view) }),
      cancel: (ref, contact) => done(service.cancel(ref, contact)),
      reschedule: (ref, contact, change) => done(service.reschedule(ref, contact, change)),
      reset: () => done(service.reset()),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Ostrý režim (server)                                                */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} options
   * @param {string} options.apiUrl adresa webovej aplikácie (…/exec)
   * @param {function} [options.fetch] náhrada za fetch (pre testy)
   * @param {function(): Date} [options.now] aktuálny čas prevádzky
   * @param {number} [options.timeoutMs] časový limit požiadavky
   */
  function createRemoteApi(options) {
    const apiUrl = options.apiUrl;
    const doFetch = options.fetch || (typeof fetch === 'function' ? (url, init) => fetch(url, init) : null);
    const now = options.now || (() => new Date());
    const timeoutMs = options.timeoutMs || 20000;

    let cache = [];
    let ready = false;
    let inflight = null;

    function request(method, payload) {
      if (!doFetch) return Promise.resolve({ ok: false, code: 'NETWORK', message: NETWORK_MESSAGE });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      let url = apiUrl;
      const init = { method, redirect: 'follow' };
      if (method === 'GET') {
        const query = Object.keys(payload)
          .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(payload[k]))
          .join('&');
        url += (apiUrl.indexOf('?') === -1 ? '?' : '&') + query;
      } else {
        // text/plain = „jednoduchá“ požiadavka bez predbežnej kontroly CORS, ktorú Apps Script nepodporuje
        init.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
        init.body = JSON.stringify(payload);
      }
      if (controller) init.signal = controller.signal;

      return Promise.resolve()
        .then(() => doFetch(url, init))
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then((data) => {
          if (!data || typeof data !== 'object') throw new Error('Neplatná odpoveď servera');
          return data;
        })
        .catch(() => ({ ok: false, code: 'NETWORK', message: NETWORK_MESSAGE }))
        .then((result) => {
          if (timer) clearTimeout(timer);
          return result;
        });
    }

    /** Načíta obsadené termíny na celé obdobie, v ktorom sa dá rezervovať. */
    function refresh() {
      if (inflight) return inflight;
      const today = Logic.toISODate(now());
      inflight = request('GET', { action: 'busy', from: today, to: Logic.addDays(today, Data.RULES.maxDaysAhead) }).then(
        (result) => {
          inflight = null;
          if (result.ok && Array.isArray(result.busy)) {
            cache = Logic.busyToBookings(result.busy);
            ready = true;
            return { ok: true };
          }
          return { ok: false, code: result.code || 'NETWORK', message: result.message || NETWORK_MESSAGE };
        }
      );
      return inflight;
    }

    /**
     * Po zmene (alebo po odmietnutí pre obsadený termín) sa obsadenosť načíta znova a až potom sa
     * vráti výsledok, aby stránka hneď kreslila aktuálny stav. Neúspešné načítanie výsledok nemení.
     */
    const withFreshData = (result) => refresh().then(() => result);
    const afterChange = (result) => (result.ok || result.code === 'SLOT_TAKEN' ? withFreshData(result) : result);

    return {
      mode: 'remote',
      /** Zrušenie a presun vyžadujú kód rezervácie z potvrdzovacieho e-mailu. */
      requiresCode: true,
      isReady: () => ready,
      snapshot: () => cache,
      refresh,

      create(input) {
        return request('POST', { action: 'create', booking: input }).then((result) => {
          if (result.ok && result.booking) {
            // nový termín sa v mriežke prejaví hneď, bez čakania na ďalšie načítanie
            cache = cache.concat(Logic.busyToBookings([result.booking]).map((b) => Object.assign(b, { id: 'new-' + result.booking.id })));
            return result;
          }
          // termín medzitým obsadil niekto iný: stránka potrebuje čerstvú obsadenosť
          return result.code === 'SLOT_TAKEN' ? withFreshData(result) : result;
        });
      },

      find(query) {
        return request('POST', { action: 'find', query }).then((result) =>
          result.ok ? { ok: true, bookings: Array.isArray(result.bookings) ? result.bookings : [] } : result
        );
      },

      cancel(ref, contact, code) {
        return request('POST', { action: 'cancel', ref, contact, code: String(code || '') }).then(afterChange);
      },

      reschedule(ref, contact, change, code) {
        return request('POST', {
          action: 'reschedule',
          ref,
          contact,
          code: String(code || ''),
          date: change.date,
          time: change.time,
        }).then(afterChange);
      },

      reset: () => Promise.resolve(),
    };
  }

  /**
   * Vyberie režim: ak je zadaná adresa servera, ostrý režim, inak ukážkový.
   * @param {object} [options] { apiUrl, now, fetch, backend }
   */
  function createApi(options) {
    const opts = options || {};
    if (opts.apiUrl) return createRemoteApi(opts);
    return createLocalApi(Storage.createBookingService({ now: opts.now, backend: opts.backend }));
  }

  return Object.freeze({ NETWORK_MESSAGE, createLocalApi, createRemoteApi, createApi });
});
