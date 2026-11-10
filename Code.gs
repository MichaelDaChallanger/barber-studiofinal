/* ==========================================================================
   Barber Studio – Code.gs (VYGENEROVANÝ SÚBOR, neupravujte ho ručne)
   Zdroj: js/data.js + js/booking-logic.js + server/src/server.js
   Vytvorený príkazom: python3 tools/build_server.py
   ========================================================================== */

/* ---------- js/data.js ---------- */
var BarberData = (function () {
  var module = { exports: {} };
  (function (module) {
    /**
     * data.js – obsah a nastavenia barber shopu (prevádzka, pravidlá, hodiny, služby, barberi, otázky).
     *
     * Všetko, čo sa na stránke bežne mení (ceny, služby, barberi, otváracie hodiny, kontakt),
     * je na jednom mieste v tomto súbore. Súbor funguje v prehliadači (globálna premenná
     * BarberData), v Node.js (require) aj v Google Apps Script, takže rovnaké dáta používa
     * stránka, automatické testy aj voliteľný server.
     */
    (function (root, factory) {
      if (typeof module === 'object' && module.exports) {
        module.exports = factory();
      } else {
        root.BarberData = factory();
      }
    })(typeof self !== 'undefined' ? self : this, function () {
      'use strict';

      /** Základné informácie o prevádzke (ukážkové údaje, adresa a telefón sú fiktívne). */
      const SHOP = {
        name: 'Barber Studio',
        slogan: 'Klasické remeslo, presný strih.',
        street: 'Obchodná 12',
        zip: '811 06',
        city: 'Bratislava',
        address: 'Obchodná 12, 811 06 Bratislava',
        phone: '+421 900 123 456',
        phoneHref: '+421900123456',
        email: 'barbershopmn17@gmail.com',
        /** Časové pásmo prevádzky: podľa neho sa určuje „teraz“ aj pre návštevníka zo zahraničia. */
        timeZone: 'Europe/Bratislava',
        mapLink: 'https://www.openstreetmap.org/?mlat=48.1486&mlon=17.1077#map=17/48.1486/17.1077',

        /**
         * Voliteľné: adresa webovej aplikácie Google Apps Script (končí sa na /exec).
         * Keď je vyplnená, rezervácie sa ukladajú do Google Tabuľky prevádzky, termíny sú spoločné
         * pre všetkých zákazníkov a chodia e-maily. Prázdna hodnota = ukážkový režim (dáta v prehliadači).
         * Postup nastavenia je v súbore README.md.
         */
        apiUrl: '',

        /**
         * Voliteľné, iba pre ukážkový režim: adresa formulára (napr. https://formspree.io/f/xxxx),
         * ktorá po každej rezervácii pošle e-mail na adresu salónu.
         */
        notifyUrl: '',

        /**
         * Voliteľné fotografie. heroPhoto = fotografia do úvodnej sekcie, gallery = fotografie strihov
         * do sekcie „Naše práce“ ({ src, alt }). Bez fotografií sa zobrazí ilustrácia a sekcia sa skryje.
         */
        heroPhoto: '',
        gallery: [],
      };

      /** Pravidlá rezervácií. */
      const RULES = {
        slotStep: 30, // krok mriežky začiatkov termínov v minútach
        maxDaysAhead: 60, // koľko dní dopredu je možné rezervovať
        maxNoteLength: 300, // maximálna dĺžka poznámky
        maxActivePerCustomer: 3, // koľko nadchádzajúcich rezervácií môže mať jeden zákazník
      };

      /** Názvy dní podľa Date.getDay() (0 = nedeľa). */
      const DAY_NAMES = ['Nedeľa', 'Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota'];

      /**
       * Otváracie hodiny podľa Date.getDay(). null = zatvorené.
       * Po–Pi 9:00–19:00, So 9:00–14:00, Ne zatvorené.
       */
      const OPENING_HOURS = {
        0: null,
        1: { open: '09:00', close: '19:00' },
        2: { open: '09:00', close: '19:00' },
        3: { open: '09:00', close: '19:00' },
        4: { open: '09:00', close: '19:00' },
        5: { open: '09:00', close: '19:00' },
        6: { open: '09:00', close: '14:00' },
      };

      /**
       * Dni, keď je zatvorené každý rok (md = "MM-DD"). Zoznam si určuje prevádzka;
       * pohyblivé sviatky (napr. Veľká noc) patria do CLOSED_DATES.
       */
      const HOLIDAYS = [
        { md: '01-01', name: 'Nový rok' },
        { md: '01-06', name: 'Traja králi' },
        { md: '12-24', name: 'Štedrý deň' },
        { md: '12-25', name: 'Prvý sviatok vianočný' },
        { md: '12-26', name: 'Druhý sviatok vianočný' },
      ];

      /** Jednorazovo zatvorené dni, napr. { date: '2027-03-29', name: 'Veľkonočný pondelok' }. */
      const CLOSED_DATES = [];

      /** Skupiny služieb v cenníku. */
      const CATEGORIES = [
        { id: 'vlasy', name: 'Vlasy' },
        { id: 'brada', name: 'Brada' },
        { id: 'balicky', name: 'Balíčky' },
      ];

      /** Cenník. duration = minúty, price = EUR, category = skupina, icon = názov ikony z art.js. */
      const SERVICES = [
        {
          id: 'panski-strih',
          name: 'Pánsky strih',
          description: 'Konzultácia, strih nožnicami a strojčekom, úprava kontúr a styling.',
          duration: 30,
          price: 18,
          category: 'vlasy',
          icon: 'scissors',
        },
        {
          id: 'strih-styling',
          name: 'Strih, umytie a styling',
          description: 'Strih s umytím vlasov, masážou pokožky hlavy a stylingom produktmi.',
          duration: 45,
          price: 25,
          category: 'vlasy',
          icon: 'wash',
        },
        {
          id: 'skin-fade',
          name: 'Skin fade',
          description: 'Plynulý prechod až na kožu, presné línie a dôkladné dokončenie britvou.',
          duration: 45,
          price: 22,
          category: 'vlasy',
          icon: 'fade',
        },
        {
          id: 'strojcek',
          name: 'Strojčekový strih',
          description: 'Rýchly strih na jednu dĺžku alebo jednoduchý prechod.',
          duration: 30,
          price: 12,
          category: 'vlasy',
          icon: 'clipper',
        },
        {
          id: 'uprava-brady',
          name: 'Úprava brady',
          description: 'Tvarovanie, skrátenie a vyčistenie kontúr brady a fúzov.',
          duration: 30,
          price: 14,
          category: 'brada',
          icon: 'beard',
        },
        {
          id: 'holenie-britvou',
          name: 'Klasické holenie britvou',
          description: 'Horúci uterák, holiaca pena a holenie britvou, nakoniec upokojujúci balzam.',
          duration: 30,
          price: 20,
          category: 'brada',
          icon: 'razor',
        },
        {
          id: 'strih-brada',
          name: 'Strih a brada',
          description: 'Pánsky strih spolu s úpravou brady. Najobľúbenejšia kombinácia.',
          duration: 60,
          price: 32,
          category: 'balicky',
          icon: 'combo',
        },
        {
          id: 'detsky-strih',
          name: 'Detský strih',
          description: 'Trpezlivý strih pre chlapcov do 12 rokov.',
          duration: 30,
          price: 14,
          category: 'vlasy',
          icon: 'kid',
        },
        {
          id: 'farbenie',
          name: 'Kamufláž sivín',
          description: 'Jemné prefarbenie vlasov alebo brady, ktoré pôsobí prirodzene.',
          duration: 45,
          price: 25,
          category: 'vlasy',
          icon: 'drop',
        },
        {
          id: 'kralovsky',
          name: 'Kráľovský balíček',
          description: 'Strih, úprava brady, holenie britvou, maska na tvár a masáž šije.',
          duration: 90,
          price: 55,
          category: 'balicky',
          icon: 'crown',
        },
      ];

      /** Služba zvýraznená vedľa cenníka. */
      const FEATURED_SERVICE = 'kralovsky';

      /**
       * Barberi. workDays podľa Date.getDay() (v kombinácii s otváracími hodinami),
       * services = id služieb, ktoré barber ponúka, look = vzhľad kresleného avatara,
       * photo = voliteľná fotografia (cesta alebo data URI), timeOff = voľno ({ from, to } vrátane).
       */
      const BARBERS = [
        {
          id: 'michael',
          name: 'Michael Nguyen',
          role: 'Majster barber a zakladateľ',
          bio: 'Strihá viac ako dvanásť rokov. Pozná klasiku aj aktuálne trendy a poradí, čo vám pristane k tvaru tváre.',
          workDays: [1, 2, 3, 4, 5, 6],
          services: [
            'panski-strih',
            'strih-styling',
            'skin-fade',
            'strojcek',
            'uprava-brady',
            'holenie-britvou',
            'strih-brada',
            'detsky-strih',
            'farbenie',
            'kralovsky',
          ],
          look: { skin: '#e0b088', hair: '#1c1612', beard: '#2a1e15', hasBeard: true, style: 'slick' },
          photo: '',
          timeOff: [],
        },
        {
          id: 'tomas',
          name: 'Tomáš Kováč',
          role: 'Špecialista na fade',
          bio: 'Presné prechody, ostré línie a čistý výsledok. Tomáš je jednotka pre skin fade a moderné krátke strihy.',
          workDays: [1, 2, 3, 4, 5],
          services: ['panski-strih', 'strih-styling', 'skin-fade', 'strojcek', 'strih-brada', 'detsky-strih'],
          look: { skin: '#c98f67', hair: '#120f0c', beard: '#120f0c', hasBeard: false, style: 'fade' },
          photo: '',
          timeOff: [],
        },
        {
          id: 'lukas',
          name: 'Lukáš Novák',
          role: 'Majster brady a holenia',
          bio: 'Horúci uterák, britva a pokoj. Lukáš sa venuje úprave brady a holeniu v tradičnom štýle.',
          workDays: [2, 3, 4, 5, 6],
          services: ['panski-strih', 'uprava-brady', 'holenie-britvou', 'strih-brada', 'farbenie', 'kralovsky'],
          look: { skin: '#e8bf9a', hair: '#4a4038', beard: '#6b5f55', hasBeard: true, style: 'curly' },
          photo: '',
          timeOff: [],
        },
      ];

      /** Časté otázky. Čísla v odpovediach sa berú z pravidiel vyššie (RULES). */
      const FAQ = [
        {
          q: 'Musím sa pri rezervácii registrovať alebo platiť vopred?',
          a: 'Nie. Stačí meno, e-mail a telefón. Platíte až na mieste po skončení služby.',
        },
        {
          q: 'Ako ďaleko dopredu si môžem termín rezervovať?',
          a:
            'Najviac ' +
            RULES.maxDaysAhead +
            ' dní dopredu. Termíny začínajú každých ' +
            RULES.slotStep +
            ' minút a rezervácia zaberie presne toľko času, koľko trvá vybraná služba.',
        },
        {
          q: 'Dá sa rezervácia zrušiť alebo presunúť?',
          a: 'Áno, kedykoľvek pred jej začiatkom. V časti Moje rezervácie zadajte e-mail alebo telefón, s ktorým ste rezervovali, a vyberte Zmeniť termín alebo Zrušiť rezerváciu. Uvoľnený termín sa hneď ponúkne ďalším zákazníkom.',
        },
        {
          q: 'Čo ak mi je jedno, ktorý barber ma ostrihá?',
          a: 'Zvoľte možnosť Ktorýkoľvek barber. Uvidíte všetky voľné časy naraz a termín dostane barber, ktorý má v daný deň najmenej práce.',
        },
        {
          q: 'Koľko rezervácií môžem mať naraz?',
          a:
            'Na jeden e-mail alebo telefón môžete mať najviac ' +
            RULES.maxActivePerCustomer +
            ' nadchádzajúce rezervácie naraz. Ak potrebujete viac termínov, napríklad pre celú rodinu, zavolajte nám.',
        },
        {
          q: 'Čo sa deje s mojimi údajmi?',
          a: 'Použijeme ich iba na vybavenie rezervácie. Podrobnosti nájdete v časti Ochrana údajov v pätičke stránky.',
        },
      ];

      /** Ukážkový zákazník, s ktorým sú predvyplnené ukážkové rezervácie. */
      const DEMO_CUSTOMER = {
        name: 'Demo Zákazník',
        email: 'demo@example.com',
        phone: '+421900123456',
      };

      return Object.freeze({
        SHOP,
        RULES,
        DAY_NAMES,
        OPENING_HOURS,
        HOLIDAYS,
        CLOSED_DATES,
        CATEGORIES,
        SERVICES,
        FEATURED_SERVICE,
        BARBERS,
        FAQ,
        DEMO_CUSTOMER,
      });
    });
  })(module);
  return module.exports;
})();

