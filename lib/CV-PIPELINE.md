# CV Pipeline

Subsystem map for everything CV-related in `lib/`. One canonical source
(`user/config/cv.json`), two generation paths (deterministic projection and
a per-JD rewrite drafted in the interactive tailor session), one closed-world
evidence contract enforced across both.

## The two paths

```
                            user/config/cv.json            (canonical, JSON Resume superset)
                                  │
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
    ┌────────────────────────┐         ┌────────────────────────────┐
    │ Deterministic          │         │ Tailored (modes/tailor.md) │
    │ cv-project.mjs         │         │ cv-draft.mjs context       │
    │ (zero-token; subset    │         │   → session drafts against │
    │  of cv.json — source-  │         │     a specific JD          │
    │  true by construction) │         │   → cv-draft.mjs finalize  │
    └──────────┬─────────────┘         │            │               │
               │                       │   cv-validate.mjs          │
               │                       │   (Rules A/B/C/D/L —       │
               │                       │    hard-fail closed-world) │
               │                       │            │               │
               │                       │            ▼               │
               │                       │   cv-fact-check.mjs        │
               │                       │   (parallel: GPT ATS sim + │
               │                       │    Gemini fact-check)      │
               │                       └────────────┬───────────────┘
               ▼                                    ▼
      Generic CV (LinkedIn,                Per-JD application CV
      personal site, recruiter)            (with fact-check walkthrough)
```

The deterministic path is the safe default for *unsupervised* artifacts. The
tailored path is for *supervised* per-application tailoring, where you review
every finding before the PDF renders.

## Canonical data

