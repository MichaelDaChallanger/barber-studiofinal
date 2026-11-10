#!/usr/bin/env python3
"""Vytvorí css/fonts.css: písma vložené priamo do štýlov (podmnožina znakov, formát WOFF2, base64).

Zdroj písiem (voľné licencie):
  - Inter (SIL Open Font License 1.1), text stránky
  - TeX Gyre Heros Condensed (GUST Font License), nadpisy
Skript stačí spustiť iba vtedy, keď chcete zmeniť písma. Výsledný súbor css/fonts.css je súčasťou projektu.

Potrebuje: Python balík fonttools a buď balík brotli, alebo Node.js (náhrada v tools/fontshim).
"""
import base64
import io
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
try:
    import brotli  # noqa: F401
except ImportError:
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "fontshim"))

from fontTools import subset  # noqa: E402
from fontTools.ttLib import TTFont  # noqa: E402

INTER = "/usr/share/fonts/opentype/inter/"
GYRE = "/usr/share/texmf/fonts/opentype/public/tex-gyre/"

FACES = [
    # (rodina v CSS, hrúbka, súbor)
    ("Inter", 400, INTER + "Inter-Regular.otf"),
    ("Inter", 600, INTER + "Inter-SemiBold.otf"),
    ("Inter", 700, INTER + "Inter-Bold.otf"),
    ("Heros Cn", 700, GYRE + "texgyreheroscn-bold.otf"),
]

# Základná latinka, Latin-1, Latin Extended-A (slovenčina, čeština a ďalšie jazyky) a interpunkcia.
UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x180))
    + [0x2009, 0x200A, 0x202F, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E,
       0x2022, 0x2026, 0x2030, 0x2032, 0x2033, 0x2039, 0x203A, 0x20AC, 0x2116, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193,
       0x2197, 0x2212, 0x00D7, 0x2713, 0x2715]
)


def build_face(path):
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["kern", "tnum", "case", "ccmp", "locl", "mark", "mkmk"]
    options.name_IDs = [1, 2, 3, 4, 6]
    options.notdef_outline = True
    options.desubroutinize = True
    options.hinting = False
    font = TTFont(path)
    sub = subset.Subsetter(options)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue(), len(font.getGlyphOrder())


def main():
    out = [
        "/* Vygenerované skriptom tools/build_fonts.py – neupravujte ručne.",
        "   Inter: SIL Open Font License 1.1 (rsms.me/inter).",
        "   Heros Cn: podmnožina písma TeX Gyre Heros Condensed Bold, GUST Font License (gust.org.pl/projects/e-foundry/tex-gyre). */",
    ]
    total = 0
    for family, weight, path in FACES:
        data, glyphs = build_face(path)
        total += len(data)
        b64 = base64.b64encode(data).decode("ascii")
        out.append(
            "@font-face { font-family: \"%s\"; font-style: normal; font-weight: %d; font-display: swap; "
            "src: url(data:font/woff2;base64,%s) format(\"woff2\"); }" % (family, weight, b64)
        )
        print(f"{family} {weight}: {len(data) / 1024:.1f} kB, {glyphs} glyfov")
    target = ROOT / "css" / "fonts.css"
    target.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"spolu {total / 1024:.1f} kB (binárne), {target.stat().st_size / 1024:.1f} kB v CSS -> {target}")


if __name__ == "__main__":
    main()
