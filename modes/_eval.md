# Mode: _eval — Lean evaluation (A/B/C/D scored)

Called for each JD the gate allowed. Every input arrives in one
`node lib/eval-context.mjs <NUM...>` call (see `modes/auto-pipeline.md`):
the **id-annotated CV**, `user/config/profile.md`, the story-bank digest
(source of citable `S0xx` ids — id/title/skills/Result per story, full
STAR text intentionally omitted), `user/config/notes.yml` (confirmed `n#`
notes from prior tailor sessions), `templates/report.example.md`, and the
JD(s). Do not re-read those files.

The id-annotated CV is `user/config/cv.json` rendered as prose with each
bullet's stable source id appended, e.g. `- Took the product from 0 to
$1M ARR [acme-b1]`. Cite those ids in Block A (see below); they are
load-bearing for CV generation downstream.

Writes `user/data/reports/{NUM}-{company-slug}-{YYYY-MM-DD}.md` and a TSV row
to `user/data/tracker-additions/{NUM}-{company-slug}.tsv`.

**This is a triage pass, not a dossier.** It runs on every fetched JD,
cheaply, with **zero WebSearch**. Everything that needs the open web —
compensation/negotiation intel, posting-legitimacy verification, company
health and growth signals — is deferred to `modes/interview-prep.md`,
which only runs for the roles that come back to the candidate. Score off
the JD text and the candidate's own files; do not gather anything else.

Narrative style only. No attribute tables, no JD→CV mapping tables, no
STAR multi-column tables. Prose bullets. `templates/report.example.md`
(committed; real reports live in the private `user/` repo — included in the eval context)
shows the exact target look and feel — header label order and bullet
density.

## Step 0 — Archetype detection

Classify into one or two archetypes from `user/config/profile.md` (Target Roles
& Archetypes). This controls framing in Block B and which CV matches lead
Block A.

Read the responsibilities, not just the title. A plain "Senior Product
Manager" / "Head of Product" title is the **UX-Led Product Manager**
archetype when the JD hands the role design or UX ownership — running
research and discovery, owning the design system or the experience end to
end, no separate design lead, or a product whose users are reached through
craft (design tooling, developer UX). Title-only classification misses these.

## Report shape

Save to `user/data/reports/{NUM}-{company-slug}-{YYYY-MM-DD}.md` using exactly this
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

# {Company} — {Role} (Remote | {City} | Hybrid {City})
```


Then the four scored blocks in narrative form, followed by Recommended
Next Step and Criteria. Each block: 3–6 short bullets, no
tables. Each block carries its own `— X/5` score in the header. There is
**no Block E section and no Block F section** — the global score is the
`**Score:**` header value (computed silently, never shown as a
calculation); legitimacy is not assessed at this stage.

### A: CV Match — X/5

What the JD asks for, and how closely the id-annotated CV matches.

- Lead with the strongest match (a single bullet naming the specific requirement and the CV line).
- **Every Match cites its source id**: end the match bullet with `[src: <id>]` using the id annotated on the cited CV bullet (e.g. `… proven 0→$1M ARR ownership [src: acme-b1]`). A Story Bank match cites its `S0xx` id. These ids are the authoritative, machine-checked handles the CV generator and validator rely on — an uncited or wrong-id Match is unusable downstream.
- Note 1–4 clear gaps with one-sentence mitigations (adjacent experience, relevant project, cover-letter angle). Gaps name the JD requirement; they carry no `[src:]` (a gap has no supporting line).
- Cite exact phrases from the CV where possible, no invented metrics.

### B: North Star — X/5

Fit with the user's target archetypes from `user/config/profile.md`.

- Is this a primary / secondary / adjacent archetype?
- Seniority alignment (IC vs lead vs executive — is the JD level one of the target levels in `user/config/profile.md`?).
- Stage fit, only as stated in the JD (Seed / Series A–C / enterprise — do not WebSearch to find it).
- Apply the bonuses/penalties from `user/config/profile.md` "Scoring Adjustments" and say which applied.

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
- Role-level mismatch (JD level outside the target levels in `user/config/profile.md`; scope unclear).
- Non-obvious culture smells (pure individual-contributor design role; no equity; weird probation clauses).
- Internal contradictions or vagueness in the JD itself (no concrete responsibilities, copy-paste boilerplate).

### Score

Compute the weighted global score silently:

| Block | What it measures | Weight |
|-------|-----------------|--------|
| A: CV Match | Skills, experience, evidence alignment | 0.35 |
| B: North Star | Fit with the user's target archetypes (from `user/config/profile.md`) | 0.30 |
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

### Criteria

Mirrors how Ashby/Greenhouse auto-generate screening criteria from the JD;
downstream the CV generator proves each evidenced criterion, the reviewer
simulates the ATS evaluation against this list, and `apply`/`cover-letter`
pick their evidence from the top of it.

Derive the criteria from the **JD's requirements** — not from Block A. Then
mark each one by consulting Block A, the id-annotated CV, the story bank, and
confirmed notes: provable criteria become `[evidenced]`, the rest `[gap]`. A
JD requirement is never dropped for lacking a match — it becomes a `[gap]`.
Rules:

- 5–15 `- ` bullets, each opening with a status tag: `[evidenced]` or `[gap]`.
- **Order by JD priority**, regardless of tag: lead/must-have requirements
  first, nice-to-haves last. Downstream reads top-of-ledger as the employer's
  most important needs.
- Criterion text is a JD requirement phrased Ashby-style — verifiable from a
  résumé (skill, years, scope, domain). NOT culture traits, company product
  names, or logistics/comp terms.
- `[evidenced]` items end with ` — [src: id, id]` citing the Block-A Match /
  CV / story-bank / note ids that prove them. `[gap]` items carry no `[src:]`.
- The `### Criteria` heading and the `- [tag] … — [src: …]` bullet shape are
  machine-parsed (`lib/cv-fact-check.mjs`); keep both verbatim.

```markdown
### Criteria

- [evidenced] 5+ years product management in B2B SaaS — [src: acme-b1]
- [evidenced] Shipped AI/LLM products from prototype to production — [src: S011, n3]
- [gap] Pricing and packaging ownership
- [gap] Public speaking / developer advocacy
```

## Tracker TSV drop

Write one TSV line to `user/data/tracker-additions/{NUM}-{company-slug}.tsv`.

Single line, 9 tab-separated columns — order matters (status BEFORE score):

```
{NUM}\t{YYYY-MM-DD}\t{Company}\t{Role}\tEvaluated\t{X.X}/5\t❌\t[{NUM}](data/reports/{NUM}-{slug}-{YYYY-MM-DD}.md)\t{one-line summary}
```

The report link is relative to the user-data root: `data/reports/…`, never `user/data/reports/…`.

`merge-tracker.mjs` will pick this up and update `user/data/applications.md` —
swapping the row's status from `Fetched` to `Evaluated` and filling in
Score / Report / Notes.

## Scoring rules

Invariants for this pass:

- **Never invent experience or metrics.** Read them from the id-annotated
  CV and the story-bank digest in the eval context; cite the exact CV line
  **and its `[src: <id>]`** when matching (see the Block A guidance above).
- **Zero WebSearch.** This pass never touches the open web. If something
  can only be known by searching (real comp, layoffs, funding, posting
  liveness), it is out of scope here — flag it for interview-prep instead.
- **Match the JD language** (EN default). Generate the report in the JD's
  language; the mode files themselves stay English.
