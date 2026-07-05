---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications, interview practice
user_invocable: true
args: mode
argument-hint: "[scan | apply | cv | cover-letter | storybank | interview-prep | practice | mock | analyze]"
---

# career-ops -- Router

> **Mode-file paths are repo-root-relative.** Every `modes/…` reference in this file resolves from the working directory, i.e. the repo root (`modes/apply.md` → `<repo-root>/modes/apply.md`) — **never** relative to this skill's folder. `.claude/skills/career-ops/` holds only this `SKILL.md`; there is no `modes/` beside it.

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| One or more URLs (no sub-command) | **`auto-pipeline`** — fan out one background agent per URL |
| `scan` | `scan` |
| `apply` | `apply` |
| `cv` (optional `optimize`) | `cv` |
| `cover-letter` (optional `{NUM}` or pasted JD) | `cover-letter` |
| `storybank` (optional `review` / `add` / `status`) | `storybank` |
| `interview-prep` | `interview-prep` |
| `practice` (optional `--type ...`, `--story S0XX`) | `practice` |
| `mock` (optional `--company ...`, `--round-type ...`, `--length ...`) | `mock` |
| `analyze --transcript {path}` (optional `--company ...`) | `analyze` |
| `onboarding` | `onboarding` -- first-run setup (also auto-triggered when a required config file is missing; see `CLAUDE.md`) |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command, treat it as input to the pipeline:

- Any number of URLs separated by whitespace → fan out one background agent per URL.

Each background agent runs `modes/_fetch.md` → `modes/_location-gate.md` → (if ALLOW) `modes/_eval.md`. The user is never blocked waiting.

If `{{mode}}` is not a sub-command AND doesn't look like a URL, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-ops -- Command Center
  /career-ops {url...}       → fetch + location-gate + score each URL in parallel (background)
  /career-ops scan           → discover new offers across portals (prints URLs to dispatch)
  /career-ops apply          → live application assistant (reads form + drafts answers)
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

### Auto-pipeline (fetch → gate → score)

For `auto-pipeline`, the orchestrator reads `modes/auto-pipeline.md` and spawns one background agent per URL with **`model: "sonnet"`**. Each agent runs fetch → gate → score inline (no nested `claude -p` subprocess — the parent agent already runs on Sonnet). The agent reads the mode files it needs via Read; they are **not** inlined into the agent prompt.

Files the agent reads on demand:

1. `modes/_fetch.md` — skipped entirely when the JD is already on disk (the agent self-checks first; see `auto-pipeline.md` Step 0)
2. `modes/_location-gate.md`
3. `modes/_eval.md` (which names its own inputs) — only if gate returns ALLOW

CV generation is never part of this pipeline.

### All other modes: read only their mode file

Read `modes/{mode}.md` — each mode is self-contained and pulls any shared
standard via an explicit path reference inside it (e.g. `apply` references
`modes/_writing.md` for candidate-facing text).

Applies to: `apply`, `scan`, `interview-prep`, `cover-letter`, `storybank`, `practice`, `mock`, `analyze`, `onboarding`.

### Delegating to subagents

For `scan`, `apply`, and any time the user provides 2+ URLs on `/career-ops`: launch one Agent per URL. Bound concurrency to ≤ 3. Browser-session management (headless for fetch/scan, headed for apply) is each mode's responsibility — see the mode file and the `agent-browser` skill for the ensure-in-mode protocol.

**Use path references, never inline mode-file content.** Inlining the 23KB `_fetch.md` and 5KB `_location-gate.md` into every dispatch wastes context on every parallel agent; the agent reads only what it needs via Read.

**One agent shape for every URL.** The agent self-checks whether the JD is already on disk before deciding whether to load `_fetch.md`. This handles scan-prefetched URLs, re-runs, and manually-pasted-twice URLs uniformly — no dispatcher branching needed.

```
Agent(
  subagent_type="general-purpose",
  model="sonnet",
  prompt="Follow modes/auto-pipeline.md per-agent flow for URL: {url}.",
  description="career-ops pipeline {url}"
)
```

Execute the instructions from the referenced mode files.
