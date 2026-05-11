# Mode: pdf — ATS-customized CV via Opus 4.7 (Bifrost)

Generates an ATS-optimized CV + PDF tailored to a specific job, using **Opus 4.7 through a local Bifrost proxy** as the customization engine. This is the single CV generation path — there is no inline variant.

Requires `BIFROST_URL` and `BIFROST_MODEL` in `.env` (or environment). Defaults: `http://localhost:4444` / `claude-opus-4-7`.

---

## When to use

`/career-ops pdf` — generate an ATS-optimized CV + PDF for an already-evaluated offer.

From the dashboard, press **`g`** on a selected row to trigger the same pipeline for that application.

**Precondition:** the JD must already be saved at `data/jds/{NUM}-{slug}.md`. If it isn't, run `/career-ops pipeline` or paste the URL/JD first — the evaluation step saves the JD.

---

## Pipeline

1. Locate the JD file for the target application at `data/jds/{NUM}-{slug}.md`.
2. Detect paper format: US/Canada → `letter`, everywhere else → `a4`.
3. Run the script:

```bash
node lib/generate-cv-llm.mjs --jd data/jds/{NUM}-{slug}.md --format {a4|letter}
```

The script derives `NUM` and `slug` from the JD filename. Pass `--num` and `--slug` explicitly only if `--jd` is inline text rather than a file.

4. The script produces:
   - `output/customized-cvs/{NUM}-{slug}-cv.md`
   - `output/customized-cvs/{NUM}-{slug}-cv.pdf`

5. Report to the user:
   - PDF path
   - Token usage (shown in script stdout)
   - Any warnings from the PDF generator

## Error handling

- **Bifrost 404/500**: proxy is not running. Ask the user to start it.
- **PDF generation failed**: WeasyPrint / uv issue, independent of the LLM step. The markdown is already saved; user can run `uv run render-cv-pdf.py --in output/customized-cvs/{NUM}-{slug}-cv.md --out output/customized-cvs/{NUM}-{slug}-cv.pdf --css style/cv-template.css --format a4` manually.
- **Empty sections**: certifications and projects are optional — the LLM simply omits the section headers when irrelevant; markdown naturally renders without them.

## Updating tracker

After a successful run, update the tracker entry for this application:
- Change PDF column from ❌ to ✅
