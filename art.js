/**
 * art.js – kreslené prvky stránky ako SVG: ikony služieb a rozhrania a avatary barberov.
 *
 * Všetko sú statické reťazce bez používateľských údajov, preto je bezpečné vkladať ich
 * do stránky ako HTML. Stránka vďaka nim nepotrebuje žiadne obrázkové súbory.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BarberArt = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Ikony v mriežke 24 × 24, kreslené jednou hrúbkou čiary (štýl nastavuje trieda .icon v CSS). */
  const ICONS = {
    scissors:
      '<circle cx="6" cy="6.5" r="2.6"/><circle cx="6" cy="17.5" r="2.6"/><path d="M8.2 8.1l12.3 9.4M8.2 15.9l12.3-9.4"/>',
    wash: '<path d="M4 9.5h16M6.5 9.5a5.5 5.5 0 0 1 11 0"/><path d="M8 13v1.5M12 13v3.5M16 13v1.5M10 17.5V19M14 17.5V19"/>',
    fade: '<path d="M4.5 6h15M6 10h12M7.5 14h9M9.5 18h5"/>',
    clipper:
      '<path d="M7 9.500h10V18a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3z"/><path d="M7 9.500v-3h10v3M9.500 6.500V3.500M12 6.500V3.500M14.500 6.500V3.500M10.500 14h3"/>',
    beard:
      '<path d="M12 8.800c-1.600-1.600-4.300-1.800-6.300.100 1.300 1.900 4.200 2.300 6.300.6 2.100 1.700 5 1.300 6.300-.6-2-1.900-4.700-1.700-6.300-.100z"/><path d="M6 13c.4 4.400 2.800 7.500 6 7.500s5.600-3.100 6-7.500"/>',
    razor:
      '<rect x="3" y="4.500" width="15" height="6" rx="1.800"/><path d="M6.500 4.500v6"/><path d="M16.800 10.500l-6.300 8.300a1.700 1.700 0 0 0 2.700 2.100l6.800-9"/>',
    combo:
      '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
    kid: '<circle cx="12" cy="13" r="6.500"/><path d="M12 6.500c0-2 1.300-3.300 3.200-3.500M9.700 12.700h.01M14.300 12.700h.01M9.800 15.500c.6.700 1.400 1 2.200 1s1.600-.3 2.200-1"/>',
    drop: '<path d="M12 3.500s6 6 6 10.300a6 6 0 0 1-12 0C6 9.500 12 3.500 12 3.500z"/><path d="M9.500 14.500A2.500 2.500 0 0 0 12 17"/>',
    crown: '<path d="M4 17.500L3 8l5 4 4-7 4 7 5-4-1 9.500z"/><path d="M4.500 20.500h15"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.500"/><path d="M3.500 10h17M8 3v4M16 3v4"/>',
    calendarCheck:
      '<rect x="3.5" y="5" width="17" height="15" rx="2.500"/><path d="M3.500 10h17M8 3v4M16 3v4M8.500 15l2.200 2.200 4.300-4.400"/>',
    users:
      '<circle cx="9" cy="8.500" r="3.200"/><path d="M3 19.500C3 16.200 5.700 14 9 14s6 2.200 6 5.500"/><path d="M16 5.600a3.200 3.200 0 0 1 0 5.800M18 14.300c1.800.7 3 2.400 3 4.700"/>',
    check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    pin: '<path d="M12 21s7-6.200 7-11.500a7 7 0 0 0-14 0C5 14.800 12 21 12 21z"/><circle cx="12" cy="9.500" r="2.500"/>',
    phone:
      '<path d="M5 4h4l2 5-2.500 1.500a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    mail: '<rect x="3" y="5.500" width="18" height="13" rx="2.500"/><path d="M3.500 7l8.500 6 8.500-6"/>',
    shield:
      '<path d="M12 3l7.500 3v5.500c0 4.600-3.100 8.200-7.500 9.500-4.400-1.300-7.500-4.900-7.500-9.500V6z"/><path d="M9 12l2.200 2.200 4-4.200"/>',
    sparkle:
      '<path d="M12 3l1.800 4.700L18.500 9l-4.700 1.800L12 15.500l-1.800-4.700L5.500 9l4.700-1.300z"/><path d="M18.500 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    bottle: '<path d="M9 3h6v3l1.500 2.500V20a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V8.500L9 6z"/><path d="M8 13h7"/>',
    cup: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.500a2.500 2.500 0 0 1 0 5H17M8 3.500v2M12 3.500v2"/>',
    cash: '<rect x="3" y="6" width="18" height="12" rx="2.500"/><circle cx="12" cy="12" r="2.500"/><path d="M6.500 9.500v.01M17.500 14.500v.01"/>',
    swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
  };

  /** SVG ikona podľa názvu; neznámy názov vráti nožnice, aby sa rozloženie nerozpadlo. */
  function icon(name, className) {
    return (
      '<svg class="icon' +
      (className ? ' ' + className : '') +
      '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      (ICONS[name] || ICONS.scissors) +
      '</svg>'
    );
  }

  /**
   * Kreslený avatar barbera. look = { skin, hair, beard, hasBeard, style: 'slick' | 'fade' | 'curly' }.
   * Farbu pozadia určuje CSS premenná --avatar-bg (trieda .av-bg).
   */
  function avatarSVG(look, crop) {
    const l = look;
    const hair = {
      slick: '<path d="M36 47c-3-21 11-31 24-31s27 10 23 31c-3-9-8-15-23-15-14 0-20 5-24 15z" fill="' + l.hair + '"/>',
      fade: '<path d="M38 45c-1-19 9-27 22-27s23 8 22 27c-3-7-8-9-22-9s-19 2-22 9z" fill="' + l.hair + '"/>',
      curly:
        '<g fill="' +
        l.hair +
        '"><circle cx="44" cy="36" r="9"/><circle cx="53" cy="27" r="10"/><circle cx="67" cy="27" r="10"/>' +
        '<circle cx="76" cy="36" r="9"/><circle cx="60" cy="24" r="9"/>' +
        '<path d="M39 47c0-9 4-15 21-15s21 6 21 15c-3-7-8-10-21-10s-18 3-21 10z"/></g>',
    }[l.style];
    const beard = l.hasBeard
      ? '<path d="M39 52c1 22 11 31 21 31s20-9 21-31c-2 9-7 14-21 14s-19-5-21-14z" fill="' + l.beard + '"/>'
      : '';
    return (
      '<svg viewBox="' +
      (crop || '0 0 120 120') +
      '" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">' +
      '<rect class="av-bg" width="120" height="120" fill="#d9cdbb"/>' +
      '<rect x="52" y="68" width="16" height="20" rx="7" fill="' + l.skin + '"/>' +
      '<rect x="52" y="68" width="16" height="20" rx="7" fill="#000" opacity=".18"/>' +
      '<path d="M10 124c3-25 21-38 50-38s47 13 50 38z" fill="#26221c"/>' +
      '<path d="M46 86l14 18 14-18" fill="none" stroke="#f2a05a" stroke-width="3"/>' +
      '<ellipse cx="39.500" cy="54" rx="3" ry="5" fill="' + l.skin + '"/><ellipse cx="80.500" cy="54" rx="3" ry="5" fill="' + l.skin + '"/>' +
      '<ellipse cx="60" cy="52" rx="21" ry="25" fill="' + l.skin + '"/>' +
      beard +
      hair +
      '<path d="M46.500 46.500q4.500-2.500 9 0M64.500 46.500q4.500-2.500 9 0" fill="none" stroke="' + l.hair + '" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="51" cy="51.500" r="1.900" fill="#1a1410"/><circle cx="69" cy="51.500" r="1.900" fill="#1a1410"/>' +
      '<path d="M54 63.500q6 3 12 0" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  return Object.freeze({ ICONS, icon, avatarSVG });
});
