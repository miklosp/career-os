# Templates

Template files used by career-ops scripts and modes. User-specific customizations go in the user-layer files under `config/` (see the "Layout" section of the top-level README). CV / cover-letter stylesheets and self-hosted fonts live in `style/`, not here.

## Files

| File | Used By | Purpose |
|------|---------|---------|
| `cv.example.md` | Onboarding | Skeleton CV — copy to `config/cv.md` and fill in |
| `profile.example.yml` | Onboarding | Example candidate profile (copy to `config/profile.yml` and fill in) |
| `_profile.template.md` | Onboarding | Template for `config/_profile.md` user customization file |
| `portals.example.yml` | Onboarding | Example portal scanner configuration (copy to `config/portals.yml` to activate) |
| `story-bank.example.md` | Onboarding | Empty STAR+R story bank — copy to `config/story-bank.md`; evaluations append here |
| `ats-prompt.example.md` | `lib/generate-cv-llm.mjs` | LLM prompt for the CV generator — copy to `config/ats-prompt.md` and customize the candidate-context paragraph |
| `cv-review-prompt.example.md` | `lib/cv-fact-check.mjs` | Fact-checker prompt — copy to `config/cv-review-prompt.md` (fully generic, no edits needed) |
| `states.yml` | `lib/verify-pipeline.mjs`, `lib/normalize-statuses.mjs`, `merge-tracker.mjs` | Canonical application states and aliases |

### portals.example.yml

Pre-configured scanner with 45+ tracked companies and search queries. Title filters, career page URLs, Greenhouse/Ashby/Lever endpoints, WebSearch queries.

**To activate:** `cp templates/portals.example.yml config/portals.yml` and customize `title_filter.positive` for your target roles.

### profile.example.yml

Example `config/profile.yml` with all fields: candidate identity, target roles, archetypes, narrative, compensation, location (+ `location_policy` for the skip gate).

**To activate:** `cp templates/profile.example.yml config/profile.yml` and fill in your details.

### _profile.template.md

Example `config/_profile.md` — archetype framing, narrative, negotiation scripts. Copied in silently on first run if missing.

### cv.example.md

Skeleton CV with placeholder sections (Summary, Core Competencies, Experience, Education) and inline `<!-- … -->` guidance. **To activate:** `cp templates/cv.example.md config/cv.md` and replace the placeholders with your actual content.

### story-bank.example.md

Empty STAR+R story bank with the format guide. **To activate:** `cp templates/story-bank.example.md config/story-bank.md`. Evaluations (Block F of `/career-ops`) append new stories under `## Stories` automatically.

### ats-prompt.example.md

LLM prompt that drives `lib/generate-cv-llm.mjs`. **To activate:** `cp templates/ats-prompt.example.md config/ats-prompt.md` and customize the "Context About the Candidate" paragraph + Rule 8 (Consultancy Framing) to fit your situation. The script reads `config/ats-prompt.md` directly at run time.

### cv-review-prompt.example.md

LLM prompt for the independent fact-checker (`lib/cv-fact-check.mjs`). Fully generic — no per-user edits needed. **To activate:** `cp templates/cv-review-prompt.example.md config/cv-review-prompt.md`.

### states.yml

Defines the canonical application states (`Fetched`, `Skipped-Location`, `Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`) with aliases. All pipeline scripts validate statuses against this file.

**Do not rename states** — the dashboard and all scripts depend on these IDs. Add aliases if you encounter new variants that should map to an existing state.
