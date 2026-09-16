# Deel - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on Deel's own hiring product.

**Host pattern:** `jobs.deel.com` - Deel runs its own hiring product here (not Ashby/Greenhouse/Lever). Apply form lives at `/deel/job-details/{uuid}/application` - click the "Apply" button on `/overview` to get there.

Driving it via cmux browser:

- `snapshot -i` exposes only the file-upload box and the Apply button. Enumerate every text input and combobox via read-only `eval` over `document.querySelectorAll("input,textarea,select")`.
- Element ids are React auto-ids (`_r_5_`, `_r_22_`, `_r_2j_`) that **regenerate after every combobox selection**. Re-enumerate ids between each dropdown; never cache them across steps.
- Comboboxes: click the input -> options render as `[role=option]` with ids `{inputId}-option-{n}`. Filter on `[role=option]` specifically - a broader `li` selector also catches the JD bullet list elsewhere in the DOM.
- Yes/No are **real radios** with no id - click via `input[value="{uuid}"]`. Works first try, unlike Ashby's hidden-checkbox buttons.
- Verification differs by widget: single-select value lands in `input.value` (not innerText); multi-select ("Select one or more") renders a chip in `innerText` (not value). Check the right one or you'll think a fill failed.
- **The SPA crashes** ("Something went wrong. We could not load this page.") on a rapid selection-then-fill burst. Recovery: click "Try again" - the form re-renders and typed text can survive. Prevention: one field at a time, read-back between each, ~2s pause after any combobox selection.
- Apply button stays disabled until the resume PDF is attached - a free completeness check before handoff.
- File upload is candidate-manual as always on the cmux path (`modes/_ats/ashby.md`).

Deel's form (#1634, 2026-07-21) was **fully factual** - no cover letter field, no narrative question at all. See `modes/_ats/greenhouse.md`: some ATS forms give the tailored CV as the only artifact a reviewer reads.
