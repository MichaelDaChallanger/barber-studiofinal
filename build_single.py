#!/usr/bin/env python3
"""Zloží projekt do jedného súboru (štýly, písma aj skripty vložené priamo v HTML).

Výstupy v priečinku dist/:
  index.html          úplná stránka pre vlastný hosting (napr. GitHub Pages): stačí nahrať tento jeden súbor
  barber-studio.html  tá istá stránka bez <html>/<head>/<body> (formát, v akom sa zverejňuje v aplikácii Claude)

Spustenie:  python3 tools/build_single.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = ("data", "booking-logic", "storage", "api", "art", "app")
STYLES = ("fonts", "styles")


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def main():
    html = read("index.html")

    # Poradie skriptov a štýlov sa berie z index.html, aby sa nedalo zabudnúť na nový súbor.
    linked_scripts = re.findall(r'<script src="js/([\w-]+)\.js"></script>', html)
    linked_styles = re.findall(r'<link rel="stylesheet" href="css/([\w-]+)\.css">', html)
    assert tuple(linked_scripts) == SCRIPTS, f"index.html načítava iné skripty: {linked_scripts}"
    assert tuple(linked_styles) == STYLES, f"index.html načítava iné štýly: {linked_styles}"

    css = "\n".join(read(f"css/{name}.css").strip() for name in STYLES)
    js = "\n".join(read(f"js/{name}.js").strip() for name in SCRIPTS)
    assert "</style" not in css.lower(), "CSS nesmie obsahovať ukončenie značky style"
    assert "</script" not in js.lower(), "JS nesmie obsahovať ukončenie značky script"

    style_tag = "<style>\n" + css + "\n</style>"
    script_tag = "<script>\n" + js + "\n</script>"

    # 1) Úplný dokument pre hosting
    site = html
    site = re.sub(r'[ \t]*<link rel="stylesheet" href="css/fonts\.css">\n', "", site)
    site = site.replace('  <link rel="stylesheet" href="css/styles.css">', style_tag)
    site = re.sub(r'[ \t]*<script src="js/[\w-]+\.js"></script>\n', "", site)
    site = site.replace("</body>", script_tag + "\n</body>")
    assert 'href="css/' not in site and 'src="js/' not in site
    assert site.count("<style>") == 1 and site.count(script_tag) == 1

    # 2) Obsah stránky bez obalu (názov, štýly, telo, skript)
    title = re.search(r"<title>.*?</title>", html, re.S).group(0)
    body = re.search(r"<body[^>]*>(.*)</body>", html, re.S).group(1)
    body = re.sub(r'[ \t]*<script src="js/[\w-]+\.js"></script>\n', "", body)
    fragment = "\n".join([title, style_tag, '<div id="top"></div>', body.strip(), script_tag]) + "\n"
    for tag in ("!doctype", "html", "head", "body"):
        assert not re.search(rf"<{tag}[\s>]", fragment, re.I), f"fragment nesmie obsahovať <{tag}>"

    out = ROOT / "dist"
    out.mkdir(exist_ok=True)
    (out / "index.html").write_text(site, encoding="utf-8")
    (out / "barber-studio.html").write_text(fragment, encoding="utf-8")
    for name in ("index.html", "barber-studio.html"):
        print(f"dist/{name}: {(out / name).stat().st_size // 1024} kB")


if __name__ == "__main__":
    main()