/* ---------- js/booking-logic.js ---------- */
var BookingLogic = (function () {
  var module = { exports: {} };
  var require = function () { return BarberData; };
  (function (module, require) {
    /**
     * booking-logic.js – čistá logika rezervácií (bez DOM, bez úložiska, bez siete).
     *
     * Všetky funkcie dostávajú aktuálny čas (`now`) a zoznam rezervácií ako parameter,
     * vďaka čomu sa dajú ľahko testovať a rovnaký kód beží v prehliadači, v Node.js aj
     * na serveri (Google Apps Script). Dátumy sa ukladajú ako reťazce "RRRR-MM-DD" a časy
     * ako "HH:MM" v čase prevádzky.
     */
    (function (root, factory) {
      if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./data.js'));
      } else {
        root.BookingLogic = factory(root.BarberData);
      }
    })(typeof self !== 'undefined' ? self : this, function (Data) {
      'use strict';

      const { SERVICES, BARBERS, OPENING_HOURS, RULES } = Data;
      const HOLIDAYS = Data.HOLIDAYS || [];
      const CLOSED_DATES = Data.CLOSED_DATES || [];

      const STATUS = Object.freeze({ CONFIRMED: 'confirmed', CANCELLED: 'cancelled', COMPLETED: 'completed' });

      /** Hodnota poľa barberId, keď si zákazník nevyberá konkrétneho barbera. */
      const ANY_BARBER = 'any';

      /* ------------------------------------------------------------------ */
      /* Dátum a čas                                                         */
      /* ------------------------------------------------------------------ */

      const pad = (n) => String(n).padStart(2, '0');

      /** Date -> "RRRR-MM-DD" v lokálnom čase. */
      function toISODate(date) {
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      }

      /** "RRRR-MM-DD" -> Date (polnoc lokálneho času) alebo null, ak je dátum neplatný. */
      function parseISODate(str) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
        if (!m) return null;
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const date = new Date(y, mo - 1, d);
        // odfiltruje napr. 2026-02-31
        if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
        return date;
      }

      /** "HH:MM" -> minúty od polnoci alebo null. */
      function timeToMinutes(time) {
        const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time || ''));
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
      }

      /** minúty od polnoci -> "HH:MM". */
      function minutesToTime(min) {
        return pad(Math.floor(min / 60)) + ':' + pad(min % 60);
      }

      /** Pripočíta n dní k ISO dátumu. */
      function addDays(iso, n) {
        const d = parseISODate(iso);
        d.setDate(d.getDate() + n);
        return toISODate(d);
      }

      /** Dátum a čas začiatku termínu ako Date. */
      function startDateTime(iso, time) {
        const d = parseISODate(iso);
        const min = timeToMinutes(time);
        d.setHours(Math.floor(min / 60), min % 60, 0, 0);
        return d;
      }

      /** Dátum a čas konca termínu ako Date. */
      function endDateTime(iso, time, duration) {
        return new Date(startDateTime(iso, time).getTime() + duration * 60000);
      }

      /**
       * Aktuálny čas v časovom pásme prevádzky ako Date, ktorého lokálne zložky (rok až sekunda)
       * zodpovedajú hodinám na stene prevádzky. Zákazník v inom časovom pásme tak vidí rovnaké
       * voľné termíny ako prevádzka.
       */
      function nowInTimeZone(timeZone, instant) {
        const d = instant || new Date();
        try {
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
          }).formatToParts(d);
          const get = (type) => Number(parts.find((p) => p.type === type).value);
          return new Date(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
        } catch (err) {
          return new Date(d.getTime());
        }
      }

      const DAY_LONG = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
      const DAY_SHORT = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];
      const MONTH_GENITIVE = [
        'januára', 'februára', 'marca', 'apríla', 'mája', 'júna',
        'júla', 'augusta', 'septembra', 'októbra', 'novembra', 'decembra',
      ];
      const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'máj', 'jún', 'júl', 'aug', 'sep', 'okt', 'nov', 'dec'];

      /**
       * Slovenský zápis dátumu bez závislosti od nastavení prehliadača.
       * style: 'long' = "pondelok 12. októbra 2026", 'mid' = "12. októbra", 'weekday' = "pondelok".
       */
      function formatDate(iso, style) {
        const d = parseISODate(iso);
        if (!d) return '';
        if (style === 'weekday') return DAY_LONG[d.getDay()];
        const dayMonth = d.getDate() + '. ' + MONTH_GENITIVE[d.getMonth()];
        if (style === 'mid') return dayMonth;
        return DAY_LONG[d.getDay()] + ' ' + dayMonth + ' ' + d.getFullYear();
      }

      /* ------------------------------------------------------------------ */
      /* Vyhľadanie dát                                                      */
      /* ------------------------------------------------------------------ */

      const getService = (id) => SERVICES.find((s) => s.id === id) || null;
      const getBarber = (id) => BARBERS.find((b) => b.id === id) || null;

      /** Ak je v daný deň mimoriadne zatvorené (sviatok, dovolenka prevádzky), vráti { name }, inak null. */
      function getClosure(iso) {
        if (!parseISODate(iso)) return null;
        const once = CLOSED_DATES.find((c) => c.date === iso);
        if (once) return { name: once.name || 'Zatvorené' };
        const yearly = HOLIDAYS.find((h) => h.md === iso.slice(5));
        return yearly ? { name: yearly.name } : null;
      }

      /** Otváracie hodiny pre daný ISO dátum, alebo null, keď je zatvorené / dátum je neplatný. */
      function getOpeningHours(iso) {
        const d = parseISODate(iso);
        if (!d || getClosure(iso)) return null;
        return OPENING_HOURS[d.getDay()] || null;
      }

      const barberOffers = (barber, serviceId) => barber.services.includes(serviceId);

      /** Pracuje barber v daný deň? (pracovný deň v týždni a nemá voľno) */
      function barberWorksOn(barber, iso) {
        const d = parseISODate(iso);
        if (!d || !barber.workDays.includes(d.getDay())) return false;
        return !(barber.timeOff || []).some((t) => iso >= t.from && iso <= t.to);
      }

      /** Barberi, ktorí danú službu ponúkajú a v daný deň pracujú. */
      function eligibleBarbers(service, iso) {
        return BARBERS.filter((b) => barberOffers(b, service.id) && barberWorksOn(b, iso));
      }

      /**
       * Stav dátumu pre rezerváciu:
       * 'invalid' | 'past' | 'too-far' | 'holiday' | 'closed' | 'barber-off' | 'ok'
       */
      function getDateStatus(iso, now, barber) {
        const d = parseISODate(iso);
        if (!d) return 'invalid';
        const today = toISODate(now);
        if (iso < today) return 'past';
        if (iso > addDays(today, RULES.maxDaysAhead)) return 'too-far';
        if (getClosure(iso)) return 'holiday';
        if (!OPENING_HOURS[d.getDay()]) return 'closed';
        if (barber && !barberWorksOn(barber, iso)) return 'barber-off';
        return 'ok';
      }

      /** Zrozumiteľná správa k stavu dátumu (prázdny reťazec pre 'ok'). */
      function dateStatusMessage(status, iso, barber) {
        switch (status) {
          case 'ok':
            return '';
          case 'past':
            return 'Vyberte dnešný alebo budúci dátum.';
          case 'too-far':
            return 'Rezervovať je možné najviac ' + RULES.maxDaysAhead + ' dní dopredu.';
          case 'holiday':
            return 'V tento deň máme zatvorené (' + getClosure(iso).name + ').';
          case 'closed':
            return 'V tento deň máme zatvorené.';
          case 'barber-off':
            return (barber ? barber.name : 'Vybraný barber') + ' v tento deň nepracuje.';
          case 'no-barber':
            return 'V tento deň túto službu nerobí žiadny barber.';
          default:
            return 'Zadajte platný dátum.';
        }
      }

      /* ------------------------------------------------------------------ */
      /* Dostupnosť termínov                                                 */
      /* ------------------------------------------------------------------ */

      /** Prekrývajú sa intervaly [aStart, aEnd) a [bStart, bEnd)? */
      const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

      /** Aktívne (nezrušené) rezervácie barbera v daný deň. */
      function activeBookingsFor(bookings, barberId, iso) {
        return bookings.filter((b) => b.status === STATUS.CONFIRMED && b.barberId === barberId && b.date === iso);
      }

      /**
       * Vráti mriežku termínov pre daný deň, službu a barbera.
       * `barber` je objekt barbera alebo ANY_BARBER (termín je voľný, ak ho má voľný aspoň jeden barber).
       * `ignoreBookingId` vynechá jednu rezerváciu z obsadenosti (používa sa pri presune termínu).
       *
       * Výsledok: { status, slots } kde slots = [{ time, end, state, reason, barberIds? }]
       *  - state 'available'   – termín je voľný,
       *  - state 'booked'      – termín je obsadený (iná rezervácia sa prekrýva s trvaním služby),
       *  - state 'unavailable' – nedá sa vybrať (reason: 'past' | 'after-closing').
       */
      function getDaySlots({ date, service, barber, bookings, now, ignoreBookingId }) {
        if (barber === ANY_BARBER) return getDaySlotsAny({ date, service, bookings, now, ignoreBookingId });

        const status = getDateStatus(date, now, barber);
        if (status !== 'ok') return { status, slots: [] };

        const hours = getOpeningHours(date);
        const open = timeToMinutes(hours.open);
        const close = timeToMinutes(hours.close);
        const busy = activeBookingsFor(bookings, barber.id, date)
          .filter((b) => b.id !== ignoreBookingId)
          .map((b) => {
            const s = timeToMinutes(b.time);
            return [s, s + b.duration];
          });

        const slots = [];
        for (let start = open; start < close; start += RULES.slotStep) {
          const end = start + service.duration;
          const time = minutesToTime(start);
          let state = 'available';
          let reason = null;

          if (startDateTime(date, time).getTime() <= now.getTime()) {
            state = 'unavailable';
            reason = 'past';
          } else if (busy.some(([bs, be]) => overlaps(start, end, bs, be))) {
            state = 'booked';
            reason = 'booked';
          } else if (end > close) {
            state = 'unavailable';
            reason = 'after-closing';
          }
          slots.push({ time, end: minutesToTime(end), state, reason });
        }
        return { status, slots };
      }

      /** Mriežka termínov pre možnosť „ktorýkoľvek barber“. Voľné termíny nesú zoznam voľných barberov. */
      function getDaySlotsAny({ date, service, bookings, now, ignoreBookingId }) {
        const status = getDateStatus(date, now, null);
        if (status !== 'ok') return { status, slots: [] };
        const barbers = eligibleBarbers(service, date);
        if (!barbers.length) return { status: 'no-barber', slots: [] };

        const grids = barbers.map((b) => getDaySlots({ date, service, barber: b, bookings, now, ignoreBookingId }).slots);
        const slots = grids[0].map((base, i) => {
          const free = barbers.filter((b, k) => grids[k][i].state === 'available').map((b) => b.id);
          const common = { time: base.time, end: base.end };
          if (free.length) return Object.assign(common, { state: 'available', reason: null, barberIds: free });
          if (grids.some((g) => g[i].reason === 'past')) return Object.assign(common, { state: 'unavailable', reason: 'past', barberIds: [] });
          if (grids.some((g) => g[i].reason === 'after-closing')) {
            return Object.assign(common, { state: 'unavailable', reason: 'after-closing', barberIds: [] });
          }
          return Object.assign(common, { state: 'booked', reason: 'booked', barberIds: [] });
        });
        return { status, slots };
      }

      /**
       * Vyberie barbera pre termín rezervovaný cez „ktorýkoľvek barber“: spomedzi voľných ten,
       * kto má v daný deň najmenej zarezervovaných minút; pri zhode rozhoduje poradie v zozname.
       */
      function pickBarberForSlot({ date, time, service, bookings, now, ignoreBookingId }) {
        const slot = getDaySlotsAny({ date, service, bookings, now, ignoreBookingId }).slots.find((s) => s.time === time);
        if (!slot || slot.state !== 'available') return null;
        const load = (id) => activeBookingsFor(bookings, id, date).reduce((sum, b) => sum + b.duration, 0);
        return slot.barberIds
          .map(getBarber)
          .sort((a, b) => load(a.id) - load(b.id) || BARBERS.indexOf(a) - BARBERS.indexOf(b))[0];
      }

      /** Počet voľných termínov v mriežke dňa. */
      const countFree = (day) => day.slots.filter((s) => s.state === 'available').length;

      /**
       * Zoznam najbližších dní, v ktorých sa dá rezervovať (dnes len ak ešte zostáva čas).
       * `barber` = objekt barbera, ANY_BARBER alebo null; pri ANY_BARBER so službou sa vynechajú dni,
       * keď službu nerobí nikto.
       */
      function listOpenDates(now, count, barber, service) {
        const result = [];
        const specific = barber && barber !== ANY_BARBER ? barber : null;
        let iso = toISODate(now);
        for (let i = 0; i <= RULES.maxDaysAhead && result.length < count; i++, iso = addDays(iso, 1)) {
          if (getDateStatus(iso, now, specific) !== 'ok') continue;
          if (!specific && service && !eligibleBarbers(service, iso).length) continue;
          if (i === 0) {
            const hours = getOpeningHours(iso);
            const closeAt = startDateTime(iso, hours.close).getTime() - RULES.slotStep * 60000;
            if (now.getTime() >= closeAt) continue;
          }
          result.push(iso);
        }
        return result;
      }

      /**
       * Najbližší voľný termín pre danú službu (u ktoréhokoľvek z barberov v `barbers`, ktorý ju ponúka).
       * Vráti { date, time, barber } alebo null.
       */
      function findNextAvailable({ service, bookings, now, barbers = BARBERS, daysAhead = RULES.maxDaysAhead }) {
        let best = null;
        let iso = toISODate(now);
        for (let i = 0; i <= daysAhead; i++, iso = addDays(iso, 1)) {
          for (const barber of barbers) {
            if (!barberOffers(barber, service.id)) continue;
            const { slots } = getDaySlots({ date: iso, service, barber, bookings, now });
            const free = slots.find((s) => s.state === 'available');
            if (free && (!best || free.time < best.time)) best = { date: iso, time: free.time, barber };
          }
          if (best) return best; // prvý deň, v ktorom je niečo voľné, obsahuje najskorší termín
        }
        return null;
      }

      /* ------------------------------------------------------------------ */
      /* Normalizácia a validácia vstupov                                    */
      /* ------------------------------------------------------------------ */

      const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

      /**
       * Zjednotí zápis telefónneho čísla: "0900 123 456", "+421 900 123 456",
       * "00421900123456" aj "900123456" -> "+421900123456".
       */
      function normalizePhone(value) {
        let s = String(value || '').trim().replace(/[\s\-().\/]/g, '');
        if (s.startsWith('00')) s = '+' + s.slice(2);
        else if (s.startsWith('0')) s = '+421' + s.slice(1);
        else if (/^[1-9]\d{8}$/.test(s)) s = '+421' + s;
        else if (/^[1-9]\d{10,14}$/.test(s)) s = '+' + s;
        return s;
      }

      /**
       * Telefónne číslo v čitateľnom tvare: "+421903111222" -> "+421 903 111 222".
       * Iné medzinárodné čísla vracia bez zmeny, lebo ich členenie sa líši podľa krajiny.
       */
      function formatPhone(value) {
        const phone = normalizePhone(value);
        const sk = /^\+421(\d{3})(\d{3})(\d{3})$/.exec(phone);
        return sk ? '+421 ' + sk[1] + ' ' + sk[2] + ' ' + sk[3] : phone;
      }

      const isValidEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
      // Slovenské číslo (+421) má presne 9 číslic za predvoľbou, ostatné medzinárodné čísla 10 až 15 číslic (E.164).
      const isValidPhone = (phone) => (phone.startsWith('+421') ? /^\+421[1-9]\d{8}$/ : /^\+[1-9]\d{9,14}$/).test(phone);
      const isValidName = (name) => /^\p{L}[\p{L}\p{M}\s.'’-]*$/u.test(name);

      /**
       * Overí vstup rezervačného formulára.
       * Vráti { valid, errors, values }, kde values sú upravené (trim, normalizované) hodnoty.
       */
      function validateBookingInput(input, now) {
        const errors = {};
        const src = input || {};

        const service = getService(src.serviceId);
        const anyBarber = src.barberId === ANY_BARBER;
        const barber = anyBarber ? null : getBarber(src.barberId);
        const date = String(src.date || '').trim();
        const time = String(src.time || '').trim();
        const name = String(src.name || '').trim().replace(/\s+/g, ' ');
        const email = normalizeEmail(src.email);
        const phoneRaw = String(src.phone || '').trim();
        const phone = normalizePhone(phoneRaw);
        const note = String(src.note || '').trim();

        if (!src.serviceId) errors.service = 'Vyberte službu.';
        else if (!service) errors.service = 'Vybraná služba neexistuje.';

        if (!src.barberId) errors.barber = 'Vyberte barbera.';
        else if (!anyBarber && !barber) errors.barber = 'Vybraný barber neexistuje.';
        else if (barber && service && !barberOffers(barber, service.id)) errors.barber = 'Tento barber vybranú službu neponúka.';

        if (!date) errors.date = 'Vyberte dátum.';
        else {
          const specific = barber && !errors.barber ? barber : null;
          let status = getDateStatus(date, now, specific);
          if (status === 'ok' && anyBarber && service && !eligibleBarbers(service, date).length) status = 'no-barber';
          if (status !== 'ok') errors.date = dateStatusMessage(status, date, specific);
        }

        if (!time) errors.time = 'Vyberte čas.';
        else if (timeToMinutes(time) === null) errors.time = 'Zadajte čas vo formáte HH:MM.';

        if (!name) errors.name = 'Zadajte meno a priezvisko.';
        else if (name.length < 2) errors.name = 'Meno je príliš krátke.';
        else if (name.length > 80) errors.name = 'Meno môže mať najviac 80 znakov.';
        else if (!isValidName(name)) errors.name = 'Meno môže obsahovať iba písmená, medzery, pomlčky a apostrofy.';

        if (!email) errors.email = 'Zadajte e-mail.';
        else if (!isValidEmail(email)) errors.email = 'Zadajte platný e-mail, napríklad meno@domena.sk.';

        if (!phoneRaw) errors.phone = 'Zadajte telefónne číslo.';
        else if (!isValidPhone(phone)) errors.phone = 'Zadajte platné telefónne číslo, napríklad 0900 123 456.';

        if (note.length > RULES.maxNoteLength) {
          errors.note = 'Poznámka môže mať najviac ' + RULES.maxNoteLength + ' znakov.';
        }

        return {
          valid: Object.keys(errors).length === 0,
          errors,
          values: { service, barber, anyBarber, date, time, name, email, phone, note },
        };
      }

      /* ------------------------------------------------------------------ */
      /* Vytvorenie, zmena, zrušenie a vyhľadanie rezervácií                 */
      /* ------------------------------------------------------------------ */

      const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

      /** Náhodné celé číslo 0..n-1; ak je k dispozícii, použije kryptografický generátor. */
      function randomIndex(n) {
        const c = typeof crypto !== 'undefined' && crypto && crypto.getRandomValues ? crypto : null;
        if (c) {
          const buf = new Uint32Array(1);
          c.getRandomValues(buf);
          return buf[0] % n;
        }
        return Math.floor(Math.random() * n);
      }

      /** Číslo rezervácie, napr. BS-7K2M9X (bez ľahko zameniteľných znakov ako 0/O a 1/I/L). */
      function generateId() {
        let id = 'BS-';
        for (let i = 0; i < 6; i++) id += ID_ALPHABET[randomIndex(ID_ALPHABET.length)];
        return id;
      }

      const sameCustomer = (a, b) =>
        normalizeEmail(a.email) === normalizeEmail(b.email) || normalizePhone(a.phone) === normalizePhone(b.phone);

      const fail = (code, message, errors) => ({ ok: false, code, message, errors: errors || {} });

      /** Chyba termínu podľa stavu slotu, alebo null, keď je slot voľný. */
      function slotFailure(slot) {
        if (!slot) return fail('INVALID_TIME', 'Tento čas nie je v ponuke.', { time: 'Tento čas nie je v ponuke.' });
        if (slot.state === 'booked') {
          return fail('SLOT_TAKEN', 'Tento termín je už obsadený. Vyberte iný čas.', { time: 'Termín je obsadený.' });
        }
        if (slot.reason === 'past') {
          return fail('PAST', 'Tento čas už uplynul. Vyberte termín v budúcnosti.', { time: 'Čas už uplynul.' });
        }
        if (slot.reason === 'after-closing') {
          return fail('OUTSIDE_HOURS', 'Služba sa do otváracích hodín nezmestí. Vyberte skorší čas.', {
            time: 'Služba sa nezmestí do otváracích hodín.',
          });
        }
        return null;
      }

      /** Má zákazník v danom čase inú potvrdenú rezerváciu? */
      function customerHasOverlap(bookings, customer, date, start, end, ignoreBookingId) {
        return bookings.some(
          (b) =>
            b.id !== ignoreBookingId &&
            b.status === STATUS.CONFIRMED &&
            b.date === date &&
            sameCustomer(b.customer || {}, customer) &&
            overlaps(start, end, timeToMinutes(b.time), timeToMinutes(b.time) + b.duration)
        );
      }

      /**
       * Vytvorí rezerváciu (nemení pole `bookings`, vracia nový objekt).
       * Výsledok: { ok: true, booking } alebo { ok: false, code, message, errors }.
       * Kódy chýb: SPAM, VALIDATION, INVALID_TIME, SLOT_TAKEN, PAST, OUTSIDE_HOURS, CUSTOMER_OVERLAP, CUSTOMER_LIMIT.
       */
      function createBooking(input, bookings, now, idFactory) {
        // Skryté pole formulára (pasca na roboty): človek ho nevidí, a teda nevyplní.
        if (String((input || {}).website || '').trim()) return fail('SPAM', 'Rezerváciu sa nepodarilo odoslať.');

        const check = validateBookingInput(input, now);
        if (!check.valid) return fail('VALIDATION', 'Skontrolujte vyplnené údaje.', check.errors);

        const { service, anyBarber, date, time, name, email, phone, note } = check.values;
        let barber = check.values.barber;

        // Dostupnosť sa vždy znova overuje na aktuálnych dátach (ochrana pred dvojitou rezerváciou).
        const day = getDaySlots({ date, service, barber: anyBarber ? ANY_BARBER : barber, bookings, now });
        const failure = slotFailure(day.slots.find((s) => s.time === time));
        if (failure) return failure;
        if (anyBarber) barber = pickBarberForSlot({ date, time, service, bookings, now });

        const start = timeToMinutes(time);
        const end = start + service.duration;
        const customer = { name, email, phone };

        // Jeden zákazník nemôže byť v tom istom čase na dvoch miestach.
        if (customerHasOverlap(bookings, customer, date, start, end)) {
          return fail('CUSTOMER_OVERLAP', 'V tomto čase už máte inú rezerváciu.', {
            time: 'V tomto čase už máte inú rezerváciu.',
          });
        }

        // Ochrana pred hromadným blokovaním termínov jedným zákazníkom.
        const upcoming = bookings.filter(
          (b) =>
            b.status === STATUS.CONFIRMED &&
            sameCustomer(b.customer || {}, customer) &&
            endDateTime(b.date, b.time, b.duration).getTime() > now.getTime()
        ).length;
        if (upcoming >= RULES.maxActivePerCustomer) {
          return fail(
            'CUSTOMER_LIMIT',
            'Dosiahli ste najvyšší počet nadchádzajúcich rezervácií (' +
              RULES.maxActivePerCustomer +
              '). Ďalší termín si rezervujte po ich absolvovaní alebo nám zavolajte.'
          );
        }

        const makeId = idFactory || generateId;
        let id = makeId();
        for (let i = 0; i < 20 && bookings.some((b) => b.id === id); i++) id = makeId();

        const booking = {
          id,
          serviceId: service.id,
          serviceName: service.name,
          barberId: barber.id,
          barberName: barber.name,
          date,
          time,
          endTime: minutesToTime(end),
          duration: service.duration,
          price: service.price,
          status: STATUS.CONFIRMED,
          customer,
          note,
          createdAt: now.toISOString(),
        };
        if (anyBarber) booking.barberAuto = true;
        return { ok: true, booking };
      }

      /** Zobrazovaný stav: zrušená / uskutočnená (už skončila) / potvrdená. */
      function getDisplayStatus(booking, now) {
        if (booking.status === STATUS.CANCELLED) return STATUS.CANCELLED;
        if (endDateTime(booking.date, booking.time, booking.duration).getTime() <= now.getTime()) {
          return STATUS.COMPLETED;
        }
        return STATUS.CONFIRMED;
      }

      /** Rezerváciu je možné zrušiť alebo presunúť, ak je potvrdená a ešte sa nezačala. */
      function canCancel(booking, now) {
        return (
          booking.status === STATUS.CONFIRMED && startDateTime(booking.date, booking.time).getTime() > now.getTime()
        );
      }

      /**
       * Rozpozná, či ide o e-mail alebo telefón.
       * Vráti { type: 'email' | 'phone', value } alebo null pri neplatnom vstupe.
       */
      function parseContactQuery(query) {
        const raw = String(query || '').trim();
        if (!raw) return null;
        if (raw.includes('@')) {
          const email = normalizeEmail(raw);
          return isValidEmail(email) ? { type: 'email', value: email } : null;
        }
        const phone = normalizePhone(raw);
        return isValidPhone(phone) ? { type: 'phone', value: phone } : null;
      }

      const matchesContact = (booking, contact) =>
        contact.type === 'email'
          ? normalizeEmail(booking.customer.email) === contact.value
          : normalizePhone(booking.customer.phone) === contact.value;

      /** Rezervácie zákazníka podľa e-mailu alebo telefónu, zoradené podľa termínu. */
      function findBookings(query, bookings) {
        const contact = parseContactQuery(query);
        if (!contact) return [];
        return bookings
          .filter((b) => matchesContact(b, contact))
          .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : a.date + a.time > b.date + b.time ? 1 : 0));
      }

      /** Spoločná kontrola pre zrušenie a presun: rezervácia existuje, patrí zákazníkovi a dá sa meniť. */
      function ownedChangeable(id, contactQuery, bookings, now, verb) {
        const booking = bookings.find((b) => b.id === id);
        if (!booking) return fail('NOT_FOUND', 'Rezervácia sa nenašla.');
        const contact = parseContactQuery(contactQuery);
        if (!contact || !matchesContact(booking, contact)) {
          return fail('FORBIDDEN', 'Túto rezerváciu nemôžete ' + verb + '.');
        }
        if (booking.status === STATUS.CANCELLED) return fail('ALREADY_CANCELLED', 'Rezervácia je už zrušená.');
        if (!canCancel(booking, now)) {
          return fail('PAST', 'Rezerváciu, ktorá sa už začala alebo skončila, nie je možné ' + verb + '.');
        }
        return { ok: true, booking };
      }

      /**
       * Zruší rezerváciu. `contactQuery` (e-mail alebo telefón) musí patriť zákazníkovi rezervácie.
       * Výsledok: { ok: true, booking } alebo { ok: false, code, message };
       * kódy: NOT_FOUND, FORBIDDEN, ALREADY_CANCELLED, PAST.
       */
      function cancelBooking(id, contactQuery, bookings, now) {
        const found = ownedChangeable(id, contactQuery, bookings, now, 'zrušiť');
        if (!found.ok) return found;
        return {
          ok: true,
          booking: Object.assign({}, found.booking, { status: STATUS.CANCELLED, cancelledAt: now.toISOString() }),
        };
      }

      /**
       * Presunie rezerváciu na iný dátum a čas (služba aj barber ostávajú).
       * `change` = { date, time }. Výsledok: { ok: true, booking, previous } alebo { ok: false, code, message };
       * kódy: NOT_FOUND, FORBIDDEN, ALREADY_CANCELLED, PAST, UNAVAILABLE, SAME_TIME, INVALID_DATE,
       * INVALID_TIME, SLOT_TAKEN, OUTSIDE_HOURS, CUSTOMER_OVERLAP.
       */
      function rescheduleBooking(id, contactQuery, change, bookings, now) {
        const found = ownedChangeable(id, contactQuery, bookings, now, 'presunúť');
        if (!found.ok) return found;
        const booking = found.booking;

        const barber = getBarber(booking.barberId);
        if (!barber) return fail('UNAVAILABLE', 'Tento barber už u nás nepracuje. Rezerváciu zrušte a vytvorte novú.');

        const date = String((change || {}).date || '').trim();
        const time = String((change || {}).time || '').trim();
        if (date === booking.date && time === booking.time) {
          return fail('SAME_TIME', 'Vybrali ste rovnaký termín, aký už máte.');
        }

        const status = getDateStatus(date, now, barber);
        if (status !== 'ok') return fail('INVALID_DATE', dateStatusMessage(status, date, barber));

        // trvanie sa berie z uloženej rezervácie, aby presun fungoval aj po zmene cenníka
        const service = { id: booking.serviceId, duration: booking.duration };
        const day = getDaySlots({ date, service, barber, bookings, now, ignoreBookingId: id });
        const failure = slotFailure(day.slots.find((s) => s.time === time));
        if (failure) return failure;

        const start = timeToMinutes(time);
        const end = start + booking.duration;
        if (customerHasOverlap(bookings, booking.customer, date, start, end, id)) {
          return fail('CUSTOMER_OVERLAP', 'V tomto čase už máte inú rezerváciu.');
        }

        return {
          ok: true,
          previous: { date: booking.date, time: booking.time },
          booking: Object.assign({}, booking, {
            date,
            time,
            endTime: minutesToTime(end),
            rescheduledAt: now.toISOString(),
          }),
        };
      }

      /* ------------------------------------------------------------------ */
      /* Údaje pre server (bez osobných údajov)                              */
      /* ------------------------------------------------------------------ */

      /** Obsadené intervaly v rozsahu dátumov. Neobsahujú žiadne údaje o zákazníkoch. */
      function publicBusy(bookings, fromIso, toIso) {
        return bookings
          .filter((b) => b.status === STATUS.CONFIRMED && b.date >= fromIso && b.date <= toIso)
          .map((b) => ({ barberId: b.barberId, date: b.date, time: b.time, duration: b.duration }));
      }

      /** Obsadené intervaly zo servera -> zjednodušené rezervácie, ktorým rozumie getDaySlots. */
      function busyToBookings(busy) {
        return (busy || []).map((b, i) => ({
          id: 'busy-' + i,
          barberId: String(b.barberId),
          date: String(b.date),
          time: String(b.time),
          duration: Number(b.duration),
          status: STATUS.CONFIRMED,
          customer: {},
        }));
      }

      /** Údaje o rezervácii, ktoré server vracia pri vyhľadaní (bez mena, kontaktu, poznámky a kódu). */
      function publicView(booking, ref) {
        return {
          ref,
          serviceId: booking.serviceId,
          serviceName: booking.serviceName,
          barberId: booking.barberId,
          barberName: booking.barberName,
          date: booking.date,
          time: booking.time,
          endTime: booking.endTime,
          duration: booking.duration,
          price: booking.price,
          status: booking.status,
        };
      }

      /* ------------------------------------------------------------------ */
      /* Texty a kalendár                                                    */
      /* ------------------------------------------------------------------ */

      /** Riadky so zhrnutím rezervácie (pre e-mail salónu aj zákazníkovi). */
      function bookingSummaryLines(booking) {
        return [
          'Služba: ' + booking.serviceName,
          'Barber: ' + booking.barberName,
          'Dátum: ' + formatDate(booking.date, 'long'),
          'Čas: ' + booking.time.replace(/^0/, '') + ' – ' + booking.endTime.replace(/^0/, ''),
          'Cena na mieste: ' + String(booking.price).replace('.', ',') + ' €',
        ];
      }

      /** Vytvorí obsah súboru .ics pre rezerváciu (lokálny čas bez časovej zóny). */
      function buildICS(booking, now) {
        const stamp = (iso, time) => iso.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
        const utc = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const esc = (t) => String(t).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
        return [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Barber Studio//Rezervacie//SK',
          'CALSCALE:GREGORIAN',
          'BEGIN:VEVENT',
          'UID:' + booking.id + '@barberstudio.sk',
          'DTSTAMP:' + utc,
          'DTSTART:' + stamp(booking.date, booking.time),
          'DTEND:' + stamp(booking.date, booking.endTime),
          'SUMMARY:' + esc(Data.SHOP.name + ': ' + booking.serviceName),
          'DESCRIPTION:' + esc('Barber: ' + booking.barberName + '. Cena: ' + booking.price + ' EUR. Číslo rezervácie: ' + booking.id),
          'LOCATION:' + esc(Data.SHOP.address),
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n');
      }

      /** Odkaz na pridanie rezervácie do Google kalendára (funguje aj tam, kde nie je povolené sťahovanie súborov). */
      function googleCalendarUrl(booking) {
        const stamp = (iso, time) => iso.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
        const params = [
          ['action', 'TEMPLATE'],
          ['text', Data.SHOP.name + ': ' + booking.serviceName],
          ['dates', stamp(booking.date, booking.time) + '/' + stamp(booking.date, booking.endTime)],
          ['ctz', Data.SHOP.timeZone || 'Europe/Bratislava'],
          ['details', 'Barber: ' + booking.barberName + '. Cena: ' + booking.price + ' EUR. Číslo rezervácie: ' + booking.id],
          ['location', Data.SHOP.address],
        ];
        return 'https://calendar.google.com/calendar/render?' + params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
      }

      return Object.freeze({
        STATUS,
        ANY_BARBER,
        DAY_SHORT,
        MONTH_SHORT,
        pad,
        toISODate,
        parseISODate,
        timeToMinutes,
        minutesToTime,
        addDays,
        startDateTime,
        endDateTime,
        nowInTimeZone,
        formatDate,
        getService,
        getBarber,
        getClosure,
        getOpeningHours,
        barberOffers,
        barberWorksOn,
        eligibleBarbers,
        getDateStatus,
        dateStatusMessage,
        getDaySlots,
        pickBarberForSlot,
        countFree,
        listOpenDates,
        findNextAvailable,
        normalizeEmail,
        normalizePhone,
        formatPhone,
        isValidEmail,
        isValidPhone,
        validateBookingInput,
        generateId,
        createBooking,
        getDisplayStatus,
        canCancel,
        parseContactQuery,
        findBookings,
        cancelBooking,
        rescheduleBooking,
        publicBusy,
        busyToBookings,
        publicView,
        bookingSummaryLines,
        buildICS,
        googleCalendarUrl,
      });
    });
  })(module, require);
  return module.exports;
})();

