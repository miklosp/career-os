# Mode: apply — Live Application Assistant

Interactive mode for when the candidate is filling out an application form. Reads what's on screen, loads prior offer context, fills fields with customized answers, and always stops before Submit so the candidate reviews and sends.

## Browser prerequisite

Apply is the **one** mode that prefers the **cmux browser** over agent-browser. Decide once at the start of the flow and stick to it for the whole session:

- **`CMUX_WORKSPACE_ID` is set** *and* `cmux` is on PATH → **cmux path (preferred)**.
- Otherwise → **agent-browser fallback** (the original ephemeral headed-Chromium path).

This preference is scoped to apply only. Fetch / scan / scoring never use cmux — they keep agent-browser / Firecrawl / Playwright unchanged.

### cmux path (preferred)

The form opens in a visible cmux browser surface in the candidate's own workspace, on their real, already-logged-in profile. No ephemeral session, no profile dance, **no teardown**.

**Sandbox prerequisite (if this `claude` runs under Agent Safehouse — the `safe` wrapper).** cmux is driven through a Unix control socket at `$CMUX_SOCKET_PATH` (`~/Library/Application Support/cmux/cmux.sock`), using the `CMUX_*` env for socket + caller-workspace targeting. Safehouse is deny-by-default: it blocks that path and strips `CMUX_*`, so a sandboxed `claude` gets `Error: Socket not found` from every `cmux …` call.

- **Launched via the dashboard `a` key:** handled automatically. The (unsandboxed) dashboard injects `SAFEHOUSE_ENV_PASS=<all CMUX_* names>` and `SAFEHOUSE_ADD_DIRS=<dirname of CMUX_SOCKET_PATH>` into the spawned workspace, so the `safe` wrapper grants the socket dir + passes `CMUX_*` through. Nothing to do.
- **Launched manually** (`/career-ops apply …` typed in a sandboxed shell): the dashboard bridge isn't there. The repo ships a `.safehouse` workdir config granting the socket dir (`add-dirs=`), but Safehouse ignores it unless trusted — `export SAFEHOUSE_TRUST_WORKDIR_CONFIG=1` (or `safe --trust-workdir-config …`). The config format has **no env-pass key** (docs-confirmed: only `add-dirs`/`add-dirs-ro`), so `CMUX_*` passthrough still needs `--env-pass`/`SAFEHOUSE_ENV_PASS`. Full manual invocation:
  `SAFEHOUSE_TRUST_WORKDIR_CONFIG=1 safe --env-pass "$(env | sed -n 's/^\(CMUX_[^=]*\)=.*/\1/p' | paste -sd, -)" claude …` — or just fall back to the **agent-browser path**.

Verify once before relying on it: `cmux current-workspace` returns a workspace (not a socket error). macOS `sandbox-exec` can need more than a path grant to permit `connect()` on an AF_UNIX socket — this check is the proof, not an assumption. If it errors and can't be fixed → use the **agent-browser fallback**.

```bash
cmux --json browser open "<application URL>"   # → note the returned surface ref, e.g. surface:7
cmux browser surface:7 get url                 # confirm navigation landed
cmux browser surface:7 snapshot -i             # interactive refs — bare eN (NO @ prefix)
```

Reuse the one `surface:N` for the entire flow. Fill / interact:

```bash
cmux browser surface:7 fill eN "..."
cmux browser surface:7 click eN
```

**File uploads (Resume / CV PDF): cmux has no upload command.** Do NOT try to script the file input. Tell the candidate the exact PDF path (`output/customized-cvs/{NUM}-*-cv.pdf`) and ask them to attach it themselves in the visible surface — the native file picker is theirs to drive. This is the one capability the agent-browser path has that cmux doesn't; it is an accepted trade for the persistent-login + visible-surface benefits.

**Never close the surface.** It is the candidate's persistent browser, not an ephemeral session. There is no teardown step in the cmux path (Step 6.4 applies to the agent-browser fallback only).

### agent-browser fallback (no cmux)

Apply spawns an ephemeral headed Chromium via `agent-browser --session-name apply --headed`. No shared CDP port, no detect/ensure/launch dance, no profile collisions with fetch. The session name persists ATS cookies between apply runs (so a saved LinkedIn or Workday login survives), but the browser process itself starts fresh each session and **must** be torn down at the end of the apply flow (see Step 6.4).

Open it on demand:

```bash
agent-browser --session-name apply --headed open "<application URL>"
agent-browser --session-name apply snapshot -i   # interactive-only refs (@eN)
```

