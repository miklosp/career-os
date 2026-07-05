# Onboarding — first-run setup

Bring a freshly-cloned repo to a working state: canonical CV, profile, portals,
and an empty tracker. Runs when a required config file is missing (auto-detected
by the session — see `CLAUDE.md`) or on demand via `/career-ops onboarding`.

**Required files** (the real files, not `*.example`): `config/cv.json`,
`config/profile.md`, `config/portals.yml`. If `config/profile.md` is missing,
copy `templates/profile.example.md` → `config/profile.md` silently first.

**Do nothing else until the basics exist.** Walk the user through, in order:

1. **CV** — offer three ways in: paste CV / paste LinkedIn / describe experience.
   Write clean prose `config/cv.md` (Summary, Core Competencies, Experience,
   Education) in the `lib/cv-schema.mjs` shape, then `pnpm cv-migrate` to produce
   the canonical `config/cv.json`. Thereafter `config/cv.json` is the source of
   truth; regenerate the human-readable view with `pnpm cv-build`.

2. **Profile** — copy `templates/profile.example.md` → `config/profile.md`;
   collect name, email, location, timezone, target roles, and salary range into
   the frontmatter (`candidate`, `location_policy`). Archetypes / narrative /
   voice go in the markdown body.

3. **Portals** — copy `templates/portals.example.yml` → `config/portals.yml`;
   align `title_filter.positive` with the target roles from step 2.

4. **Tracker** — create `data/applications.md` with the header row
   `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |`.

5. **Deepen** — ask for superpower, energizers / drainers, deal-breakers, lead
   achievement, and any published work. Store in `config/profile.md`.

6. **Confirm ready.** Offer recurring scan automation via `/loop` or `/schedule`
   if available, else suggest cron.

**After onboarding, keep learning.** Score-too-high / missed-experience feedback
updates `config/profile.md` — never system-layer files under `modes/` or `lib/`.