/* ==========================================================================
   Barber Studio – server (Google Apps Script + Google Tabuľka)

   Čo robí:
     - ukladá rezervácie do hárka tejto Google Tabuľky (jeden riadok = jedna rezervácia),
     - stráži, aby sa dva termíny neprekrývali (zámok + opätovná kontrola pred zápisom),
     - posiela e-mail prevádzke aj zákazníkovi (nová rezervácia, zrušenie, presun).

   Pravidlá rezervácií sú tie isté ako na stránke: časť nad touto čiarou (BarberData
   a BookingLogic) je vygenerovaná zo súborov js/data.js a js/booking-logic.js.
   Po zmene cenníka, barberov alebo hodín spustite `python3 tools/build_server.py`
   a kód v Apps Script nahraďte novým obsahom súboru server/Code.gs.

   Nasadenie krok za krokom je v súbore README.md (časť „Ostrý režim“).
   ========================================================================== */

/* ====================== NASTAVENIA ====================== */
var CONFIG = {
  /** Názov hárka, do ktorého sa zapisujú rezervácie. */
  SHEET_NAME: 'Rezervácie',
  /** Kam chodia upozornenia pre prevádzku. Prázdne = e-mail účtu, pod ktorým skript beží. */
  OWNER_EMAIL: '',
  /** false = e-maily sa neposielajú. */
  SEND_EMAILS: true,
  /** Adresa webu (použije sa v e-mailoch), napr. 'https://meno.github.io/barber-studio/'. */
  SITE_URL: '',
};

