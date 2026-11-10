#!/usr/bin/env python3
"""
End-to-end testy rezervačného systému v reálnom prehliadači (Chromium cez Playwright).

Príprava (jednorazovo):
    pip install playwright
    playwright install chromium

Spustenie z koreňa projektu:
    python3 tests/e2e/run_e2e.py            # všetky testy
    python3 tests/e2e/run_e2e.py presun     # iba testy, ktorých názov obsahuje "presun"

Skupiny testov:
    t..  ukážkový režim (dáta v prehliadači), stránka sa otvára priamo zo súboru index.html
    r..  ostrý režim: stránka komunikuje s miestnou napodobeninou servera (tests/mock-backend.js),
         v ktorej beží ten istý kód ako na Google (server/Code.gs)
    b..  jednosúborové verzie z priečinka dist/ (pred testom sa nanovo zostavia)

Každý test beží v čistom kontexte prehliadača (prázdny localStorage) s pevne nastaveným časom:
nedeľa 11. 10. 2026, 19:55 (Europe/Bratislava). Ukážkové dáta sa generujú vzhľadom na tento čas,
preto sú očakávané hodnoty v testoch vždy rovnaké.
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
URL = (ROOT / "index.html").as_uri()
FIXED_NOW = "2026-10-11T19:55:00+02:00"
FIXED_UTC = "2026-10-11T17:55:00Z"
STORAGE_KEY = "barberstudio.bookings.v2"
MON = "2026-10-12"  # najbližší pracovný deň
TUE = "2026-10-13"
ALL_TIMES = [f"{h:02d}:{m:02d}" for h in range(9, 19) for m in (0, 30)]  # 9:00 až 18:30

TESTS = []


def test(fn):
    """Test v ukážkovom režime."""
    fn.remote = False
    TESTS.append(fn)
    return fn


def remote(fn):
    """Test v ostrom režime (potrebuje miestny server)."""
    fn.remote = True
    TESTS.append(fn)
    return fn


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def norm(text):
    """Nahradí pevné medzery a zjednotí biele znaky."""
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


# --------------------------------------------------------------------------
# Miestny server pre ostrý režim
# --------------------------------------------------------------------------
class Backend:
    """Spustí tests/mock-backend.js na voľnom porte a umožní nahliadnuť do jeho tabuľky a pošty."""

    def __init__(self):
        self.proc = subprocess.Popen(
            ["node", str(ROOT / "tests" / "mock-backend.js"), "--port", "0", "--now", FIXED_UTC],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        line = self.proc.stdout.readline()
        match = re.search(r"LISTENING (http://\S+)/exec", line)
        if not match:
            raise RuntimeError("Miestny server sa nespustil: " + line)
        self.base = match.group(1)
        self.api_url = self.base + "/exec"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(self.base + path, data=data, method="POST" if data is not None else "GET")
        with self.opener.open(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))

    def reset(self):
        self.call("/__test/reset", {"now": FIXED_UTC})

    def state(self):
        return self.call("/__test/state")

    def records(self):
        return self.state()["records"]

    def mails(self):
        return self.state()["mails"]

    def offline(self, flag):
        self.call("/__test/offline", {"offline": flag})

    def fail_next_mail(self):
        self.call("/__test/fail-mail", {})

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


# --------------------------------------------------------------------------
# Pomocné funkcie
# --------------------------------------------------------------------------
class Session:
    """Jedno okno prehliadača s čistým úložiskom a pevným časom."""

    def __init__(self, browser, width=1280, height=900, clock=FIXED_NOW, tz="Europe/Bratislava", api_url=None, url=URL,
                 reduced_motion=None, wait_ready=True):
        self.browser = browser
        self.api_url = api_url
        self.children = []
        self.ctx = browser.new_context(
            viewport={"width": width, "height": height},
            locale="sk-SK",
            timezone_id=tz,
            reduced_motion=reduced_motion,
        )
        self.page = self.ctx.new_page()
        self.errors = []
        self.requests = []
        self.page.on("request", lambda r: self.requests.append(r.url))
        self.page.on("pageerror", lambda e: self.errors.append("pageerror: " + str(e)))
        self.page.on(
            "console",
            lambda m: self.errors.append("console: " + m.text)
            if m.type == "error" and "Failed to load resource" not in m.text and "ERR_" not in m.text
            else None,
        )
        if api_url:
            self.page.add_init_script("window.BARBER_CONFIG = { apiUrl: %s };" % json.dumps(api_url))
        self.page.clock.set_fixed_time(clock)
        self.page.goto(url)
        self.page.wait_for_selector("#services-list li")
        if api_url and wait_ready:
            self.wait_synced()

    def another(self, **kwargs):
        """Ďalšie nezávislé okno (iný zákazník); zavrie sa spolu s týmto."""
        kwargs.setdefault("api_url", self.api_url)
        child = Session(self.browser, **kwargs)
        self.children.append(child)
        return child

    def close(self):
        for child in self.children:
            child.close()
        self.ctx.close()

    def all_errors(self):
        return self.errors + [e for child in self.children for e in child.errors]

    def external_requests(self):
        """Požiadavky mimo stránky samotnej (v ostrom režime sa nepočíta adresa servera)."""
        own = ("file:", "data:", "blob:", "about:")
        base = self.api_url.rsplit("/", 1)[0] if self.api_url else None
        return [u for u in self.requests if not u.startswith(own) and not (base and u.startswith(base))]

    # --- ostrý režim ---
    def wait_synced(self):
        """Počká, kým stránka načíta obsadenosť zo servera."""
        self.page.wait_for_function(
            "() => document.querySelector('#slots-message').textContent.indexOf('Načítavam') === -1", timeout=10000
        )

    # --- ukladanie ---
    def stored(self):
        return self.page.evaluate(f"JSON.parse(localStorage.getItem('{STORAGE_KEY}') || '[]')")

    # --- formulár ---
    def choose(self, service=None, barber=None, date=None, time_=None):
        p = self.page
        if service:
            p.select_option("#service", service)
        if barber:
            p.click(f"label.barber-choice:has(#barber-{barber})")
        if date:
            p.fill("#date", date)
        if time_:
            p.click(f'label.slot[for="slot-{time_.replace(":", "")}"]')

    def fill_contact(self, name="Ján Testovací", email="jan@example.com", phone="0944 123 987", note="", consent=True):
        p = self.page
        p.fill("#name", name)
        p.fill("#email", email)
        p.fill("#phone", phone)
        if note:
            p.fill("#note", note)
        if consent and not p.is_checked("#consent"):
            p.check("#consent")

    def submit(self):
        self.page.click("#submit-booking")

    def book(self, service, barber, date, time_, **contact):
        self.choose(service, barber, date, time_)
        self.fill_contact(**contact)
        self.submit()

    def confirmed(self):
        """Počká na potvrdenie a vráti jeho text."""
        self.page.wait_for_selector("#confirmation:not([hidden])")
        return norm(self.page.inner_text("#confirmation"))

    def code(self):
        return self.page.inner_text("#confirmation .confirmation-code strong").strip()

    def slot_states(self, root="#time-slots"):
        """Slovník {čas: stav} pre mriežku termínov."""
        return self.page.evaluate(
            """(root) => Object.fromEntries([...document.querySelectorAll(root + ' label.slot')].map(l => [
                l.querySelector('input').value, l.dataset.state]))""",
            root,
        )

    def slot_disabled(self, time_):
        return self.page.is_disabled(f'#slot-{time_.replace(":", "")}')

    def message(self):
        return norm(self.page.inner_text("#slots-message"))

    def form_error(self):
        return norm(self.page.inner_text("#form-error"))

    def lookup(self, query):
        self.page.fill("#lookup-input", query)
        self.page.click("#lookup-submit")
        self.page.wait_for_function("() => !document.querySelector('#lookup-submit').classList.contains('is-loading')")

    def cards(self):
        return self.page.evaluate(
            """() => [...document.querySelectorAll('#my-bookings-results .booking-card')].map(c => ({
                id: c.dataset.id, ref: c.dataset.ref, status: c.dataset.status, text: c.innerText.replace(/\\u00a0/g, ' ')}))"""
        )

    def toast(self):
        return norm(self.page.inner_text("#toast"))


def push_booking(session, **fields):
    """Zapíše rezerváciu priamo do úložiska (akoby ju medzitým vytvorila iná karta prehliadača)."""
    booking = {
        "id": "BS-OTHER1", "serviceId": "panski-strih", "serviceName": "Pánsky strih", "barberId": "michael",
        "barberName": "Michael Nguyen", "date": MON, "time": "12:00", "endTime": "12:30", "duration": 30, "price": 18,
        "status": "confirmed", "customer": {"name": "Prvý Zákazník", "email": "prvy@example.com", "phone": "+421900000001"},
        "note": "", "createdAt": "2026-10-11T17:00:00.000Z",
    }
    booking.update(fields)
    session.page.evaluate(
        """([key, booking]) => {
            const list = JSON.parse(localStorage.getItem(key));
            list.push(booking);
            localStorage.setItem(key, JSON.stringify(list));
        }""",
        [STORAGE_KEY, booking],
    )


# --------------------------------------------------------------------------
# Testy: obsah a navigácia
# --------------------------------------------------------------------------
@test
def t01_sekcie_a_obsah(s):
    p = s.page
    for sec in ["uvod", "o-nas", "sluzby", "postup", "barberi", "rezervacia", "moje-rezervacie", "otazky", "kontakt"]:
        check(p.locator(f"#{sec}").count() == 1, f"chýba sekcia #{sec}")
    check(norm(p.locator(".hero h1").inner_text()).lower() == "poriadny strih. bez čakania.", "hero nadpis: " + p.locator(".hero h1").inner_text())
    check(p.locator('.hero a:has-text("Rezervovať termín")').count() >= 1, "hero tlačidlo Rezervovať termín")
    check(p.locator(".hero-scene svg, svg.hero-scene").count() >= 1, "ilustrácia v úvode")
    check(p.title() == "Barber Studio", "názov stránky")

    services = p.locator("#services-list li")
    check(services.count() >= 8, f"služieb je {services.count()}, treba aspoň 8")
    for i in range(services.count()):
        t = norm(services.nth(i).inner_text())
        check(re.search(r"\d+ €", t) and re.search(r"\d+ min", t), f"služba bez ceny/trvania: {t}")
        check(services.nth(i).locator(".icon-tile svg").count() == 1, f"služba bez ikony: {t}")
    featured = norm(p.inner_text("#featured-service"))
    check("Kráľovský balíček" in featured.title() or "KRÁĽOVSKÝ BALÍČEK" in featured.upper(), "odporúčaná služba: " + featured)
    check("55 €" in featured and "90 min" in featured, "cena a trvanie odporúčanej služby")

    # čísla v sekcii O nás sa počítajú z dát
    stats = norm(p.inner_text("#about-stats"))
    for needle in ["10", "3", "6", "12 €"]:
        check(needle in stats, f"čísla o salóne neobsahujú {needle}: {stats}")
    check(p.locator("#postup .process > li").count() == 4, "postup má mať 4 kroky")

    barbers = p.locator("#barbers-list article")
    check(barbers.count() >= 3, "barberov je menej ako 3")
    for i in range(barbers.count()):
        b = barbers.nth(i)
        check(b.locator("h3").inner_text().strip() != "", "barber bez mena")
        check(b.locator(".barber-avatar svg").count() == 1, "barber bez avatara")
        check(len(b.locator(".barber-bio").inner_text()) > 30, "barber bez bio")
        check(b.locator(".barber-services li").count() >= 4, "barber bez zoznamu služieb")
    check("Michael Nguyen" in p.inner_text("#barbers-list").title() or "MICHAEL NGUYEN" in p.inner_text("#barbers-list").upper(), "Michael Nguyen medzi barbermi")
    nexts = [norm(t) for t in p.locator("#barbers-list .barber-next").all_inner_texts()]
    check(nexts == ["Najbližšie voľno: zajtra o 10:00", "Najbližšie voľno: zajtra o 9:00", "Najbližšie voľno: utorok o 9:00"], f"najbližšie voľno: {nexts}")

    contact = norm(p.locator("#kontakt").inner_text())
    for needle in ["Obchodná 12", "+421 900 123 456", "barbershopmn17@gmail.com", "9:00 – 19:00", "9:00 – 14:00", "Zatvorené"]:
        check(needle in contact, f"kontakt neobsahuje „{needle}“")
    check(p.locator('#kontakt a[href*="openstreetmap.org"]').count() >= 1, "odkaz na mapu")
    check(p.locator("#kontakt .map-wrap svg").count() == 1, "schematická mapa")
    check(p.get_attribute('#kontakt a[href^="tel:"]', "href") == "tel:+421900123456", "telefón ako odkaz")
    check(p.get_attribute('#kontakt a[href^="mailto:"]', "href") == "mailto:barbershopmn17@gmail.com", "e-mail ako odkaz")

    footer = norm(p.locator("footer").inner_text())
    check("© 2026 Barber Studio" in footer, "copyright v pätičke: " + footer)
    check("Pondelok až piatok 9:00 – 19:00" in footer and "Nedeľa zatvorené" in footer, "hodiny v pätičke: " + footer)
    check(p.locator("footer nav a").count() >= 6, "rýchle odkazy v pätičke")


@test
def t02_navigacia_plynule_posuvanie(s):
    p = s.page
    check(p.evaluate("getComputedStyle(document.documentElement).scrollBehavior") == "smooth", "scroll-behavior: smooth")
    links = p.locator("#site-nav li a")
    check(links.count() == 6, "navigácia má 6 odkazov")
    p.click('#site-nav a[href="#sluzby"]')
    p.wait_for_function("() => { const r = document.querySelector('#sluzby').getBoundingClientRect(); return r.top < 140 && r.top > -40; }", timeout=8000)
    check(p.evaluate("location.hash") == "#sluzby", "hash po kliknutí")
    # zvýraznenie aktívnej položky
    p.wait_for_function("() => document.querySelector('#site-nav a.is-active')?.getAttribute('href') === '#sluzby'", timeout=5000)
    # hlavička po posunutí dostane pozadie a neprekrýva nadpis sekcie
    check("is-scrolled" in p.get_attribute("#site-header", "class"), "hlavička po posunutí")
    header_bottom = p.evaluate("document.querySelector('#site-header').getBoundingClientRect().bottom")
    title_top = p.evaluate("document.querySelector('#sluzby h2').getBoundingClientRect().top")
    check(title_top >= header_bottom, f"nadpis sekcie je pod hlavičkou ({title_top} < {header_bottom})")


@test
def t03_mobilne_menu(s):
    p = s.page
    p.set_viewport_size({"width": 390, "height": 844})
    check(p.is_visible(".nav-toggle"), "hamburger je na mobile viditeľný")
    check(not p.is_visible("#site-nav"), "menu je na začiatku zatvorené")
    check(p.get_attribute(".nav-toggle", "aria-expanded") == "false", "aria-expanded=false")
    p.click(".nav-toggle")
    check(p.is_visible("#site-nav"), "menu sa otvorí")
    check(p.get_attribute(".nav-toggle", "aria-expanded") == "true", "aria-expanded=true")
    p.click('#site-nav a[href="#kontakt"]')
    check(not p.is_visible("#site-nav"), "menu sa po kliknutí na odkaz zatvorí")
    p.click(".nav-toggle")
    p.keyboard.press("Escape")
    check(not p.is_visible("#site-nav"), "Escape zatvorí menu")
    check(p.evaluate("document.activeElement.className").startswith("nav-toggle"), "po Escape sa focus vráti na tlačidlo menu")


@test
def t04_filtre_cennika(s):
    p = s.page
    tabs = {norm(t).replace(" ", "") for t in p.locator("#service-tabs .tab").all_inner_texts()}
    check(tabs == {"Všetko10", "Vlasy6", "Brada2", "Balíčky2"}, f"záložky cenníka: {tabs}")
    check(p.get_attribute('.tab[data-category="all"]', "aria-pressed") == "true", "na začiatku je vybrané Všetko")

    def visible():
        return p.evaluate("[...document.querySelectorAll('#services-list li')].filter(li => !li.hidden).map(li => li.dataset.serviceId)")

    check(len(visible()) == 10, "na začiatku sú viditeľné všetky služby")
    p.click('.tab[data-category="brada"]')
    check(visible() == ["uprava-brady", "holenie-britvou"], f"brada: {visible()}")
    check(p.get_attribute('.tab[data-category="brada"]', "aria-pressed") == "true", "aria-pressed na vybranej záložke")
    check(p.get_attribute('.tab[data-category="all"]', "aria-pressed") == "false", "aria-pressed na pôvodnej záložke")
    check(not p.is_visible('#services-list li[data-service-id="panski-strih"]'), "skrytá služba nie je viditeľná")
    p.click('.tab[data-category="balicky"]')
    check(visible() == ["strih-brada", "kralovsky"], f"balíčky: {visible()}")
    p.click('.tab[data-category="vlasy"]')
    check(len(visible()) == 6, f"vlasy: {visible()}")
    p.click('.tab[data-category="all"]')
    check(len(visible()) == 10, "Všetko vráti celý cenník")


@test
def t05_caste_otazky_a_cisla_z_pravidiel(s):
    p = s.page
    items = p.locator("#faq-list .faq-item")
    check(items.count() == 6, f"častých otázok je {items.count()}")
    for i in range(items.count()):
        check(items.nth(i).locator("h3").is_visible() and items.nth(i).locator("p").is_visible(), "otázka aj odpoveď sú viditeľné bez klikania")
        check(len(items.nth(i).locator("p").inner_text()) > 40, "odpoveď je prázdna")
    text = norm(p.inner_text("#faq-list"))
    check("60 dní" in text and "každých 30 minút" in text, "čísla v odpovediach: " + text[:200])
    check("najviac 3 nadchádzajúce" in text, "limit rezervácií v odpovediach")
    # tie isté čísla sú aj v nápovedi pri dátume
    check("najviac 60 dní dopredu" in p.inner_text("#date-hint"), p.inner_text("#date-hint"))


@test
def t06_okno_ochrany_udajov(s):
    p = s.page
    check(not p.is_visible("#privacy-dialog"), "okno je na začiatku zatvorené")
    p.locator("footer [data-open-privacy]").click()
    check(p.is_visible("#privacy-dialog"), "okno sa otvorí z pätičky")
    check(p.evaluate("document.querySelector('#privacy-dialog').matches(':modal')"), "okno je modálne (obsah pod ním je neaktívny)")
    text = norm(p.inner_text("#privacy-dialog"))
    for needle in ["Ochrana údajov", "Meno, e-mail, telefónne číslo", "iba vo vašom prehliadači", "barbershopmn17@gmail.com"]:
        check(needle.lower() in text.lower(), f"okno neobsahuje „{needle}“")
    p.keyboard.press("Escape")
    check(not p.is_visible("#privacy-dialog"), "Escape zatvorí okno")
    p.locator("#booking-form [data-open-privacy]").click()
    check(p.is_visible("#privacy-dialog"), "okno sa otvorí z formulára")
    p.click("#privacy-close")
    check(not p.is_visible("#privacy-dialog"), "tlačidlo Zavrieť zatvorí okno")
    check(p.evaluate("document.activeElement.hasAttribute('data-open-privacy')"), "focus sa vráti na odkaz, ktorý okno otvoril")


@test
def t07_stav_otvorene_zatvorene(s):
    check(norm(s.page.inner_text("#open-now")) == "Teraz zatvorené. Najbližšie otvárame: zajtra o 9:00.", s.page.inner_text("#open-now"))
    check("Nedeľa" in s.page.inner_text("#hours-table tr.is-today"), "dnešný deň je v tabuľke zvýraznený")
    cases = [
        ("2026-10-12T10:00:00+02:00", "Teraz otvorené, zatvárame o 19:00.", "Pondelok"),
        ("2026-10-12T08:15:00+02:00", "Teraz zatvorené. Najbližšie otvárame: dnes o 9:00.", "Pondelok"),
        ("2026-10-12T19:00:00+02:00", "Teraz zatvorené. Najbližšie otvárame: zajtra o 9:00.", "Pondelok"),
        ("2026-10-17T13:59:00+02:00", "Teraz otvorené, zatvárame o 14:00.", "Sobota"),
        ("2026-10-17T15:00:00+02:00", "Teraz zatvorené. Najbližšie otvárame: pondelok o 9:00.", "Sobota"),
    ]
    for clock, expected, day in cases:
        other = s.another(clock=clock)
        got = norm(other.page.inner_text("#open-now"))
        check(got == expected, f"{clock}: „{got}“, očakávané „{expected}“")
        check(("is-open" in other.page.get_attribute("#open-now", "class")) == expected.startswith("Teraz otvorené"), f"{clock}: trieda is-open")
        check(day in other.page.inner_text("#hours-table tr.is-today"), f"{clock}: zvýraznený deň")


# --------------------------------------------------------------------------
# Testy: dostupnosť termínov
# --------------------------------------------------------------------------
@test
def t08_zobrazenie_volnych_a_obsadenych_slotov(s):
    p = s.page
    check("Najprv vyberte" in s.message(), "pred výberom sa zobrazí pokyn")
    s.choose("panski-strih", "michael", MON)
    states = s.slot_states()
    check(list(states) == ALL_TIMES, f"mriežka má mať 20 slotov (9:00–18:30), má {len(states)}")
    # Michael v pondelok: 9:00–10:00 (strih a brada), 10:30–11:00 (pánsky strih), 14:00–15:30 (kráľovský balíček)
    booked = sorted(t for t, st in states.items() if st == "booked")
    check(booked == ["09:00", "09:30", "10:30", "14:00", "14:30", "15:00"], f"obsadené sloty: {booked}")
    for t in booked:
        check(s.slot_disabled(t), f"obsadený slot {t} sa dá vybrať")
        check("is-booked" in p.get_attribute(f'label.slot[for="slot-{t.replace(":", "")}"]', "class"), f"slot {t} nie je vizuálne odlíšený")
    check(not s.slot_disabled("10:00"), "10:00 má byť voľné")
    check(not s.slot_disabled("11:00"), "11:00 má byť voľné")
    check(p.is_visible("#slots-legend"), "legenda je viditeľná")
    check("Voľných termínov: 14" in s.message(), s.message())
    # mriežka je rozdelená na časti dňa
    groups = [norm(t).lower() for t in p.locator("#time-slots .slot-group-title").all_inner_texts()]
    check(groups == ["dopoludnia", "popoludní", "večer"], f"časti dňa: {groups}")
    # obsadený slot vyzerá inak (šrafovanie + preškrtnutie) a nedá sa vybrať kliknutím
    bg = p.evaluate("getComputedStyle(document.querySelector('label.slot.is-booked .slot-body')).backgroundImage")
    deco = p.evaluate("getComputedStyle(document.querySelector('label.slot.is-booked .slot-body')).textDecorationLine")
    check("repeating-linear-gradient" in bg and deco == "line-through", f"obsadený slot: {bg[:40]} / {deco}")
    p.click('label.slot[for="slot-0900"]', force=True)
    check(p.evaluate("document.querySelector('input[name=time]:checked')") is None, "obsadený slot sa vybral")


@test
def t09_trvanie_sluzby_sa_respektuje(s):
    s.choose("strih-brada", "michael", MON)  # 60 min
    st = s.slot_states()
    # 10:00–11:00 zasahuje do rezervácie 10:30; 13:30–14:30 zasahuje do 14:00
    check(st["10:00"] == "booked" and st["13:30"] == "booked", f"prekrytie: {st['10:00']}, {st['13:30']}")
    check(st["11:00"] == "available" and st["13:00"] == "available", "11:00 a 13:00 majú byť voľné")
    check(st["18:00"] == "available", "18:00 + 60 min končí presne pri zatvorení, má byť voľné")
    check(st["18:30"] == "unavailable", "18:30 + 60 min presahuje zatvorenie")
    check(s.slot_disabled("18:30"), "slot po zatvorení sa dá vybrať")
    s.choose("kralovsky", date="2026-10-17")  # sobota, 90 min, zatvárame o 14:00
    st = s.slot_states()
    check(st["12:30"] == "available" and st["13:00"] == "unavailable", f"sobota: 12:30={st['12:30']}, 13:00={st['13:00']}")
    check(len(st) == 10, "v sobotu má mať mriežka 10 slotov (9:00–13:30)")


@test
def t10_dni_bez_terminov(s):
    p = s.page
    s.choose("panski-strih", "michael")
    p.fill("#date", "2026-10-18")  # nedeľa
    check("zatvorené" in s.message(), "nedeľa: " + s.message())
    check(p.locator("#time-slots label").count() == 0, "v nedeľu sa nemajú zobraziť sloty")
    check(not p.is_visible("#slots-legend"), "bez slotov sa legenda nezobrazuje")
    p.fill("#date", "2026-10-10")  # minulosť
    check("dnešný alebo budúci" in s.message(), "minulosť: " + s.message())
    p.fill("#date", "2027-03-01")  # viac ako 60 dní
    check("60 dní" in s.message(), "príliš ďaleko: " + s.message())
    p.fill("#date", "2026-10-11")  # dnes (nedeľa)
    check("zatvorené" in s.message(), "dnes je nedeľa")
    s.choose(barber="tomas", date="2026-10-17")  # sobota, Tomáš nepracuje
    check("Tomáš Kováč v tento deň nepracuje" in s.message(), "Tomáš v sobotu: " + s.message())
    s.choose(barber="lukas", date=MON)  # pondelok, Lukáš nepracuje
    check("Lukáš Novák v tento deň nepracuje" in s.message(), "Lukáš v pondelok: " + s.message())
    # atribúty rozsahu dátumu
    check(p.get_attribute("#date", "min") == "2026-10-11", "min dátum")
    check(p.get_attribute("#date", "max") == "2026-12-10", "max dátum")


@test
def t11_vyber_barbera_podla_sluzby(s):
    p = s.page
    s.choose("holenie-britvou")
    check(p.is_disabled("#barber-tomas"), "Tomáš neponúka holenie, má byť zablokovaný")
    check(not p.is_disabled("#barber-michael") and not p.is_disabled("#barber-lukas"), "Michael a Lukáš majú byť dostupní")
    check(not p.is_disabled("#barber-any"), "Ktorýkoľvek barber je dostupný vždy")
    check("neponúka" in p.inner_text("label.barber-choice:has(#barber-tomas)"), "vysvetlenie pri zablokovanom barberovi")
    s.choose("panski-strih")
    check(not p.is_disabled("#barber-tomas"), "po zmene služby sa barber odblokuje")
    check("Špecialista na fade" in p.inner_text("label.barber-choice:has(#barber-tomas)"), "po zmene služby sa vráti pôvodný popis")
    # opačný smer
    s2 = s.another()
    s2.page.click("label.barber-choice:has(#barber-tomas)")
    check(s2.page.eval_on_selector('#service option[value="holenie-britvou"]', "o => o.disabled"), "služba, ktorú barber neponúka, má byť zablokovaná")
    check(s2.page.eval_on_selector('#service option[value="skin-fade"]', "o => o.disabled") is False, "skin fade má byť dostupný")
    s2.page.click("label.barber-choice:has(#barber-any)")
    check(s2.page.eval_on_selector('#service option[value="holenie-britvou"]', "o => o.disabled") is False, "pri ktoromkoľvek barberovi sú dostupné všetky služby")


@test
def t12_pas_dni_s_poctom_volnych_terminov(s):
    p = s.page
    days = p.locator("#date-chips .day")
    check(days.count() == 14, f"pás má ponúknuť 14 dní, má {days.count()}")
    check(p.locator("#date-chips .day-free").count() == 0, "bez služby a barbera sa počet voľných termínov neukazuje")
    dates = p.evaluate("[...document.querySelectorAll('#date-chips .day')].map(d => d.dataset.date)")
    check(dates[0] == MON and "2026-10-18" not in dates and "2026-10-11" not in dates, f"pás začína najbližším otvoreným dňom a vynecháva nedele: {dates[:8]}")
    check(norm(p.locator(f'.day[data-date="{MON}"] .day-week').text_content()) == "Zajtra", "prvý deň je označený ako Zajtra")

    s.choose("panski-strih", "michael")
    check(norm(p.locator(f'.day[data-date="{MON}"] .day-free').text_content()) == "Voľné: 14", p.locator(f'.day[data-date="{MON}"]').inner_text())
    check("voľné termíny: 14" in p.get_attribute(f'.day[data-date="{MON}"]', "aria-label"), "počet je aj v popise pre čítačky")
    # kliknutie na deň vyberie dátum
    p.click(f'.day[data-date="{TUE}"]')
    check(p.input_value("#date") == TUE, "kliknutie na deň nastaví dátum")
    check(p.get_attribute(f'.day[data-date="{TUE}"]', "aria-pressed") == "true", "vybraný deň je označený")
    check(p.get_attribute(f'.day[data-date="{MON}"]', "aria-pressed") == "false", "ostatné dni nie sú označené")
    check(len(s.slot_states()) == 20, "po výbere dňa sa zobrazia termíny")
    # počet v páse sedí s mriežkou
    free = sum(1 for st in s.slot_states().values() if st == "available")
    check(norm(p.locator(f'.day[data-date="{TUE}"] .day-free').text_content()) == f"Voľné: {free}", "počet v páse sedí s mriežkou")

    # pás sa riadi pracovnými dňami barbera
    s.choose(barber="tomas")
    dates = p.evaluate("[...document.querySelectorAll('#date-chips .day')].map(d => d.dataset.date)")
    check("2026-10-17" not in dates and MON in dates, f"Tomáš nepracuje v sobotu: {dates[:8]}")
    s.choose(barber="lukas")
    dates = p.evaluate("[...document.querySelectorAll('#date-chips .day')].map(d => d.dataset.date)")
    check(MON not in dates and dates[0] == TUE, f"Lukáš nepracuje v pondelok: {dates[:8]}")

    # úplne obsadený deň
    push_booking(s, id="BS-FULL01", barberId="tomas", barberName="Tomáš Kováč", date="2026-10-16", time="09:00", endTime="19:00", duration=600)
    p.reload()
    p.wait_for_selector("#services-list li")
    s.choose("panski-strih", "tomas", "2026-10-16")
    full = p.locator('.day[data-date="2026-10-16"]')
    check("is-full" in full.get_attribute("class") and norm(full.locator(".day-free").text_content()) == "Obsadené", "plný deň je v páse označený")
    check("už nie sú voľné termíny" in s.message(), s.message())
    check(all(st == "booked" for st in s.slot_states().values()), "všetky sloty plného dňa sú obsadené")


@test
def t13_ktorykolvek_barber_zobrazi_zjednotenu_dostupnost(s):
    p = s.page
    s.choose("panski-strih", "michael", MON)
    michael = s.slot_states()
    s.choose(barber="tomas")
    tomas = s.slot_states()
    s.choose(barber="any")
    union = s.slot_states()
    for t in ALL_TIMES:
        expected = "available" if "available" in (michael[t], tomas[t]) else "booked"
        check(union[t] == expected, f"{t}: {union[t]}, očakávané {expected} (Michael {michael[t]}, Tomáš {tomas[t]})")
    booked = sorted(t for t, st in union.items() if st == "booked")
    check(booked == ["09:30", "10:30", "15:00"], f"obsadené u oboch naraz: {booked}")
    check("Voľných termínov: 17" in s.message(), s.message())
    check("Ktorýkoľvek barber" in p.inner_text("#slip-barber"), "zhrnutie: " + p.inner_text("#slip-barber"))
    check(norm(p.locator(f'.day[data-date="{MON}"] .day-free').text_content()) == "Voľné: 17", "počet v páse dní")

    # službu, ktorú robí v daný deň iba jeden barber, určuje jeho kalendár
    s.choose("holenie-britvou", "michael", MON)
    only = s.slot_states()
    s.choose(barber="any")
    check(s.slot_states() == only, "holenie v pondelok robí iba Michael")


@test
def t14_sviatky_a_mimoriadne_zatvorene_dni(s):
    # 21. 12. 2026 je pondelok; pred sviatkami sú v rozsahu rezervácie všetky zimné sviatky
    w = s.another(clock="2026-12-21T10:00:00+01:00")
    p = w.page
    note = norm(p.inner_text("#hours-note"))
    for needle in ["24. decembra (Štedrý deň)", "25. decembra", "26. decembra", "1. januára (Nový rok)", "6. januára (Traja králi)"]:
        check(needle in note, f"poznámka pri otváracích hodinách neobsahuje „{needle}“: {note}")
    w.choose("panski-strih", "michael", "2026-12-24")
    check("zatvorené (Štedrý deň)" in w.message(), w.message())
    check(p.locator("#time-slots label").count() == 0, "vo sviatok sa neponúkajú termíny")
    w.choose(barber="any", date="2027-01-01")
    check("zatvorené (Nový rok)" in w.message(), w.message())
    dates = p.evaluate("[...document.querySelectorAll('#date-chips .day')].map(d => d.dataset.date)")
    for holiday in ["2026-12-24", "2026-12-25", "2026-12-26", "2027-01-01", "2027-01-06"]:
        check(holiday not in dates, f"pás dní ponúka sviatok {holiday}")
    check(dates[:5] == ["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-28", "2026-12-29"], f"pás dní okolo Vianoc: {dates[:5]}")
    # sviatok sa nedá rezervovať ani priamym volaním logiky
    result = p.evaluate(
        """() => BookingLogic.createBooking({serviceId:'panski-strih', barberId:'michael', date:'2026-12-24', time:'10:00',
            name:'Ján Testovací', email:'jan@example.com', phone:'0944 123 987'}, [], BookingLogic.nowInTimeZone('Europe/Bratislava'))"""
    )
    check(result["ok"] is False, f"rezervácia na sviatok prešla: {result}")
    # mimo sviatkov poznámka nie je
    check(not s.page.is_visible("#hours-note"), "v októbri sa poznámka o sviatkoch nezobrazuje")


@test
def t15_cas_prevadzky_plati_aj_pre_navstevnika_v_inom_pasme(s):
    # V Bratislave je pondelok 0:30, v New Yorku ešte nedeľa 18:30.
    ny = s.another(clock="2026-10-12T00:30:00+02:00", tz="America/New_York")
    p = ny.page
    check(p.evaluate("new Date().getDay()") == 0, "príprava: v pásme návštevníka je ešte nedeľa")
    check(p.get_attribute("#date", "min") == MON, "dnešok sa určuje podľa času prevádzky: " + str(p.get_attribute("#date", "min")))
    check(norm(p.inner_text("#open-now")) == "Teraz zatvorené. Najbližšie otvárame: dnes o 9:00.", p.inner_text("#open-now"))
    check(norm(p.locator(f'.day[data-date="{MON}"] .day-week').text_content()) == "Dnes", "pondelok je pre prevádzku dnes")
    check("Pondelok" in p.inner_text("#hours-table tr.is-today"), "zvýraznený deň v otváracích hodinách")

    # V Bratislave je nedeľa 19:55, v Tokiu už pondelok 2:55.
    tokyo = s.another(tz="Asia/Tokyo")
    p = tokyo.page
    check(p.evaluate("new Date().getDay()") == 1, "príprava: v pásme návštevníka je už pondelok")
    check(p.get_attribute("#date", "min") == "2026-10-11", "min dátum podľa prevádzky")
    check(norm(p.inner_text("#next-slot-when")).upper() == "ZAJTRA O 9:00", p.inner_text("#next-slot-when"))

    # Pondelok 10:05 v Bratislave (4:05 v New Yorku): termíny, ktoré už v prevádzke uplynuli, sa neponúkajú.
    late = s.another(clock="2026-10-12T10:05:00+02:00", tz="America/New_York")
    late.choose("panski-strih", "lukas", TUE)
    check(late.slot_states()["09:00"] in ("available", "booked"), "zajtrajšie termíny sú v ponuke")
    late.choose(barber="any", date=MON)
    st = late.slot_states()
    for t in ["09:00", "09:30", "10:00"]:
        check(st[t] != "available" and late.slot_disabled(t), f"{t} už v prevádzke uplynulo, je {st[t]}")
    check("available" in st.values(), "neskoršie dnešné termíny ostávajú v ponuke")
    check(norm(late.page.inner_text("#open-now")).startswith("Teraz otvorené"), late.page.inner_text("#open-now"))


# --------------------------------------------------------------------------
# Testy: vytvorenie rezervácie
# --------------------------------------------------------------------------
@test
def t16_vytvorenie_rezervacie_a_potvrdenie(s):
    p = s.page
    before = len(s.stored())
    check(before == 25, f"ukážkových rezervácií je {before}")
    s.choose("panski-strih", "michael", MON, "11:00")
    slip = norm(p.inner_text("#slip"))
    for needle in ["Pánsky strih (30 min)", "Michael Nguyen", "Pondelok 12. októbra 2026", "11:00 – 11:30", "18 €"]:
        check(needle in slip, f"zhrnutie neobsahuje „{needle}“: {slip}")
    done = p.evaluate("[...document.querySelectorAll('#booking-form .step.is-done')].map(e => e.dataset.step)")
    check(done == ["service", "barber", "date", "time"], f"hotové kroky pred vyplnením údajov: {done}")
    s.fill_contact(note="Prosím o kratšie po bokoch")
    s.submit()

    conf = s.confirmed()
    check("rezervácia je potvrdená" in conf.lower(), "chýba nadpis potvrdenia")
    for needle in ["Pánsky strih", "Michael Nguyen", "Pondelok 12. októbra 2026", "11:00 – 11:30", "18 €",
                   "Ján Testovací", "jan@example.com", "+421 944 123 987", "Prosím o kratšie po bokoch", "Číslo rezervácie"]:
        check(needle.lower() in conf.lower(), f"potvrdenie neobsahuje „{needle}“")
    check("priradený automaticky" not in conf, "barber bol vybraný ručne")
    check(re.fullmatch(r"BS-[A-Z0-9]{6}", s.code()), "číslo rezervácie: " + s.code())
    check(p.evaluate("document.activeElement.id") == "confirmation", "focus sa presunie na potvrdenie")
    check(not p.is_visible(".booking-layout"), "formulár sa po úspechu skryje")

    stored = s.stored()
    check(len(stored) == before + 1, "rezervácia sa neuložila")
    b = stored[-1]
    check((b["serviceId"], b["barberId"], b["date"], b["time"], b["endTime"], b["price"], b["status"]) ==
          ("panski-strih", "michael", MON, "11:00", "11:30", 18, "confirmed"), json.dumps(b))
    check(b["id"] == s.code(), "číslo na potvrdení sedí s uloženou rezerváciou")
    check(b["customer"]["phone"] == "+421944123987", "telefón sa má uložiť normalizovaný")
    check(not b.get("barberAuto"), "ručný výber barbera nemá príznak automatického priradenia")


@test
def t17_po_rezervacii_je_termin_obsadeny(s):
    p = s.page
    s.book("panski-strih", "michael", MON, "11:00")
    s.confirmed()
    p.click("#new-booking")
    check(p.is_visible(".booking-layout"), "formulár sa má znova zobraziť")
    check(p.input_value("#name") == "Ján Testovací", "údaje zákazníka ostanú predvyplnené")
    check(p.input_value("#service") == "", "výber služby sa vymaže")
    check(not p.is_checked("#consent"), "súhlas sa dáva ku každej rezervácii zvlášť")
    s.choose("panski-strih", "michael", MON)
    check(s.slot_states()["11:00"] == "booked", "nový termín 11:00 má byť obsadený")
    check(s.slot_disabled("11:00"), "obsadený termín sa dá vybrať")
    check(s.slot_states()["11:30"] == "available", "11:30 má byť voľné")
    check("Voľných termínov: 13" in s.message(), s.message())


@test
def t18_obsadeny_termin_sa_neda_rezervovat_ani_nasilu(s):
    p = s.page
    before = len(s.stored())
    s.choose("panski-strih", "michael", MON)
    s.fill_contact()
    # odblokovanie obsadeného slotu cez konzolu (simulácia manipulácie)
    p.evaluate("() => { const i = document.querySelector('#slot-0900'); i.disabled = false; i.click(); }")
    check(p.is_checked("#slot-0900"), "príprava testu: slot sa nepodarilo vynútiť")
    s.submit()
    check("obsadený" in s.form_error(), "chybová správa: " + s.form_error())
    check(len(s.stored()) == before, "obsadený termín sa uložil!")
    check(p.is_hidden("#confirmation"), "potvrdenie sa nemá zobraziť")
    check(not p.is_checked("#slot-0900"), "výber obsadeného času sa má zrušiť")
    check(s.slot_disabled("09:00"), "po chybe sa mriežka obnoví")


@test
def t19_dvojita_rezervacia_z_dvoch_kariet(s):
    """Druhá karta s tým istým úložiskom nesmie dovoliť rezerváciu termínu, ktorý medzičasom obsadila prvá."""
    s.choose("panski-strih", "michael", MON, "12:00")  # v tejto karte je 12:00 ešte voľné
    s.fill_contact(name="Druhý Zákazník", email="druhy@example.com", phone="0900 777 888")
    push_booking(s)  # medzitým iný zákazník uloží rovnaký termín
    before = len(s.stored())
    s.submit()
    check("obsadený" in s.form_error(), "chýba hlásenie o obsadenom termíne")
    check(len(s.stored()) == before, "dvojitá rezervácia sa uložila")
    check(s.slot_states()["12:00"] == "booked", "mriežka sa má po chybe aktualizovať")
    # to isté pri ktoromkoľvek barberovi: voľný ostáva Tomáš, preto rezervácia prejde k nemu
    s.choose(barber="any", time_="12:00")
    s.submit()
    check("Tomáš Kováč" in s.confirmed(), "pri ktoromkoľvek barberovi sa termín pridelí voľnému barberovi")


@test
def t20_validacia_formulara(s):
    p = s.page
    before = len(s.stored())
    s.submit()  # prázdny formulár
    for field, text in [("service", "Vyberte službu"), ("barber", "Vyberte barbera"), ("date", "Vyberte dátum"), ("time", "Vyberte čas"),
                        ("name", "Zadajte meno"), ("email", "Zadajte e-mail"), ("phone", "Zadajte telefónne"), ("consent", "súhlas")]:
        msg = norm(p.inner_text(f"#{field}-error"))
        check(text in msg, f"chyba pre {field}: „{msg}“")
    check("Skontrolujte" in s.form_error(), "súhrnná chyba")
    for sel in ["#service", "#date", "#name", "#email", "#phone", "#consent"]:
        check(p.get_attribute(sel, "aria-invalid") == "true", f"{sel} nemá aria-invalid")
    check(p.evaluate("document.activeElement.id") == "service", "focus má ísť na prvé chybné pole")
    check(len(s.stored()) == before, "neplatný formulár sa uložil")

    # konkrétne neplatné hodnoty
    s.choose("panski-strih", "michael", MON, "11:00")
    p.fill("#name", "J")
    p.fill("#email", "nie-je-email")
    p.fill("#phone", "123")
    s.submit()
    check("príliš krátke" in p.inner_text("#name-error"), "krátke meno: " + p.inner_text("#name-error"))
    check("platný e-mail" in p.inner_text("#email-error"), "neplatný e-mail")
    check("platné telefónne" in p.inner_text("#phone-error"), "neplatný telefón")
    check(p.inner_text("#service-error").strip() == "" and p.inner_text("#time-error").strip() == "", "správne polia nemajú hlásiť chybu")
    check(len(s.stored()) == before, "neplatné údaje sa uložili")

    # opravy: chyby miznú počas písania
    p.fill("#email", "jan@example.com")
    check(p.inner_text("#email-error").strip() == "" and p.get_attribute("#email", "aria-invalid") is None, "chyba e-mailu mala zmiznúť")
    p.fill("#name", "Ján Testovací")
    p.fill("#phone", "+421 944 123 987")
    p.check("#consent")
    s.submit()
    s.confirmed()
    check(len(s.stored()) == before + 1, "po oprave sa mala rezervácia uložiť")


@test
def t21_pocitadlo_poznamky_a_limit(s):
    p = s.page
    p.fill("#note", "x" * 450)
    check(p.input_value("#note") == "x" * 300, "textarea má obmedziť poznámku na 300 znakov")
    check("300 / 300" in p.inner_text("#note-count"), "počítadlo znakov")


@test
def t22_xss_je_zablokovane(s):
    p = s.page
    s.choose("panski-strih", "michael", MON, "16:00")
    p.fill("#name", "<img src=x onerror=window.__xss=1>")
    p.fill("#email", "jan@example.com")
    p.fill("#phone", "0944 123 987")
    p.check("#consent")
    s.submit()
    check("iba písmená" in p.inner_text("#name-error"), "meno s HTML sa musí odmietnuť: " + p.inner_text("#name-error"))
    p.fill("#name", "Ján Testovací")
    p.fill("#note", "<b>tučné</b><script>window.__xss=1</script>")
    s.submit()
    s.confirmed()
    check(p.evaluate("window.__xss") is None, "skript z poznámky sa vykonal")
    check(p.locator("#confirmation b, #confirmation script").count() == 0, "HTML z poznámky sa vložilo do stránky")
    check("<b>tučné</b>" in p.inner_text("#confirmation"), "poznámka sa má zobraziť ako text")
    # ani v zozname rezervácií sa poznámka nesmie stať súčasťou stránky
    p.click("#show-my-bookings")
    p.wait_for_selector("#my-bookings-results .booking-card")
    check(p.locator("#my-bookings-results script, #my-bookings-results b").count() == 0, "HTML v zozname rezervácií")
    check(p.evaluate("window.__xss") is None, "skript sa vykonal v zozname rezervácií")


@test
def t23_najblizsi_volny_termin_v_uvode(s):
    p = s.page
    check(p.is_visible("#next-slot"), "blok najbližšieho termínu")
    check(norm(p.inner_text("#next-slot-when")) == "ZAJTRA O 9:00", p.inner_text("#next-slot-when"))
    check(norm(p.inner_text("#next-slot-detail")) == "12. októbra, Tomáš Kováč, Pánsky strih", p.inner_text("#next-slot-detail"))
    p.click("#next-slot-book")
    check(p.input_value("#service") == "panski-strih", "služba predvyplnená")
    check(p.is_checked("#barber-tomas"), "barber predvyplnený")
    check(p.input_value("#date") == MON, "dátum predvyplnený")
    check(p.is_checked("#slot-0900"), "čas predvyplnený")
    check("Tomáš Kováč" in p.inner_text("#slip-barber"), "zhrnutie")
    # po obsadení tohto termínu sa ponúkne ďalší
    s.fill_contact()
    s.submit()
    s.confirmed()
    check(norm(p.inner_text("#next-slot-when")) == "ZAJTRA O 10:00", "po rezervácii sa ponúkne ďalší voľný termín: " + p.inner_text("#next-slot-when"))
    check("Michael Nguyen" in p.inner_text("#next-slot-detail"), p.inner_text("#next-slot-detail"))


@test
def t24_predvyplnenie_z_cennika_a_barberov(s):
    p = s.page
    p.click('#services-list li[data-service-id="skin-fade"] button')
    check(p.input_value("#service") == "skin-fade", "služba z cenníka")
    p.click('#barbers-list article[data-barber-id="lukas"] button')
    # Lukáš skin fade neponúka, preto sa barber nemá predvyplniť
    check(not p.is_checked("#barber-lukas"), "Lukáš neponúka skin fade")
    p.click('#barbers-list article[data-barber-id="tomas"] button')
    check(p.is_checked("#barber-tomas"), "barber z kariet")
    p.click("#featured-service button")
    check(p.input_value("#service") == "kralovsky", "odporúčaná služba z oranžovej karty")


@test
def t25_rychla_rezervacia_v_uvode(s):
    p = s.page
    p.select_option("#quick-service", "holenie-britvou")
    check(p.eval_on_selector('#quick-barber option[value="tomas"]', "o => o.disabled"), "rýchla voľba: barber, ktorý službu neponúka, je zablokovaný")
    p.click("#quick-go")
    check(p.input_value("#service") == "holenie-britvou", "služba sa prenesie do formulára")
    check(p.is_checked("#barber-any"), "bez výberu barbera sa použije ktorýkoľvek barber")
    p.wait_for_function("() => { const r = document.querySelector('#rezervacia').getBoundingClientRect(); return r.top < 140 && r.top > -40; }", timeout=8000)
    # s konkrétnym barberom
    other = s.another()
    other.page.select_option("#quick-barber", "lukas")
    check(other.page.eval_on_selector('#quick-service option[value="skin-fade"]', "o => o.disabled"), "rýchla voľba: služba, ktorú barber neponúka, je zablokovaná")
    other.page.select_option("#quick-service", "uprava-brady")
    other.page.click("#quick-go")
    check(other.page.input_value("#service") == "uprava-brady" and other.page.is_checked("#barber-lukas"), "služba aj barber sa prenesú do formulára")


@test
def t26_automaticke_priradenie_barbera(s):
    p = s.page
    # 9:00 v pondelok: Michael je obsadený, voľný je iba Tomáš
    s.book("panski-strih", "any", MON, "09:00")
    conf = s.confirmed()
    check("Tomáš Kováč" in conf and "priradený automaticky" in conf, "9:00 má dostať Tomáš: " + conf)
    b = s.stored()[-1]
    check(b["barberId"] == "tomas" and b["barberAuto"] is True, json.dumps(b))
    # 12:00: voľní sú obaja, termín dostane ten, kto má v ten deň menej práce (Tomáš 150 min, Michael 180 min)
    p.click("#new-booking")
    s.book("panski-strih", "any", MON, "12:00", name="Druhý Zákazník", email="druhy@example.com", phone="0900 777 888")
    check("Tomáš Kováč" in s.confirmed(), "12:00 má dostať menej vyťažený barber")
    # 12:30: Tomáš má už 180 min, rovnako ako Michael; pri zhode rozhoduje poradie v tíme
    p.click("#new-booking")
    s.book("panski-strih", "any", MON, "12:30", name="Tretí Zákazník", email="treti@example.com", phone="0900 777 999")
    check("Michael Nguyen" in s.confirmed(), "pri rovnakej vyťaženosti rozhoduje poradie v tíme")
    check([b["barberId"] for b in s.stored()[-3:]] == ["tomas", "tomas", "michael"], "uložené priradenia")
    # v mojich rezerváciách je už konkrétny barber
    p.click("#show-my-bookings")
    p.wait_for_selector("#my-bookings-results .booking-card")
    check("Barber: Michael Nguyen" in s.cards()[0]["text"], s.cards()[0]["text"])


@test
def t27_limit_rezervacii_na_zakaznika(s):
    p = s.page
    demo = dict(name="Demo Zákazník", email="demo@example.com", phone="0900 123 456")
    # ukážkový zákazník má 2 nadchádzajúce rezervácie; tretia ešte prejde
    s.book("panski-strih", "tomas", "2026-10-15", "10:00", **demo)
    s.confirmed()
    before = len(s.stored())
    p.click("#new-booking")
    s.book("panski-strih", "tomas", "2026-10-16", "10:00", **demo)
    check("najvyšší počet nadchádzajúcich rezervácií (3)" in s.form_error(), "limit: " + s.form_error())
    check(len(s.stored()) == before, "štvrtá rezervácia sa uložila")
    check(p.is_hidden("#confirmation"), "potvrdenie sa nemá zobraziť")
    # limit sa viaže na kontakt: rovnaký telefón s iným e-mailom tiež neprejde
    p.fill("#email", "iny@example.com")
    s.submit()
    check("najvyšší počet" in s.form_error() and len(s.stored()) == before, "limit podľa telefónu")
    # po zrušení jednej rezervácie je miesto opäť voľné
    s.lookup("demo@example.com")
    p.locator('.booking-card[data-status="confirmed"]').first.locator('[data-action="cancel"]').click()
    p.locator('[data-action="confirm-cancel"]').click()
    p.fill("#email", "demo@example.com")
    s.choose(time_="10:00")
    p.check("#consent")
    s.submit()
    s.confirmed()
    check(len(s.stored()) == before + 1, "po zrušení sa dá rezervovať znova")


@test
def t28_pasca_na_roboty(s):
    p = s.page
    trap = p.locator("#website")
    wrap = p.locator("div.visually-hidden:has(#website)")
    check(wrap.bounding_box()["width"] <= 1 and wrap.evaluate("e => getComputedStyle(e).overflow") == "hidden", "skryté pole nesmie byť viditeľné")
    check(trap.get_attribute("tabindex") == "-1", "skryté pole nie je v poradí klávesu Tab")
    check(p.evaluate("document.querySelector('#website').closest('[aria-hidden=true]') !== null"), "skryté pole je skryté aj pre čítačky")
    before = len(s.stored())
    s.choose("panski-strih", "michael", MON, "11:00")
    s.fill_contact()
    p.evaluate("document.querySelector('#website').value = 'http://spam.example'")  # robot vyplní všetko
    s.submit()
    check("nepodarilo odoslať" in s.form_error(), "hlásenie: " + s.form_error())
    check(len(s.stored()) == before and p.is_hidden("#confirmation"), "rezervácia od robota sa uložila")
    p.evaluate("document.querySelector('#website').value = ''")
    s.submit()
    s.confirmed()
    check(len(s.stored()) == before + 1, "bez vyplneného skrytého poľa rezervácia prejde")


# --------------------------------------------------------------------------
# Testy: moje rezervácie
# --------------------------------------------------------------------------
@test
def t29_zobrazenie_rezervacii_podla_emailu_a_telefonu(s):
    p = s.page
    for query in ["demo@example.com", "  DEMO@Example.com ", "0900 123 456", "+421900123456", "00421900123456", "900123456"]:
        s.lookup(query)
        statuses = sorted(c["status"] for c in s.cards())
        check(statuses == ["cancelled", "completed", "confirmed", "confirmed"], f"{query!r}: {statuses}")
    s.lookup("demo@example.com")
    texts = {c["id"]: c["text"] for c in s.cards()}
    check(set(texts) == {"BS-DEMO05", "BS-DEMO22", "BS-DEMO90", "BS-DEMO91"}, f"rezervácie ukážkového zákazníka: {sorted(texts)}")
    upcoming = [c for c in s.cards() if c["status"] == "confirmed"]
    check([c["id"] for c in upcoming] == ["BS-DEMO05", "BS-DEMO22"], "nadchádzajúce sú zoradené od najbližšej")
    for c in upcoming:
        t = norm(c["text"])
        check(re.search(r"(Strih, umytie a styling|Klasické holenie britvou)", t), "služba: " + t)
        check(re.search(r"Barber: (Michael Nguyen|Lukáš Novák)", t), "barber: " + t)
        check(re.search(r"\d{1,2}\. októbra 2026", t), "dátum: " + t)
        check(re.search(r"\d{1,2}:\d{2} – \d{1,2}:\d{2}", t), "čas: " + t)
        check(re.search(r"\d+ €", t), "cena: " + t)
        check("Potvrdená" in t and "Zrušiť rezerváciu" in t and "Zmeniť termín" in t, "stav a tlačidlá: " + t)
    for needle in ("Zrušená", "Uskutočnená"):
        check(any(needle in t and "Zrušiť rezerváciu" not in t and "Zmeniť termín" not in t for t in texts.values()),
              f"rezervácia v stave {needle} nemá mať tlačidlá")
    results = norm(p.inner_text("#my-bookings-results")).lower()
    check("nadchádzajúce rezervácie (2)" in results and "história (2)" in results, "nadpisy skupín: " + results[:80])

    # odkaz s ukážkovým účtom
    p.fill("#lookup-input", "")
    p.click("#use-demo")
    p.wait_for_selector("#my-bookings-results .booking-card")
    check(len(s.cards()) == 4 and p.input_value("#lookup-input") == "demo@example.com", "odkaz s ukážkovým účtom nezobrazil rezervácie")


@test
def t30_vyhladavanie_bez_vysledku_a_neplatny_vstup(s):
    p = s.page
    s.lookup("nikto@example.com")
    check(p.locator("#my-bookings-results [data-empty]").count() == 1, "chýba hlásenie o prázdnom výsledku")
    check(len(s.cards()) == 0, "nemali by byť žiadne karty")
    s.lookup("")
    check("Zadajte e-mail alebo telefónne" in p.inner_text("#lookup-error"), "prázdny vstup: " + p.inner_text("#lookup-error"))
    s.lookup("abc")
    check("platný e-mail" in p.inner_text("#lookup-error"), "neplatný vstup")
    check(p.get_attribute("#lookup-input", "aria-invalid") == "true", "aria-invalid")
    check(len(s.cards()) == 0, "pri chybe sa nemá nič zobraziť")
    s.lookup("demo@example.com")
    check(p.inner_text("#lookup-error").strip() == "" and p.get_attribute("#lookup-input", "aria-invalid") is None, "po oprave chyba zmizne")


@test
def t31_nova_rezervacia_sa_zobrazi_v_mojich_rezervaciach(s):
    p = s.page
    s.book("strih-brada", "lukas", "2026-10-14", "17:00", name="Peter Nový", email="peter.novy@example.com", phone="0911 000 111")
    s.confirmed()
    p.click("#show-my-bookings")
    p.wait_for_selector("#my-bookings-results .booking-card")
    cards = s.cards()
    check(len(cards) == 1 and cards[0]["status"] == "confirmed", f"{cards}")
    t = norm(cards[0]["text"])
    check("Strih a brada" in t and "Lukáš Novák" in t and "Streda 14. októbra 2026" in t and "17:00 – 18:00" in t and "32 €" in t, t)
    # rovnaká rezervácia sa nájde aj podľa telefónu
    s.lookup("+421 911 000 111")
    check(len(s.cards()) == 1, "vyhľadanie podľa telefónu")


@test
def t32_zrusenie_uvolni_termin(s):
    p = s.page
    # 1) Ukážkový zákazník má v utorok 13. 10. o 11:00 Strih, umytie a styling u Michaela (45 min)
    s.choose("strih-styling", "michael", TUE)
    check(s.slot_states()["11:00"] == "booked" and s.slot_states()["11:30"] == "booked", "príprava: termín má byť obsadený")
    check(s.slot_disabled("11:00"), "príprava: obsadený slot je zablokovaný")
    before = [b for b in s.stored() if b["status"] == "confirmed"]

    # 2) nájdeme rezerváciu a zrušíme ju (s potvrdením)
    s.lookup("demo@example.com")
    card = p.locator('.booking-card[data-id="BS-DEMO05"]')
    check(card.count() == 1, "karta rezervácie sa nenašla")
    card.locator('[data-action="cancel"]').click()
    check("Naozaj chcete zrušiť" in card.inner_text(), "chýba potvrdenie zrušenia")
    check(card.locator(".code-field").count() == 0, "v ukážkovom režime sa kód rezervácie nevyžaduje")
    card.locator('[data-action="keep"]').click()
    check(card.locator('[data-action="cancel"]').count() == 1, "„Ponechať“ má vrátiť pôvodné tlačidlo")
    check(len([b for b in s.stored() if b["status"] == "confirmed"]) == len(before), "„Ponechať“ nesmie nič zrušiť")
    card.locator('[data-action="cancel"]').click()
    card.locator('[data-action="confirm-cancel"]').click()

    # 3) rezervácia je zrušená
    cancelled = p.locator('.booking-card[data-id="BS-DEMO05"][data-status="cancelled"]')
    check(cancelled.count() == 1, "zrušená rezervácia sa nezobrazila v histórii")
    check("Zrušená" in cancelled.inner_text() and cancelled.locator("[data-action]").count() == 0, "stav / tlačidlá po zrušení")
    check("Rezervácia bola zrušená" in s.toast(), "chýba oznámenie")
    check(len([b for b in s.stored() if b["status"] == "confirmed"]) == len(before) - 1, "v úložisku sa má zrušiť presne jedna rezervácia")
    check(sum(1 for b in s.stored() if b["status"] == "cancelled") == 2, "úložisko: zrušené rezervácie")

    # 4) termín je opäť voľný v rezervačnom formulári (bez obnovenia stránky)
    check(s.slot_states()["11:00"] == "available" and s.slot_states()["11:30"] == "available", "po zrušení sa termín neuvoľnil")
    check(not s.slot_disabled("11:00"), "uvoľnený slot sa dá vybrať")
    check("nadchádzajúce rezervácie (1)" in norm(p.inner_text("#my-bookings-results")).lower(), "počet nadchádzajúcich")
    # po obnovení stránky ostáva stav zachovaný
    p.reload()
    p.wait_for_selector("#services-list li")
    s.choose("strih-styling", "michael", TUE)
    check(s.slot_states()["11:00"] == "available", "po obnovení stránky má byť termín stále voľný")


@test
def t33_zruseny_termin_sa_da_znova_rezervovat(s):
    p = s.page
    s.lookup("demo@example.com")
    p.locator('.booking-card[data-id="BS-DEMO05"] [data-action="cancel"]').click()
    p.locator('[data-action="confirm-cancel"]').click()
    s.choose("strih-styling", "michael", TUE, "11:00")
    s.fill_contact(name="Iný Zákazník", email="iny@example.com", phone="0905 000 222")
    s.submit()
    check("11:00 – 11:45" in s.confirmed(), "nový zákazník dostal uvoľnený termín")
    # a teraz je termín znova obsadený
    p.click("#new-booking")
    s.choose("strih-styling", "michael", TUE)
    check(s.slot_states()["11:00"] == "booked", "termín má byť opäť obsadený")


@test
def t34_cudziu_rezervaciu_nemozno_zrusit_ani_presunut(s):
    p = s.page
    # pokus o zrušenie a presun cudzej rezervácie priamo cez službu (obchádza používateľské rozhranie)
    result = p.evaluate("() => BookingStorage.createBookingService().cancel('BS-DEMO05', 'cudzi@example.com')")
    check(result["ok"] is False and result["code"] == "FORBIDDEN", f"{result}")
    result = p.evaluate("() => BookingStorage.createBookingService().reschedule('BS-DEMO05', 'cudzi@example.com', {date: '2026-10-15', time: '10:00'})")
    check(result["ok"] is False and result["code"] == "FORBIDDEN", f"{result}")
    b = next(b for b in s.stored() if b["id"] == "BS-DEMO05")
    check((b["status"], b["date"], b["time"]) == ("confirmed", TUE, "11:00"), "cudzia rezervácia sa nesmie zmeniť")
    # cudzí kontakt rezerváciu ani neuvidí
    s.lookup("cudzi@example.com")
    check(len(s.cards()) == 0, "cudzí kontakt nevidí rezervácie iných")


@test
def t35_presun_terminu(s):
    p = s.page
    s.lookup("demo@example.com")
    card = p.locator('.booking-card[data-id="BS-DEMO05"]')  # utorok 13. 10. o 11:00, Michael, 45 min
    card.locator('[data-action="reschedule"]').click()
    panel = card.locator(".reschedule")
    check("Nový termín: Strih, umytie a styling, Michael Nguyen" in norm(panel.inner_text()), "nadpis panela: " + norm(panel.inner_text())[:80])
    check(panel.locator(".day").count() == 14, "panel ponúka 14 dní")
    check("Vyberte nový dátum" in panel.inner_text(), "pokyn pred výberom dátumu")
    panel.locator('[data-action="confirm-reschedule"]').click()
    check("Vyberte nový dátum a čas" in panel.locator(".panel-error").inner_text(), "potvrdenie bez výberu")

    # ten istý deň: pôvodný čas sa neponúka, vlastná rezervácia neblokuje okolité časy
    panel.locator(f'.day[data-date="{TUE}"]').click()
    st = s.slot_states(".reschedule")
    check(st["11:00"] == "unavailable", f"pôvodný čas sa nemá ponúkať ako nový: {st['11:00']}")
    check(st["11:30"] == "available" and st["10:30"] == "available", "okolité časy blokovala iba vlastná rezervácia")
    check(st["09:00"] == "booked" and st["16:30"] == "booked", "cudzie rezervácie ostávajú obsadené")

    # iný deň
    panel.locator('.day[data-date="2026-10-15"]').click()
    check("Štvrtok 15. októbra 2026, voľných termínov: 19" in norm(panel.inner_text()), norm(panel.inner_text())[-200:])
    panel.locator('label.slot[for="resched-BSDEMO05-1000"]').click()
    panel.locator('[data-action="confirm-reschedule"]').click()
    p.wait_for_selector('.booking-card[data-id="BS-DEMO05"] [data-action="reschedule"]')

    check(s.toast() == "Termín je presunutý: 15. októbra o 10:00.", "oznámenie: " + s.toast())
    t = norm(p.locator('.booking-card[data-id="BS-DEMO05"]').inner_text())
    check("Štvrtok 15. októbra 2026" in t and "10:00 – 10:45" in t and "Potvrdená" in t, "karta po presune: " + t)
    b = next(b for b in s.stored() if b["id"] == "BS-DEMO05")
    check((b["date"], b["time"], b["endTime"], b["status"]) == ("2026-10-15", "10:00", "10:45", "confirmed"), json.dumps(b))
    check(len(s.stored()) == 25, "presun nesmie vytvoriť novú rezerváciu")
    check([c["id"] for c in s.cards() if c["status"] == "confirmed"] == ["BS-DEMO22", "BS-DEMO05"], "po presune sa karty zoradia podľa dátumu")

    # pôvodný termín je voľný, nový obsadený
    s.choose("strih-styling", "michael", TUE)
    check(s.slot_states()["11:00"] == "available", "pôvodný termín sa mal uvoľniť")
    s.choose(date="2026-10-15")
    st = s.slot_states()
    check(st["10:00"] == "booked" and st["10:30"] == "booked" and st["11:00"] == "available", f"nový termín má byť obsadený: {st['10:00']}, {st['10:30']}")


@test
def t36_presun_iba_na_volny_termin(s):
    p = s.page
    s.lookup("demo@example.com")
    card = p.locator('.booking-card[data-id="BS-DEMO05"]')
    card.locator('[data-action="reschedule"]').click()
    card.locator(f'.reschedule .day[data-date="{TUE}"]').click()
    check(p.is_disabled("#resched-BSDEMO05-0900"), "obsadený čas sa v paneli nedá vybrať")
    check(p.is_disabled("#resched-BSDEMO05-1100"), "pôvodný čas sa v paneli nedá vybrať")
    # „Späť“ vráti tlačidlá a nič nezmení
    card.locator('[data-action="back"]').click()
    check(card.locator('[data-action="reschedule"]').count() == 1 and card.locator(".reschedule").count() == 0, "„Späť“ zatvorí panel")
    # priame volanie služby: obsadený čas, rovnaký čas, minulosť, nedeľa, čas po zatvorení
    call = "(change) => BookingStorage.createBookingService().reschedule('BS-DEMO05', 'demo@example.com', change)"
    for change, code in [({"date": TUE, "time": "09:00"}, "SLOT_TAKEN"), ({"date": TUE, "time": "11:00"}, "SAME_TIME"),
                         ({"date": "2026-10-10", "time": "10:00"}, "INVALID_DATE"), ({"date": "2026-10-18", "time": "10:00"}, "INVALID_DATE"),
                         ({"date": "2026-10-17", "time": "13:30"}, "OUTSIDE_HOURS"), ({"date": TUE, "time": "10:07"}, "INVALID_TIME")]:
        result = p.evaluate(call, change)
        check(result["ok"] is False and result["code"] == code, f"{change}: {result.get('code')} namiesto {code}")
    b = next(b for b in s.stored() if b["id"] == "BS-DEMO05")
    check((b["date"], b["time"]) == (TUE, "11:00"), "neúspešný presun nesmie rezerváciu zmeniť")
    # zrušená ani uskutočnená rezervácia sa presunúť nedá
    for booking_id, code in [("BS-DEMO91", "ALREADY_CANCELLED"), ("BS-DEMO90", "PAST")]:
        result = p.evaluate(
            "(id) => BookingStorage.createBookingService().reschedule(id, 'demo@example.com', {date: '2026-10-15', time: '10:00'})", booking_id
        )
        check(result["ok"] is False and result["code"] == code, f"{booking_id}: {result}")


@test
def t37_data_preziju_obnovenie_stranky_a_daju_sa_obnovit(s):
    p = s.page
    s.book("uprava-brady", "lukas", "2026-10-15", "10:00", name="Trvalý Zákazník", email="trvaly@example.com", phone="0902 222 333")
    s.confirmed()
    p.reload()
    p.wait_for_selector("#services-list li")
    s.lookup("trvaly@example.com")
    check(len(s.cards()) == 1, "rezervácia sa po obnovení stránky stratila")
    # obnovenie ukážkových dát s potvrdením priamo na stránke
    p.click("#reset-demo")
    check(p.is_visible("#reset-confirm"), "pred obnovením sa stránka pýta na potvrdenie")
    p.click("#reset-no")
    check(not p.is_visible("#reset-confirm") and len(s.stored()) == 26, "„Nie“ nič neobnoví")
    p.click("#reset-demo")
    p.click("#reset-yes")
    check("Demo dáta boli obnovené" in s.toast(), "oznámenie po obnovení")
    s.lookup("trvaly@example.com")
    check(len(s.cards()) == 0, "po obnovení má rezervácia zmiznúť")
    s.lookup("demo@example.com")
    check(len(s.cards()) == 4 and len(s.stored()) == 25, "po obnovení sa majú vrátiť ukážkové dáta")


@test
def t38_zmena_v_inej_karte_sa_prejavi_hned(s):
    """Dve karty toho istého prehliadača zdieľajú úložisko: zmena v jednej sa prejaví v druhej bez obnovenia."""
    p = s.page
    second = s.ctx.new_page()
    second.clock.set_fixed_time(FIXED_NOW)
    second.goto(URL)
    second.wait_for_selector("#services-list li")
    s.choose("panski-strih", "michael", MON)
    check(s.slot_states()["12:00"] == "available", "príprava: 12:00 je voľné")
    # druhá karta vytvorí rezerváciu na 12:00
    second.select_option("#service", "panski-strih")
    second.click("label.barber-choice:has(#barber-michael)")
    second.fill("#date", MON)
    second.click('label.slot[for="slot-1200"]')
    second.fill("#name", "Druhá Karta")
    second.fill("#email", "druha@example.com")
    second.fill("#phone", "0900 444 555")
    second.check("#consent")
    second.click("#submit-booking")
    second.wait_for_selector("#confirmation:not([hidden])")
    # prvá karta to vidí bez obnovenia stránky
    p.wait_for_function("() => document.querySelector('label.slot[for=\"slot-1200\"]').dataset.state === 'booked'", timeout=5000)
    check(s.slot_disabled("12:00"), "termín obsadený v inej karte sa už nedá vybrať")
    second.close()


@test
def t39_pridanie_do_kalendara_a_email_salonu(s):
    p = s.page
    s.book("panski-strih", "michael", MON, "11:00")
    s.confirmed()
    href = urllib.parse.unquote(p.get_attribute("#add-to-calendar", "href"))
    check("calendar.google.com" in href, href)
    check("dates=20261012T110000/20261012T113000" in href and "ctz=Europe/Bratislava" in href, href)
    check(p.get_attribute("#add-to-calendar", "target") == "_blank", "odkaz sa má otvoriť v novej karte")
    check("noopener" in p.get_attribute("#add-to-calendar", "rel"), "odkaz do novej karty má mať rel=noopener")
    mail = urllib.parse.unquote(p.get_attribute("#mail-booking", "href"))
    check(mail.startswith("mailto:barbershopmn17@gmail.com?"), mail)
    check("Michael Nguyen" in mail and "11:00 – 11:30" in mail and "Telefón: +421 944 123 987" in mail, mail)


# --------------------------------------------------------------------------
# Testy: responzivita a prístupnosť
# --------------------------------------------------------------------------
@test
def t40_responzivita_bez_horizontalneho_posuvu(s):
    p = s.page
    s.choose("strih-brada", "michael", MON, "11:00")
    s.lookup("demo@example.com")
    p.locator('.booking-card[data-id="BS-DEMO05"] [data-action="reschedule"]').click()
    p.locator(f'.booking-card[data-id="BS-DEMO05"] .day[data-date="{TUE}"]').click()
    for width, height in [(320, 640), (360, 740), (390, 844), (768, 1024), (820, 1180), (1024, 768), (1280, 800), (1920, 1080)]:
        p.set_viewport_size({"width": width, "height": height})
        p.wait_for_timeout(80)
        overflow = p.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check(overflow <= 0, f"{width}px: horizontálny posun {overflow}px")
        wide = p.evaluate(
            """() => [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect();
                return r.width > 0 && r.right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed'
                  && !e.closest('.hero-bg, .hero-scene, .marquee, .days, .map-wrap, .nav-toggle-bars, #site-nav:not(.is-open), .visually-hidden, .skip-link, .toast, .slot input, .barber-choice input, dialog:not([open])'); })
                .slice(0, 3).map(e => e.tagName + '.' + e.className)"""
        )
        check(not wide, f"{width}px: prvky mimo obrazovky {wide}")
        # vodorovné pásy sa posúvajú vo vlastnom kontajneri, nie spolu so stránkou
        check(p.evaluate("getComputedStyle(document.querySelector('#date-chips')).overflowX") == "auto", "pás dní má vlastný posun")
        toggle = p.is_visible(".nav-toggle")
        check(toggle == (width <= 1024), f"{width}px: hamburger má byť {'viditeľný' if width <= 1024 else 'skrytý'}")
        check(p.is_visible('a.btn:has-text("Rezervovať termín")') or toggle, f"{width}px: tlačidlo rezervácie v hlavičke")


@test
def t41_rozlozenie_rezervacie_desktop_vs_mobil(s):
    p = s.page

    def box(sel):
        return p.locator(sel).bounding_box()

    s.choose("panski-strih", "michael", MON, "11:00")
    p.set_viewport_size({"width": 1280, "height": 900})
    form, slip = box("#booking-form"), box("#slip")
    check(slip["x"] > form["x"] + form["width"] - 5, "desktop: zhrnutie má byť vedľa formulára")
    check(not p.is_visible("#submit-summary"), "desktop: krátke zhrnutie nad tlačidlom je skryté (zastupuje ho lístok)")

    p.set_viewport_size({"width": 390, "height": 844})
    check(not p.is_visible("#slip"), "mobil: lístok vedľa formulára sa nezobrazuje")
    summary, submit = box("#submit-summary"), box("#submit-booking")
    check(summary is not None and summary["y"] + summary["height"] <= submit["y"] + 1, "mobil: zhrnutie je tesne nad tlačidlom")
    text = norm(p.inner_text("#submit-summary"))
    for needle in ["Pánsky strih", "Michael Nguyen", "Pondelok 12. októbra 2026, 11:00 – 11:30", "18 €"]:
        check(needle in text, f"mobilné zhrnutie neobsahuje „{needle}“: {text}")
    s.choose(barber="tomas")  # zmena barbera zruší vybraný čas, ak u neho nie je voľný
    check(p.is_visible("#submit-summary") == (p.evaluate("!!document.querySelector('input[name=time]:checked')")), "zhrnutie sa zobrazuje len pri úplnom výbere")

    # služby: na desktope je odporúčaná služba vedľa cenníka, na mobile nad ním
    def side_by_side():
        f, m = box("#featured-service"), box("#services-list")
        return m["x"] > f["x"] + f["width"] - 5

    check(not side_by_side(), "mobil: odporúčaná služba má byť nad cenníkom")
    p.set_viewport_size({"width": 1280, "height": 900})
    check(side_by_side(), "desktop: odporúčaná služba má byť vedľa cenníka")
    cols = lambda sel: p.evaluate("(sel) => getComputedStyle(document.querySelector(sel)).gridTemplateColumns.split(' ').length", sel)
    check(cols("#barbers-list") == 3 and cols("#barber-choices") == 2 and cols("#faq-list") == 2, "desktop: počty stĺpcov")
    p.set_viewport_size({"width": 820, "height": 1100})
    check(cols("#barbers-list") == 2, f"tablet: barberi v {cols('#barbers-list')} stĺpcoch")
    p.set_viewport_size({"width": 390, "height": 844})
    check(cols("#barbers-list") == 1 and cols("#barber-choices") == 1 and cols("#faq-list") == 1, "mobil: všetko v jednom stĺpci")


@test
def t42_dotykove_ciele_a_pisma_na_mobile(s):
    p = s.page
    p.set_viewport_size({"width": 390, "height": 844})
    s.choose("panski-strih", "michael", MON)
    s.lookup("demo@example.com")
    small = p.evaluate(
        """() => [...document.querySelectorAll('button:not(.link-button), .btn, select, input[type=text], input[type=email], input[type=tel], input[type=date], .slot-body, .chip, .barber-choice-body')]
            .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40 && !e.closest('.visually-hidden'); })
            .map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().height))"""
    )
    check(not small, f"príliš malé dotykové prvky: {small}")
    fs = p.evaluate(
        "() => ['#name','#email','#phone','#note','#service','#date','#lookup-input','#quick-service'].map(s => parseFloat(getComputedStyle(document.querySelector(s)).fontSize))"
    )
    check(all(f >= 16 for f in fs), f"písmo polí je menšie ako 16 px (iOS by priblížil stránku): {fs}")


@test
def t43_pristupnost_formulara(s):
    p = s.page
    unlabeled = p.evaluate(
        """() => [...document.querySelectorAll('#booking-form input, #booking-form select, #booking-form textarea, #lookup-form input, .quick select')]
            .filter(c => !(c.labels && c.labels.length) && !c.getAttribute('aria-label')).map(c => c.id || c.name)"""
    )
    check(not unlabeled, f"polia bez popisku: {unlabeled}")
    check(p.get_attribute("html", "lang") == "sk", "lang=sk")
    check(p.locator("h1").count() == 1, "stránka má mať jeden h1")
    # nadpisy idú po úrovniach bez preskakovania
    levels = p.evaluate("[...document.querySelectorAll('main h1, main h2, main h3, main h4')].filter(h => h.offsetParent !== null).map(h => +h.tagName[1])")
    jumps = [(a, b) for a, b in zip(levels, levels[1:]) if b > a + 1]
    check(not jumps, f"preskočené úrovne nadpisov: {jumps}")
    # tlačidlá s rovnakým textom majú rozlišujúci popis
    labels = p.evaluate("[...document.querySelectorAll('#services-list button')].map(b => b.getAttribute('aria-label'))")
    check(len(set(labels)) == 10 and all(l.startswith("Rezervovať službu ") for l in labels), "tlačidlá v cenníku majú vlastné popisy")
    # dekoratívne obrázky sú pred čítačkami skryté
    check(p.evaluate("[...document.querySelectorAll('svg')].every(svg => svg.getAttribute('aria-hidden') === 'true' || svg.closest('[aria-hidden=true]') || svg.getAttribute('role') === 'img')"), "SVG bez aria-hidden")
    s.choose("panski-strih", "michael", MON)
    no_name = p.evaluate("""() => [...document.querySelectorAll('#time-slots input')].filter(i => !i.labels.length).length""")
    check(no_name == 0, "sloty bez popisku")
    # obsadené sloty majú textovú alternatívu (nielen farbu)
    check("obsadené" in p.locator("label.slot.is-booked").first.text_content().lower(), "obsadený slot bez textu pre čítačky")
    # hlásenia sa oznamujú čítačkám
    check(p.get_attribute("#slots-message", "aria-live") == "polite" and p.get_attribute("#toast", "role") == "status", "živé oblasti")
    check(p.get_attribute("#form-error", "role") == "alert", "chyba formulára má role=alert")
    # odkaz na preskočenie je prvý prvok po Tab
    p.reload()
    p.wait_for_selector("#services-list li")
    p.keyboard.press("Tab")
    check(p.evaluate("document.activeElement.className") == "skip-link", "prvý Tab má ísť na odkaz „Preskočiť na obsah“")
    outline = p.evaluate("getComputedStyle(document.activeElement).outlineStyle")
    check(outline != "none", "focus musí byť viditeľný")


@test
def t44_kontrast_textu(s):
    """Text na všetkých farebných plochách spĺňa kontrast WCAG AA (4,5:1 pre bežný text, 3:1 pre veľký)."""
    p = s.page
    s.choose("panski-strih", "michael", MON, "11:00")
    s.lookup("demo@example.com")
    failures = p.evaluate(
        """() => {
          const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
            const v = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
          const lum = ({ r, g, b }) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
          const background = (el) => { const layers = []; let hasImage = false;
            for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e);
              if (cs.backgroundImage !== 'none' && e !== document.body) hasImage = true;
              const c = parse(cs.backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; } }
            if (hasImage) return null; // prechody a obrázky sa posudzujú zvlášť
            let bg = { r: 255, g: 255, b: 255, a: 1 }; layers.reverse().forEach((l) => { bg = over(l, bg); }); return bg; };
          const out = [];
          const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
          const seen = new Set();
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement; if (!n.textContent.trim() || seen.has(el)) continue; seen.add(el);
            if (!el.offsetParent || el.closest('.visually-hidden, [aria-hidden=true], .hero, .marquee, .is-booked, .is-off, [hidden], .is-cancelled, .is-completed')) continue;
            if (el.closest('label') && el.closest('label').querySelector('input:disabled')) continue;
            if (el.matches('option')) continue;
            const cs = getComputedStyle(el); const fg = parse(cs.color); const bg = background(el); if (!fg || !bg) continue;
            const color = over(fg, bg); const l1 = lum(color), l2 = lum(bg);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const size = parseFloat(cs.fontSize); const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
            if (ratio < (large ? 3 : 4.5)) out.push(n.textContent.trim().slice(0, 30) + ' ' + ratio.toFixed(2) + ' (' + el.tagName + '.' + el.className + ')');
          }
          return out.slice(0, 8);
        }"""
    )
    check(not failures, f"nízky kontrast: {failures}")


@test
def t45_klavesnicove_ovladanie_rezervacie(s):
    p = s.page
    s.choose("panski-strih", "michael", MON)
    p.focus("#slot-1100")
    p.keyboard.press("Space")
    check(p.is_checked("#slot-1100"), "slot sa dá vybrať medzerníkom")
    p.keyboard.press("ArrowRight")
    check(p.is_checked("#slot-1130"), "šípky prepínajú medzi voľnými slotmi")
    # šípka nepreskočí na obsadený slot: z 10:00 doľava je 9:30 (obsadený), preto zostane 10:00
    p.focus("#slot-1000")
    p.keyboard.press("Space")
    p.keyboard.press("ArrowLeft")
    check(p.evaluate("document.querySelector('input[name=time]:checked').value") != "09:30", "šípky nesmú vybrať obsadený slot")
    # deň sa dá vybrať klávesom Enter, barber medzerníkom
    p.focus(f'.day[data-date="{TUE}"]')
    p.keyboard.press("Enter")
    check(p.input_value("#date") == TUE, "deň sa dá vybrať klávesnicou")
    p.focus("#barber-tomas")
    p.keyboard.press("Space")
    check(p.is_checked("#barber-tomas"), "barber sa dá vybrať klávesnicou")
    # celý formulár sa dá odoslať klávesom Enter z textového poľa
    s.choose(time_="10:00")
    s.fill_contact()
    p.focus("#name")
    p.keyboard.press("Enter")
    s.confirmed()


@test
def t46_pisma_su_sucastou_stranky_a_nic_sa_nenacitava_zvonka(s):
    p = s.page
    p.evaluate("document.fonts.ready")
    check(p.evaluate("document.fonts.check('700 40px \"Heros Cn\"')"), "nadpisové písmo Heros Cn nie je načítané")
    check(p.evaluate("document.fonts.check('400 16px Inter') && document.fonts.check('700 16px Inter')"), "písmo Inter nie je načítané")
    loaded = p.evaluate("[...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/\"/g, '') + ' ' + f.weight)")
    check("Heros Cn 700" in loaded and "Inter 400" in loaded, f"načítané rezy písma: {loaded}")
    check(p.evaluate("getComputedStyle(document.querySelector('h1')).fontFamily").replace('"', "").startswith("Heros Cn"), "nadpisy používajú Heros Cn")
    check(p.evaluate("getComputedStyle(document.body).fontFamily").replace('"', "").startswith("Inter"), "text používa Inter")
    # slovenské znaky sú v písme (nevykreslia sa náhradným písmom)
    widths = p.evaluate(
        """() => { const c = document.createElement('canvas').getContext('2d'); const t = 'ľščťžýáíéúäôňďĺŕ ĽŠČŤŽÝÁÍÉÚÄÔŇĎĹŔ €';
            c.font = '700 40px "Heros Cn", monospace'; const a = c.measureText(t).width;
            c.font = '700 40px monospace'; return [a, c.measureText(t).width]; }"""
    )
    check(abs(widths[0] - widths[1]) > 5, f"slovenské znaky sa nekreslia písmom Heros Cn: {widths}")
    # počas bežného používania stránka nikam neposiela požiadavky
    s.book("panski-strih", "michael", MON, "11:00")
    s.confirmed()
    p.click("#show-my-bookings")
    p.wait_for_selector("#my-bookings-results .booking-card")
    check(not s.external_requests(), f"stránka načítava cudzie zdroje: {s.external_requests()[:3]}")
    check(p.locator('link[href^="http"], script[src^="http"], img[src^="http"]').count() == 0, "odkazy na cudzie zdroje v HTML")


@test
def t47_obmedzeny_pohyb(s):
    quiet = s.another(reduced_motion="reduce")
    p = quiet.page
    check(p.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), "príprava: nastavenie obmedzeného pohybu")
    check(p.evaluate("getComputedStyle(document.querySelector('.marquee-track')).animationName") == "none", "bežiaci pás sa pri obmedzenom pohybe nehýbe")
    check(p.evaluate("getComputedStyle(document.documentElement).scrollBehavior") == "auto", "plynulé posúvanie je vypnuté")
    # bez obmedzenia pás beží
    check(s.page.evaluate("getComputedStyle(document.querySelector('.marquee-track')).animationName") != "none", "bežiaci pás má animáciu")


@test
def t48_ziadne_chyby_v_konzole(s):
    p = s.page
    s.book("panski-strih", "any", MON, "11:00")
    s.confirmed()
    p.click("#new-booking")
    s.lookup("demo@example.com")
    p.locator('.booking-card[data-id="BS-DEMO05"] [data-action="reschedule"]').click()
    p.locator('.booking-card[data-id="BS-DEMO05"] [data-action="back"]').click()
    p.locator("footer [data-open-privacy]").click()
    p.click("#privacy-close")
    p.click('.tab[data-category="brada"]')
    p.set_viewport_size({"width": 390, "height": 844})
    p.click(".nav-toggle")
    check(not s.errors, f"chyby v konzole: {s.errors}")


# --------------------------------------------------------------------------
# Testy: ostrý režim (server)
# --------------------------------------------------------------------------
@remote
def r01_rezervacia_sa_zapise_do_tabulky_a_odidu_emaily(s, backend):
    p = s.page
    check("rezervačný systém prevádzky" in p.inner_text("#footer-mode"), "pätička v ostrom režime: " + p.inner_text("#footer-mode"))
    check(p.locator("#reset-demo").count() == 0 and p.locator("#use-demo").count() == 0, "ukážkové ovládanie sa v ostrom režime nezobrazuje")
    check("kód z potvrdzovacieho e-mailu" in p.inner_text("#lookup-hint"), p.inner_text("#lookup-hint"))
    check(not p.is_visible("#system-notice"), "pri dostupnom serveri sa oznam nezobrazuje")
    check(norm(p.inner_text("#next-slot-when")) == "ZAJTRA O 9:00", "najbližší termín z údajov servera")

    s.choose("panski-strih", "michael", MON)
    check(all(st == "available" for st in s.slot_states().values()), "prázdna tabuľka = všetky termíny voľné")
    s.choose(time_="10:00")
    s.fill_contact(note="Prosím kratšie po bokoch")
    s.submit()
    conf = s.confirmed()
    check("Potvrdenie sme poslali na jan@example.com" in conf, "informácia o e-maile: " + conf[:200])
    check("kód rezervácie" in conf.lower() and re.fullmatch(r"BS-[A-Z0-9]{6}", s.code()), "kód rezervácie: " + s.code())
    check(p.locator("#mail-booking").count() == 0, "ručné poslanie e-mailu sa v ostrom režime neponúka")
    check(p.evaluate(f"localStorage.getItem('{STORAGE_KEY}')") is None, "v ostrom režime sa nič neukladá do prehliadača")

    records = backend.records()
    check(len(records) == 1, f"v tabuľke má byť 1 riadok, je {len(records)}")
    r = records[0]
    check((r["status"], r["date"], r["time"], r["endTime"], r["serviceName"], r["barberName"]) ==
          ("potvrdená", MON, "10:00", "10:30", "Pánsky strih", "Michael Nguyen"), json.dumps(r, ensure_ascii=False))
    check((r["name"], r["email"], r["phone"], r["note"], r["price"]) ==
          ("Ján Testovací", "jan@example.com", "+421944123987", "Prosím kratšie po bokoch", "18"), json.dumps(r, ensure_ascii=False))
    check(r["id"] == s.code(), "kód na stránke sedí s tabuľkou")

    mails = backend.mails()
    check([m["to"] for m in mails] == ["jan@example.com", "majitel@example.com"], f"e-maily: {[m['to'] for m in mails]}")
    check(s.code() in mails[0]["body"] and "Pánsky strih" in mails[0]["body"] and "10:00" in mails[0]["body"], "potvrdenie zákazníkovi: " + mails[0]["body"][:200])
    check("Nová rezervácia" in mails[1]["subject"] and "+421 944 123 987" in mails[1]["body"], "oznámenie prevádzke")

    # termín je obsadený aj po obnovení stránky (údaje sú na serveri)
    p.reload()
    p.wait_for_selector("#services-list li")
    s.wait_synced()
    s.choose("panski-strih", "michael", MON)
    check(s.slot_states()["10:00"] == "booked" and s.slot_disabled("10:00"), "po obnovení stránky je termín obsadený")
    check(not s.external_requests(), f"požiadavky mimo servera: {s.external_requests()[:3]}")


@remote
def r02_termin_je_spolocny_pre_vsetkych_zakaznikov(s, backend):
    """Dvaja zákazníci na dvoch zariadeniach: termín dostane iba prvý, druhému ho server odmietne."""
    other = s.another()
    for session, who in [(s, dict()), (other, dict(name="Druhý Zákazník", email="druhy@example.com", phone="0900 777 888"))]:
        session.choose("panski-strih", "michael", MON, "12:00")
        session.fill_contact(**who)
    check(other.slot_states()["12:00"] == "available", "príprava: druhý zákazník vidí termín ešte ako voľný")
    s.submit()
    s.confirmed()
    other.submit()
    other.page.wait_for_function("() => document.querySelector('#form-error').textContent.trim() !== ''")
    check("obsadený" in other.form_error(), "druhý zákazník: " + other.form_error())
    check(other.page.is_hidden("#confirmation"), "druhému zákazníkovi sa nesmie zobraziť potvrdenie")
    other.page.wait_for_function("() => document.querySelector('label.slot[for=\"slot-1200\"]').dataset.state === 'booked'", timeout=5000)
    check(len(backend.records()) == 1, "v tabuľke smie byť iba jedna rezervácia")
    check(len(backend.mails()) == 2, "e-maily odišli iba za prvú rezerváciu")
    # druhý zákazník si vyberie iný čas a uspeje
    other.choose(time_="12:30")
    other.submit()
    other.confirmed()
    check([r["time"] for r in backend.records()] == ["12:00", "12:30"], "obe rezervácie sú v tabuľke")
    # server odmietne aj požiadavku poslanú mimo stránky
    result = s.page.evaluate(
        """async (url) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'create', booking: { serviceId: 'panski-strih', barberId: 'michael', date: '2026-10-12', time: '12:00',
            name: 'Tretí Zákazník', email: 'treti@example.com', phone: '0900 111 000' } }) })).json()""",
        backend.api_url,
    )
    check(result["ok"] is False and result["code"] == "SLOT_TAKEN", f"priama požiadavka: {result}")
    check(len(backend.records()) == 2, "priama požiadavka nesmie nič zapísať")


@remote
def r03_moje_rezervacie_a_zrusenie_s_kodom(s, backend):
    p = s.page
    s.book("strih-brada", "michael", MON, "13:00")
    s.confirmed()
    code = s.code()
    p.click("#show-my-bookings")
    p.wait_for_selector("#my-bookings-results .booking-card")
    cards = s.cards()
    check(len(cards) == 1 and cards[0]["status"] == "confirmed", f"{cards}")
    text = norm(cards[0]["text"])
    check("Strih a brada" in text and "Pondelok 12. októbra 2026" in text and "13:00 – 14:00" in text, text)
    # kto pozná iba e-mail, nedozvie sa kód ani osobné údaje
    check(cards[0]["id"] == "" and code not in text and "Ján" not in text and "944" not in text, "karta nesmie prezradiť kód ani kontakt: " + text)
    found = p.evaluate(
        """async (url) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'find', query: 'jan@example.com' }) })).json()""",
        backend.api_url,
    )
    check(code not in json.dumps(found) and "customer" not in json.dumps(found), f"odpoveď servera prezrádza údaje: {found}")

    card = p.locator(".booking-card").first
    card.locator('[data-action="cancel"]').click()
    check(card.locator(".code-field input").count() == 1, "pri zrušení sa pýta kód rezervácie")
    card.locator('[data-action="confirm-cancel"]').click()
    check("Zadajte kód rezervácie" in card.locator(".panel-error").inner_text(), "bez kódu sa nič neodošle")
    card.locator(".code-field input").fill("BS-AAAAAA")
    card.locator('[data-action="confirm-cancel"]').click()
    p.wait_for_function("() => document.querySelector('.booking-card .panel-error').textContent.indexOf('nesedí') !== -1")
    check(backend.records()[0]["status"] == "potvrdená", "nesprávny kód nesmie rezerváciu zrušiť")
    card.locator(".code-field input").fill(code.lower().replace("-", " "))  # kód sa dá napísať aj malými písmenami
    card.locator('[data-action="confirm-cancel"]').click()
    p.wait_for_selector('.booking-card[data-status="cancelled"]')
    check("Rezervácia bola zrušená" in s.toast(), s.toast())
    r = backend.records()[0]
    check(r["status"] == "zrušená" and r["cancelledAt"] != "", json.dumps(r, ensure_ascii=False))
    mails = backend.mails()
    check(len(mails) == 4 and "zrušen" in mails[2]["subject"].lower() and mails[3]["to"] == "majitel@example.com", f"e-maily po zrušení: {[m['subject'] for m in mails]}")
    # termín je opäť voľný, aj pre iného zákazníka
    p.click("#new-booking")
    s.choose("strih-brada", "michael", MON)
    check(s.slot_states()["13:00"] == "available", "po zrušení je termín voľný")
    other = s.another()
    other.choose("strih-brada", "michael", MON)
    check(other.slot_states()["13:00"] == "available", "termín je voľný aj pre ostatných")


@remote
def r04_presun_s_kodom(s, backend):
    p = s.page
    s.book("panski-strih", "tomas", MON, "09:00")
    s.confirmed()
    code = s.code()
    other = s.another()
    other.book("panski-strih", "tomas", TUE, "10:00", name="Druhý Zákazník", email="druhy@example.com", phone="0900 777 888")
    other.confirmed()

    p.click("#show-my-bookings")
    p.wait_for_selector("#my-bookings-results .booking-card")
    card = p.locator(".booking-card").first
    card.locator('[data-action="reschedule"]').click()
    panel = card.locator(".reschedule")
    panel.locator(f'.day[data-date="{TUE}"]').click()
    # stránka má obsadenosť z okamihu načítania, preto ju pred presunom obnovíme návratom na kartu
    check(panel.locator(".code-field input").count() == 1, "pri presune sa pýta kód rezervácie")
    st = s.slot_states(".reschedule")
    if st["10:00"] == "available":  # ešte nenačítaná rezervácia druhého zákazníka: server ju aj tak odmietne
        panel.locator("label.slot >> text=10:00").click()
        panel.locator(".code-field input").fill(code)
        panel.locator('[data-action="confirm-reschedule"]').click()
        p.wait_for_function("() => document.querySelector('.reschedule .panel-error').textContent.trim() !== ''")
        check("obsadený" in panel.locator(".panel-error").inner_text(), "server odmietne presun na obsadený termín: " + panel.locator(".panel-error").inner_text())
        check((backend.records()[0]["date"], backend.records()[0]["time"]) == (MON, "09:00"), "neúspešný presun nič nezmenil")
    panel.locator("label.slot >> text=11:00").click()
    panel.locator(".code-field input").fill("BS-ZLYKOD")
    panel.locator('[data-action="confirm-reschedule"]').click()
    p.wait_for_function("() => document.querySelector('.reschedule .panel-error').textContent.indexOf('nesedí') !== -1")
    panel.locator(".code-field input").fill(code)
    panel.locator('[data-action="confirm-reschedule"]').click()
    p.wait_for_function("() => document.querySelector('#toast').textContent.indexOf('presunutý') !== -1")
    check(s.toast() == "Termín je presunutý: 13. októbra o 11:00.", s.toast())
    r = backend.records()[0]
    check((r["date"], r["time"], r["endTime"], r["status"], r["id"]) == (TUE, "11:00", "11:30", "potvrdená", code), json.dumps(r, ensure_ascii=False))
    check(r["rescheduledAt"] != "", "v tabuľke je čas presunu")
    check(len(backend.records()) == 2, "presun nevytvára nový riadok")
    mails = backend.mails()
    check(any("11:00" in m["body"] and "presun" in (m["subject"] + m["body"]).lower() for m in mails[4:]), f"e-mail o presune: {[m['subject'] for m in mails]}")
    t = norm(p.locator(".booking-card").first.inner_text())
    check("Utorok 13. októbra 2026" in t and "11:00 – 11:30" in t, "karta po presune: " + t)
    # pôvodný termín sa uvoľnil
    p.click("#new-booking")
    s.choose("panski-strih", "tomas", MON)
    check(s.slot_states()["09:00"] == "available", "pôvodný termín je voľný")


@remote
def r05_vypadok_servera(s, backend):
    backend.offline(True)
    down = s.another(wait_ready=False)
    p = down.page
    p.wait_for_selector("#system-notice:not([hidden])")
    notice = norm(p.inner_text("#system-notice"))
    check("nedostupný" in notice and "+421 900 123 456" in notice and "Skúsiť znova" in notice, "oznam o výpadku: " + notice)
    check("Načítavam voľné termíny" in down.message(), "bez údajov zo servera sa termíny neponúkajú: " + down.message())
    check(not p.is_visible("#next-slot"), "najbližší termín sa bez údajov nezobrazuje")
    check(p.locator("#services-list li").count() == 10 and p.is_visible("#kontakt"), "zvyšok stránky funguje aj počas výpadku")
    # po obnovení servera stačí kliknúť na „Skúsiť znova“
    backend.offline(False)
    p.click("#system-notice button")
    down.wait_synced()
    check(not p.is_visible("#system-notice"), "po obnovení spojenia oznam zmizne")
    down.choose("panski-strih", "michael", MON, "10:00")
    down.fill_contact()
    # výpadok počas odosielania: rezervácia sa nestratí potichu
    backend.offline(True)
    down.submit()
    p.wait_for_function("() => document.querySelector('#form-error').textContent.trim() !== ''")
    check("nedostupný" in down.form_error(), "chyba pri odoslaní: " + down.form_error())
    check(p.is_hidden("#confirmation") and p.is_visible("#booking-form"), "formulár ostáva vyplnený")
    check(p.input_value("#name") == "Ján Testovací" and p.is_checked("#slot-1000"), "vyplnené údaje ostávajú")
    down.lookup("jan@example.com")
    check("nedostupný" in p.inner_text("#my-bookings-results"), "vyhľadanie počas výpadku: " + p.inner_text("#my-bookings-results"))
    # po obnovení sa rezervácia odošle na druhý pokus
    backend.offline(False)
    down.submit()
    down.confirmed()
    check(len(backend.records()) == 1, "po obnovení spojenia sa rezervácia uložila práve raz")


@remote
def r06_rezervacia_plati_aj_ked_sa_email_nepodari_odoslat(s, backend):
    backend.fail_next_mail()
    s.book("panski-strih", "any", MON, "10:00")
    conf = s.confirmed()
    check("e-mail sa nepodarilo odoslať" in conf and "kód rezervácie uložte" in conf, "upozornenie: " + conf[:220])
    r = backend.records()[0]
    check(r["status"] == "potvrdená" and r["barberAuto"] != "", "rezervácia je uložená aj bez e-mailu: " + json.dumps(r, ensure_ascii=False))
    check(any("E-mail sa nepodarilo odoslať" in line for line in backend.state()["logs"]), "chyba je zapísaná v zázname servera")
    check([m["to"] for m in backend.mails()] == ["majitel@example.com"], "oznámenie prevádzke odišlo")


@remote
def r07_pravidla_plati_aj_server(s, backend):
    """Server nedôveruje prehliadaču: každú požiadavku kontroluje sám."""
    p = s.page
    post = """async ([url, payload]) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })).json()"""
    base = {"serviceId": "panski-strih", "barberId": "michael", "date": MON, "time": "10:00", "name": "Ján Testovací", "email": "jan@example.com", "phone": "0944 123 987"}
    cases = [
        ({"date": "2026-10-18"}, None, "nedeľa"),
        ({"date": "2026-10-10"}, None, "minulosť"),
        ({"time": "18:45"}, None, "čas mimo mriežky"),
        ({"serviceId": "kralovsky", "time": "18:00"}, "OUTSIDE_HOURS", "presah cez zatvorenie"),
        ({"barberId": "tomas", "serviceId": "holenie-britvou"}, None, "služba, ktorú barber neponúka"),
        ({"name": "<script>alert(1)</script>"}, "VALIDATION", "HTML v mene"),
        ({"email": "zly-email"}, "VALIDATION", "neplatný e-mail"),
        ({"website": "http://spam.example"}, "SPAM", "pasca na roboty"),
    ]
    for change, code, label in cases:
        result = p.evaluate(post, [backend.api_url, {"action": "create", "booking": dict(base, **change)}])
        check(result["ok"] is False and (code is None or result["code"] == code), f"{label}: {result}")
    check(len(backend.records()) == 0 and len(backend.mails()) == 0, "neplatné požiadavky nesmú nič zapísať ani poslať")
    result = p.evaluate(post, [backend.api_url, {"action": "neznama"}])
    check(result["ok"] is False and result["code"] == "BAD_REQUEST", f"neznáma akcia: {result}")
    # vzorec v poznámke sa do tabuľky zapíše ako text
    result = p.evaluate(post, [backend.api_url, {"action": "create", "booking": dict(base, note='=HYPERLINK("http://zle.example";"klik")')}])
    check(result["ok"] is True, f"platná rezervácia: {result}")
    check(backend.records()[0]["note"].startswith("=HYPERLINK"), "poznámka sa uloží ako text")
    raw = backend.call("/__test/state")["records"][0]
    check(raw["phone"] == "+421944123987", "telefón sa ukladá v jednotnom tvare")


# --------------------------------------------------------------------------
# Testy: jednosúborové verzie
# --------------------------------------------------------------------------
def _smoke(session):
    """Spoločná kontrola zostavených verzií: písma, obsah, rezervácia, zrušenie."""
    p = session.page
    check(p.locator("#services-list li").count() == 10 and p.locator("#barbers-list article").count() == 3, "obsah sa vykreslil")
    p.evaluate("document.fonts.ready")
    check(p.evaluate("document.fonts.check('700 40px \"Heros Cn\"') && document.fonts.check('400 16px Inter')"), "písma sú súčasťou súboru")
    check(p.evaluate("getComputedStyle(document.querySelector('.site-header')).position") == "fixed", "štýly sú načítané")
    session.book("panski-strih", "any", MON, "09:00")
    check("Tomáš Kováč" in session.confirmed(), "rezervácia v zostavenej verzii")
    p.click("#show-my-bookings")
    p.wait_for_selector("#my-bookings-results .booking-card")
    p.locator('.booking-card [data-action="cancel"]').click()
    p.locator('[data-action="confirm-cancel"]').click()
    p.wait_for_selector('.booking-card[data-status="cancelled"]')
    check(not session.external_requests(), f"cudzie zdroje: {session.external_requests()[:3]}")
    check(p.locator('link[rel="stylesheet"], script[src]').count() == 0, "všetko je vložené priamo v súbore")
    check(p.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 0, "bez vodorovného posunu")


@test
def b01_jeden_subor_pre_hosting(s):
    built = s.another(url=(ROOT / "dist" / "index.html").as_uri())
    p = built.page
    check(p.title() == "Barber Studio" and p.get_attribute("html", "lang") == "sk", "názov a jazyk stránky")
    check(p.locator('meta[name="viewport"]').count() == 1 and p.locator('meta[name="description"]').count() == 1, "meta údaje")
    check(p.locator('script[type="application/ld+json"]').count() == 1, "štruktúrované údaje pre vyhľadávače")
    data = json.loads(p.inner_text('script[type="application/ld+json"]'))
    check(data["@type"] == "HairSalon" and data["email"] == "barbershopmn17@gmail.com", "štruktúrované údaje sedia so stránkou")
    _smoke(built)
    check(not built.errors, f"chyby v konzole: {built.errors}")


@test
def b02_verzia_pre_aplikaciu(s):
    """dist/barber-studio.html nemá vlastný <html>/<head>/<body>; aplikácia ho vkladá do svojej kostry stránky."""
    fragment = (ROOT / "dist" / "barber-studio.html").read_text(encoding="utf-8")
    check(fragment.startswith("<title>Barber Studio</title>"), "súbor sa má začínať názvom stránky")
    check(not re.search(r"<(!doctype|html|head|body)[\s>]", fragment, re.I), "súbor nesmie obsahovať vlastnú kostru dokumentu")
    shell = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
        "<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}"
        "body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>"
        "</head><body>\n" + fragment + "\n</body></html>"
    )
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "artifact.html"
        path.write_text(shell, encoding="utf-8")
        built = s.another(url=path.as_uri())
        p = built.page
        check(p.title() == "Barber Studio", "názov stránky")
        check(p.evaluate("getComputedStyle(document.body).backgroundColor") != "rgba(0, 0, 0, 0)", "stránka má vlastné pozadie")
        check(p.evaluate("getComputedStyle(document.documentElement).colorScheme") == "dark", "stránka si určuje farebnú schému sama")
        check(p.locator("#top").count() == 1, "kotva #top pre odkaz v logu")
        _smoke(built)
        # aj na šírku telefónu
        p.set_viewport_size({"width": 390, "height": 844})
        check(p.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 0, "mobil: bez vodorovného posunu")
        check(not built.errors, f"chyby v konzole: {built.errors}")


# --------------------------------------------------------------------------
# Spúšťač
# --------------------------------------------------------------------------
def main():
    pattern = sys.argv[1] if len(sys.argv) > 1 else ""
    selected = [t for t in TESTS if pattern in t.__name__]
    if not selected:
        print(f"Žiadny test nezodpovedá filtru „{pattern}“.")
        sys.exit(2)

    if any(t.__name__.startswith("b") for t in selected):
        subprocess.run([sys.executable, str(ROOT / "tools" / "build_single.py")], check=True, stdout=subprocess.DEVNULL)
    backend = Backend() if any(t.remote for t in selected) else None

    passed, failed = [], []
    started_all = time.time()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for fn in selected:
                started = time.time()
                session = None
                try:
                    if fn.remote:
                        backend.reset()
                        session = Session(browser, api_url=backend.api_url)
                        fn(session, backend)
                    else:
                        session = Session(browser)
                        fn(session)
                    if session.all_errors():
                        raise AssertionError(f"chyby v konzole: {session.all_errors()}")
                    passed.append(fn.__name__)
                    print(f"PASS  {fn.__name__:<62} {time.time() - started:4.1f}s")
                except Exception as err:  # noqa: BLE001
                    failed.append(fn.__name__)
                    print(f"FAIL  {fn.__name__:<62} {time.time() - started:4.1f}s")
                    msg = str(err).strip().splitlines()
                    print("      " + (msg[0] if msg else repr(err))[:600])
                    if not isinstance(err, AssertionError):
                        traceback.print_exc()
                finally:
                    if session:
                        session.close()
            browser.close()
    finally:
        if backend:
            backend.close()

    print(f"\nVýsledok: {len(passed)} z {len(selected)} testov prešlo, {len(failed)} zlyhalo. Čas: {time.time() - started_all:.0f} s.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
