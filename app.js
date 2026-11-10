/**
 * app.js – používateľské rozhranie: vykresľovanie sekcií, rezervačný formulár,
 * potvrdenie, správa rezervácií (zrušenie a presun) a navigácia.
 *
 * Používateľské vstupy sa nikdy nevkladajú cez innerHTML (iba cez textContent),
 * takže meno ani poznámka zákazníka nemôžu vložiť HTML ani skript. Ako HTML sa
 * vkladajú len statické kresby z art.js (ikony, avatary).
 */
(function () {
  'use strict';

  const Data = window.BarberData;
  const Logic = window.BookingLogic;
  const Store = window.BookingStorage;
  const Art = window.BarberArt;
  const { SHOP, RULES } = Data;
  const ANY = Logic.ANY_BARBER;

  /** Aktuálny čas v časovom pásme prevádzky. */
  const now = () => Logic.nowInTimeZone(SHOP.timeZone);

  // Režim: ak je zadaná adresa servera, pracuje sa so serverom, inak s prehliadačom (ukážka).
  const config = window.BARBER_CONFIG || {};
  const apiUrl = typeof config.apiUrl === 'string' ? config.apiUrl : SHOP.apiUrl;
  const api = window.BookingApi.createApi({ apiUrl, now });
  const remote = api.mode === 'remote';

  /* ------------------------------------------------------------------ */
  /* Pomocné funkcie                                                     */
  /* ------------------------------------------------------------------ */

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  /** Vytvorí DOM element: h('div', { class: 'x', text: '...' }, ...deti). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    });
    children.flat().forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return el;
  }

  /** Statická kresba z art.js (SVG reťazec) -> DOM uzol. Nikdy sa nepoužíva na údaje od používateľa. */
  function art(svgString) {
    const template = document.createElement('template');
    template.innerHTML = svgString;
    return template.content.firstChild;
  }
  const icon = (name, className) => art(Art.icon(name, className));
  const iconTile = (name) => h('span', { class: 'icon-tile', 'aria-hidden': 'true' }, icon(name));

  const NBSP = ' ';
  const fmtPrice = (n) => String(n).replace('.', ',') + NBSP + '€';
  const fmtDuration = (min) => min + NBSP + 'min';
  const fmtTime = (t) => t.replace(/^0/, '');
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const fmtDateLong = (iso) => Logic.formatDate(iso, 'long');
  const fmtDateMid = (iso) => Logic.formatDate(iso, 'mid');
  const fmtRange = (b) => fmtTime(b.time) + ' – ' + fmtTime(b.endTime);

  const STATUS_LABELS = { confirmed: 'Potvrdená', cancelled: 'Zrušená', completed: 'Uskutočnená' };
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  /** "Dnes", "Zajtra" alebo deň v týždni. */
  function relativeDay(iso, long) {
    const today = Logic.toISODate(now());
    if (iso === today) return 'Dnes';
    if (iso === Logic.addDays(today, 1)) return 'Zajtra';
    return long ? capitalize(Logic.formatDate(iso, 'weekday')) : Logic.DAY_SHORT[Logic.parseISODate(iso).getDay()];
  }

  /** Pracovné dni barbera ako text, napr. "Po–So" alebo "Ut–So". */
  function workDaysText(barber) {
    const days = WEEK_ORDER.filter((d) => barber.workDays.includes(d));
    const runs = [];
    days.forEach((d) => {
      const last = runs[runs.length - 1];
      if (last && WEEK_ORDER.indexOf(d) === WEEK_ORDER.indexOf(last[last.length - 1]) + 1) last.push(d);
      else runs.push([d]);
    });
    return runs
      .map((run) =>
        run.length > 2
          ? Logic.DAY_SHORT[run[0]] + '–' + Logic.DAY_SHORT[run[run.length - 1]]
          : run.map((d) => Logic.DAY_SHORT[d]).join(', ')
      )
      .join(', ');
  }

  function avatar(barber) {
    if (barber.photo) return h('img', { src: barber.photo, alt: '', loading: 'lazy' });
    return art(Art.avatarSVG(barber.look));
  }

  function setLoading(button, loading) {
    if (!button) return;
    button.classList.toggle('is-loading', loading);
    if (loading) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('is-visible'), 5000);
  }

  /* ------------------------------------------------------------------ */
  /* Stav a prvky                                                        */
  /* ------------------------------------------------------------------ */

  const state = {
    serviceId: '',
    barberId: '', // id barbera, ANY alebo ''
    date: '',
    time: '',
    category: 'all',
    lookupQuery: '',
    lookupResults: null, // null = ešte sa nehľadalo
    submitting: false,
  };

  const els = {
    form: $('#booking-form'),
    layout: $('.booking-layout'),
    service: $('#service'),
    barberChoices: $('#barber-choices'),
    date: $('#date'),
    days: $('#date-chips'),
    slots: $('#time-slots'),
    slotsMessage: $('#slots-message'),
    legend: $('#slots-legend'),
    name: $('#name'),
    email: $('#email'),
    phone: $('#phone'),
    note: $('#note'),
    noteCount: $('#note-count'),
    website: $('#website'),
    consent: $('#consent'),
    formError: $('#form-error'),
    submitSummary: $('#submit-summary'),
    submit: $('#submit-booking'),
    confirmation: $('#confirmation'),
    notice: $('#system-notice'),
    toast: $('#toast'),
    lookupForm: $('#lookup-form'),
    lookupInput: $('#lookup-input'),
    lookupSubmit: $('#lookup-submit'),
    results: $('#my-bookings-results'),
  };

  const currentService = () => Logic.getService(state.serviceId);
  /** Vybraný barber: objekt, ANY alebo null. */
  const currentBarber = () => (state.barberId === ANY ? ANY : Logic.getBarber(state.barberId));
  const snapshot = () => api.snapshot();

  /* ------------------------------------------------------------------ */
  /* Vykresľovanie statických sekcií                                     */
  /* ------------------------------------------------------------------ */

  /** Doplní kontaktné údaje a ikony z dát, aby sa menili na jednom mieste (data.js). */
  function bindShopData() {
    const values = Object.assign({}, SHOP, { zipCity: SHOP.zip + ' ' + SHOP.city });
    $$('[data-shop]').forEach((el) => {
      if (values[el.dataset.shop]) el.textContent = values[el.dataset.shop];
    });
    $$('[data-shop-href]').forEach((el) => {
      const kind = el.dataset.shopHref;
      el.href = kind === 'tel' ? 'tel:' + SHOP.phoneHref : kind === 'mailto' ? 'mailto:' + SHOP.email : SHOP[kind];
    });
    $$('[data-icon]').forEach((el) => {
      el.setAttribute('aria-hidden', 'true');
      el.append(icon(el.dataset.icon));
    });

    if (SHOP.heroPhoto) {
      const hero = $('.hero');
      hero.classList.add('has-photo');
      hero.style.setProperty('--hero-photo', 'url("' + SHOP.heroPhoto + '")');
    }
    if (SHOP.gallery && SHOP.gallery.length) {
      $('#gallery-list').replaceChildren(
        ...SHOP.gallery.map((photo) => h('li', {}, h('img', { src: photo.src, alt: photo.alt || '', loading: 'lazy' })))
      );
      $('#prace').hidden = false;
    }
  }

  const hoursText = (hours) => (hours ? fmtTime(hours.open) + ' – ' + fmtTime(hours.close) : 'Zatvorené');

  /** Otváracie hodiny v kontakte, v pätičke a v nápovedi pri dátume (všetko z OPENING_HOURS). */
  function renderHours() {
    $('#hours-table tbody').replaceChildren(
      ...WEEK_ORDER.map((d) =>
        h('tr', { dataset: { day: d } }, h('th', { scope: 'row', text: Data.DAY_NAMES[d] }), h('td', { text: hoursText(Data.OPENING_HOURS[d]) }))
      )
    );

    // súvislé dni s rovnakými hodinami sa spoja: "Pondelok až piatok 9:00 – 19:00"
    const groups = [];
    WEEK_ORDER.forEach((d) => {
      const text = hoursText(Data.OPENING_HOURS[d]);
      const last = groups[groups.length - 1];
      if (last && last.text === text) last.days.push(d);
      else groups.push({ text, days: [d] });
    });
    const footer = $('#footer-hours');
    footer.replaceChildren();
    groups.forEach((g, i) => {
      const first = Data.DAY_NAMES[g.days[0]];
      const label = g.days.length > 1 ? first + ' až ' + Data.DAY_NAMES[g.days[g.days.length - 1]].toLowerCase() : first;
      if (i) footer.append(h('br'));
      footer.append(label + ' ' + (g.text === 'Zatvorené' ? 'zatvorené' : g.text));
    });

    const closed = WEEK_ORDER.filter((d) => !Data.OPENING_HOURS[d]).map((d) => Data.DAY_NAMES[d].toLowerCase());
    $('#date-hint').textContent =
      (closed.length ? 'Zatvorené máme: ' + closed.join(', ') + '. ' : '') +
      'Rezervovať sa dá najviac ' + RULES.maxDaysAhead + ' dní dopredu.';

    // mimoriadne zatvorené dni v období, na ktoré sa dá rezervovať
    const today = Logic.toISODate(now());
    const closures = [];
    for (let i = 0, iso = today; i <= RULES.maxDaysAhead; i++, iso = Logic.addDays(iso, 1)) {
      const closure = Logic.getClosure(iso);
      if (closure && Data.OPENING_HOURS[Logic.parseISODate(iso).getDay()]) closures.push(fmtDateMid(iso) + ' (' + closure.name + ')');
    }
    const note = $('#hours-note');
    note.hidden = !closures.length;
    note.textContent = closures.length ? 'Mimoriadne zatvorené: ' + closures.join(', ') + '.' : '';
  }

  /** Čísla v sekcii O nás sa počítajú z dát, takže vždy sedia s cenníkom. */
  function renderStats() {
    const openDays = WEEK_ORDER.filter((d) => Data.OPENING_HOURS[d]).length;
    const minPrice = Math.min(...Data.SERVICES.map((s) => s.price));
    const stats = [
      ['Služby', String(Data.SERVICES.length)],
      ['Barberi', String(Data.BARBERS.length)],
      ['Dní v týždni', String(openDays)],
      ['Ceny od', fmtPrice(minPrice)],
    ];
    $('#about-stats').replaceChildren(...stats.map(([label, value]) => h('div', {}, h('dt', { text: label }), h('dd', { text: value }))));
  }

  function renderMarquee() {
    const items = () => Data.SERVICES.map((s) => h('span', { class: 'marquee-item', text: s.name }));
    $('#marquee-track').replaceChildren(...items(), ...items()); // dvakrát za sebou, aby pás plynule nadväzoval
  }

  function bookButton(label, ariaLabel, preset, className) {
    return h(
      'button',
      { type: 'button', class: className || 'btn btn-ghost btn-small', 'aria-label': ariaLabel, onclick: () => startBooking(preset) },
      label,
      icon('arrow', 'icon-arrow')
    );
  }

  function renderServiceTabs() {
    const tabs = [{ id: 'all', name: 'Všetko', count: Data.SERVICES.length }].concat(
      Data.CATEGORIES.map((c) => ({ id: c.id, name: c.name, count: Data.SERVICES.filter((s) => s.category === c.id).length }))
    );
    $('#service-tabs').replaceChildren(
      ...tabs.map((t) =>
        h(
          'button',
          {
            type: 'button',
            class: 'tab',
            dataset: { category: t.id },
            'aria-pressed': String(state.category === t.id),
            onclick: () => {
              state.category = t.id;
              renderServiceTabs();
              $$('#services-list .menu-item').forEach((li) => {
                li.hidden = t.id !== 'all' && li.dataset.category !== t.id;
              });
            },
          },
          t.name,
          h('span', { class: 'tab-count', text: String(t.count) })
        )
      )
    );
  }

  function renderServices() {
    renderServiceTabs();
    $('#services-list').replaceChildren(
      ...Data.SERVICES.map((s) =>
        h(
          'li',
          { class: 'menu-item', dataset: { serviceId: s.id, category: s.category } },
          iconTile(s.icon),
          h(
            'div',
            { class: 'menu-row' },
            h('h3', { class: 'menu-name', text: s.name }),
            h('span', { class: 'menu-leader', 'aria-hidden': 'true' }),
            h('span', { class: 'menu-price', text: fmtPrice(s.price) })
          ),
          h('p', { class: 'menu-desc', text: s.description }),
          h(
            'div',
            { class: 'menu-foot' },
            h('span', { class: 'menu-duration' }, icon('clock'), 'Trvanie: ' + fmtDuration(s.duration)),
            bookButton('Rezervovať', 'Rezervovať službu ' + s.name, { serviceId: s.id })
          )
        )
      )
    );
  }

  /** Oranžová karta s odporúčanou službou vedľa cenníka. */
  function renderFeatured() {
    const s = Logic.getService(Data.FEATURED_SERVICE);
    $('#featured-service').replaceChildren(
      h('p', { class: 'featured-label' }, icon('crown'), 'Odporúčame'),
      h('h3', { text: s.name }),
      h('p', { text: s.description }),
      h('div', { class: 'featured-price' }, h('strong', { text: fmtPrice(s.price) }), h('span', { text: fmtDuration(s.duration) })),
      bookButton('Rezervovať balíček', 'Rezervovať službu ' + s.name, { serviceId: s.id }, 'btn btn-dark')
    );
  }

  function renderBarbers() {
    $('#barbers-list').replaceChildren(
      ...Data.BARBERS.map((b) =>
        h(
          'article',
          { class: 'barber', dataset: { barberId: b.id } },
          h('div', { class: 'barber-avatar' }, avatar(b)),
          h(
            'div',
            { class: 'barber-body' },
            h('h3', { text: b.name }),
            h('p', { class: 'barber-role', text: b.role }),
            h('p', { class: 'barber-next', dataset: { nextFor: b.id }, hidden: true }),
            h('p', { class: 'barber-bio', text: b.bio }),
            h('p', { class: 'barber-label', text: 'Ponúka' }),
            h('ul', { class: 'barber-services' }, b.services.map((id) => h('li', { text: Logic.getService(id).name }))),
            h('p', { class: 'barber-days' }, icon('calendar'), 'Pracuje: ' + workDaysText(b)),
            bookButton('Rezervovať termín', 'Rezervovať termín u barbera ' + b.name, { barberId: b.id }, 'btn btn-dark btn-small')
          )
        )
      )
    );
  }

  /** Pri každom barberovi jeho najbližší voľný termín (pre najkratšiu službu, ktorú ponúka). */
  function renderBarberAvailability() {
    if (remote && !api.isReady()) return;
    Data.BARBERS.forEach((b) => {
      const el = $('[data-next-for="' + b.id + '"]');
      if (!el) return;
      const service = Data.SERVICES.filter((s) => Logic.barberOffers(b, s.id)).sort((x, y) => x.duration - y.duration)[0];
      const next = service && Logic.findNextAvailable({ service, bookings: snapshot(), now: now(), barbers: [b] });
      el.hidden = !next;
      if (next) el.textContent = 'Najbližšie voľno: ' + relativeDay(next.date, true).toLowerCase() + ' o ' + fmtTime(next.time);
    });
  }

  const serviceOption = (s) => h('option', { value: s.id, text: `${s.name} (${fmtDuration(s.duration)}, ${fmtPrice(s.price)})` });

  /** Pás rýchlej rezervácie v úvode: predvyberie službu a barbera vo formulári. */
  function initQuickCard() {
    const serviceSelect = $('#quick-service');
    const barberSelect = $('#quick-barber');
    serviceSelect.append(...Data.SERVICES.map(serviceOption));
    barberSelect.append(...Data.BARBERS.map((b) => h('option', { value: b.id, text: b.name })));

    const sync = () => {
      const service = Logic.getService(serviceSelect.value);
      const barber = Logic.getBarber(barberSelect.value);
      $$('option', serviceSelect).forEach((o) => {
        if (o.value) o.disabled = !!barber && !Logic.barberOffers(barber, o.value);
      });
      $$('option', barberSelect).forEach((o) => {
        if (o.value) o.disabled = !!service && !Logic.barberOffers(Logic.getBarber(o.value), service.id);
      });
    };
    serviceSelect.addEventListener('change', sync);
    barberSelect.addEventListener('change', sync);

    $('#quick-go').addEventListener('click', (event) => {
      event.preventDefault();
      startBooking({
        serviceId: serviceSelect.value || undefined,
        barberId: barberSelect.value || (serviceSelect.value ? ANY : undefined),
      });
    });
  }

  function barberChoice(id, name, note, picture) {
    return h(
      'label',
      { class: 'barber-choice' },
      h('input', { type: 'radio', name: 'barber', value: id, id: 'barber-' + id }),
      h(
        'span',
        { class: 'barber-choice-body' },
        h('span', { class: 'barber-choice-avatar', 'aria-hidden': 'true' }, picture),
        h('span', {}, h('span', { class: 'barber-choice-name', text: name }), h('span', { class: 'barber-choice-note', dataset: { role: note }, text: note }))
      )
    );
  }

  function renderFormChoices() {
    els.service.append(...Data.SERVICES.map(serviceOption));
    els.barberChoices.replaceChildren(
      barberChoice(ANY, 'Ktorýkoľvek barber', 'Najviac voľných termínov', icon('users')),
      ...Data.BARBERS.map((b) => barberChoice(b.id, b.name, b.role, avatar(b)))
    );
  }

  /** Stav „teraz otvorené / zatvorené“, zvýraznenie dneška a hodiny v ilustrácii. */
  function renderOpeningInfo() {
    const t = now();
    const todayIso = Logic.toISODate(t);
    const minutes = t.getHours() * 60 + t.getMinutes();

    $$('#hours-table tr').forEach((row) => row.classList.toggle('is-today', row.dataset.day === String(t.getDay())));

    const hourHand = $('#clock-hour');
    if (hourHand) {
      hourHand.setAttribute('transform', 'rotate(' + ((t.getHours() % 12) + t.getMinutes() / 60) * 30 + ' 86 150)');
      $('#clock-minute').setAttribute('transform', 'rotate(' + t.getMinutes() * 6 + ' 86 150)');
    }

    const el = $('#open-now');
    const hours = Logic.getOpeningHours(todayIso);
    el.classList.remove('is-open');
    let text = '';
    if (hours && minutes >= Logic.timeToMinutes(hours.open) && minutes < Logic.timeToMinutes(hours.close)) {
      el.classList.add('is-open');
      text = 'Teraz otvorené, zatvárame o ' + fmtTime(hours.close) + '.';
    } else {
      // zatvorené: nájde najbližší otvorený okamih
      for (let i = 0, iso = todayIso; i < 15 && !text; i++, iso = Logic.addDays(iso, 1)) {
        const h2 = Logic.getOpeningHours(iso);
        if (!h2 || (i === 0 && minutes >= Logic.timeToMinutes(h2.open))) continue;
        const when = i === 0 ? 'dnes' : i === 1 ? 'zajtra' : Logic.formatDate(iso, 'weekday');
        text = 'Teraz zatvorené. Najbližšie otvárame: ' + when + ' o ' + fmtTime(h2.open) + '.';
      }
    }
    if (el.textContent !== text) el.textContent = text;
  }

  /** Blok „Najbližší voľný termín“ v úvode. */
  function renderNextSlot() {
    const box = $('#next-slot');
    if (remote && !api.isReady()) {
      box.hidden = true;
      return;
    }
    const service = Logic.getService('panski-strih') || Data.SERVICES[0];
    const next = Logic.findNextAvailable({ service, bookings: snapshot(), now: now() });
    if (!next) {
      box.hidden = true;
      return;
    }
    $('#next-slot-when').textContent = `${relativeDay(next.date, true)} o ${fmtTime(next.time)}`;
    $('#next-slot-detail').textContent = `${fmtDateMid(next.date)}, ${next.barber.name}, ${service.name}`;
    $('#next-slot-book').onclick = () => startBooking({ serviceId: service.id, barberId: next.barber.id, date: next.date, time: next.time });
    box.hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* Rezervačný formulár                                                 */
  /* ------------------------------------------------------------------ */

  /** Zablokuje služby a barberov, ktorí k sebe nepasujú. */
  function syncChoices() {
    const service = currentService();
    const barber = Logic.getBarber(state.barberId);

    $$('option', els.service).forEach((opt) => {
      if (!opt.value) return;
      opt.disabled = !!barber && !Logic.barberOffers(barber, opt.value);
    });

    $$('input[name="barber"]', els.barberChoices).forEach((input) => {
      input.checked = state.barberId === input.value;
      if (input.value === ANY) return;
      const b = Logic.getBarber(input.value);
      const unsupported = !!service && !Logic.barberOffers(b, service.id);
      input.disabled = unsupported;
      const note = $('.barber-choice-note', input.closest('label'));
      note.textContent = unsupported ? 'Túto službu neponúka' : note.dataset.role;
    });
  }

  /**
   * Tlačidlo dňa do vodorovného pásu. Ak je známa služba aj barber, ukáže počet voľných termínov.
   * `bookings` = rezervácie, podľa ktorých sa počíta obsadenosť.
   */
  function dayButton(iso, options) {
    const { service, barber, bookings, selected, onPick, ignoreBookingId } = options;
    const date = Logic.parseISODate(iso);
    let free = null;
    if (service && barber) {
      free = Logic.countFree(Logic.getDaySlots({ date: iso, service, barber, bookings, now: now(), ignoreBookingId }));
    }
    const label = capitalize(fmtDateLong(iso)) + (free === null ? '' : free ? ', voľné termíny: ' + free : ', obsadené');
    return h(
      'button',
      {
        type: 'button',
        class: 'chip day' + (free === 0 ? ' is-full' : ''),
        dataset: { date: iso },
        'aria-pressed': String(selected),
        'aria-label': label,
        onclick: () => onPick(iso),
      },
      h('span', { class: 'day-week', text: relativeDay(iso, false) }),
      h('span', { class: 'day-num', text: String(date.getDate()) }),
      h('span', { class: 'day-month', text: Logic.MONTH_SHORT[date.getMonth()] }),
      free === null ? null : h('span', { class: 'day-free', text: free ? 'Voľné: ' + free : 'Obsadené' })
    );
  }

  function renderDays() {
    const service = currentService();
    const barber = currentBarber();
    const dates = Logic.listOpenDates(now(), 14, barber, service);
    const ready = !remote || api.isReady();
    els.days.replaceChildren(
      ...dates.map((iso) =>
        dayButton(iso, {
          service: ready ? service : null,
          barber,
          bookings: snapshot(),
          selected: state.date === iso,
          onPick: setDate,
        })
      )
    );
  }

  function setDate(iso) {
    state.date = iso;
    els.date.value = iso;
    clearError('date');
    refreshAll();
  }

  const reasonTitle = (slot) =>
    slot.state === 'booked'
      ? 'Obsadené'
      : slot.reason === 'past'
      ? 'Tento čas už uplynul'
      : slot.reason === 'after-closing'
      ? 'Služba by presiahla otváracie hodiny'
      : '';

  function dayStatusMessage(status, iso, barber) {
    const base = Logic.dateStatusMessage(status, iso, barber && barber !== ANY ? barber : null);
    if (status === 'barber-off') return base + ' Vyberte iný dátum alebo iného barbera.';
    if (status === 'closed' || status === 'holiday' || status === 'no-barber') return base + ' Vyberte iný dátum.';
    return base;
  }

  const SLOT_GROUPS = [
    { title: 'Dopoludnia', until: 12 * 60 },
    { title: 'Popoludní', until: 17 * 60 },
    { title: 'Večer', until: 24 * 60 },
  ];

  /** Mriežka termínov rozdelená na dopoludnie, popoludnie a večer. `name` = názov skupiny prepínačov. */
  function slotGrid(slots, name, idPrefix, selectedTime) {
    let from = 0;
    return SLOT_GROUPS.map((group) => {
      const part = slots.filter((s) => {
        const m = Logic.timeToMinutes(s.time);
        return m >= from && m < group.until;
      });
      from = group.until;
      if (!part.length) return null;
      return h(
        'div',
        { class: 'slot-group' },
        h('p', { class: 'slot-group-title', text: group.title }),
        h(
          'div',
          { class: 'slot-grid' },
          part.map((s) => {
            const id = idPrefix + s.time.replace(':', '');
            const cls = 'slot' + (s.state === 'booked' ? ' is-booked' : s.state === 'unavailable' ? ' is-off' : '');
            return h(
              'label',
              { class: cls, for: id, title: reasonTitle(s) || null, dataset: { state: s.state } },
              h('input', { type: 'radio', name, id, value: s.time, disabled: s.state !== 'available', checked: s.time === selectedTime }),
              h('span', { class: 'slot-body', text: fmtTime(s.time) }),
              s.state === 'booked' ? h('span', { class: 'visually-hidden', text: ', obsadené' }) : null,
              s.state === 'unavailable' ? h('span', { class: 'visually-hidden', text: ', nedostupné' }) : null
            );
          })
        )
      );
    });
  }

  /** Prekreslí mriežku termínov podľa aktuálneho výberu a uložených rezervácií. */
  function refreshSlots() {
    const service = currentService();
    const barber = currentBarber();
    els.slots.replaceChildren();
    els.legend.hidden = true;
    els.slotsMessage.classList.remove('is-warning');

    if (remote && !api.isReady()) {
      els.slotsMessage.textContent = 'Načítavam voľné termíny…';
      return;
    }
    if (!service || !barber || !state.date) {
      els.slotsMessage.textContent = 'Najprv vyberte službu, barbera a dátum.';
      return;
    }

    const day = Logic.getDaySlots({ date: state.date, service, barber, bookings: snapshot(), now: now() });
    if (day.status !== 'ok') {
      state.time = '';
      els.slotsMessage.textContent = dayStatusMessage(day.status, state.date, barber);
      els.slotsMessage.classList.add('is-warning');
      return;
    }

    if (state.time && !day.slots.some((s) => s.time === state.time && s.state === 'available')) state.time = '';

    els.slots.replaceChildren(...slotGrid(day.slots, 'time', 'slot-', state.time).filter(Boolean));

    const free = Logic.countFree(day);
    if (free) {
      els.slotsMessage.textContent = `Voľných termínov: ${free}. Dĺžka služby: ${fmtDuration(service.duration)}.`;
    } else {
      els.slotsMessage.textContent = 'Na tento deň už nie sú voľné termíny. Vyberte iný dátum alebo barbera.';
      els.slotsMessage.classList.add('is-warning');
    }
    els.legend.hidden = false;
  }

  /** Zhrnutie rezervácie vedľa formulára. */
  function updateSlip() {
    const service = currentService();
    const barber = currentBarber();
    const set = (id, text) => {
      const dd = $('#slip-' + id);
      dd.textContent = text || dd.dataset.empty;
      dd.classList.toggle('is-empty', !text);
    };
    set('service', service ? `${service.name} (${fmtDuration(service.duration)})` : '');
    set('barber', barber === ANY ? 'Ktorýkoľvek barber' : barber ? barber.name : '');
    set('date', state.date && Logic.parseISODate(state.date) ? capitalize(fmtDateLong(state.date)) : '');
    let timeText = '';
    if (state.time && service) {
      timeText = `${fmtTime(state.time)} – ${fmtTime(Logic.minutesToTime(Logic.timeToMinutes(state.time) + service.duration))}`;
    }
    set('time', timeText);
    $('#slip-price').textContent = service ? fmtPrice(service.price) : fmtPrice(0);

    // Krátke zhrnutie priamo nad tlačidlom (na úzkych obrazovkách nahrádza lístok vedľa formulára).
    const ready = service && barber && timeText && state.date && Logic.parseISODate(state.date);
    els.submitSummary.hidden = !ready;
    if (ready) {
      els.submitSummary.replaceChildren(
        h('strong', { text: service.name }),
        h('span', { text: barber === ANY ? 'Ktorýkoľvek barber' : barber.name }),
        h('span', { text: capitalize(fmtDateLong(state.date)) + ', ' + timeText }),
        h('span', { class: 'submit-summary-price', text: fmtPrice(service.price) })
      );
    }
  }

  /** Označí hotové kroky formulára fajkou. */
  function updateSteps() {
    const errors = validateAll();
    const done = {
      service: !!currentService(),
      barber: !!currentBarber(),
      date: !!state.date && !errors.date,
      time: !!state.time,
      contact: !errors.name && !errors.email && !errors.phone && !errors.note && !errors.consent,
    };
    $$('.step[data-step]', els.form).forEach((step) => step.classList.toggle('is-done', !!done[step.dataset.step]));
  }

  function refreshAll() {
    syncChoices();
    renderDays();
    refreshSlots();
    updateSlip();
    updateSteps();
  }

  /** Všetko, čo závisí od zoznamu rezervácií (po zmene dát alebo po načítaní zo servera). */
  function refreshAvailability() {
    refreshAll();
    renderNextSlot();
    renderBarberAvailability();
  }

  /** Predvyplní formulár (tlačidlá v cenníku, kartách barberov a v úvode) a posunie stránku k rezervácii. */
  function startBooking(preset) {
    if (!els.confirmation.hidden) showForm();
    if (preset.serviceId) {
      state.serviceId = preset.serviceId;
      els.service.value = preset.serviceId;
      clearError('service');
    }
    if (preset.barberId) {
      const service = currentService();
      const b = Logic.getBarber(preset.barberId);
      if (preset.barberId === ANY || (b && (!service || Logic.barberOffers(b, service.id)))) {
        state.barberId = preset.barberId;
        clearError('barber');
      }
    }
    if (preset.date) {
      state.date = preset.date;
      els.date.value = preset.date;
      clearError('date');
    }
    if (preset.time) state.time = preset.time;
    refreshAll();
    $('#rezervacia').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ----- Chyby formulára ----- */

  const FIELD_CONTROLS = {
    service: '#service',
    date: '#date',
    name: '#name',
    email: '#email',
    phone: '#phone',
    note: '#note',
    consent: '#consent',
  };
  const FIELD_ORDER = ['service', 'barber', 'date', 'time', 'name', 'email', 'phone', 'note', 'consent'];

  function setError(field, message) {
    const target = $('#' + field + '-error');
    if (target) target.textContent = message || '';
    const control = FIELD_CONTROLS[field] && $(FIELD_CONTROLS[field]);
    if (control) {
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    }
  }
  const clearError = (field) => setError(field, '');

  function clearErrors() {
    FIELD_ORDER.forEach(clearError);
    els.formError.textContent = '';
  }

  function showErrors(errors) {
    FIELD_ORDER.forEach((field) => setError(field, errors[field] || ''));
  }

  function focusFirstError(errors) {
    const field = FIELD_ORDER.find((f) => errors[f]);
    if (!field) return;
    let target = null;
    if (field === 'barber') target = $('input[name="barber"]:not(:disabled)', els.barberChoices);
    else if (field === 'time') target = $('input[name="time"]:not(:disabled)', els.slots) || els.slotsMessage;
    else target = $(FIELD_CONTROLS[field]);
    if (target) {
      if (!target.matches('input, select, textarea, button')) target.setAttribute('tabindex', '-1');
      target.focus();
    }
  }

  const collectInput = () => ({
    serviceId: state.serviceId,
    barberId: state.barberId,
    date: state.date,
    time: state.time,
    name: els.name.value,
    email: els.email.value,
    phone: els.phone.value,
    note: els.note.value,
    website: els.website.value,
  });

  function validateAll() {
    const errors = Object.assign({}, Logic.validateBookingInput(collectInput(), now()).errors);
    if (!els.consent.checked) errors.consent = 'Pre odoslanie rezervácie je potrebný súhlas so spracovaním údajov.';
    return errors;
  }

  /** Kontrola jedného poľa (pri opustení poľa alebo úprave poľa s chybou). */
  function validateField(field) {
    const errors = validateAll();
    setError(field, errors[field] || '');
  }

  /* ----- Odoslanie ----- */

  const SLOT_ERRORS = ['SLOT_TAKEN', 'INVALID_TIME', 'PAST', 'OUTSIDE_HOURS', 'CUSTOMER_OVERLAP'];

  async function onSubmit(event) {
    event.preventDefault();
    if (state.submitting) return;
    els.formError.textContent = '';

    const errors = validateAll();
    if (Object.keys(errors).length) {
      showErrors(errors);
      els.formError.textContent = 'Skontrolujte zvýraznené polia a skúste to znova.';
      focusFirstError(errors);
      return;
    }

    // Dostupnosť sa pri uložení znova overuje na aktuálnych dátach (v ostrom režime na serveri).
    state.submitting = true;
    setLoading(els.submit, true);
    const result = await api.create(collectInput());
    state.submitting = false;
    setLoading(els.submit, false);

    if (!result.ok) {
      showErrors(result.errors || {});
      els.formError.textContent = result.message || 'Rezerváciu sa nepodarilo odoslať. Skúste to znova.';
      if (SLOT_ERRORS.includes(result.code)) {
        state.time = '';
        refreshAvailability();
        focusFirstError({ time: true });
      } else {
        focusFirstError(result.errors || {});
      }
      return;
    }

    clearErrors();
    notifyShop(result.booking);
    showConfirmation(result.booking, result);
    refreshAvailability();
  }

  /* ----- Potvrdenie ----- */

  /** Riadok s údajom na potvrdení; note je doplnok menším písmom, className určuje šírku v mriežke. */
  function detailRow(label, value, note, className) {
    return h(
      'div',
      className ? { class: className } : {},
      h('dt', { text: label }),
      h('dd', {}, value, note ? h('small', { text: note }) : null)
    );
  }

  function bookingMailText(b) {
    return ['Nová rezervácia ' + b.id, '']
      .concat(Logic.bookingSummaryLines(b))
      .concat(['', 'Meno: ' + b.customer.name, 'E-mail: ' + b.customer.email, 'Telefón: ' + Logic.formatPhone(b.customer.phone), b.note ? 'Poznámka: ' + b.note : ''])
      .join('\n');
  }

  function bookingMailto(b) {
    return (
      'mailto:' + SHOP.email +
      '?subject=' + encodeURIComponent('Rezervácia ' + b.id + ' – ' + b.serviceName) +
      '&body=' + encodeURIComponent(bookingMailText(b))
    );
  }

  /** Ukážkový režim: voliteľné upozornenie salónu cez formulárovú službu (SHOP.notifyUrl). Chyba nikdy nezruší rezerváciu. */
  function notifyShop(b) {
    if (remote || !SHOP.notifyUrl || typeof fetch !== 'function') return;
    try {
      const body = new URLSearchParams({ subject: 'Rezervácia ' + b.id + ' – ' + b.serviceName, email: b.customer.email, message: bookingMailText(b) });
      fetch(SHOP.notifyUrl, { method: 'POST', headers: { Accept: 'application/json' }, body }).catch(function () {});
    } catch (e) {
      /* ignorované */
    }
  }

  function showConfirmation(b, result) {
    const firstName = b.customer.name.split(' ')[0];
    let lead;
    if (!remote) {
      lead = 'Toto je ukážková verzia, e-mail sa neposiela automaticky. Uložte si číslo rezervácie, pridajte si termín do kalendára alebo pošlite rezerváciu salónu e-mailom.';
    } else if (result && result.mailed) {
      lead = 'Potvrdenie sme poslali na ' + b.customer.email + '. Kód rezervácie budete potrebovať, ak budete chcieť termín presunúť alebo zrušiť.';
    } else {
      lead = 'Potvrdzovací e-mail sa nepodarilo odoslať, preto si kód rezervácie uložte. Budete ho potrebovať, ak budete chcieť termín presunúť alebo zrušiť.';
    }

    els.confirmation.replaceChildren(
      h(
        'div',
        { class: 'confirmation-head' },
        h('span', { class: 'confirmation-check', 'aria-hidden': 'true' }, icon('check')),
        h('h3', { text: 'Rezervácia je potvrdená' }),
        h('p', { class: 'confirmation-code' }, h('span', { text: remote ? 'Kód rezervácie' : 'Číslo rezervácie' }), h('strong', { text: b.id }))
      ),
      h('p', { class: 'confirmation-lead', text: 'Ďakujeme, ' + firstName + '. ' + lead }),
      h(
        'dl',
        { class: 'confirmation-grid' },
        detailRow('Služba', b.serviceName),
        detailRow('Barber', b.barberName, b.barberAuto ? 'priradený automaticky' : ''),
        detailRow('Dátum', capitalize(fmtDateLong(b.date))),
        detailRow('Čas', fmtRange(b)),
        detailRow('Cena na mieste', fmtPrice(b.price)),
        detailRow('Meno', b.customer.name),
        detailRow('E-mail', b.customer.email, '', 'is-wide'),
        detailRow('Telefón', Logic.formatPhone(b.customer.phone)),
        b.note ? detailRow('Poznámka', b.note, '', 'is-full') : null
      ),
      h(
        'div',
        { class: 'confirmation-actions' },
        h('a', { class: 'btn btn-orange', id: 'add-to-calendar', href: Logic.googleCalendarUrl(b), target: '_blank', rel: 'noopener noreferrer', text: 'Pridať do Google kalendára' }),
        remote ? null : h('a', { class: 'btn btn-ghost', id: 'mail-booking', href: bookingMailto(b), text: 'Poslať salónu e-mailom' }),
        h('button', { type: 'button', class: 'btn btn-ghost', id: 'show-my-bookings', text: 'Zobraziť moje rezervácie', onclick: () => openMyBookings(b.customer.email) }),
        h('button', { type: 'button', class: 'btn btn-ghost', id: 'new-booking', text: 'Rezervovať ďalší termín', onclick: newBooking })
      )
    );
    els.layout.hidden = true;
    els.confirmation.hidden = false;
    els.confirmation.focus();
    els.confirmation.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showForm() {
    els.confirmation.hidden = true;
    els.layout.hidden = false;
  }

  /** Nová rezervácia: údaje o zákazníkovi ostanú predvyplnené, výber termínu sa vymaže. */
  function newBooking() {
    state.serviceId = state.barberId = state.date = state.time = '';
    els.service.value = '';
    els.date.value = '';
    els.note.value = '';
    els.noteCount.textContent = '0 / ' + RULES.maxNoteLength + ' znakov';
    els.consent.checked = false; // súhlas sa dáva ku každej rezervácii zvlášť
    clearErrors();
    showForm();
    refreshAll();
    $('#rezervacia').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------------------------------------------ */
  /* Moje rezervácie                                                     */
  /* ------------------------------------------------------------------ */

  /** Obsadenosť bez jednej rezervácie (pri presune sa vlastný termín neberie ako prekážka). */
  function snapshotWithout(b) {
    let skipped = false;
    return snapshot().filter((x) => {
      if (skipped) return true;
      const same = x.id === b.id || (x.barberId === b.barberId && x.date === b.date && x.time === b.time && x.duration === b.duration && x.status === 'confirmed');
      if (same) skipped = true;
      return !same;
    });
  }

  /** Pole na kód rezervácie (iba v ostrom režime). */
  function codeField(id) {
    if (!api.requiresCode) return null;
    return h(
      'div',
      { class: 'code-field' },
      h('label', { for: id, text: 'Kód rezervácie z potvrdzovacieho e-mailu' }),
      h('input', { type: 'text', id, name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '12', placeholder: 'BS-XXXXXX' })
    );
  }

  function bookingCard(b) {
    const t = now();
    const status = Logic.getDisplayStatus(b, t);
    const date = Logic.parseISODate(b.date);
    const actions = h('div', { class: 'booking-actions' });
    const uid = String(b.ref).replace(/[^A-Za-z0-9]/g, '');

    const showButtons = () =>
      actions.replaceChildren(
        h('button', { type: 'button', class: 'btn btn-ghost btn-small', dataset: { action: 'reschedule' }, onclick: showReschedule }, icon('swap'), 'Zmeniť termín'),
        h('button', { type: 'button', class: 'btn btn-danger btn-small', dataset: { action: 'cancel' }, text: 'Zrušiť rezerváciu', onclick: showCancelConfirm })
      );

    function showCancelConfirm() {
      const error = h('p', { class: 'panel-error', role: 'alert' });
      const code = codeField('cancel-code-' + uid);
      const confirmButton = h('button', {
        type: 'button',
        class: 'btn btn-danger btn-small',
        dataset: { action: 'confirm-cancel' },
        text: 'Áno, zrušiť',
        onclick: async () => {
          const value = code ? $('input', code).value.trim() : '';
          if (code && !value) {
            error.textContent = 'Zadajte kód rezervácie.';
            $('input', code).focus();
            return;
          }
          setLoading(confirmButton, true);
          const result = await api.cancel(b.ref, state.lookupQuery, value);
          setLoading(confirmButton, false);
          if (!result.ok) {
            if (code) error.textContent = result.message;
            else showToast(result.message);
            if (!code) await loadMyBookings();
            return;
          }
          await loadMyBookings();
          refreshAvailability(); // uvoľnený termín sa ihneď zobrazí vo formulári
          showToast('Rezervácia bola zrušená a termín je opäť voľný.');
          const card = $(`.booking-card[data-ref="${uid}"]`, els.results);
          if (card) card.focus();
        },
      });
      actions.replaceChildren(
        h(
          'div',
          { class: 'cancel-confirm', role: 'group', 'aria-label': 'Potvrdenie zrušenia' },
          h('p', { text: 'Naozaj chcete zrušiť túto rezerváciu?' }),
          code,
          confirmButton,
          h('button', { type: 'button', class: 'btn btn-ghost btn-small', dataset: { action: 'keep' }, text: 'Ponechať', onclick: showButtons }),
          error
        )
      );
      if (code) $('input', code).focus();
    }

    function showReschedule() {
      const barber = Logic.getBarber(b.barberId);
      const service = { id: b.serviceId, duration: b.duration };
      const pick = { date: '', time: '' };
      const bookings = snapshotWithout(b);
      const days = h('div', { class: 'days', role: 'group', 'aria-label': 'Nový dátum' });
      const message = h('p', { class: 'slots-message', 'aria-live': 'polite', text: 'Vyberte nový dátum.' });
      const grid = h('div', { class: 'slots', role: 'radiogroup', 'aria-label': 'Nový čas' });
      const error = h('p', { class: 'panel-error', role: 'alert' });
      const code = codeField('reschedule-code-' + uid);

      const renderPanel = () => {
        const dates = barber ? Logic.listOpenDates(now(), 14, barber) : [];
        days.replaceChildren(
          ...dates.map((iso) =>
            dayButton(iso, {
              service,
              barber,
              bookings,
              selected: pick.date === iso,
              onPick: (value) => {
                pick.date = value;
                pick.time = '';
                error.textContent = '';
                renderPanel();
              },
            })
          )
        );
        grid.replaceChildren();
        if (!barber) {
          message.textContent = 'Tento barber už u nás nepracuje. Rezerváciu zrušte a vytvorte novú.';
          return;
        }
        if (!pick.date) return;
        const day = Logic.getDaySlots({ date: pick.date, service, barber, bookings, now: now() });
        // pôvodný čas sa neponúka ako nový
        const slots = day.slots.map((s) => (pick.date === b.date && s.time === b.time ? Object.assign({}, s, { state: 'unavailable', reason: null }) : s));
        grid.replaceChildren(...slotGrid(slots, 'resched-time-' + uid, 'resched-' + uid + '-', pick.time).filter(Boolean));
        const free = slots.filter((s) => s.state === 'available').length;
        message.textContent = free ? capitalize(fmtDateLong(pick.date)) + ', voľných termínov: ' + free + '.' : 'Na tento deň už nie sú voľné termíny.';
      };
      grid.addEventListener('change', (e) => {
        pick.time = e.target.value;
        error.textContent = '';
      });

      const confirmButton = h('button', {
        type: 'button',
        class: 'btn btn-orange btn-small',
        dataset: { action: 'confirm-reschedule' },
        text: 'Potvrdiť nový termín',
        onclick: async () => {
          const value = code ? $('input', code).value.trim() : '';
          if (!pick.date || !pick.time) {
            error.textContent = 'Vyberte nový dátum a čas.';
            return;
          }
          if (code && !value) {
            error.textContent = 'Zadajte kód rezervácie.';
            $('input', code).focus();
            return;
          }
          setLoading(confirmButton, true);
          const result = await api.reschedule(b.ref, state.lookupQuery, { date: pick.date, time: pick.time }, value);
          setLoading(confirmButton, false);
          if (!result.ok) {
            error.textContent = result.message;
            return;
          }
          await loadMyBookings();
          refreshAvailability();
          showToast('Termín je presunutý: ' + fmtDateMid(pick.date) + ' o ' + fmtTime(pick.time) + '.');
          const card = $(`.booking-card[data-ref="${uid}"]`, els.results);
          if (card) card.focus();
        },
      });

      actions.replaceChildren(
        h(
          'div',
          { class: 'reschedule', role: 'group', 'aria-label': 'Zmena termínu' },
          h('p', { class: 'reschedule-title', text: 'Nový termín: ' + b.serviceName + ', ' + b.barberName }),
          days,
          message,
          grid,
          code,
          error,
          h(
            'div',
            { class: 'reschedule-buttons' },
            confirmButton,
            h('button', { type: 'button', class: 'btn btn-ghost btn-small', dataset: { action: 'back' }, text: 'Späť', onclick: showButtons })
          )
        )
      );
      renderPanel();
    }

    if (Logic.canCancel(b, t)) showButtons();
    else if (status === 'confirmed') actions.append(h('p', { class: 'booking-sub', text: 'Termín sa už začal, zmeniť ho nie je možné.' }));

    return h(
      'article',
      { class: 'booking-card is-' + status, tabindex: '-1', dataset: { id: b.id || '', ref: uid, status } },
      h(
        'div',
        { class: 'booking-date', 'aria-hidden': 'true' },
        h('span', { class: 'booking-date-week', text: Logic.DAY_SHORT[date.getDay()] }),
        h('span', { class: 'booking-date-num', text: String(date.getDate()) }),
        h('span', { class: 'booking-date-month', text: Logic.MONTH_SHORT[date.getMonth()] })
      ),
      h(
        'div',
        { class: 'booking-main' },
        h('h4', { text: b.serviceName }),
        h('p', { class: 'booking-sub', text: 'Barber: ' + b.barberName }),
        b.id ? h('p', { class: 'booking-sub', text: 'Číslo rezervácie: ' + b.id }) : null
      ),
      h(
        'div',
        { class: 'booking-when-wrap' },
        h('p', { class: 'booking-when', text: capitalize(fmtDateLong(b.date)) }),
        h('p', { class: 'booking-sub', text: `${fmtRange(b)} (${fmtDuration(b.duration)})` })
      ),
      h(
        'div',
        { class: 'booking-side' },
        h('span', { class: 'status status-' + status, text: STATUS_LABELS[status] }),
        h('p', { class: 'booking-price', text: fmtPrice(b.price) })
      ),
      actions
    );
  }

  function renderMyBookings() {
    const list = state.lookupResults;
    if (!state.lookupQuery || !list) {
      els.results.replaceChildren();
      return;
    }
    if (!list.length) {
      els.results.replaceChildren(
        h(
          'p',
          { class: 'results-empty', dataset: { empty: 'true' } },
          'Pre „' + state.lookupQuery + '“ sme nenašli žiadne rezervácie. Skontrolujte zápis e-mailu alebo čísla, alebo si ',
          h('a', { href: '#rezervacia', text: 'vyberte nový termín' }),
          '.'
        )
      );
      return;
    }

    const t = now();
    const upcoming = list.filter((b) => Logic.getDisplayStatus(b, t) === 'confirmed');
    const history = list.filter((b) => Logic.getDisplayStatus(b, t) !== 'confirmed').reverse();
    const nodes = [];
    nodes.push(h('h3', { class: 'results-group-title', text: `Nadchádzajúce rezervácie (${upcoming.length})` }));
    nodes.push(
      upcoming.length
        ? h('div', { class: 'booking-list', dataset: { group: 'upcoming' } }, upcoming.map(bookingCard))
        : h('p', { class: 'results-empty', text: 'Nemáte žiadne nadchádzajúce rezervácie.' })
    );
    if (history.length) {
      nodes.push(h('h3', { class: 'results-group-title', text: `História (${history.length})` }));
      nodes.push(h('div', { class: 'booking-list', dataset: { group: 'history' } }, history.map(bookingCard)));
    }
    els.results.replaceChildren(...nodes);
  }

  /** Načíta rezervácie pre zadaný kontakt a vykreslí ich. */
  async function loadMyBookings() {
    if (!state.lookupQuery) {
      state.lookupResults = null;
      renderMyBookings();
      return;
    }
    setLoading(els.lookupSubmit, true);
    const result = await api.find(state.lookupQuery);
    setLoading(els.lookupSubmit, false);
    if (!result.ok) {
      state.lookupResults = null;
      els.results.replaceChildren(h('p', { class: 'results-empty', role: 'alert', text: result.message }));
      return;
    }
    state.lookupResults = result.bookings;
    renderMyBookings();
  }

  async function onLookup(event) {
    event.preventDefault();
    const query = els.lookupInput.value.trim();
    const errorEl = $('#lookup-error');
    errorEl.textContent = '';
    els.lookupInput.removeAttribute('aria-invalid');

    if (!query) {
      errorEl.textContent = 'Zadajte e-mail alebo telefónne číslo.';
    } else if (!Logic.parseContactQuery(query)) {
      errorEl.textContent = 'Zadajte platný e-mail alebo telefónne číslo, napríklad meno@domena.sk alebo 0900 123 456.';
    }
    if (errorEl.textContent) {
      els.lookupInput.setAttribute('aria-invalid', 'true');
      state.lookupQuery = '';
      state.lookupResults = null;
      els.results.replaceChildren();
      els.lookupInput.focus();
      return;
    }
    state.lookupQuery = query;
    await loadMyBookings();
  }

  function openMyBookings(query) {
    els.lookupInput.value = query;
    onLookup(new Event('submit', { cancelable: true }));
    $('#moje-rezervacie').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------------------------------------------ */
  /* Navigácia a okno ochrany údajov                                     */
  /* ------------------------------------------------------------------ */

  function initNav() {
    // hlavička je nad úvodom priehľadná a po posunutí dostane tmavé pozadie
    const header = $('#site-header');
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    const toggle = $('.nav-toggle');
    const nav = $('#site-nav');
    const setOpen = (open) => {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });

    // zvýraznenie sekcie, ktorá je práve v strede obrazovky
    if ('IntersectionObserver' in window) {
      const links = $$('.site-nav li a');
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            links.forEach((a) => {
              const active = a.getAttribute('href') === '#' + entry.target.id;
              a.classList.toggle('is-active', active);
              if (active) a.setAttribute('aria-current', 'true');
              else a.removeAttribute('aria-current');
            });
          });
        },
        { rootMargin: '-45% 0px -50% 0px' }
      );
      $$('main section[id]').forEach((section) => observer.observe(section));
    }
  }

  function initPrivacy() {
    const dialog = $('#privacy-dialog');
    const open = () => {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    };
    const close = () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
    $$('[data-open-privacy]').forEach((button) => button.addEventListener('click', open));
    $('#privacy-close').addEventListener('click', close);
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) close(); // klik mimo obsahu okna
    });
    if (remote) {
      $('#privacy-storage').textContent =
        'Údaje sa odosielajú do rezervačného systému prevádzky a ukladajú sa v jej tabuľke, ku ktorej má prístup iba prevádzka. Na váš e-mail príde potvrdenie rezervácie.';
    }
  }

  function renderFaq() {
    $('#faq-list').replaceChildren(...Data.FAQ.map((item) => h('div', { class: 'faq-item' }, h('h3', { text: item.q }), h('p', { text: item.a }))));
  }

  /* ------------------------------------------------------------------ */
  /* Ostrý režim: načítanie obsadenosti zo servera                       */
  /* ------------------------------------------------------------------ */

  function showNotice(message, onRetry) {
    els.notice.replaceChildren(message, onRetry ? h('button', { type: 'button', class: 'link-button', text: 'Skúsiť znova', onclick: onRetry }) : null);
    els.notice.hidden = !message;
  }

  async function syncWithServer() {
    const result = await api.refresh();
    if (result.ok) showNotice('');
    else if (!api.isReady()) showNotice(result.message + ' ', syncWithServer);
    refreshAvailability();
    return result;
  }

  function initMode() {
    if (!remote) {
      // zmeny z inej karty prehliadača
      window.addEventListener('storage', (e) => {
        if (e.key !== Store.STORAGE_KEY) return;
        refreshAvailability();
        loadMyBookings();
      });
      return;
    }
    $('#footer-mode').textContent = 'Rezervácie spracúva rezervačný systém prevádzky.';
    $('#lookup-hint').textContent = 'Na zmenu alebo zrušenie termínu budete potrebovať kód z potvrdzovacieho e-mailu.';
    syncWithServer();
    // obsadenosť sa obnovuje po návrate na kartu a raz za minútu
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncWithServer();
    });
    setInterval(() => {
      if (!document.hidden && !state.submitting) syncWithServer();
    }, 60000);
  }

  /* ------------------------------------------------------------------ */
  /* Inicializácia                                                       */
  /* ------------------------------------------------------------------ */

  function init() {
    bindShopData();
    renderHours();
    renderStats();
    renderMarquee();
    renderServices();
    renderFeatured();
    renderBarbers();
    renderFormChoices();
    renderFaq();
    initQuickCard();
    renderOpeningInfo();
    $('#year').textContent = now().getFullYear();

    // rozsah dátumu: dnes až 60 dní dopredu
    const today = Logic.toISODate(now());
    els.date.min = today;
    els.date.max = Logic.addDays(today, RULES.maxDaysAhead);
    els.note.maxLength = RULES.maxNoteLength;
    els.noteCount.textContent = '0 / ' + RULES.maxNoteLength + ' znakov';

    els.service.addEventListener('change', () => {
      state.serviceId = els.service.value;
      clearError('service');
      refreshAll();
    });

    els.barberChoices.addEventListener('change', (e) => {
      if (e.target.name !== 'barber') return;
      state.barberId = e.target.value;
      clearError('barber');
      refreshAll();
    });

    els.date.addEventListener('change', () => {
      state.date = els.date.value;
      clearError('date');
      refreshAll();
    });

    els.slots.addEventListener('change', (e) => {
      if (e.target.name !== 'time') return;
      state.time = e.target.value;
      clearError('time');
      updateSlip();
      updateSteps();
    });

    // živá kontrola textových polí
    ['name', 'email', 'phone', 'note'].forEach((field) => {
      const control = els[field];
      control.addEventListener('blur', () => {
        if (control.value.trim()) validateField(field);
        updateSteps();
      });
      control.addEventListener('input', () => {
        if (control.getAttribute('aria-invalid') === 'true') validateField(field);
      });
    });
    els.consent.addEventListener('change', () => {
      if (els.consent.checked) clearError('consent');
      updateSteps();
    });
    els.note.addEventListener('input', () => {
      els.noteCount.textContent = `${els.note.value.length} / ${RULES.maxNoteLength} znakov`;
    });

    els.form.addEventListener('submit', onSubmit);
    els.lookupForm.addEventListener('submit', onLookup);
    const demoButton = $('#use-demo');
    if (demoButton) demoButton.addEventListener('click', () => openMyBookings(Data.DEMO_CUSTOMER.email));

    // obnovenie ukážkových dát s potvrdením priamo na stránke (okno confirm nie je všade dostupné)
    const resetButton = $('#reset-demo');
    const resetBox = $('#reset-confirm');
    if (resetButton) {
      const toggleReset = (open) => {
        resetBox.hidden = !open;
        resetButton.hidden = open;
        (open ? $('#reset-no') : resetButton).focus();
      };
      resetButton.addEventListener('click', () => toggleReset(true));
      $('#reset-no').addEventListener('click', () => toggleReset(false));
      $('#reset-yes').addEventListener('click', async () => {
        await api.reset();
        state.lookupQuery = '';
        state.lookupResults = null;
        els.lookupInput.value = '';
        els.results.replaceChildren();
        showForm();
        refreshAvailability();
        toggleReset(false);
        showToast('Demo dáta boli obnovené.');
      });
    }

    initNav();
    initPrivacy();
    initMode();
    refreshAvailability();

    // stav „otvorené / zatvorené“ a hodiny v ilustrácii sa priebežne obnovujú
    setInterval(renderOpeningInfo, 30000);
  }

  init();
})();
