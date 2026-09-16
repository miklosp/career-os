# Mode: auto-pipeline — The one real entry point

Fired when the user runs `/career-ops <url...>`.
This is the only orchestrator — scan, manual, and multi-URL all go through
it.

## Input

One or more URLs (pasted by the user, or scan's `DISPATCH_URLS`).

## Phase 1 — Prep: fetch + deterministic gate (inline, zero tokens)

Run in the current session — no agent, no mode-file loads:

```bash
node lib/prep-jds.mjs <url...>
```

It runs `lib/fetch-jd.mjs` on every URL (dedup, ban list, NUM reservation,
JD file write, `Fetched` row) and `lib/location-gate.mjs` on every fetched
NUM, then emits one JSON line. Buckets:

- **`ready`** — `[{num, path, gate: "allow"|"needs-llm"}]` → Phase 2.
- **`skipped`** — deterministic gate SKIPs (geography, or JD language
  outside `jd_languages`); `Skipped-Location` rows already written.
  Nothing to do.
- **`expired`** — JD + row kept as trail; never scored. Mention in the
  wrap-up.
- **`evaluated`** — report already on disk, row awaiting the user's
  `merge-tracker.mjs` run. Not re-scored; remind the user to merge.
- **`deferred`** — `unknown-host` / `error` / orphaned rows → Phase 3.
- **`done`** / **`banned`** — counts; already handled / ban-listed. Silent.

Lists of >10 URLs: run it in the background and surface per-URL progress
(stderr emits one line per URL).

## Phase 2 — Dispatch batched eval agents

Chunk `ready` into groups of **4** in queue order (last group may be
smaller). One background agent per group, `model: "sonnet"` (scoring
quality is fine on Sonnet, and Sonnet keeps the batch cheap against the
rate limit), **≤ 3 concurrent** — queue remaining chunks as agents
finish. Phase 3 solo agents share the same cap, after the batches.

```
Agent(
  subagent_type="general-purpose",
  model="sonnet",
  prompt="Follow the batch-agent flow in modes/auto-pipeline.md for these
    JDs: 2279 (gate: needs-llm), 2281 (gate: allow), 2284 (gate: allow).
    Each JD is an independent, sealed evaluation.",
  description="career-ops eval batch 2279 2281 2284"
)
```

Path references only — never inline mode-file or JD content into the
prompt.

## Phase 3 — Deferred URLs: solo fallback agents

One background agent per `deferred` entry (`model: "sonnet"`), following
the solo-agent flow below. This is the only path that ever loads
`modes/_fetch.md`.

## Batch-agent flow

The agent never touches the network — every JD in the batch is already on
disk.

1. **One context call** — everything arrives in a single turn:

   ```bash
   node lib/eval-context.mjs <num...>
   ```

   Emits: id-annotated CV, `config/profile.md`, story-bank digest (S0xx
   ids stay citable), confirmed notes, `templates/report.example.md`, and
   every JD in the batch. Do NOT re-Read any of these files.
2. Read `modes/_eval.md` once — the scoring spec for every JD in the
   batch.
3. If any JD is flagged `gate: needs-llm`: Read `modes/_location-gate.md`
   once, and apply it to each flagged JD **before** scoring it. On SKIP
   the mode updates the row — no report, no TSV, move to the next JD.
4. Evaluate the JDs strictly in the given order, **each as a sealed
   section**:
   - Score only against that JD. Never compare with, rank against, or
     reuse reasoning, scores, or `[src:]` citations from other JDs in the
     batch.
   - Write the report AND the tracker TSV **in the same turn** (two Write
     calls in one response), then move to the next JD.
5. Finish with one line per NUM: `{num} {company} — {score}/5` (or
   `skipped-location`). Never run `merge-tracker.mjs` /
   `dedup-tracker.mjs`.

## Solo-agent flow (deferred URLs only)

1. **Fetch** — `node lib/fetch-jd.mjs "{url}"`, branch on `status`:
   - `unknown-host` / `error` — load `modes/_fetch.md` and follow it.
     After a successful resolve of a *new structured source*, teach the
     registry (`--learn`) so the next hit is zero-token.
   - `exists` with `appStatus` null (orphaned JD) — re-register only:
     append the `Fetched` row for the returned `num` (see `_fetch.md`
     Step 5).
   - `banned`, or `exists` in a terminal state — stop silently.
2. **Gate** — `node lib/location-gate.mjs {NUM}`. Exit 10 → stop (row
   updated). Exit 20 → follow `modes/_location-gate.md`; on SKIP, stop.
3. **Score** — `node lib/eval-context.mjs {NUM}`, then follow
   `modes/_eval.md`. Write the report + TSV in the same turn.