/* ====================== HÁROK ====================== */

/** Poradie stĺpcov v hárku. Vľavo je to, čo zaujíma prevádzku, vpravo technické údaje. */
var COLUMNS = [
  'status', 'date', 'time', 'endTime', 'serviceName', 'barberName', 'name', 'phone', 'email', 'note',
  'price', 'id', 'duration', 'serviceId', 'barberId', 'barberAuto', 'createdAt', 'cancelledAt', 'rescheduledAt',
];
var HEADERS = [
  'Stav', 'Dátum', 'Čas', 'Koniec', 'Služba', 'Barber', 'Meno', 'Telefón', 'E-mail', 'Poznámka',
  'Cena (€)', 'Kód', 'Trvanie (min)', 'ID služby', 'ID barbera', 'Barber priradený automaticky', 'Vytvorené', 'Zrušené', 'Presunuté',
];
var STATUS_TEXT = { confirmed: 'potvrdená', cancelled: 'zrušená' };

function col(key) {
  return COLUMNS.indexOf(key) + 1;
}

/** Vráti hárok s rezerváciami; ak ešte neexistuje, vytvorí ho s hlavičkou. */
function getSheet() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = book.insertSheet(CONFIG.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    var head = sheet.getRange(1, 1, 1, HEADERS.length);
    head.setNumberFormat('@');
    head.setValues([HEADERS]);
    head.setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Jednorazové nastavenie: spustite túto funkciu v editore Apps Script (tlačidlo Spustiť).
 * Vytvorí hárok s hlavičkou a vyžiada potrebné povolenia (tabuľka a odosielanie e-mailov).
 */
function setup() {
  var sheet = getSheet();
  var quota = CONFIG.SEND_EMAILS ? MailApp.getRemainingDailyQuota() : 0;
  Logger.log('Hárok „' + sheet.getName() + '“ je pripravený. Dnes možno odoslať ešte ' + quota + ' e-mailov.');
}

/** Text bunky tak, aby ho tabuľka nikdy nepochopila ako vzorec ani číslo. */
function cellText(value) {
  var text = String(value === null || value === undefined ? '' : value);
  return /^[=+\-@\t\r']/.test(text) ? "'" + text : text;
}

function cleanCell(value) {
  return String(value === null || value === undefined ? '' : value).replace(/^'/, '').trim();
}

/** "12.10.2026" alebo "2026-10-12" -> "2026-10-12" (prevádzka môže riadok dopísať ručne). */
function normalizeDateCell(text) {
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return iso[1] + '-' + BookingLogic.pad(iso[2]) + '-' + BookingLogic.pad(iso[3]);
  var sk = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(text);
  if (sk) return sk[3] + '-' + BookingLogic.pad(sk[2]) + '-' + BookingLogic.pad(sk[1]);
  return '';
}

/** "9:00", "09:00" alebo "9.00" -> "09:00". */
function normalizeTimeCell(text) {
  var m = /^(\d{1,2})[:.](\d{2})/.exec(text);
  return m ? BookingLogic.pad(m[1]) + ':' + m[2] : '';
}

function findByName(list, text) {
  var needle = text.toLowerCase();
  if (!needle) return null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].name.toLowerCase() === needle) return list[i];
  }
  for (var j = 0; j < list.length; j++) {
    if (list[j].name.toLowerCase().indexOf(needle) === 0) return list[j]; // napr. iba krstné meno barbera
  }
  return null;
}

