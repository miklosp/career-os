# Mode: _eval — Lean evaluation (A/B/C/D scored, F Posting Legitimacy)

Called after `modes/_location-gate.md` returns ALLOW. Reads
`jds/{NUM}-*.md` plus `config/cv.md` and `config/_profile.md`. Writes
`reports/{NUM}-{company-slug}-{YYYY-MM-DD}.md` and a TSV row to
`data/tracker-additions/{NUM}-{company-slug}.tsv`.

Narrative style only. No attribute tables, no JD→CV mapping tables, no
STAR multi-column tables. Prose bullets. See `reports/013-zyte-2026-04-16.md`
for the target look and feel.

## Step 0 — Archetype detection

Classify into one or two archetypes from `modes/_shared.md` (Archetype
Detection). This controls framing in Block B and proof-point selection.

## Report shape

Save to `reports/{NUM}-{company-slug}-{YYYY-MM-DD}.md` using exactly this
header. The dashboard parser (`dashboard/internal/data/career.go`) reads
`**URL:**`, `**Summary:**`, and `**Location:**` — keep those labels verbatim.
`**ID:**` is human-facing; `**Score:**` is picked up from the applications.md
row, not the report header. PDF status lives only in applications.md (dashboard
reads the ✅/❌ from the PDF column there) — do NOT put a `**PDF:**` line in the
report header, it goes stale.

```markdown
**Score:** {X.X/5}
**ID:** {NUM}
**URL:** {canonical employer ATS URL}
**Summary:** {Summary of the company and the role.}
**Location:** {Location or remote policy}

# {Company} — {Role} (Remote | Stockholm | Hybrid Stockholm)
```


Then the six blocks in narrative form. Each block: 3–6 short bullets, no
tables. Each block carries its own `— X/5` score in the header.

### A: CV Match — X/5

What the JD asks for, and how closely `config/cv.md` matches.

- Lead with the strongest match (a single bullet naming the specific requirement and the CV line).
- Note 1–4 clear gaps with one-sentence mitigations (adjacent experience, relevant project, cover-letter angle).
- Cite exact phrases from `config/cv.md` where possible, no invented metrics.

### B: North Star — X/5

Fit with the user's target archetypes from `config/_profile.md`.

- Is this a primary / secondary / adjacent archetype?
- Seniority alignment (IC vs lead vs executive — does the JD level match the user's target level?).
- Stage fit (Seed / Series A–C / enterprise).
- Apply the bonuses/penalties from `_profile.md` "Scoring Adjustments" (AI-native +0.3, dev-tooling +0.2, etc.) and say which applied.

### C: Cultural Signals — X/5

Everything qualitative the JD reveals about the company, minus compensation.

- Remote policy as stated (EU-remote / Stockholm hybrid / onsite Berlin with relocation).
- Team size, reporting structure, stage, growth signals from a quick WebSearch.
- Domain fit — does the product sit in a space the user has credibility in?
- Language / tone of the JD (over-corporate? builder-vibe? red flags?).

### D: Red Flags — X/5

Blockers, warnings, negative adjustments. Higher score = fewer red flags.

- Hiring freeze / recent layoffs (one WebSearch: `"{company}" layoffs 2025-2026`).
- Overloaded JD (entry-level title + staff-level requirements, unrealistic years / tech age ratios).
- Role-level mismatch (IC role when user wants Head+; scope unclear).
- Non-obvious culture smells (pure individual-contributor design role; no equity; weird probation clauses).

### E: Global Score — X.X/5

Weighted mean across the four scored blocks:

```
E = A × 0.35 + B × 0.30 + C × 0.20 + D × 0.15
```

Round to one decimal. Follow with one or two sentences of recommendation:

- 4.5+ → apply immediately, draft Block H below too
- 4.0–4.4 → apply, good match
- 3.5–3.9 → apply only if there's a specific reason
- Below 3.5 → recommend against applying

### Recommended Next Step

One sentence. `Apply within a week.` / `Draft CV and wait on the intro
call.` / `Skip — IC scope misalignment.` Do not hedge.

### Extracted Keywords

Close the report with a simple bulleted list of 15–20 JD keywords (tech,
methodology, tool names, buzzwords) for ATS optimisation when generating the
PDF later.

## Story bank

If `config/story-bank.md` exists, silently append 1–2 new STAR+R
stories from Block B / C observations if they're not already there. This
keeps the bank growing without cluttering the report itself.

## Tracker TSV drop

Write one TSV line to `data/tracker-additions/{NUM}-{company-slug}.tsv`.

Single line, 9 tab-separated columns — order matters (status BEFORE score):

```
{NUM}\t{YYYY-MM-DD}\t{Company}\t{Role}\tEvaluated\t{X.X}/5\t❌\t[{NUM}](reports/{NUM}-{slug}-{YYYY-MM-DD}.md)\t{one-line summary}
```

`merge-tracker.mjs` will pick this up and update `data/applications.md` —
swapping the row's status from `Fetched` to `Evaluated` and filling in
Score / Report / Notes.

## Scoring rules

- **Never invent metrics.** Read them from `config/cv.md`.
- **Cite exact CV lines** when matching.
- **Use WebSearch sparingly** — one or two queries total across Blocks C + F.
- **Stay direct.** No corporate-speak in the bullets.
- **Match the JD language** (EN default). If the JD is in French / German / Japanese and the user has set `language.modes_dir`, switch the report language too.
