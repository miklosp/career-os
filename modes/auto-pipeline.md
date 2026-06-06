# Mode: auto-pipeline — The one real entry point

Fired when the user runs `/career-ops <url...>`.
This is the only orchestrator — scan, manual, and multi-URL all go through
it.

## Input

One or more URLs. If multiple URLs: fan out.

## Orchestration

For **each** URL the user supplied, dispatch one background agent in parallel,
with `model: "sonnet"` (scoring quality is fine on Sonnet, and Sonnet keeps
the agent baseline cheap). Bound concurrency to **≤ 3** active agents — keeps
target-site rate limits healthy and stays under the Apify account-level
parallel-run cap. Larger lists: queue the rest and run them as earlier agents
finish.

Each agent runs gate → score **inline**. Fetch is a zero-token Node
helper first, with the LLM `_fetch.md` path only as a fallback.

### Per-agent flow

#### Step 1 — Fetch (zero-token helper first; do this BEFORE loading any mode files)

Run the deterministic helper. It does dedup, NUM reservation, the
structured fetch, the JD file write, and the `applications.md` row in one
call — no Claude tokens, no `modes/_fetch.md` load:

```bash
node lib/fetch-jd.mjs "{url}"
```

It emits exactly one JSON line. Branch on `status`:

- **`ok`** — JD written. Use the returned `num` / `path`. Go to Step 2.
- **`expired`** — JD written with `Status: expired`. Go to Step 2 (the
  gate / scoring short-circuit it, but the trail is kept).
- **`exists`** — dedup hit. The helper also returns `appStatus`:
  - `Fetched` → fetch already done, not yet scored. Go to Step 2 with the
    returned `num` / `path`.
  - `Evaluated` / `Applied` / `Skipped-Location` / `SKIP` / any terminal
    state → already handled. Stop silently.
  - `appStatus` null (orphaned JD, no row) → re-register only: append the
    `Fetched` row for the returned `num` (see `_fetch.md` Step 5), then
    Step 2.
- **`banned`** — the company is on the `banned_companies` list in
  `config/portals.yml`. The helper wrote nothing (no JD, no row) and logged
  the URL in `scan-history.db` as `status='banned'`. **Stop silently.** Do
  NOT load `_fetch.md`, do NOT create a row, do NOT score. Zero further
  spend — that is the entire point of the ban list.
- **`unknown-host`** or **`error`** — only now load `modes/_fetch.md` and
  follow it as the fallback. **After** a
  successful manual resolve of a *new structured source*, teach the
  registry so the next hit is zero-token — see `_fetch.md` "Learning loop".

Most URLs (any known ATS + LinkedIn + scan-prefetched) resolve at the
helper and never load `_fetch.md` at all.

#### Step 2 — Location gate

Two stages — deterministic first, LLM only when needed.

**2a. Deterministic short-circuit (zero tokens):**

```bash
node lib/location-gate.mjs {NUM}
```

Exit codes:
- `0` → ALLOW (proceed to Step 3 — skip 2b, no LLM gate needed)
- `10` → SKIP applied. The script has already updated the applications.md row to `Skipped-Location` with the rule-id + quoted Location as evidence. **Stop here. No report, no TSV.**
- `20` → NEEDS_LLM (no deterministic answer — fall through to 2b)

The deterministic gate fires on structured `**Remote scope:** onsite:City` / `hybrid:City` headers (LinkedIn Voyager populates these). It does NOT inspect JD body language — that is 2b's job.

**2b. LLM gate (only on exit 20):**

Follow `modes/_location-gate.md`. If it returns `SKIP:<rule-id>: "<evidence>"`, the gate has already updated the applications.md row to `Skipped-Location` with the quoted evidence in Notes. Stop here. No report, no TSV.

#### Step 3 — Score

If gate returned `ALLOW`, follow `modes/_eval.md` inline. The eval mode
lists the exact files to read. Write `data/reports/{NUM}-{slug}-{date}.md`
and drop a TSV in `data/tracker-additions/`.

#### Step 4 — Stop
