#!/usr/bin/env python3
"""
render-cv-pdf.py — render a markdown CV to PDF via WeasyPrint.

Usage:
    uv run render-cv-pdf.py --in <input.md> --out <output.pdf> \
        [--css <stylesheet.css>] [--format a4|letter]

Converts markdown to HTML, respecting the ::: description ::: fenced-div
convention used in config/cv.md, then renders to PDF with WeasyPrint.
Page size is injected at render time based on --format.
"""

import argparse
import os
import re
import sys
from pathlib import Path

# WeasyPrint needs GLib/Pango which Homebrew installs to /opt/homebrew/lib.
# macOS doesn't include that path by default, so we add it here.
_hb_lib = "/opt/homebrew/lib"
if os.path.isdir(_hb_lib):
    os.environ["DYLD_LIBRARY_PATH"] = (
        _hb_lib + (":" + os.environ["DYLD_LIBRARY_PATH"] if os.environ.get("DYLD_LIBRARY_PATH") else "")
    )

import markdown
import weasyprint
from weasyprint.text.fonts import FontConfiguration


PAGE_SIZES = {"a4": "A4", "letter": "letter"}


def expand_fenced_divs(md_text: str) -> str:
    """Convert Pandoc-style ::: class ::: fenced divs into HTML <div class="...">."""
    return re.sub(
        r"^::: (\w+)\s*\n(.*?)\n^:::\s*$",
        r'<div class="\1">\n\2\n</div>',
        md_text,
        flags=re.MULTILINE | re.DOTALL,
    )


def render(md_path: Path, pdf_path: Path, css_path: Path | None, page_format: str) -> None:
    md_text = md_path.read_text(encoding="utf-8")
    md_text = expand_fenced_divs(md_text)
    body = markdown.markdown(md_text)
    html = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'></head>"
        f"<body>{body}</body></html>"
    )

    page_size = PAGE_SIZES.get(page_format.lower())
    if not page_size:
        sys.exit(f"Invalid --format: {page_format}. Use a4 or letter.")

    font_config = FontConfiguration()
    stylesheets = []

    if css_path and css_path.exists():
        stylesheets.append(weasyprint.CSS(filename=str(css_path), font_config=font_config))

    # Inject @page size so the same CSS file works for both A4 and Letter.
    stylesheets.append(
        weasyprint.CSS(string=f"@page {{ size: {page_size}; }}", font_config=font_config)
    )

    weasyprint.HTML(string=html, base_url=str(md_path.parent)).write_pdf(
        str(pdf_path), stylesheets=stylesheets, font_config=font_config
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="input", required=True, help="Input markdown file")
    parser.add_argument("--out", dest="output", required=True, help="Output PDF path")
    parser.add_argument("--css", dest="css", default=None, help="External stylesheet")
    parser.add_argument("--format", dest="page_format", default="a4", help="a4 or letter")
    args = parser.parse_args()

    md_path = Path(args.input).resolve()
    pdf_path = Path(args.output).resolve()
    css_path = Path(args.css).resolve() if args.css else None

    if not md_path.exists():
        sys.exit(f"Input markdown not found: {md_path}")
    if css_path and not css_path.exists():
        sys.exit(f"CSS not found: {css_path}")

    pdf_path.parent.mkdir(parents=True, exist_ok=True)

    render(md_path, pdf_path, css_path, args.page_format)
    size_kb = pdf_path.stat().st_size / 1024
    print(f"✅ PDF : {pdf_path} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
