---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
user_invocable: true
args: mode
argument-hint: "[scan | pdf | apply | tracker | interview-prep | update]"
---

# career-ops -- Router

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| One or more URLs / JD text (no sub-command) | **`auto-pipeline`** — fan out one background agent per URL |
| `pdf` | `pdf` |
| `tracker` | `tracker` |
| `apply` | `apply` |
| `scan` | `scan` |
| `interview-prep` | `interview-prep` |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command, treat it as input to the pipeline:

- Any number of URLs separated by whitespace → fan out one background agent per URL.
- JD text (keywords "responsibilities", "requirements", "qualifications", "we're looking for", etc.) → single foreground invocation.

Each background agent runs `modes/_fetch.md` → `modes/_location-gate.md` → (if ALLOW) `modes/_eval.md`. The user is never blocked waiting.

If `{{mode}}` is not a sub-command AND doesn't look like a URL or JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-ops -- Command Center

Main flow:
  /career-ops {url...}  → fetch + location-gate + score each URL in parallel (background)
  /career-ops {JD text} → same pipeline on pasted JD text

Utilities:
  /career-ops scan      → discover new offers across portals (prints URLs to dispatch)
  /career-ops pdf       → generate ATS-optimized CV + PDF (Opus 4.7 via Bifrost)
  /career-ops tracker   → application status overview
  /career-ops apply     → live application assistant (reads form + drafts answers)
  /career-ops interview-prep → company-specific interview prep

CV personalization is user-triggered only — press `g` in the dashboard on an Evaluated row.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Auto-pipeline (fetch → gate → score)

For `auto-pipeline`, the orchestrator reads `modes/auto-pipeline.md` and spawns background agents. Each agent loads, in order:

1. `modes/_shared.md`
2. `config/_profile.md`
3. `modes/_fetch.md`
4. `modes/_location-gate.md`
5. `modes/_eval.md`

Scoring runs with `--model claude-sonnet-4-6`. Fetch is no-LLM. CV generation is never part of this pipeline.

### Other modes requiring `_shared.md` + their mode file:

Read `modes/_shared.md` + `modes/{mode}.md`.

Applies to: `pdf`, `apply`, `scan`.

### Standalone modes (only their mode file):

Read `modes/{mode}.md`.

Applies to: `tracker`, `interview-prep`.

### Delegating to subagents

For `scan`, `apply`, and any time the user provides 2+ URLs on `/career-ops`: launch one Agent per URL. Bound concurrency to ≤ 3. Browser-session management (headless for fetch/scan, headed for apply) is each mode's responsibility — see the mode file and the `agent-browser` skill for the ensure-in-mode protocol.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/_fetch.md]\n\n[content of modes/_location-gate.md]\n\n[content of modes/_eval.md]\n\nURL: {url}",
  description="career-ops fetch+gate+score {url}"
)
```

Execute the instructions from the loaded mode files.
