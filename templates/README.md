# Templates

Template files used by career-ops scripts and modes. User-specific customizations go in the user-layer files under `user/config/` — the private user-data repo (see the "Layout" section of the top-level README). CV / cover-letter stylesheets and self-hosted fonts live in `style/`, not here.

## Files

| File | Used By | Purpose |
|------|---------|---------|
| `report.example.md` | `lib/eval-context.mjs` (`modes/_eval.md`) | Target look and feel for evaluation reports |
| `states.yml` | `lib/verify-pipeline.mjs`, `lib/normalize-statuses.mjs`, `merge-tracker.mjs` | Canonical application states and aliases, plus the outcome-column vocabularies (`outcome`) |

Starter user data (CV, profile, portals, story bank, notes, aliases, empty tracker) is not here. It lives in `user-template/`, which mirrors the `user/` layout; see `user-template/README.md`.

> **Note:** the CV-generator and fact-checker prompts are *not* templates. They are generic system prompts that ship ready-to-run at `lib/prompts/ats-prompt.md` and `lib/prompts/cv-review-prompt.md`, read directly by `lib/cv-draft.mjs context` (printed for the tailor session) / `lib/cv-fact-check.mjs`. No copy step; candidate specifics are filled in at run time from `user/config/cv.md`, `user/config/profile.md`, the evaluation report, and `user/config/story-bank.md`.

### states.yml

Defines the canonical application states (`Fetched`, `Skipped-Location`, `Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`) with aliases. All pipeline scripts validate statuses against this file.

**Do not rename states** — the dashboard and all scripts depend on these IDs. Add aliases if you encounter new variants that should map to an existing state.