`user/config/cv.json` is a [JSON Resume](https://jsonresume.org) v1.0.0 *superset* —
themes are deliberately unused; the project renders it itself, so the schema
extends freely. The fields specific to this pipeline:

| Field | Purpose | Authored or derived |
|---|---|---|
| `basics.{name,contactLine,summary}` | Identity + headline | Authored (`name`/`contactLine` projected from `profile.md` at render) |
| `skills_inventory[]` | Closed-world pool for Core Competencies (validator Rule D) | Authored |
| `evidence_refs{skill: [bulletId]}` | Skill ↔ bullet overlap map (informational) | Derived (`buildEvidenceRefs`, recomputed on `cv-migrate`) |
| `languages_line` | Round-tripped as-is | Authored |
| `work[].{position,company,slug,...}` | Role headers | Authored; `slug` deterministic from company |
| `work[].highlights[]` and `subEntries[].highlights[]` | Bullets, the evidence atoms | See below |

Each highlight:

```jsonc
{
  "id": "acme-b3",             // stable across edits; never reassigned by index
  "text": "Co-created GTM strategy with C-suite ...",
  "tier": "core",                  // optional, JSON-only authored metadata
  "archetypes": ["product"]        // optional, JSON-only authored metadata
}
```

`tier` and `archetypes` are **JSON-only** (same class as `skills_inventory` and
`evidence_refs`) — they never render into `cv.md`. They are *authored*, not
derivable; see [Authored metadata preservation](#authored-metadata-preservation).

## File-by-file

| File | Role |
|---|---|
| `cv-schema.mjs` | One source of truth for parse, serialize, id assignment, `eachHighlight`, `collectSourceIds`, `buildEvidenceRefs`, `mergeAuthoredMetadata`, `identityFromProfile`. Every other CV script imports from here. |
| `cv-md-to-json.mjs` (`pnpm cv-migrate`) | Markdown → JSON. Re-parses `cv.md`, recomputes `evidence_refs`, **merges authored `tier`/`archetypes` from the prior `cv.json` by stable id** so prose edits never wipe prioritization. |
| `cv-json-to-md.mjs` (`pnpm cv-build`, `pnpm cv-check`) | JSON → derived markdown view (identity projected from `profile.md`). `--annotate-ids --stdout` emits the id-annotated source view used by the generator/validator. `--check` is the round-trip gate. |
| `cv-project.mjs` (`pnpm cv-project`) | Deterministic projection: filters highlights by `--tier`, `--archetype`, `--budget`; prunes empty roles; emits projected `cv.json` or derived markdown. Zero tokens. |
| `cv-draft.mjs` (`pnpm cv-draft`) | Deterministic bookends of the in-session draft. `context {NUM}` prints `prompts/ats-prompt.md` filled with the id-annotated `cv.json`, confirmed `notes.yml`, `story-bank.md`, the latest `user/data/reports/{NUM}-*.md`, and the JD, plus the draft path. `finalize {draft}` extracts `<bridges>`/`<gaps>`, runs `cv-validate.mjs`, strips `[src:]` tags, projects everything but Summary / competency selection / bullets from `profile.md` + `cv.json`, normalizes ATS unicode, and writes `{NUM}-{slug}-cv.md` + `-trace.json`. |
| `cv-validate.mjs` | Hard-fail validator: Rule A (every bullet has `[src: id]`), B (every cited id resolves), C (high-risk entities present in cited source; <0.12 token overlap is a soft flag for the judge), D (Core Competencies ⊆ `skills_inventory ∪ aliases.yml`), L (Summary ≤ 85 words, bullets ≤ 25 words, one `[src: id]` per bullet). On fail, `cv-draft.mjs finalize` prints the `<failed_constraints>` block and exits non-zero; the session fixes the draft and reruns. Never auto-revises. |
| `cv-fact-check.mjs` (`pnpm fact-check`) | Review pass: two parallel calls — ATS criteria simulation (CV text only; `REVIEW_MODEL`, same family as Ashby's evaluator) + citation-grounded fact-check (`FACTCHECK_MODEL`, a third model family). Computes met/total and expected×verdict deviations in Node; merges both into the review JSON consumed by the dashboard walkthrough. Independent control from the validator. |
| `cv-status.mjs` | Deterministic, zero-token CV health check used by `modes/cv.md`. File presence, coverage, quantification, tier/archetype distribution, story-bank gaps, keyword-aggregation eligibility, integrity. Composite score + prioritized next actions. |
| `keyword-frequency.mjs` (`pnpm kw-analysis`) | Cross-report keyword aggregation with `--min-score` weighting and `strong/partial/gap` coverage classification. Advisory input to `modes/cv.md` — never the selection authority. |
| `prompts/ats-prompt.md`, `prompts/cv-review-prompt.md`, `prompts/ats-sim-prompt.md` | Generator, fact-checker, and ATS-simulator system prompts. Generic; candidate specifics injected at run time. |

## The deterministic path

`cv-project.mjs` is the mechanism for the generic CV (LinkedIn, personal site,
recruiter sends). It is a strict subset of `cv.json`, so it cannot fabricate
anything by construction — no validator, no judge needed.

```bash
pnpm cv-project --archetype design --budget 18
pnpm cv-project --tier core              # tightest spine
pnpm cv-project --archetype ai --json    # filtered cv.json
```

Selection rules:

- `tier`: `core` always included (the CV's spine); `default` included unless
  trimmed by `--budget` or `--tier core`; `depth` only with `--tier depth`.
- `archetype`: a highlight passes if its `archetypes` is empty (universal) or
  contains the requested archetype.
- `--budget N`: never trims `core` (warns if `core` alone exceeds `N`); fills
  `default` then `depth` in original order until `N` is reached; preserves
  original bullet order in the output.

## The tailored path

Same canonical input, JD-aware rewrite, drafted by the interactive tailor
session (`modes/tailor.md`) — no generator API call. One
`node lib/cv-draft.mjs context {NUM}` call gives the session:

- The **id-annotated** CV (`cv-json-to-md.mjs --annotate-ids --stdout`)
- Confirmed `user/config/notes.yml` (`n#` ids)
- `user/config/story-bank.md` (`S0xx` ids)
- The latest `user/data/reports/{NUM}-*-{date}.md` (Block-A Match ids are valid `[src:]`
  targets; Block-A Gaps are forbidden)
- The JD (`user/data/jds/{NUM}-*.md`) — wording only, never evidence
- The contract itself (`prompts/ats-prompt.md`) and the draft path to write

**Closed-world evidence**: every emitted bullet's `[src: id]` must point at a
real `cv.json` bullet id, story-bank id, confirmed note, or Block-A match. The
Summary ends a composite `[src: …]`. Core Competencies is closed-world over
`cv.json.skills_inventory ∪ user/config/aliases.yml`. The validator hard-fails any
violation: `cv-draft.mjs finalize` prints the `<failed_constraints>` block,
exits non-zero, and writes nothing. The session fixes the draft in front of the
user and reruns until it passes (no retry cap). On pass, only the Summary, the
competency selection, and the bullets survive from the draft; identity comes
from `profile.md`, and the headline, role and sub-entry headings, dates
(including `subEntries[].dateRange`), meta lines, descriptions, languages, and
education come from `cv.json`.

Bridges (CV↔JD vocabulary substitutions) are traced in
`user/output/customized-cvs/{NUM}-{slug}-trace.json` and consumed by the judge. The
judge's Stage-A simulation scores the CV against the report's Criteria ledger
(report-only — it never injects text into the CV).

## Authored metadata preservation

`tier` and `archetypes` are authored on highlights but invisible to `cv.md`
(same as `skills_inventory` and `evidence_refs`). Without intervention, every
`pnpm cv-migrate` would silently wipe them — `cv.md` carries no such fields, and
re-parsing produces a fresh `{id, text}` highlight. `cv-schema.mjs` exports
`mergeAuthoredMetadata(parsed, prev)`: `cv-md-to-json.mjs` reads the prior
`cv.json` *before* overwriting and re-attaches `tier`/`archetypes` to each
parsed highlight by stable id. Ids are deterministic from structure, so an
unchanged `cv.md` re-parses to the same ids and the merge is exact.

`evidence_refs` doesn't need the merge — it is recomputed deterministically by
`buildEvidenceRefs` against the (possibly expanded) `skills_inventory`.

## Health & optimization

`/career-ops cv` (see `modes/cv.md`) drives the full lifecycle, from "CV on
disk" to "as good as it gets":

1. `cv-status.mjs` reports file presence, bullet coverage per role/tier/
   archetype, quantification ratio, `skills_inventory` size, `evidence_refs`
   coverage, story-bank gaps (distinctive-token overlap), duplicate story ids,
   keyword-aggregation eligibility, writing heuristics, data integrity, and a
   composite 0–100 score with a prioritized next-actions list.
2. If ≥10 applications scored ≥3.5 exist, `keyword-frequency.mjs` is run as an
   *advisor* — proposing tier promotions, ordering changes, and
   `skills_inventory` additions. The user decides; the explicit data file stays
   the selection authority.
3. The mode walks each next-action interactively (story to surface, bullet to
   quantify, skill to add, tier to assign), proposes the change, and applies it
   on approval.

## Onboarding → optimal

```
user-template/config/cv.md → user/config/cv.md  → pnpm cv-migrate  →  user/config/cv.json
                                                                       │
                                                              /career-ops cv
                                                                       │
                                              cv-status → checklist → apply → re-check
                                                                       │
                                            ───────────────┴───────────────
                                            ▼                             ▼
                                     pnpm cv-project           /career-ops tailor
                                     (generic CV out)          (per-JD, supervised)
```

Run `pnpm cv-check` after any edit cycle — the round-trip gate confirms the
serializer and parser still agree.
