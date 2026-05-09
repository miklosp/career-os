# Templates

System-layer template files used by career-ops scripts and modes. Auto-updated with each release. Put user-specific customizations in the user-layer files under `data/` (see DATA_CONTRACT.md).

## Files

| File | Used By | Purpose |
|------|---------|---------|
| `cv-template.css` | `render-cv-pdf.py` | Stylesheet for ATS-optimized CV PDFs (WeasyPrint) |
| `portals.example.yml` | Onboarding | Example portal scanner configuration (copy to `config/portals.yml` to activate) |
| `profile.example.yml` | Onboarding | Example candidate profile (copy to `config/profile.yml` and fill in) |
| `_profile.template.md` | Onboarding | Template for `config/_profile.md` user customization file |
| `states.yml` | `verify-pipeline.mjs`, `normalize-statuses.mjs`, `merge-tracker.mjs` | Canonical application states and aliases |

### cv-template.css

Applied by `render-cv-pdf.py` (WeasyPrint) to the LLM-generated markdown CV. Page size (`A4` / `letter`) is injected at render time based on the `--format` flag; the CSS file itself is format-agnostic.

**Design:** Inter body, JetBrains Mono role metadata, single-column ATS-safe layout, self-hosted fonts from `fonts/`.

### portals.example.yml

Pre-configured scanner with 45+ tracked companies and search queries. Title filters, career page URLs, Greenhouse/Ashby/Lever endpoints, WebSearch queries.

**To activate:** `cp templates/portals.example.yml config/portals.yml` and customize `title_filter.positive` for your target roles.

### profile.example.yml

Example `config/profile.yml` with all fields: candidate identity, target roles, archetypes, narrative, compensation, location (+ `location_policy` for the skip gate).

**To activate:** `cp templates/profile.example.yml config/profile.yml` and fill in your details.

### _profile.template.md

Example `config/_profile.md` — archetype framing, narrative, negotiation scripts. Copied in silently on first run if missing.

### states.yml

Defines the canonical application states (`Fetched`, `Skipped-Location`, `Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`) with aliases. All pipeline scripts validate statuses against this file.

**Do not rename states** — the dashboard and all scripts depend on these IDs. Add aliases if you encounter new variants that should map to an existing state.
