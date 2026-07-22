# Mode: tailor — Interactive per-application CV

Turns per-application CV production into a guided loop: criteria → elicit the
missing evidence from the user → generate → walk the review → PDF → hand off to
`apply`. Runs standalone via `/career-ops tailor {NUM | company | URL}`, and is
the step `apply` points you to when a role has no reviewed CV yet. This is the
**user-triggered** CV-personalization path (CLAUDE.md: CV personalization is
never part of the background pipeline). Often runs inside a cmux workspace
launched from the dashboard `t` key.

The provenance contract is CLAUDE.md → **CV Generation → Fact-Check**: a
generator under a `[src: id]` closed-world contract, a deterministic validator,
and an independent cross-family judge. Those three are the scripts below — this
mode orchestrates them and the human decisions between them. Two rules carry the
whole flow: **never auto-revise from reviewer output** (the user applies fixes,
the reviewer only surfaces), and **regenerate at most once**.

## Step 0 — Resolve & gate

Resolve the argument to a single **NUM**, then locate:

- **JD** — glob `data/jds/{NUM}-*.md`.
- **Report** — newest `data/reports/{NUM}-*.md` by mtime.
- **Row** — the `| {NUM} |` line in `data/applications.md` (company, role, score, status, PDF cell).

A URL resolves by matching the report/JD `**URL:**` header or the applications.md
row; a company name resolves by matching the row. If NUM is ambiguous, ask.

Gate before doing any work:

- **No report** → stop. This mode tailors against an evaluation; there is none.
  Point the user at the eval pipeline: `/career-ops {url}`.
- **Status `Applied` / `Discarded` / `SKIP`** → surface it and stop, unless the
  user explicitly overrides ("do it anyway").
- **Score below 4.0/5** → per CLAUDE.md Ethical Use, recommend against applying
  and say why. Proceed only on a stated override.

## Step 1 — Criteria backfill (legacy reports only)

If the report already has a `### Criteria` section, skip this step. If it has the
legacy `### Extracted Keywords` section instead, distill **Block A** into a
Criteria ledger per the spec in `modes/_eval.md` → **### Criteria** (matches →
`[evidenced] … — [src: id]`, gaps → `[gap]`) and replace the Extracted Keywords
section in the report file **in place**. Block A only — **zero WebSearch**.

## Step 2 — Gap elicitation (one batched round)

Read the `[gap]` criteria from the report. Ask **one** `AskUserQuestion`
(`multiSelect`): "Which of these do you actually have evidence for?", listing the
gaps as options (**max 4 per call**; a second call only if there are more than 4
gaps). For each gap the user selects, let them dictate the evidence
conversationally, then:

1. **Append** to `config/notes.yml` (schema: `templates/notes.example.yml`) a
   `{claim, supporting_detail, source_type: "elicited", confirmed: true}` entry.
   Note ids are positional (`n1`, `n2`, … in list order) and the generator cites
   them by position — **append only, never reorder**, so existing ids stay stable.
2. **Update the report Criteria line** for that gap: `[gap]` → `[evidenced] … —
   [src: n#]` with the new note's id. Match the report's existing ` — [src: …]`
   format (this is internal data, not candidate-facing text).

Unselected gaps are accepted as-is and stay `[gap]` — the CV must not claim them.
If dictated evidence is a full STAR-shaped story, offer
`/career-ops storybank add` — but the default sink is `notes.yml`; the story bank
stays small and curated.

## Step 3 — Generate

```bash
node lib/generate-cv-llm.mjs --jd {the data/jds/{NUM}-*.md path from Step 0} --no-pdf
```

The generator derives NUM + slug from the JD filename/heading and **prints** the
output `.md` path — use that path downstream (the CV slug is heading-derived and
may differ from the JD filename; if you need to re-find it, glob the newest
`output/customized-cvs/{NUM}-*-cv.md`). A **non-zero exit is a validator
hard-fail**: surface the printed `<failed_constraints>` findings verbatim and
stop. Never hand-fix the CV to get past the validator — that is the contract.

