# Barber Studio – web s online rezerváciou (verzia 2)

Responzívna stránka barber shopu v slovenčine s rezervačným systémom. Čisté HTML, CSS a JavaScript, bez frameworkov, bez platených služieb a bez platieb.

## Spustenie

Otvorte `index.html` v prehliadači (stačí dvojklik). Nič sa neinštaluje.

Na hosting (napr. GitHub Pages) stačí nahrať jediný súbor `dist/index.html` – je v ňom vzhľad, písma aj skripty.

## Dva režimy

| Režim | Kedy | Kde sú dáta |
|---|---|---|
| Ukážkový | `apiUrl` v `js/data.js` je prázdne (predvolené) | v prehliadači návštevníka (localStorage) |
| Ostrý | `apiUrl` obsahuje adresu webovej aplikácie Google Apps Script | v Google Tabuľke majiteľa, e-maily posiela Google |

### Zapnutie ostrého režimu (voliteľné, zadarmo)

1. Vytvorte novú Google Tabuľku.
2. Rozšírenia → Apps Script, vložte obsah `server/Code.gs`.
3. Spustite funkciu `setup` a povoľte prístup.
4. Nasadiť → Nové nasadenie → Webová aplikácia; spustiť ako „Ja“, prístup „Ktokoľvek“.
5. Adresu končiacu na `/exec` vložte do `apiUrl` v `js/data.js` (v jednosúborovej verzii vyhľadajte `apiUrl: ''`).
6. Po zmene služieb, barberov alebo pravidiel spustite `python3 tools/build_server.py` a `Code.gs` nasaďte znova.

Pozor: serverová časť bola otestovaná proti miestnej napodobenine prostredia Google (`tests/helpers/gas-mock.js`, `tests/mock-backend.js`), nie na skutočnom účte Google.

## Štruktúra

```
index.html              stránka
css/fonts.css           vložené písma (Inter, Heros Cn) – generuje tools/build_fonts.py
css/styles.css          vzhľad
js/data.js              údaje prevádzky, služby, barberi, pravidlá, časté otázky
js/booking-logic.js     pravidlá rezervácií (bez závislosti od prehliadača)
js/storage.js           ukážkový režim: localStorage a ukážkové dáta
js/api.js               jednotné rozhranie pre oba režimy
js/art.js               ikony a avatary (SVG)
js/app.js               používateľské rozhranie
server/src/server.js    zdroj serverovej časti
server/Code.gs          vygenerovaný súbor pre Google Apps Script
tools/                  build_single.py, build_server.py, build_fonts.py
tests/                  testy logiky, servera a testy v prehliadači
dist/                   jednosúborové verzie
```

## Funkcie

- Úvod s najbližším voľným termínom a rýchlou rezerváciou, o nás, cenník s filtrom (10 služieb), postup, barberi (3), časté otázky, kontakt.
- Rezervácia: služba, barber alebo „ktorýkoľvek barber“ (termín dostane menej vyťažený), pás dní s počtom voľných termínov, mriežka časov, kontaktné údaje.
- Moje rezervácie: vyhľadanie podľa e-mailu alebo telefónu, presun termínu, zrušenie. V ostrom režime sa pri zmene pýta kód z e-mailu.
- Pridanie do Google kalendára.

## Pravidlá

- Po–Pi 9:00–19:00, So 9:00–14:00, Ne zatvorené; sviatky 1. 1., 6. 1., 24.–26. 12.
- Termíny po 30 minútach, najviac 60 dní dopredu, služba sa musí skončiť do zatvorenia.
- Iba budúce termíny, podľa času prevádzky (Europe/Bratislava) bez ohľadu na pásmo návštevníka.
- Jeden barber nemá dve rezervácie naraz; zákazník najviac 3 nadchádzajúce rezervácie.
- Ochrana: validácia vstupov, skryté pole proti robotom, text sa do stránky vkladá bezpečne, server všetko kontroluje znova a zápis chráni zámkom.

## Testy

```
npm test                         # 81 testov logiky a servera (Node.js)
python3 tests/e2e/run_e2e.py     # 57 testov v prehliadači (Playwright, Chromium)
```

Testy v prehliadači: `t..` ukážkový režim, `r..` ostrý režim proti miestnemu serveru, `b..` jednosúborové verzie.

## Zostavenie

```
python3 tools/build_single.py    # dist/index.html a dist/barber-studio.html
python3 tools/build_server.py    # server/Code.gs
```

## Obmedzenia

- V ukážkovom režime sú rezervácie iba v prehliadači daného návštevníka.
- Ostrý režim nebol overený na skutočnom účte Google; Google obmedzuje počet e-mailov za deň.
- E-mail zákazníka sa neoveruje, v ostrej prevádzke by pomohlo overenie alebo CAPTCHA.
- Fotografie nie sú súčasťou; dajú sa doplniť cez `heroPhoto`, `gallery` a `photo` v `js/data.js`.

## Písma

Inter (SIL Open Font License 1.1) a TeX Gyre Heros Condensed (GUST Font License), vložené priamo v stránke, takže sa nič nenačítava z cudzích serverov.
