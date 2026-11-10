#!/usr/bin/env python3
"""Zloží server/Code.gs pre Google Apps Script.

Výsledok obsahuje tie isté dáta a tú istú logiku ako stránka (js/data.js, js/booking-logic.js)
a k nim serverovú časť (server/src/server.js). Spustite po každej zmene cenníka, barberov,
otváracích hodín alebo pravidiel a obsah Code.gs skopírujte do editora Apps Script.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
read = lambda p: (ROOT / p).read_text(encoding="utf-8")


def indent(text):
    return "\n".join(("    " + line if line.strip() else "") for line in text.rstrip().splitlines())


data = read("js/data.js")
logic = read("js/booking-logic.js")
server = read("server/src/server.js")

out = f"""/* ==========================================================================
   Barber Studio – Code.gs (VYGENEROVANÝ SÚBOR, neupravujte ho ručne)
   Zdroj: js/data.js + js/booking-logic.js + server/src/server.js
   Vytvorený príkazom: python3 tools/build_server.py
   ========================================================================== */

/* ---------- js/data.js ---------- */
var BarberData = (function () {{
  var module = {{ exports: {{}} }};
  (function (module) {{
{indent(data)}
  }})(module);
  return module.exports;
}})();

/* ---------- js/booking-logic.js ---------- */
var BookingLogic = (function () {{
  var module = {{ exports: {{}} }};
  var require = function () {{ return BarberData; }};
  (function (module, require) {{
{indent(logic)}
  }})(module, require);
  return module.exports;
}})();

{server}"""

target = ROOT / "server" / "Code.gs"
target.write_text(out, encoding="utf-8")
print(f"server/Code.gs: {len(out.splitlines())} riadkov, {len(out.encode()) // 1024} kB")