/**
 * Riadok hárka -> rezervácia. Rozumie aj riadkom, ktoré prevádzka dopísala ručne
 * (napr. telefonická rezervácia iba s dátumom, časom, službou a menom barbera).
 * Riadok, z ktorého sa nedá určiť termín, vráti null a do obsadenosti sa nepočíta.
 */
function rowToBooking(cells, rowNumber) {
  var o = {};
  for (var i = 0; i < COLUMNS.length; i++) o[COLUMNS[i]] = cleanCell(cells[i]);

  var service = BookingLogic.getService(o.serviceId) || findByName(BarberData.SERVICES, o.serviceName);
  var barber = BookingLogic.getBarber(o.barberId) || findByName(BarberData.BARBERS, o.barberName);
  var date = normalizeDateCell(o.date);
  var time = normalizeTimeCell(o.time);
  var duration = Number(o.duration) > 0 ? Number(o.duration) : service ? service.duration : 0;
  if (!barber || !BookingLogic.parseISODate(date) || BookingLogic.timeToMinutes(time) === null || !duration) return null;

  var price = o.price !== '' ? Number(o.price.replace(',', '.')) : service ? service.price : 0;
  return {
    row: rowNumber,
    id: o.id || 'RUCNE-' + rowNumber,
    status: /^(zru|cancel)/i.test(o.status) ? 'cancelled' : 'confirmed',
    date: date,
    time: time,
    endTime: BookingLogic.minutesToTime(BookingLogic.timeToMinutes(time) + duration),
    duration: duration,
    serviceId: service ? service.id : o.serviceId,
    serviceName: o.serviceName || (service ? service.name : ''),
    barberId: barber.id,
    barberName: barber.name,
    price: isNaN(price) ? 0 : price,
    customer: { name: o.name, email: o.email, phone: o.phone },
    note: o.note,
  };
}

