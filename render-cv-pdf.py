#!/usr/bin/env python3
"""
render-cv-pdf.py — render a markdown CV to PDF via WeasyPrint.

Usage:
    uv run render-cv-pdf.py --in <input.md> --out <output.pdf> \
        [--css <stylesheet.css>] [--format a4|letter] \
        [--target-pages N] [--keywords "a,b,c" | @path] [--no-txt]

Converts markdown to HTML, respecting the ::: description ::: fenced-div
convention used in config/cv.md, then renders to PDF with WeasyPrint.
Page size is injected at render time based on --format.

Page fitting is a RENDERER concern (the model cannot count pages reliably):
with --target-pages, pages are measured with pypdf and the lowest-priority
Experience bullets are trimmed deterministically until the CV fits. Priority,
lowest first: oldest roles before recent ones (reverse-chronological CV
convention + ats-prompt Rule 4); bullets containing a protected --keywords
term are trimmed last; a role/sub-role is never left with zero bullets.
Trimming only removes content; it never adds or rewrites — no fabrication risk.

Also emits a plain-text sibling (<out>.txt, unless --no-txt) for
paste-into-form ATS flows, derived from the same markdown.
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
from pypdf import PdfReader
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


def render_bytes(md_text: str, css_path: Path | None, page_size: str, base_url: str) -> bytes:
    body = markdown.markdown(expand_fenced_divs(md_text))
    html = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'></head>"
        f"<body>{body}</body></html>"
    )
    font_config = FontConfiguration()
    stylesheets = []
    if css_path and css_path.exists():
        stylesheets.append(weasyprint.CSS(filename=str(css_path), font_config=font_config))
    # Inject @page size so the same CSS file works for both A4 and Letter.
    stylesheets.append(
        weasyprint.CSS(string=f"@page {{ size: {page_size}; }}", font_config=font_config)
    )
    return weasyprint.HTML(string=html, base_url=base_url).write_pdf(
        stylesheets=stylesheets, font_config=font_config
    )


def page_count(pdf_bytes: bytes) -> int:
    import io

    return len(PdfReader(io.BytesIO(pdf_bytes)).pages)


def _bullet_protected(line: str, keywords: list[str]) -> bool:
    low = line.lower()
    return any(k in low for k in keywords)


def trim_one_bullet(md_text: str, keywords: list[str]) -> str | None:
    """Remove exactly one lowest-priority Experience bullet. Returns the new
    markdown, or None if nothing more can be safely trimmed.

    Priority (trim first): the LAST (oldest) role's LAST unprotected bullet.
    Never empties a role/sub-role (keeps >=1 bullet under each heading).
    Bullets containing a protected keyword are only trimmed once no
    unprotected bullet remains.
    """
    lines = md_text.split("\n")
    in_exp = False
    # group bullets by their owning heading block within Experience
    blocks: list[list[int]] = []
    cur: list[int] = []
    for i, ln in enumerate(lines):
        s = ln.strip()
        if re.match(r"^##\s+", ln):
            in_exp = s.lower() == "## experience"
            cur = []
            continue
        if not in_exp:
            continue
        if re.match(r"^###\s+", ln) or re.match(r"^\*\*.+\*\*", s):
            cur = []
            blocks.append(cur)
            continue
        if s.startswith("- "):
            cur.append(i)

    # candidate bullets, oldest-block first, last bullet within a block first
    def candidates(only_unprotected: bool):
        for blk in reversed(blocks):
            if len(blk) <= 1:  # never empty a heading block
                continue
            for idx in reversed(blk):
                if only_unprotected and _bullet_protected(lines[idx], keywords):
                    continue
                return idx
        return None

    target = candidates(True)
    if target is None:
        target = candidates(False)
    if target is None:
        return None
    del lines[target]
    # collapse a blank gap left behind
    out = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    return out


def to_plain_text(md_text: str) -> str:
    """Deterministic markdown → plain text for paste-into-form ATS boxes."""
    t = expand_fenced_divs(md_text)
    t = re.sub(r"<div class=\"\w+\">|</div>", "", t)
    t = re.sub(r"<br\s*/?>", "\n", t)                           # line breaks
    t = re.sub(r"^#{1,6}\s*", "", t, flags=re.MULTILINE)        # headings
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", t)            # links → text
    t = re.sub(r"\*\*([^*]+)\*\*", r"\1", t)                    # bold
    t = re.sub(r"(?<!\*)\*(?!\*)([^*]+)\*", r"\1", t)           # italic
    t = re.sub(r"^\s*-\s+", "- ", t, flags=re.MULTILINE)        # normalize bullets
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    return t + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="input", required=True, help="Input markdown file")
    parser.add_argument("--out", dest="output", required=True, help="Output PDF path")
    parser.add_argument("--css", dest="css", default=None, help="External stylesheet")
    parser.add_argument("--format", dest="page_format", default="a4", help="a4 or letter")
    parser.add_argument("--target-pages", dest="target_pages", type=int, default=None,
                        help="Trim oldest bullets until the PDF fits in N pages")
    parser.add_argument("--keywords", dest="keywords", default=None,
                        help="Comma list or @file of terms; bullets containing one are trimmed last")
    parser.add_argument("--no-txt", dest="no_txt", action="store_true",
                        help="Skip the plain-text sibling")
    args = parser.parse_args()

    md_path = Path(args.input).resolve()
    pdf_path = Path(args.output).resolve()
    css_path = Path(args.css).resolve() if args.css else None

    if not md_path.exists():
        sys.exit(f"Input markdown not found: {md_path}")
    if css_path and not css_path.exists():
        sys.exit(f"CSS not found: {css_path}")

    page_size = PAGE_SIZES.get(args.page_format.lower())
    if not page_size:
        sys.exit(f"Invalid --format: {args.page_format}. Use a4 or letter.")

    keywords: list[str] = []
    if args.keywords:
        raw = args.keywords
        if raw.startswith("@"):
            kp = Path(raw[1:]).resolve()
            raw = kp.read_text(encoding="utf-8") if kp.exists() else ""
        keywords = [k.strip().lower() for k in re.split(r"[,\n]", raw) if k.strip()]

    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    md_text = md_path.read_text(encoding="utf-8")
    base_url = str(md_path.parent)

    pdf = render_bytes(md_text, css_path, page_size, base_url)
    trimmed = 0
    if args.target_pages:
        guard = 0
        while page_count(pdf) > args.target_pages and guard < 60:
            nxt = trim_one_bullet(md_text, keywords)
            if nxt is None:
                print(
                    f"⚠ Cannot trim below {page_count(pdf)} pages without emptying a "
                    f"role — leaving as-is (target {args.target_pages}).",
                    file=sys.stderr,
                )
                break
            md_text = nxt
            trimmed += 1
            guard += 1
            pdf = render_bytes(md_text, css_path, page_size, base_url)

    pdf_path.write_bytes(pdf)
    size_kb = pdf_path.stat().st_size / 1024
    pages = page_count(pdf)
    extra = f", trimmed {trimmed} bullet(s) → {pages}p" if trimmed else f", {pages}p"
    print(f"✅ PDF : {pdf_path} ({size_kb:.1f} KB{extra})")

    if not args.no_txt:
        txt_path = pdf_path.with_suffix(".txt")
        txt_path.write_text(to_plain_text(md_text), encoding="utf-8")
        print(f"✅ TXT : {txt_path}")


if __name__ == "__main__":
    main()
