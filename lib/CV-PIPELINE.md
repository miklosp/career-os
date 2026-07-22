# CV Pipeline

Subsystem map for everything CV-related in `lib/`. One canonical source
(`config/cv.json`), two generation paths (deterministic projection and
LLM-tailored rewrite), one closed-world evidence contract enforced across both.

## The two paths

```
                            config/cv.json            (canonical, JSON Resume superset)
                                  │
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
    ┌────────────────────────┐         ┌────────────────────────────┐
    │ Deterministic          │         │ LLM-tailored               │
    │ cv-project.mjs         │         │ generate-cv-llm.mjs        │
    │ (zero-token; subset    │         │ (Opus via Bifrost; rewrites│
    │  of cv.json — source-  │         │  against a specific JD)    │
    │  true by construction) │         │            │               │
    └──────────┬─────────────┘         │            ▼               │
               │                       │   cv-validate.mjs          │
               │                       │   (Rules A/B/C/D —         │
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
LLM path is for *supervised* per-application tailoring, where you review every
finding before the PDF renders.

## Canonical data

`config/cv.json` is a [JSON Resume](https://jsonresume.org) v1.0.0 *superset* —
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
  "id": "secberus-b3",             // stable across edits; never reassigned by index
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
| `generate-cv-llm.mjs` (`pnpm cv-llm`) | Per-JD tailored rewrite. Opus reads `cv.json` (id-annotated), confirmed `notes.yml`, `story-bank.md`, and the latest `data/reports/{NUM}-*.md`. Every output bullet must end `[src: id]`; Summary ends a composite `[src: …]`. |
| `cv-validate.mjs` | Hard-fail validator: Rule A (every bullet has `[src: id]`), B (≥0.12 token overlap with cited source — soft flag for the judge), C (high-risk entities present in cited source), D (Core Competencies ⊆ `skills_inventory ∪ aliases.yml`). On fail, retries the generator with a `<failed_constraints>` diff (max 2) then surfaces — never auto-revises. |
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

## The LLM-tailored path

Same canonical input, JD-aware rewrite. The generator gets:

- The **id-annotated** CV (`cv-json-to-md.mjs --annotate-ids --stdout`)
- Confirmed `config/notes.yml` (`n#` ids)
- `config/story-bank.md` (`S0xx` ids)
- The latest `data/reports/{NUM}-*-{date}.md` (Block-A Match ids are valid `[src:]`
  targets; Block-A Gaps are forbidden)

**Closed-world evidence**: every emitted bullet's `[src: id]` must point at a
real `cv.json` bullet id, story-bank id, confirmed note, or Block-A match. The
Summary ends a composite `[src: …]`. Core Competencies is closed-world over
`cv.json.skills_inventory ∪ config/aliases.yml`. The validator hard-fails any
violation; on fail it retries the generator with a `<failed_constraints>` block
(max 2) then **surfaces** (non-zero exit) — it never auto-revises silently.

Bridges (CV↔JD vocabulary substitutions) are traced in
`output/customized-cvs/{NUM}-{slug}-trace.json` and consumed by the judge. The
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
templates/cv.example.md  →  config/cv.md  →  pnpm cv-migrate  →  config/cv.json
                                                                       │
                                                              /career-ops cv
                                                                       │
                                              cv-status → checklist → apply → re-check
                                                                       │
                                            ───────────────┴───────────────
                                            ▼                             ▼
                                     pnpm cv-project           generate-cv-llm
                                     (generic CV out)          (per-JD, supervised)
```

Run `pnpm cv-check` after any edit cycle — the round-trip gate confirms the
serializer and parser still agree.
