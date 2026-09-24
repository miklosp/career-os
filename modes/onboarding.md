# Onboarding — first-run setup

Bring a freshly-cloned repo to a working state: canonical CV, profile, portals,
and an empty tracker. Runs when `user/` is missing or still holds template
placeholders (auto-detected by the session — see `CLAUDE.md`) or on demand via
`/career-ops onboarding`.

**Required files:** `user/config/cv.json`, `user/config/profile.md`,
`user/config/portals.yml`, with the template placeholders (`Your Name`,
`Jane Smith`) replaced.

**User-data repo.** Everything the user owns lives in `user/` (paths resolve
through `lib/paths.mjs`; `CAREER_OPS_USER_DIR` overrides the location). If the
user has a data repo already, clone it: `git clone <private-data-remote> user`. On a
true first run with no data repo yet, copy the starter layout and make it a repo:
`mkdir -p user && cp -R user-template/. user/ && git -C user init` (remote
steps: `user-template/README.md`). The copy brings the placeholder
config files and an empty tracker; the steps below replace the placeholders.

**Do nothing else until the basics exist.** Walk the user through, in order:

1. **CV** — offer three ways in: paste CV / paste LinkedIn / describe experience.
   Rewrite the placeholder `user/config/cv.md` as clean prose (Summary, Core
   Competencies, Experience, Education) in the `lib/cv-schema.mjs` shape, then
   `pnpm cv-migrate` to produce the canonical `user/config/cv.json`. Thereafter
   `user/config/cv.json` is the source of truth; regenerate the human-readable
   view with `pnpm cv-build`.

2. **Profile** — in `user/config/profile.md`, collect name, email, location,
   timezone, target roles, and salary range into the frontmatter (`candidate`, `location_policy`). Archetypes / narrative /
   voice go in the markdown body.

3. **Portals** — in `user/config/portals.yml`, align `title_filter.positive`
   with the target roles from step 2.

4. **Tracker** — `user/data/applications.md` ships with the header row only;
   confirm it exists (restore from `user-template/data/applications.md` if not).

5. **Deepen** — ask for superpower, energizers / drainers, deal-breakers, lead
   achievement, and any published work. Store in `user/config/profile.md`.

6. **Confirm ready.** Offer recurring scan automation via `/loop` or `/schedule`
   if available, else suggest cron.

**After onboarding, keep learning.** Score-too-high / missed-experience feedback
updates `user/config/profile.md` — never system-layer files under `modes/` or `lib/`.