function readBookings(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var rows = sheet.getRange(2, 1, last - 1, COLUMNS.length).getDisplayValues();
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var booking = rowToBooking(rows[i], i + 2);
    if (booking) list.push(booking);
  }
  return list;
}

function bookingToRow(booking) {
  var values = {
    status: STATUS_TEXT[booking.status] || booking.status,
    date: booking.date,
    time: booking.time,
    endTime: booking.endTime,
    serviceName: booking.serviceName,
    barberName: booking.barberName,
    name: booking.customer.name,
    phone: booking.customer.phone,
    email: booking.customer.email,
    note: booking.note || '',
    price: String(booking.price),
    id: booking.id,
    duration: String(booking.duration),
    serviceId: booking.serviceId,
    barberId: booking.barberId,
    barberAuto: booking.barberAuto ? 'áno' : '',
    createdAt: booking.createdAt || '',
    cancelledAt: booking.cancelledAt || '',
    rescheduledAt: booking.rescheduledAt || '',
  };
  return COLUMNS.map(function (key) {
    return cellText(values[key]);
  });
}

function writeRow(sheet, rowNumber, booking) {
  var range = sheet.getRange(rowNumber, 1, 1, COLUMNS.length);
  range.setNumberFormat('@'); // obyčajný text: dátum, čas ani telefón sa nesmú automaticky preformátovať
  range.setValues([bookingToRow(booking)]);
}