## Step 4 — Review

```bash
node lib/cv-fact-check.mjs --review-only output/customized-cvs/{NUM}-{slug}-cv.md
```

Then read `output/customized-cvs/{NUM}-{slug}-cv-review.json`. It carries
`findings` (each `{severity, generated_text, replacement, source_type,
unusable}`) and `simulation` (`criteria` with per-criterion `expected`/`verdict`,
plus Node-computed `deviations`, each `{type, criterion}`).

## Step 5 — Walkthrough (AskUserQuestion)

Findings first, ordered **fabricated → stretched → bridge**, batched **≤4 per
`AskUserQuestion` call**. Per finding, options like **Apply fix** / **Keep
as-is** (the built-in **Other** covers a custom rewrite); put the
`generated_text`, the issue, and the proposed `replacement` in the option
descriptions so the user decides from the file, not from memory.

- **Apply** an accepted fix with the **Edit** tool on the CV `.md`: an exact
  `generated_text` → `replacement` splice. In any text you hand-write (a custom
  rewrite), use plain-ASCII punctuation — no em/en-dashes, smart quotes, or `…`
  (`modes/_writing.md` §5; nothing normalizes these edits on this path).
- A finding flagged **`unusable: true`** cannot be spliced (its quote is not in
  the CV). Surface it for a hand edit of the affected section instead.

Then work the simulation `deviations`:

- **`overclaim`** (a `[gap]` criterion the ATS reads as *Met*) — treat with
  **fabrication** severity: rewrite the offending CV text so the gap is no longer
  claimed.
- **`uncertain_evidence`** (an `[evidenced]` criterion the ATS reads as
  *Uncertain*) — an elicitation opportunity: "the ATS would read {criterion} as
  Uncertain; do you have a concrete number or artifact?" Dictated evidence →
  `notes.yml` + report Criteria update, **same rules as Step 2**.
- **`lost_evidence`** (an `[evidenced]` criterion the ATS reads as *does not
  meet*) — note it for the regeneration; don't hand-patch.

## Step 6 — Regenerate once, automatically

If Steps 2 or 5 **added notes or changed the Criteria ledger** (not mere CV text
splices), re-run **Step 3 then Step 4 once**. Walk only the **new** findings —
diff against the already-actioned ones by `generated_text`. **Never regenerate a
second time**: if issues remain after this pass, surface them for a hand edit.

## Step 7 — PDF & close out

Render (a4 default; `--format letter` only for US-market roles):

```bash
uv run --project . render-cv-pdf.py \
  --in  output/customized-cvs/{NUM}-{slug}-cv.md \
  --out output/customized-cvs/{NUM}-{slug}-cv.pdf \
  --css style/cv-template.css --format a4
```

- **Delete the review JSON** (`{NUM}-{slug}-cv-review.json`) once every finding
  was actioned — its presence is what the dashboard reads as "review-pending".
  If the user aborts mid-walkthrough, **leave it in place** (resume semantics).
- **Update the applications.md row**: flip the PDF cell to ✅. Edit the existing
  `| {NUM} |` row in place — never add a row, never touch status or run
  merge-tracker (that is the user's job).

## Step 8 — Handoff to apply

Offer to open the application URL and continue with `/career-ops apply`, which
owns the per-ATS form mechanics and the browser. Detect a cmux workspace with the
**`cmux current-workspace` capability probe** (returns a workspace, not a socket
error) — **not** an env var; if it's a cmux workspace, `apply` opens the URL in
the cmux browser, non-headless, so the user watches. Otherwise `apply`'s
agent-browser fallback applies. Either way, restate the Ethical Use stop: forms
get filled, **nothing is submitted** without the user.

## Cost & pacing

Worst case is ~2 generation (Opus) + 2 review (GPT) calls — one regeneration, no
more. Batch `AskUserQuestion` into groups of ≤4. Don't ask what a file already
answers: read the report, the review JSON, and `notes.yml` before prompting.