If a previous apply session is somehow still running, `agent-browser close --session-name apply` first to start clean.

#### One-time sandbox setup (macOS sandbox-claude)

If Claude Code is running inside `sandbox-exec` (the default), `agent-browser` and `chromium-full` must be enabled as optional integrations in the sandbox policy. Without this, `agent-browser` fails with `Failed to create socket directory: Operation not permitted` and Chromium fails with `sandbox initialization failed`.

Enable from outside the sandbox (exact flag depends on your harness; typical form):

```
sandbox-claude --allow agent-browser --allow chromium-full …
```

After this, verify with:

```bash
agent-browser --help          # should print without socket errors
```

#### Connect and navigate (once apply mode is up)

```bash
agent-browser --session-name apply open "<application URL>"
agent-browser --session-name apply snapshot -i    # interactive-only refs (@eN)
```

## Rules (both browsers)

- NEVER click the Submit/Send/Apply button. Fill everything, take a final screenshot, hand off to the candidate.
- Do not tick consent checkboxes that imply agreement to policies the candidate hasn't read — leave those for the candidate.
- Resume / CV PDF upload (PDF is typically in `output/customized-cvs/{NUM}-*-cv.pdf`):
  - **cmux path:** no upload command — give the candidate the exact PDF path and ask them to attach it themselves in the visible surface.
  - **agent-browser fallback:** `agent-browser --session-name apply upload @eN <pdf-path>`.
- After fill, screenshot top and bottom of the form to `/tmp/career-apply-screens/{NUM}-*.png` and present both to the candidate for review (`cmux browser surface:N screenshot --out <path>` or `agent-browser --session-name apply screenshot`).

## Fallback — no browser control

If the sandbox blocks `agent-browser` / `chromium-full` and the candidate cannot enable them, fall back to:
- The candidate shares a screenshot of the form (Read tool reads images)
- Or pastes the form questions as text
- Or says company + role so we can search for it

Claude drafts answers for copy-paste.

## Workflow

```
1. DETECT    → Read active Chrome tab (screenshot/URL/title)
2. IDENTIFY  → Extract company + role from the page
3. SEARCH    → Match against existing reports in data/reports/
4. LOAD      → Read full report + Section G (if it exists)
5. COMPARE   → Does the role on screen match the evaluated one? If changed → warn
6. ANALYZE   → Identify ALL visible form questions
7. GENERATE  → For each question, generate a customized answer
8. PRESENT   → Display answers formatted for copy-paste
```

## Step 1 — Detect the offer

**cmux path (preferred — `CMUX_WORKSPACE_ID` set):**
1. `cmux --json browser open "<URL>"` — note the returned `surface:N`.
2. `cmux browser surface:N snapshot -i` — grab bare `eN` refs for every interactive element.
3. Read title/URL via `cmux browser surface:N get url` and the snapshot header.

**agent-browser fallback (no cmux):**
1. `agent-browser --session-name apply --headed open "<URL>"` — spawns the headed browser on first call; subsequent commands reuse it within the session.
2. `agent-browser --session-name apply snapshot -i` — grab `@eN` refs for every interactive element.
3. Read title/URL from the snapshot header.

**No-browser fallback:** candidate shares a screenshot / pastes questions / names the company.

## Step 2 — Identify and search for context

1. Extract company name and role title from the page
2. Search in `data/reports/` by company name (Grep case-insensitive)
3. If match found → load the full report
4. If Section G exists → load prior draft answers as a base
5. If NO match found → notify and offer to run a quick auto-pipeline

## Step 3 — Detect role changes

If the role on screen differs from the evaluated one:
- **Warn the candidate**: "The role has changed from [X] to [Y]. Should I re-evaluate or adapt the answers to the new title?"
- **If adapting**: Adjust answers to the new role without re-evaluating
- **If re-evaluating**: Run full A-F evaluation, update report, regenerate Section G
- **Update tracker**: Change role title in applications.md if appropriate

## Step 4 — Analyze form questions

