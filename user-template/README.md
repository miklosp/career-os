# user-template

Starter layout for `user/`, the private user-data repo. Every path career-ops
reads or writes for you (`config/`, `data/`, `output/`, `transcripts/`) lives
there, resolved through `lib/paths.mjs`.

1. Copy the template (run from the repo root; `user/` is gitignored by the
   main repo):

   ```bash
   mkdir -p user && cp -R user-template/. user/
   ```

2. Make it a git repo:

   ```bash
   git -C user init && git -C user add -A && git -C user commit -m "chore: initial user data"
   ```

3. Optional: push it to a private remote (on another machine,
   `git clone <private-data-remote> user` from the repo root):

   ```bash
   git -C user remote add origin <private-data-remote>
   git -C user push -u origin HEAD
   ```

4. Run `/career-ops onboarding` in Claude Code. It replaces the placeholder CV,
   profile, and portals with yours.

`config/cv.json` is the canonical CV. `config/cv.md` is derived from it
(`pnpm cv-build`). To start from prose instead, edit `config/cv.md` and run
`pnpm cv-migrate`. `data/scan-history.db` is created on first scan.
