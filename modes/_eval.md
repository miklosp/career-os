# Mode: _eval — Lean evaluation (A/B/C/D scored)

Called after `modes/_location-gate.md` returns ALLOW. Reads
`data/jds/{NUM}-*.md`, `config/cv.md`, and `config/profile.md`.

Writes `data/reports/{NUM}-{company-slug}-{YYYY-MM-DD}.md` and a TSV row
to `data/tracker-additions/{NUM}-{company-slug}.tsv`.

**This is a triage pass, not a dossier.** It runs on every fetched JD,
cheaply, with **zero WebSearch**. Everything that needs the open web —
compensation/negotiation intel, posting-legitimacy verification, company
health and growth signals — is deferred to `modes/interview-prep.md`,
which only runs for the roles that come back to the candidate. Score off
the JD text and the candidate's own files; do not gather anything else.

Narrative style only. No attribute tables, no JD→CV mapping tables, no
STAR multi-column tables. Prose bullets. See `templates/report.example.md`
(committed; `data/reports/` is gitignored) for the exact target look and
feel — header label order and bullet density.

## Step 0 — Archetype detection

Classify into one or two archetypes from `config/profile.md` (Target Roles
& Archetypes). This controls framing in Block B and proof-point selection.

## Report shape

Save to `data/reports/{NUM}-{company-slug}-{YYYY-MM-DD}.md` using exactly this
header. The dashboard parser (`dashboard/internal/data/career.go`) reads
`**URL:**`, `**Summary:**`, and `**Location:**` — keep those labels verbatim.
`**ID:**` is human-facing; `**Score:**` is the silently-computed weighted mean
(see "Score" below) and is also picked up from the applications.md row. PDF
status lives only in applications.md (dashboard reads the ✅/❌ from the PDF
column there) — do NOT put a `**PDF:**` line in the report header, it goes stale.

```markdown
**Score:** {X.X/5}
**ID:** {NUM}
**URL:** {copy the canonical URL verbatim from the JD's `**URL:**` header — employer ATS URL, or a LinkedIn URL for easy-apply roles}
**Summary:** {Summary of the company and the role.}
**Location:** {Location or remote policy}

# {Company} — {Role} (Remote | Stockholm | Hybrid Stockholm)
```


Then the four scored blocks in narrative form, followed by Recommended
Next Step and Extracted Keywords. Each block: 3–6 short bullets, no
tables. Each block carries its own `— X/5` score in the header. There is
**no Block E section and no Block F section** — the global score is the
`**Score:**` header value (computed silently, never shown as a
calculation); legitimacy is not assessed at this stage.

### A: CV Match — X/5

What the JD asks for, and how closely `config/cv.md` matches.

- Lead with the strongest match (a single bullet naming the specific requirement and the CV line).
- Note 1–4 clear gaps with one-sentence mitigations (adjacent experience, relevant project, cover-letter angle).
- Cite exact phrases from `config/cv.md` where possible, no invented metrics.

### B: North Star — X/5

Fit with the user's target archetypes from `config/profile.md`.

- Is this a primary / secondary / adjacent archetype?
- Seniority alignment (IC vs lead vs executive — does the JD level match the user's target level?).
- Stage fit, only as stated in the JD (Seed / Series A–C / enterprise — do not WebSearch to find it).
- Apply the bonuses/penalties from `config/profile.md` "Scoring Adjustments" (AI-native +0.3, dev-tooling +0.2, etc.) and say which applied.

### C: Cultural Signals — X/5

Everything qualitative the **JD text itself** reveals about the company.
Do not WebSearch for team size, funding, or growth — that is
interview-prep's job for callbacks.

- Remote policy as stated (EU-remote / Stockholm hybrid / onsite Berlin with relocation).
- Domain fit — does the product sit in a space the user has credibility in?
- Language / tone of the JD (over-corporate? builder-vibe? red flags?).
- Any team / reporting structure the JD explicitly describes (taken at face value, not researched).

### D: Red Flags — X/5

Blockers, warnings, negative adjustments, **read off the JD only**.
Higher score = fewer red flags.

- Overloaded JD (entry-level title + staff-level requirements, unrealistic years / tech age ratios).
- Role-level mismatch (IC role when user wants Head+; scope unclear).
- Non-obvious culture smells (pure individual-contributor design role; no equity; weird probation clauses).
- Internal contradictions or vagueness in the JD itself (no concrete responsibilities, copy-paste boilerplate).

### Score

Compute the weighted global score silently:

| Block | What it measures | Weight |
|-------|-----------------|--------|
| A: CV Match | Skills, experience, proof-points alignment | 0.35 |
| B: North Star | Fit with the user's target archetypes (from `config/profile.md`) | 0.30 |
| C: Cultural Signals | Remote policy, domain fit, JD tone (JD text only) | 0.20 |
| D: Red Flags | Blockers, warnings, negative adjustments (JD text only) | 0.15 |

`Global = A×0.35 + B×0.30 + C×0.20 + D×0.15`. Write it, rounded to one
decimal, into the `**Score:**` header line and the tracker TSV. **Do
not** print the calculation, a Block E section, or a restated score-band
sentence in the report body — the header value, the Summary, and the
Recommended Next Step already carry that signal.

Bands (drive the Recommended Next Step; never printed as a band): 4.5+
strong, apply immediately · 4.0–4.4 good, worth applying · 3.5–3.9
decent, apply only with a specific reason · below 3.5 recommend against
(see Ethical Use in CLAUDE.md).

### Recommended Next Step

One sentence. `Apply within a week.` / `Draft CV and wait on the intro
call.` / `Skip — IC scope misalignment.` Do not hedge.

### Extracted Keywords

A simple bulleted list of 15–20 JD keywords (tech, methodology, tool
names, buzzwords) for ATS optimisation when generating the PDF later.

## Tracker TSV drop

Write one TSV line to `data/tracker-additions/{NUM}-{company-slug}.tsv`.

Single line, 9 tab-separated columns — order matters (status BEFORE score):

```
{NUM}\t{YYYY-MM-DD}\t{Company}\t{Role}\tEvaluated\t{X.X}/5\t❌\t[{NUM}](data/reports/{NUM}-{slug}-{YYYY-MM-DD}.md)\t{one-line summary}
```

`merge-tracker.mjs` will pick this up and update `data/applications.md` —
swapping the row's status from `Fetched` to `Evaluated` and filling in
Score / Report / Notes.

## Scoring rules

Invariants for this pass:

- **Never invent experience or metrics.** Read them from `config/cv.md`
  and `config/story-bank.md` at evaluation time; cite the exact CV line
  when matching (see the Block A guidance above).
- **Zero WebSearch.** This pass never touches the open web. If something
  can only be known by searching (real comp, layoffs, funding, posting
  liveness), it is out of scope here — flag it for interview-prep instead.
- **Match the JD language** (EN default). Generate the report in the JD's
  language; the mode files themselves stay English.