/* ====================== ČAS ====================== */

var TIME_ZONE = BarberData.SHOP.timeZone || 'Europe/Bratislava';

/** Aktuálny čas prevádzky ako Date, ktorého zložky zodpovedajú hodinám v prevádzke. */
function shopNow() {
  var text = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss");
  var m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)$/.exec(text);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function stamp() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
}

/* ====================== KÓD REZERVÁCIE ====================== */

var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Náhodný kód rezervácie (BS-XXXXXX). Slúži aj ako overenie pri zrušení a presune. */
function makeCode() {
  var hex = Utilities.getUuid().replace(/-/g, '');
  var code = 'BS-';
  for (var i = 0; i < 6; i++) code += CODE_ALPHABET.charAt(parseInt(hex.substr(i * 4, 4), 16) % CODE_ALPHABET.length);
  return code;
}

function normalizeCode(code) {
  var text = String(code || '').toUpperCase().replace(/\s+/g, '');
  if (!text) return '';
  return text.indexOf('BS-') === 0 ? text : 'BS-' + text.replace(/^BS/, '');
}

/* ====================== E-MAILY ====================== */

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ownerEmail() {
  return CONFIG.OWNER_EMAIL || Session.getEffectiveUser().getEmail();
}

/** Odošle e-mail. Chyba pri odosielaní nikdy nezruší rezerváciu; vráti true, ak sa e-mail odoslal. */
function sendMail(to, subject, lines) {
  if (!CONFIG.SEND_EMAILS || !to) return false;
  try {
    MailApp.sendEmail({
      to: to,
      subject: subject,
      name: BarberData.SHOP.name,
      replyTo: ownerEmail(),
      body: lines.join('\n'),
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#231c17">' +
        lines.map(function (line) { return line === '' ? '<br>' : '<div>' + escapeHtml(line) + '</div>'; }).join('') +
        '</div>',
    });
    return true;
  } catch (err) {
    Logger.log('E-mail sa nepodarilo odoslať: ' + err);
    return false;
  }
}

