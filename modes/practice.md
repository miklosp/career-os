# Mode: practice — Drill Loop

When the user runs `/career-ops practice [--type ...] [--story S0XX]`, run this mode. Single-question drills that score against the 5-dim rubric, surface root causes, and feed the revisit queue.

This mode is for **focused drilling** — one weakness at a time. For a full simulated interview, use `mock` instead. For scoring a real transcript, use `analyze`.

## Inputs

| File | When | Why |
|------|------|-----|
| `modes/_rubrics.md` | ALWAYS | 5-dim score anchors, root cause taxonomy, triage priority stack |
| `modes/_role-drills.md` | When `--type pm-lens` | PM Six-Lens Stress Test |
| `user/config/story-bank.md` | ALWAYS | Story content for `--story` flag; story freshness/overuse signals |
| `user/data/revisit-queue.md` | ALWAYS (read at session start) | Active root causes to drill against |
| `user/data/score-history.md` | ALWAYS (append at session end) | Score log |
| `user/config/profile.md` | ALWAYS | Seniority band (Target Roles & Archetypes) |
| `user/data/active-strategy.md` | ALWAYS (read at session start) | Current Active Strategy / bottleneck |

Do NOT read `user/config/cv.md` or evaluation reports. Drills are about delivery, not job fit.

## Drill types

| `--type` | Focus | Drill loop |
|----------|-------|------------|
| `behavioral` (default) | Standard behavioral question, full STAR+R answer | One question, scored on all 5 dims |
| `tension` | Tension-mining — pull the conflict to the surface | Coach probes for the hardest moment in the story |
| `spiky` | Spiky POV — take a real stance, defend it | Coach challenges every claim; scores Differentiation heavily |
| `gap` | Gap-handling — answer a question where the candidate has no strong story | Coach asks a question the bank doesn't cover well; practices honest framing |
| `pm-lens` | PM Six-Lens Stress Test | See `modes/_role-drills.md` |

If `--type` is not specified, default to `behavioral`. If `--story S0XX` is also given, pick a question that the story is supposed to answer (from its `Best For` field).

## Session structure

### Step 0: Session intro

Read `user/data/revisit-queue.md`. If any root causes are active, surface them at the top:

> "Active revisit queue:
> - Reflexive 'we' framing (3 sessions ago, last seen 2 sessions ago)
> - Narrative hoarding (2 sessions ago)
>
> I'll probe for these as we go. Want to focus this session on any of them, or run a general drill?"

Wait for input. The candidate can pick a focus or just say "general."

Read `user/data/active-strategy.md` for Active Strategy. If a current bottleneck is set, frame the session around it:

> "Active Strategy is targeting Differentiation. I'll bias question choice and scoring toward that dim."

### Step 1: Round 1 — Warmup (unscored)

Pick a low-stakes question matching the `--type`. Examples:
- `behavioral`: "Tell me about a recent product decision you owned."
- `tension`: "Tell me about a recent project where you disagreed with someone."
- `spiky`: "What's something everyone in your field takes for granted that you think is wrong?"
- `gap`: pick a question the bank has no strong match for (cross-reference story-bank `Best For` fields against the question).
- `pm-lens`: ask the candidate to describe a recent product decision, then run the lens loop from `_role-drills.md`.

If `--story S0XX` is set, pick the question from that story's `Best For` field most aligned with the `--type`.

Candidate answers. **Do not score the warmup.** Just confirm:

> "Round 2 starts now. Same drill, harder question. I'll score this one."

### Step 2: Round 2 — Scored round

Pick a harder question (or a follow-up that probes the same answer deeper). Candidate answers.

