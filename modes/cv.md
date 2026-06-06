# Mode: cv — CV Health & Optimization

When the user runs `/career-ops cv {status|optimize|onboard}`, run this mode. It is the home for the full CV lifecycle, from "I have nothing in `config/`" to "my CV is as good as it gets." All scoring and gap detection is deterministic — handled by `lib/cv-status.mjs`. This mode reads the report and walks the user through the resulting next-actions interactively.

This mode is **interactive**. Edits go to `config/cv.json` (and `config/story-bank.md` when renumbering), but only with explicit per-item approval. Never auto-apply a batch.

For the full subsystem map (the two generation paths, provenance contract, validator/judge), read `lib/CV-PIPELINE.md`.

## Subcommand routing

| Subcommand | Behavior |
|------------|----------|
| `status` | Read-only. Run `lib/cv-status.mjs` and present the score + sections + top actions. No prompts, no edits. |
| `optimize` (default) | Status + interactive walk through the next-actions list, one item at a time, until the user stops or the report has no gain remaining. |
| `onboard` | Triggered explicitly, or automatically when `config/cv.json` is missing. Drives the user from nothing to a working `cv.json`. |

If no subcommand is given, default to `optimize`. Resolve onboarding-state first regardless: if `config/cv.json` is missing, run `onboard` even if the user asked for `optimize`.

---

## Inputs

1. `lib/cv-status.mjs` — deterministic health check. Always run with `--json` so the structured report drives the walk; render the human form to the user from the JSON, or run a second time without `--json` and surface the pretty output verbatim.
2. `config/cv.json` — canonical CV; you may read and edit, by id.
3. `config/story-bank.md` — for story walks and duplicate-id renumbering.
4. `config/profile.md` — archetype vocabulary (`product` / `ai` / `design`), candidate identity.
5. `lib/keyword-frequency.mjs` — only run on demand from this mode, and only when `cv-status` reports `meta.keywordAggEligible: true`.
6. `lib/CV-PIPELINE.md` — read once if the user asks "what does X mean".

Never modify `config/cv.md` directly. It is derived from `cv.json` (`pnpm cv-build`); run that after a batch of `cv.json` edits if the user wants the markdown view refreshed.

---

## `status` — read-only

```
node lib/cv-status.mjs
```

Present the output as-is. Add one sentence pointing at `/career-ops cv optimize` if any next-actions are listed.

---

## `onboard` — from zero to `cv.json`

Reached automatically when `config/cv.json` is missing. Walk the user through, in this order:

1. **Source.** Offer three on-ramps:
   - Paste their existing CV (markdown or plain text).
   - Paste their LinkedIn profile (About + Experience).
   - Dictate experience in natural language; you do the structuring.
2. **Draft `config/cv.md`** in the `lib/cv-schema.mjs` shape: `# Name`, contact line, `## Summary`, `## Core Competencies` (comma-separated), `## Experience` with `### Position - Company` headings, optional dateRange/metaRaw lines, `::: description :::` block, then `-` bullets. Sub-roles get `**Name** - context` subheadings under the parent role.
3. **Migrate.** Run `pnpm cv-migrate` — produces the canonical `config/cv.json` with stable per-bullet ids.
4. **Skills_inventory.** If the Core Competencies line is thin (<10 entries), ask which skills they can genuinely defend in an interview and append them.
5. **Round-trip gate.** `pnpm cv-check` — must pass; if it fails, surface the diff and fix the underlying markdown shape before continuing.
6. Hand off to `optimize` for everything else (tiering, archetype tagging, story-bank, metrics).

`tier` and `archetypes` are **not** assigned during onboarding — they go on after the structure is in place, during the optimize walk. This keeps onboarding short and avoids asking the user to make prioritization judgments before they see the full pool.

---

## `optimize` — drive the score to the target

### Step 1: snapshot

Run `node lib/cv-status.mjs --json` and capture the JSON. Show the user:

- The composite score (`score / max`) and a one-line summary of each section's score.
- The top 3–5 `next_actions` with their `gain`.

Then ask: *"Work through these now? I'll take them one at a time; you approve each change."*

### Step 2: walk actions

For each action in `next_actions` order, route by kind:

**Duplicate story ids (`storybank` / `integrity` priority ~92–95)**
Read `config/story-bank.md`, locate the duplicated `**ID:** SXXX` lines, propose new ids that don't collide (next free `S0NN`), and Edit them in. Confirm before each. The S0XX placeholder template (if present) is *not* a duplicate — leave it.

**Untagged bullets / low core / low default (`tiering`)**
For each untagged bullet (or all, if the user wants a bulk pass), present:
- The bullet text + its current role/sub-entry.
- A proposed `tier` (use judgment: outcome metrics → `core`; supporting context → `default`; process detail / long-tail → `depth`) and `archetypes` (drawn from `config/profile.md` table; `[]` if the bullet is universal leadership / outcome).
Apply with a small Edit to `cv.json`. Re-run `cv-status` every ~5 changes to track score progress.

**Underrepresented story (`storybank`)**
Read the story body, ask the user which CV role it belongs under, and draft a CV bullet that:
- Cites real artifacts from the story (number, project name, outcome).
- Stays one sentence, 12–22 words.
- Includes a token that will match Rule C if cited from this story id later.
Append it to the role's `highlights` (or the relevant `subEntries` slot) with a fresh id `<role-slug>-b<next>`. Confirm before writing.

**Unquantified bullet (`quantified`)**
Read the bullet aloud and ask for the number that belongs there ("how many users", "what %", "what duration"). Never invent. If the user can't recall, mark `skip` and move on — *don't* paraphrase to hide the gap.

**Skills inventory expansion (`skills`)**
If the action calls for inventory growth, propose specific additions evidenced by existing bullets. If `meta.keywordAggEligible` is true, offer to run `pnpm kw-analysis --min-score 3.5` first — its `gap`-classified keywords are the strongest signal for what to add. Each addition needs the user's nod; this list is closed-world for every generated CV.

**Run-on / too-short bullets (`writing`)**
For >40-word bullets: propose a split into two atomic bullets (each will get its own `[src: id]` under Rule A). For <6-word bullets: propose an expanded version with concrete context. Apply on approval.

**Coverage shortfalls (`coverage`)**
If a role has <3 bullets, ask the user to describe one more accomplishment; draft a bullet, confirm, append. If an archetype is under-covered, identify universal bullets in `cv.json` that genuinely belong to that archetype and propose adding the archetype tag — *don't* tag bullets that aren't really about that archetype.

### Step 3: keyword aggregation (only when eligible)

Run `node lib/keyword-frequency.mjs --min-score 3.5 --json` and treat the output as **advisory**:

- `gap` keywords appearing in many JDs → propose as `skills_inventory` additions or as bullet-rewording prompts (only if the user actually has the experience).
- `partial` keywords → propose tightening one existing bullet's wording to cover the term.

Never auto-apply keyword-driven changes. The aggregation reflects market frequency, not your differentiation; treat it as a coach, not a selector.

### Step 4: round trip + re-score

After a batch of `cv.json` edits:

```
pnpm cv-build   # regenerate config/cv.md so the view matches
pnpm cv-check   # round-trip gate
node lib/cv-status.mjs   # new score
```

Tell the user the delta. If gain remains and they want to continue, loop to Step 2 with the refreshed actions. Otherwise stop.

---

## Guardrails

- **No invention.** Numbers come from the user; story-derived bullets cite the story's actual facts. If the user can't supply a metric, mark the bullet skipped, not fudged.
- **Edits are explicit.** One bullet's tier change per Edit when interactive; only batch when the user says "do all of these like that."
- **`cv.md` is derived.** Edit `cv.json`; regenerate `cv.md` after a batch. Never hand-edit `cv.md` here.
- **Authored metadata survives `cv-migrate`.** `lib/cv-schema.mjs` merges `tier`/`archetypes` from the prior `cv.json` by stable id — but if the user *changes the bullet text in cv.md* in a way that shifts the id (e.g., renames a role/subEntry slug), the id changes and the metadata won't merge. After any structural rename, re-tier the affected bullets.
- **Pipeline integrity rules still apply.** This mode does not touch `data/applications.md`, `data/tracker-additions/`, or any scoring/scan artifact. CV only.