Identify ALL visible questions:
- Free text fields (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Salary fields (range, expectation)
- Upload fields (resume, cover letter PDF)

Classify each question:
- **Already answered in Section G** → adapt the existing answer
- **New question** → generate answer from the report + config/cv.md

## Step 5 — Generate answers

**Cover letter:** if the form allows one (free-text field or PDF upload), ALWAYS include it. Same visual design as the CV. Map JD quotes to proof points. One page max.

**MANDATORY: every free-text answer goes through the two passes below before it enters the form.** Short factual fields (name, phone, LinkedIn URL, Yes/No, dropdowns) are exempt. Everything the reviewer actually reads — cover notes, "why us", "why you", "tell us about a project", custom long-answer questions — gets both passes. The standards are in-repo; this mode is self-contained and depends on no external skill.

1. Draft from source material:
   - **Report context**: proof points from block B, STAR stories from block F
   - **Prior Section G**: if a draft answer exists, use it as a base and refine
   - **"I'm choosing you" tone**: same framework as auto-pipeline
   - **Specificity**: reference something concrete from the JD visible on screen
   - **Proof point**: include in "Additional info" if there is a field for it
2. **Voice pass** — rewrite the draft in the candidate's signature per `config/profile.md` → **Voice & Branding** (first person, proof-before-claim, builder's register, confident close). Keep every proof point.
3. **Scrub pass** — enforce `modes/_writing.md` §2–§4 on the result: kill corporate-speak and AI-tell vocabulary, strip AI-writing patterns (em-dash/rule-of-three/negative-parallelism/vague-attribution/filler), fix passive voice, vary structure. Then the §6 self-check.
4. Only after both passes: fill the field (cmux: `cmux browser surface:N fill eN "..."` / agent-browser: `agent-browser --session-name apply fill @eN "..."`) or present for copy-paste. Browser-filled text has no normalizer in its path — apply the §5 Unicode substitutions by hand.

Why mandatory: ATS reviewers and AI screeners both flag generic LLM output. Form answers are held to the same bar as the user's case studies — voice first, then a ruthless AI-tell scrub.

**Output format:**

```
## Answers for [Company] — [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### 1. [Exact form question]

[Answer ready for copy-paste — PLAIN TEXT, no blockquote `>`, no indentation, no wrapper characters. The candidate copies this directly into the form field.]

### 2. [Next question]

[Answer]

...

---

Notes:
- [Any observations about the role, changes, etc.]
- [Personalization suggestions the candidate should review]
```

**MANDATORY — no blockquote formatting around answers.** Whether writing answers in the chat, in Section G, or anywhere else the candidate might copy them: use plain text paragraphs under the `###` question heading. Do not wrap answers in `> ` blockquotes, do not indent them, do not use code fences. Blockquote markers and leading spaces get included when copying and break the paste into form fields. This applies to all free-text answers in apply mode.

## Step 6 — Post-apply (MANDATORY)

When the candidate confirms they submitted (or says they did it themselves):

1. **Verify tracker status.** Grep `data/applications.md` for the row; if it's not yet `Applied`, update it (merge-tracker is the user's job, but direct-edit is fine for a single status flip).
2. **Append Section G to the report** — MANDATORY, not optional. Write the ACTUAL text that went into each form field, verbatim, under a `## Section G — Submitted Answers` heading at the bottom of the report. Include:
   - **Form URL** and the date submitted.
   - Each question as a `###` subheading. Place the submitted answer as plain-text paragraphs directly under the heading — NO `> ` blockquote wrapping, NO indentation. The candidate should be able to copy an answer directly into a reused form field without cleanup.
   - A short **Drafting notes** subsection at the end — what voice moves worked (e.g. "led with Botkube not the generic opener"), any phrasing the candidate pushed back on, and which antipatterns the scrub pass caught. This is the future-self handoff; it compounds across applications.
3. **Suggest next step**: LinkedIn outreach to the hiring manager or a relevant Legora PM (30s of WebSearch + a short `/career-ops contact` draft).
4. **Tear down the apply browser — agent-browser fallback ONLY.** If this session used agent-browser: `agent-browser close --session-name apply` — MANDATORY, not optional. The session-named cookies stay on disk for the next run; only the Chromium process exits. Skipping this is how processes leak. If the candidate wants to keep the window open to copy something, ask, then close. **If this session used the cmux path: do NOT close anything** — the surface is the candidate's persistent browser. There is no teardown.

Section G is not a nice-to-have. It's the only record of what the candidate *actually* said, separate from the auto-generated draft in Step 5. If the candidate reopens this application six weeks later, or applies to another Ashby form at the same company, Section G is the battle-tested starting point.

## Scroll handling

If the form has more questions than are visible:
- Ask the candidate to scroll and share another screenshot
- Or paste the remaining questions
- Process in iterations until the full form is covered
