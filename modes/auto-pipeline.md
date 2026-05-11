# Mode: auto-pipeline — The one real entry point

Fired when the user runs `/career-ops <url...>` or pastes a JD directly.
This is the only orchestrator — scan, manual, and multi-URL all go through
it.

## Input

One or more URLs (or one pasted JD). If multiple URLs: fan out.

## Browser prerequisite

Before any agent dispatches, ensure Chromium on `:9222` is in **fetch mode** (headless, `$HOME/.chromium-debug` profile). The `agent-browser` skill ("Chromium CDP session management") has the detect → ensure → launch protocol; follow it idempotently so running the pipeline never steals the browser out from under an open apply session without a deliberate swap. If apply mode is currently running, shut it down before fan-out.

## Orchestration

For **each** URL the user supplied, dispatch one background agent in parallel.
Bound concurrency to **≤ 3** active agents at any time — keeps browser sessions
(agent-browser via CDP) and target-site rate limits healthy, and avoids
saturating the CDP endpoint when multiple agents share it. Larger lists: queue
the rest and run them as earlier agents finish.

Each agent runs the same four-step flow and exits. The user is not blocked
waiting for any of them.

### Per-agent flow

1. **Fetch** — follow `modes/_fetch.md`. Outputs `NUM` + `data/jds/{NUM}-*.md`
   + a new row in `data/applications.md` with status `Fetched`.

2. **Location gate** — follow `modes/_location-gate.md`. If it returns
   `SKIP:<rule-id>: "<evidence>"`, the gate has already updated the
   applications.md row to `Skipped-Location` with the quoted evidence in
   Notes. Stop here. No report, no TSV.

3. **Score** — if gate returned `ALLOW`, follow `modes/_eval.md`. Run as:

   ```bash
   claude -p --model claude-sonnet-4-6 --dangerously-skip-permissions <prompt>
   ```

   Writes `data/reports/{NUM}-{slug}-{date}.md` and drops a TSV in
   `data/tracker-additions/`.

4. **Do NOT run `merge-tracker.mjs`.** The user runs it when they're ready
   to consolidate, or the dashboard surfaces the pending TSVs. Agents stay
   out of the tracker-level merge.

## Merging later

When the user asks to merge, or before generating CVs from the dashboard:

```bash
node merge-tracker.mjs
```

`merge-tracker.mjs` reads every TSV in `data/tracker-additions/`, updates the
matching `Fetched` row in `data/applications.md` to `Evaluated` (or appends
a new row if somehow the fetch row went missing), dedups by NUM +
company+role, and archives the consumed TSVs.

## CV generation — still Opus, still user-triggered

PDF / CV customisation is **never** part of this pipeline. The user invokes
it from the dashboard `g` key, which runs `lib/generate-cv-llm.mjs` against the
chosen JD. That path uses Opus 4.7 via Bifrost (`BIFROST_MODEL=claude-opus-4-7`).

## Tone for form answers (only when E ≥ 4.5, inside `_eval.md` Block H)

**Position: "I'm choosing you."** — the candidate has options and is choosing this company for concrete reasons.

- **Confident without arrogance**: "I've spent the past year building production AI agent systems — your role is where I want to apply that experience next."
- **Selective without aloof**: "I've been intentional about finding a team where I can contribute meaningfully from day one."
- **Specific and concrete**: reference something REAL from the JD and something REAL from the CV.
- **Direct, no fluff**: 2–4 sentences per answer. No "I'm passionate about...", no "I would love the opportunity to...".
- **Hook is the proof, not the claim**: "I built X that does Y," never "I'm great at X."

Framework per generic question:

- **Why this role?** → "Your {specific thing} maps directly to {specific thing I built}."
- **Why this company?** → Mention something concrete. "I've been using {product} for {time / purpose}."
- **Relevant experience?** → One quantified proof point.
- **Good fit?** → "I sit at the intersection of {A} and {B}, which is exactly where this role lives."
- **How did you hear?** → Honest: "Evaluated against my criteria, scored highest."

Language matches the JD (EN default).
