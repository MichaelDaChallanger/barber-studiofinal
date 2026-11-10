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
