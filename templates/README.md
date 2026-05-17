# Templates

Template files used by career-ops scripts and modes. User-specific customizations go in the user-layer files under `config/` (see the "Layout" section of the top-level README). CV / cover-letter stylesheets and self-hosted fonts live in `style/`, not here.

## Files

| File | Used By | Purpose |
|------|---------|---------|
| `cv.example.md` | Onboarding | Skeleton CV — copy to `config/cv.md` and fill in |
| `profile.example.md` | Onboarding | Example candidate profile — frontmatter (identity, location policy, tooling) + markdown body (archetypes, narrative, voice, scoring). Copy to `config/profile.md` and fill in. |
| `portals.example.yml` | Onboarding | Example portal scanner configuration (copy to `config/portals.yml` to activate) |
| `story-bank.example.md` | Onboarding | Empty STAR+R story bank — copy to `config/story-bank.md`; evaluations append here |
| `states.yml` | `lib/verify-pipeline.mjs`, `lib/normalize-statuses.mjs`, `merge-tracker.mjs` | Canonical application states and aliases |

### portals.example.yml

Pre-configured scanner with 45+ tracked companies and search queries. Title filters, career page URLs, Greenhouse/Ashby/Lever endpoints, WebSearch queries.

**To activate:** `cp templates/portals.example.yml config/portals.yml` and customize `title_filter.positive` for your target roles.

### profile.example.md

Single source of truth for personal data. **YAML frontmatter** carries the structured contracts the system parses (`candidate` → CV identity header, `location_policy` → skip gate, `tooling` → dashboard apply launcher). The **markdown body** carries everything LLM modes read as prose: archetypes, adaptive framing, exit narrative, voice & branding, comp anchor, scoring adjustments. Coaching session state lives separately in `data/active-strategy.md`.

**To activate:** `cp templates/profile.example.md config/profile.md` and fill in your details.

### cv.example.md

Skeleton CV with placeholder sections (Summary, Core Competencies, Experience, Education) and inline `<!-- … -->` guidance. **To activate:** `cp templates/cv.example.md config/cv.md` and replace the placeholders with your actual content.

### story-bank.example.md

Empty STAR+R story bank with the format guide. **To activate:** `cp templates/story-bank.example.md config/story-bank.md`. Evaluations (Block F of `/career-ops`) append new stories under `## Stories` automatically.

> **Note:** the CV-generator and fact-checker prompts are *not* templates. They are generic system prompts that ship ready-to-run at `lib/prompts/ats-prompt.md` and `lib/prompts/cv-review-prompt.md`, read directly by `lib/generate-cv-llm.mjs` / `lib/cv-fact-check.mjs`. No copy step; candidate specifics are injected at run time from `config/cv.md`, `config/profile.md`, the evaluation report, and `config/story-bank.md`.

### states.yml

Defines the canonical application states (`Fetched`, `Skipped-Location`, `Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`) with aliases. All pipeline scripts validate statuses against this file.

**Do not rename states** — the dashboard and all scripts depend on these IDs. Add aliases if you encounter new variants that should map to an existing state.