Score silently against the 5-dim rubric. Apply seniority calibration for Senior/Lead (the candidate's band — confirm from `user/config/profile.md`).

Detect root causes — does the answer show any of the 9 patterns from `_rubrics.md`? If two or more rounds in this session show the same cause, that cause goes into the revisit queue at session end.

Emit the Round Debrief:

```
## Round Debrief — {Type}
- Question: {the question}
- Drill: {behavioral / tension / spiky / gap / pm-lens}

## Scorecard (1-5)
- Substance: __  (anchor: __)
- Structure: __
- Relevance: __
- Credibility: __
- Differentiation: __
- Hire Signal: Strong Hire / Hire / Mixed / No Hire

## Interviewer's Read
{1-2 key moments told from the interviewer's POV. Quote a specific phrase or pivot point.
 What landed; what dropped engagement. Brief — 3-5 sentences.}

## Root Cause Detected
{If a pattern from the taxonomy is showing — name it. Otherwise: "No clear pattern in this round."}

## Next Round Adjustment
- One specific change to try in the next answer: {concrete instruction, e.g.
  "Replace every 'we' in the next answer with the specific actor (you, the engineer, the customer)."}
```

### Step 3: Round 3 — Apply the adjustment (scored)

Same question type. Coach asks a new question — different topic — but the candidate is supposed to apply the Round 2 adjustment.

Score, emit Round Debrief.

If the targeted dimension improved by ≥1 score: positive signal. Note it: "Adjustment landed. Keep this pattern."
If it stayed flat or got worse: deeper issue. Note it: "Adjustment didn't stick — likely a root cause, not a surface fix."

### Step 4: Round 4+ (optional)

Continue if the candidate wants more reps. End the session when they say "done" or after 5 scored rounds (returns diminish).

### Step 5: Session end

Append rows to `user/data/score-history.md` — one row per scored round.

If any root cause was detected in **2+ rounds** this session:
- If it's already in `user/data/revisit-queue.md`, update `Last seen` to today's date and increment "Drills tried."
- If new, append it with `Status: active`, today's date as both `First detected` and `Last seen`.
- If a root cause hasn't been seen for **3+ sessions**, flip its status to `Status: resolved`.

Print session summary:

```
─── Session summary ───
Drill: {type}
Rounds: {N} (1 warmup, {N-1} scored)
Per-dim averages: S__ / St__ / R__ / Cr__ / D__
Best moment: {brief, quoted}
Active revisit queue: {count} entries
{If new entry was added: "New entry: {root cause}"}
```

---

## Question-source guidance

When picking questions, draw from (in priority order):

1. **The candidate's revisit queue** — drill questions designed to surface the active root causes
2. **`user/data/score-history.md` weak dimensions** — pick questions that stress the dim the candidate is weakest on
3. **`user/config/story-bank.md` overuse warnings** — if a story has `Use Count >= 5`, prefer questions that DON'T map to it (force the candidate to find a different story)
4. **High-Signal Question Themes** from `modes/_round-types.md`
5. **PM-specific patterns** from `modes/_round-types.md` if archetype = Product Leadership / AI PM

**Never** invent questions that don't match the candidate's role/archetype. Don't ask system-design questions in a behavioral drill.

## Anti-patterns (do NOT do)

- Score the warmup — defeats its purpose (it's there to take the edge off).
- Run a drill without surfacing the revisit queue first — wastes the session.
- Emit multiple root causes in one round debrief — pick the strongest signal, name one cause. Multiple noise > one clear signal.
- Skip the "Next Round Adjustment" — that's the only line the candidate carries forward.
- Run more than 5 scored rounds — diminishing returns; fatigue introduces false signal.
- Write to `user/data/applications.md` from this mode — practice has nothing to do with the tracker.

## State writes (summary)

- `user/data/score-history.md` — append one row per scored round
- `user/data/revisit-queue.md` — update or append based on detected root causes
- `user/config/story-bank.md` — increment `Use Count` and update `Last Used` only if a specific story `--story S0XX` was practiced and the candidate confirms "I'd use this in a real interview" at end-of-session. (Default: no story-bank writes from practice.)
- `user/data/active-strategy.md` — only edit it if the candidate explicitly asks for a strategy pivot.
