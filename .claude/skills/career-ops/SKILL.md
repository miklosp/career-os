---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications, interview practice
user_invocable: true
args: mode
argument-hint: "[scan | apply | tailor | cv | cover-letter | storybank | interview-prep | practice | mock | analyze]"
---

# career-ops -- Router

> **Mode-file paths are repo-root-relative.** Every `modes/…` reference in this file resolves from the working directory, i.e. the repo root (`modes/apply.md` → `<repo-root>/modes/apply.md`) — **never** relative to this skill's folder. `.claude/skills/career-ops/` holds only this `SKILL.md`; there is no `modes/` beside it.

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| One or more URLs (no sub-command) | **`auto-pipeline`** — zero-token prep script, then batched background eval agents |
| `scan` | `scan` |
| `apply` | `apply` |
| `tailor` (optional `{NUM}` / company / URL) | `tailor` |
| `cv` (optional `optimize`) | `cv` |
| `cover-letter` (optional `{NUM}` or pasted JD) | `cover-letter` |
| `storybank` (optional `review` / `add` / `status`) | `storybank` |
| `interview-prep` | `interview-prep` |
| `practice` (optional `--type ...`, `--story S0XX`) | `practice` |
| `mock` (optional `--company ...`, `--round-type ...`, `--length ...`) | `mock` |
| `analyze --transcript {path}` (optional `--company ...`) | `analyze` |
| `onboarding` | `onboarding` -- first-run setup (also auto-triggered when a required config file is missing; see `CLAUDE.md`) |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command, treat it as input to the pipeline:

- Any number of URLs separated by whitespace → the auto-pipeline flow.

The session runs `node lib/prep-jds.mjs <url...>` inline (fetch + deterministic gate, zero tokens), then dispatches batched background eval agents over the resulting queue — see `modes/auto-pipeline.md`. The user is never blocked waiting.

If `{{mode}}` is not a sub-command AND doesn't look like a URL, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-ops -- Command Center
  /career-ops {url...}       → prep (zero-token fetch + gate), then score in batched background agents
  /career-ops scan           → discover new offers across portals (prints URLs to dispatch)
  /career-ops apply          → live application assistant (reads form + drafts answers)
  /career-ops tailor {NUM}   → interactive per-application CV: criteria → evidence → generate → review → PDF
  /career-ops cover-letter   → one-page cover letter PDF for an application (+ paste-ready text)
  /career-ops interview-prep → company-specific interview prep (research artifact)

Practice & simulation:
  /career-ops practice [--type ...] [--story S0XX] → drill loop: scored rounds against 5-dim rubric
  /career-ops mock {NUM} [--round-type ...] [--length ...] → full simulated interview, post-mock debrief
  /career-ops analyze {NUM} {transcript-path} → score a real-interview transcript with triage
  /career-ops storybank [review | add | status] → interactive story-bank management
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Auto-pipeline (prep → batched score)

For `auto-pipeline`, the orchestrator reads `modes/auto-pipeline.md`, runs `lib/prep-jds.mjs` inline (zero tokens — fetch + deterministic gate for every URL), chunks the `ready` queue into groups of 4, and spawns one background agent per chunk with **`model: "sonnet"`**, ≤ 3 concurrent. Each agent pulls its whole context in one `lib/eval-context.mjs` call, then reads `modes/_eval.md` once (plus `modes/_location-gate.md` only when a JD is flagged `needs-llm`) and scores each JD as a sealed, independent evaluation. Mode files are **not** inlined into the agent prompt.

`deferred` URLs (`unknown-host` / `error` / orphaned rows) get one solo background agent each, after the batches — the only path that loads `modes/_fetch.md`.

CV generation is never part of this pipeline.

### All other modes: read only their mode file

Read `modes/{mode}.md` — each mode is self-contained and pulls any shared
standard via an explicit path reference inside it (e.g. `apply` references
`modes/_writing.md` for candidate-facing text).

Applies to: `apply`, `tailor`, `scan`, `interview-prep`, `cover-letter`, `storybank`, `practice`, `mock`, `analyze`, `onboarding`.

### Delegating to subagents

For URLs on `/career-ops`: batch eval agents per the auto-pipeline flow above. For `scan` and `apply`: launch one Agent per unit of work. Bound concurrency to ≤ 3 in all cases. Browser-session management (headless for fetch/scan, headed for apply) is each mode's responsibility — see the mode file and the `agent-browser` skill for the ensure-in-mode protocol.

**Use path references, never inline mode-file content.** Inlining the 23KB `_fetch.md` and 5KB `_location-gate.md` into every dispatch wastes context on every parallel agent; the agent reads only what it needs via Read.

```
Agent(
  subagent_type="general-purpose",
  model="sonnet",
  prompt="Follow the batch-agent flow in modes/auto-pipeline.md for these JDs: {num (gate: allow|needs-llm), ...}. Each JD is an independent, sealed evaluation.",
  description="career-ops eval batch {nums}"
)
```

Execute the instructions from the referenced mode files.