function manageHint() {
  var lines = ['Termín zmeníte alebo zrušíte na našej stránke v časti Moje rezervácie. Budete potrebovať kód rezervácie.'];
  if (CONFIG.SITE_URL) lines.push(CONFIG.SITE_URL);
  return lines;
}

function customerLines(booking, intro) {
  var shop = BarberData.SHOP;
  return [
    'Dobrý deň, ' + booking.customer.name + ',',
    '',
    intro,
    '',
  ]
    .concat(BookingLogic.bookingSummaryLines(booking))
    .concat(['Kód rezervácie: ' + booking.id, '', 'Kde nás nájdete: ' + shop.address, 'Telefón: ' + shop.phone, ''])
    .concat(manageHint())
    .concat(['', 'Tešíme sa na vás.', shop.name]);
}

function ownerLines(booking, intro) {
  var lines = [intro, ''].concat(BookingLogic.bookingSummaryLines(booking));
  lines.push('', 'Meno: ' + booking.customer.name, 'Telefón: ' + BookingLogic.formatPhone(booking.customer.phone), 'E-mail: ' + booking.customer.email);
  if (booking.note) lines.push('Poznámka: ' + booking.note);
  lines.push('Kód rezervácie: ' + booking.id);
  return lines;
}

function when(booking) {
  return BookingLogic.formatDate(booking.date, 'mid') + ' o ' + booking.time.replace(/^0/, '');
}

/* ====================== ODPOVEDE ====================== */

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function failure(code, message) {
  return { ok: false, code: code, message: message };
}

/** Vykoná zmenu dát pod zámkom, aby dve požiadavky naraz nezapísali ten istý termín. */
function withLock(work) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return failure('BUSY', 'Rezervačný systém je práve vyťažený. Skúste to o chvíľu znova.');
  }
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

/* ====================== ČÍTANIE (GET) ====================== */

/**
 * GET ?action=busy&from=RRRR-MM-DD&to=RRRR-MM-DD  -> obsadené intervaly bez osobných údajov
 * GET bez parametrov                             -> informácia, že služba beží
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  try {
    if (params.action === 'busy') {
      var today = BookingLogic.toISODate(shopNow());
      var limit = BookingLogic.addDays(today, BarberData.RULES.maxDaysAhead);
      var from = BookingLogic.parseISODate(params.from) && params.from > today ? params.from : today;
      var to = BookingLogic.parseISODate(params.to) && params.to < limit ? params.to : limit;
      return respond({ ok: true, busy: BookingLogic.publicBusy(readBookings(getSheet()), from, to) });
    }
    return respond({ ok: true, service: BarberData.SHOP.name + ' – rezervácie', time: stamp() });
  } catch (err) {
    return respond(failure('SERVER', 'Na serveri nastala chyba. Skúste to neskôr.'));
  }
}

/* ====================== ZMENY (POST) ====================== */

function handleCreate(input) {
  return withLock(function () {
    var sheet = getSheet();
    var list = readBookings(sheet);
    var result = BookingLogic.createBooking(input, list, shopNow(), makeCode);
    if (!result.ok) return result;

    var booking = result.booking;
    booking.createdAt = stamp();
    writeRow(sheet, sheet.getLastRow() + 1, booking);

    var mailed = sendMail(booking.customer.email, 'Potvrdenie rezervácie: ' + when(booking), customerLines(booking, 'vaša rezervácia je potvrdená.'));
    sendMail(ownerEmail(), 'Nová rezervácia: ' + booking.serviceName + ', ' + when(booking), ownerLines(booking, 'Nová rezervácia z webu.'));
    return { ok: true, booking: booking, mailed: mailed };
  });
}

function handleFind(query) {
  if (!BookingLogic.parseContactQuery(query)) {
    return failure('VALIDATION', 'Zadajte platný e-mail alebo telefónne číslo.');
  }
  var list = readBookings(getSheet());
  var found = BookingLogic.findBookings(query, list).map(function (b) {
    return BookingLogic.publicView(b, b.row);
  });
  return { ok: true, bookings: found };
}

/** Nájde rezerváciu podľa riadka a overí kód z potvrdzovacieho e-mailu. */
function findVerified(list, ref, code) {
  var wanted = normalizeCode(code);
  for (var i = 0; i < list.length; i++) {
    if (list[i].row === Number(ref)) return wanted && list[i].id === wanted ? list[i] : null;
  }
  return null;
}

var CODE_MISMATCH = 'Kód rezervácie nesedí. Nájdete ho v potvrdzovacom e-maile, napríklad BS-7K2M9X.';

function handleCancel(data) {
  return withLock(function () {
    var sheet = getSheet();
    var list = readBookings(sheet);
    var booking = findVerified(list, data.ref, data.code);
    if (!booking) return failure('CODE_MISMATCH', CODE_MISMATCH);

    var result = BookingLogic.cancelBooking(booking.id, data.contact, list, shopNow());
    if (!result.ok) return result;

    sheet.getRange(booking.row, col('status')).setValue(cellText(STATUS_TEXT.cancelled));
    sheet.getRange(booking.row, col('cancelledAt')).setNumberFormat('@').setValue(cellText(stamp()));

    sendMail(booking.customer.email, 'Rezervácia zrušená: ' + when(booking), customerLines(booking, 'vaša rezervácia bola zrušená. Termín sme uvoľnili.'));
    sendMail(ownerEmail(), 'Zrušená rezervácia: ' + booking.serviceName + ', ' + when(booking), ownerLines(booking, 'Zákazník zrušil rezerváciu.'));
    return { ok: true, booking: BookingLogic.publicView(result.booking, booking.row) };
  });
}

function handleReschedule(data) {
  return withLock(function () {
    var sheet = getSheet();
    var list = readBookings(sheet);
    var booking = findVerified(list, data.ref, data.code);
    if (!booking) return failure('CODE_MISMATCH', CODE_MISMATCH);

    var result = BookingLogic.rescheduleBooking(booking.id, data.contact, { date: data.date, time: data.time }, list, shopNow());
    if (!result.ok) return result;

    var moved = result.booking;
    var range = sheet.getRange(booking.row, col('date'), 1, 3);
    range.setNumberFormat('@');
    range.setValues([[cellText(moved.date), cellText(moved.time), cellText(moved.endTime)]]);
    sheet.getRange(booking.row, col('rescheduledAt')).setNumberFormat('@').setValue(cellText(stamp()));

    var was = 'Pôvodný termín: ' + when(booking) + '.';
    sendMail(moved.customer.email, 'Nový termín rezervácie: ' + when(moved), customerLines(moved, 'váš termín sme presunuli. ' + was));
    sendMail(ownerEmail(), 'Presunutá rezervácia: ' + moved.serviceName + ', ' + when(moved), ownerLines(moved, 'Zákazník presunul rezerváciu. ' + was));
    return { ok: true, booking: BookingLogic.publicView(moved, booking.row) };
  });
}

/**
 * POST s telom vo formáte JSON:
 *   { action: 'create', booking: { serviceId, barberId, date, time, name, email, phone, note } }
 *   { action: 'find', query }
 *   { action: 'cancel', ref, code, contact }
 *   { action: 'reschedule', ref, code, contact, date, time }
 */
function doPost(e) {
  var data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return respond(failure('BAD_REQUEST', 'Požiadavke sa nepodarilo porozumieť.'));
  }
  try {
    switch (data && data.action) {
      case 'create':
        return respond(handleCreate(data.booking || {}));
      case 'find':
        return respond(handleFind(data.query));
      case 'cancel':
        return respond(handleCancel(data));
      case 'reschedule':
        return respond(handleReschedule(data));
      default:
        return respond(failure('BAD_REQUEST', 'Neznáma požiadavka.'));
    }
  } catch (err) {
    Logger.log('Chyba: ' + err + (err && err.stack ? '\n' + err.stack : ''));
    return respond(failure('SERVER', 'Na serveri nastala chyba. Skúste to neskôr alebo nám zavolajte.'));
  }
}
