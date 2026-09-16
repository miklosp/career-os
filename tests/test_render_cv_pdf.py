#!/usr/bin/env python3
"""Tests for the fence handling in render-cv-pdf.py.

Dependency-free (plain asserts, no pytest). Run:  uv run tests/test_render_cv_pdf.py

Every case here is a real failure shape that reached a generated PDF:
  - "::: democracy" (empty div)          — CV 3199, nShift
  - "::: description" never closed        — CV 554,  nShift (submitted)
  - "::: development description"         — CV 200,  evroc  (submitted)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "render_cv_pdf", Path(__file__).resolve().parent.parent / "render-cv-pdf.py"
)
r = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(r)

FAILURES = []


def check(name, actual, expected):
    if actual != expected:
        FAILURES.append(f"{name}\n   expected: {expected!r}\n   actual  : {actual!r}")
        print(f"FAIL {name}")
    else:
        print(f"ok   {name}")


# ── expand_fenced_divs ────────────────────────────────────────────────────────

check(
    "well-formed div converts",
    r.expand_fenced_divs("::: description\nLed UX design.\n:::\n"),
    '<div class="description">\nLed UX design.\n</div>\n',
)

check(
    "multi-line content is preserved",
    r.expand_fenced_divs("::: description\nOne\nTwo\n:::\n"),
    '<div class="description">\nOne\nTwo\n</div>\n',
)

# The 3199 bug: an empty div used to swallow the NEXT fence, dumping both
# fences and the following text into the page as literal markup.
check(
    "empty div does not swallow the following fence",
    r.expand_fenced_divs("::: democracy\n:::\n\n::: description\nLed hands-on design.\n:::\n"),
    '<div class="democracy">\n</div>\n\n<div class="description">\nLed hands-on design.\n</div>\n',
)

check(
    "two adjacent divs stay separate",
    r.expand_fenced_divs("::: description\nA\n:::\n\n::: description\nB\n:::\n"),
    '<div class="description">\nA\n</div>\n\n<div class="description">\nB\n</div>\n',
)

# ── normalize_fences ──────────────────────────────────────────────────────────

# The 200/evroc bug: a class with stray words matches no fence pattern.
text, fixes = r.normalize_fences("::: development description\nLed UX design.\n:::\n")
check("multi-word class is normalized", text, "::: description\nLed UX design.\n:::\n")
check("multi-word class is reported", len(fixes), 1)

# The 554/nShift bug: an opener with no closer.
text, fixes = r.normalize_fences("::: description\nA consultancy.\n\n**Botkube** - platform\n")
check("unclosed fence is closed at the blank line", text,
      "::: description\nA consultancy.\n:::\n\n**Botkube** - platform\n")
check("unclosed fence is reported", len(fixes), 1)

text, fixes = r.normalize_fences("::: description\nTrailing.\n")
check("unclosed fence at EOF is closed", text, "::: description\nTrailing.\n:::\n")

text, fixes = r.normalize_fences("::: description\nA\n:::\n\n::: description\nB\n:::\n")
check("well-formed input is left alone", fixes, [])

# End to end: the exact 554 shape must render clean.
text, _ = r.normalize_fences("::: description\nA consultancy.\n\n**Botkube** - platform\n")
check("repaired 554 shape converts to HTML", r.expand_fenced_divs(text),
      '<div class="description">\nA consultancy.\n</div>\n\n**Botkube** - platform\n')

# ── find_markup_leaks patterns ────────────────────────────────────────────────

def leaks_in(line):
    return [name for pattern, name in r.MARKUP_LEAKS if pattern.search(line)]

check("fence marker is a leak", leaks_in("::: description Led UX"), ["fenced-div marker"])
check("src tag is a leak", leaks_in("Took it to $1M ARR [src: w2.b1]"), ["[src: id] citation tag"])
check("audit tag is a leak", leaks_in("<gaps>"), ["audit block tag"])
check("clean prose is not a leak", leaks_in("Took the product from 0 to $1M ARR"), [])
check("rendered bold is not a leak", leaks_in("Owned the roadmap at strategic level"), [])

print()
if FAILURES:
    print(f"{len(FAILURES)} failure(s):\n")
    for f in FAILURES:
        print(f" - {f}")
    sys.exit(1)
print("all tests passed")
