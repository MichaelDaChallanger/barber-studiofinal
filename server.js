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
