# Mode: analyze — Transcript Analysis

When the user runs `/career-ops analyze {NUM} {transcript-path}`, run this mode. Score a real-interview transcript against the 5-dim rubric, walk the triage priority stack, and emit per-unit findings.

For mock interviews you've run inside this system, use `mock` (it generates the same kind of analysis built-in). Use this mode for **real interviews** — your own recordings, Otter transcripts, retro notes.

## Inputs

| File | When | Why |
|------|------|-----|
| `{transcript-path}` | ALWAYS (required arg) | The transcript to score |
| `modes/_rubrics.md` | ALWAYS | 5-dim score anchors, root cause taxonomy, **triage priority stack** |
| `modes/_round-types.md` | If transcript declares a round type | Per-round weight shift for the Hire Signal roll-up |
| `config/story-bank.md` | ALWAYS | Cross-reference stories used; flag overuse / freshness |
| `data/interview-prep/{NUM}-*.md` | If `--company` is set AND prep exists | Compare against pre-interview expectations |
| `data/score-history.md` | ALWAYS (append at end; also read to surface trends) | Score log |
| `data/applications.md` | If `--company` is set | Cross-reference current tracker row |

## Transcript format

If the transcript has speaker labels, use them. If not, ask the candidate at Step 0 to identify which lines are theirs.

---

## Step 0: Triage and setup

Read the transcript. Detect:
- Round type (recruiter / HM / behavioral / panel / system design / case / etc.) — infer from the questions if not labeled
- Approximate length (number of questions and answers)
- Whether transcript quality is good or has gaps

Print the triage banner:

```
─── Transcript Analysis ───
Transcript: {path}
Company: {if --company set, else "unknown"}
Detected round type: {type — or "ambiguous, please confirm"}
Question count: ~{N}
Quality: {clean / has gaps / fragmentary}

Before scoring, two quick things:
1. Self-assessment (optional but strongly recommended) — how do you think
   you did, 1-5 per dim? (Substance, Structure, Relevance, Credibility, Differentiation)
2. Round type: confirm or correct.
```

Wait for the candidate's response. Self-assessment is optional — if they skip, score blind and surface no self-vs-coach delta in the output. If they provide it, capture and use it in Step 3.

**Transcript Quality Gate:** If the transcript has significant gaps (garbled, ≥40% unrecoverable, missing whole answers), say so upfront:

> "This transcript has quality issues — {specifics}. I can score what's here, but confidence is reduced. Findings will be marked with `[low-confidence]` where the source text is fragmentary. Continue? [y/n]"

---

## Step 1: Per-unit scoring (independent)

Walk through the transcript answer-by-answer. For each unit (Q1, Q2, ...):

1. Identify the question (paraphrase if long).
2. Read the candidate's answer carefully.
3. Score each of the 5 dims (1-5) with seniority calibration for Senior/Lead.
4. Identify any root cause pattern from `_rubrics.md` taxonomy.
5. Cross-reference `config/story-bank.md` — did the candidate appear to use a story from the bank? Which one? If yes, note for later.

Do NOT skip any unit. Even short answers get scored — a 30-second recruiter answer scores on Structure + Relevance more than Substance, but it still scores.

## Step 2: Apply the triage priority stack

After scoring all units, walk the **Post-Scoring Decision Tree** from `_rubrics.md`:

```
1. Relevance — were there answers that didn't address the question? Flag them first.
2. Substance — were there answers with insufficient evidence? Flag second.
3. Structure — were the well-substantiated answers disorganized? Flag third.
4. Credibility — were claims diluted by reflexive "we", missing proof, over-claiming? Flag fourth.
5. Differentiation — were the credible answers generic / forgettable? Flag last.
```

The point: don't recommend "spiky POV practice" if the candidate has 3 Relevance-1 answers. Fix the load-bearing dim first.

## Step 3: Multi-lens analysis

Now re-read the transcript from three perspectives. Each produces 2-3 sentences max — these are framings, not essays.

| Lens | What it asks | Output |
|------|--------------|--------|
| **Hiring Manager** | "Would I want this person on my team in 12 months?" | Verdict + the moment that tipped it |
| **Skeptic** | "What's the strongest case for passing on this candidate?" | The single weakest moment, quoted |
| **Values Alignment** | "Does this person carry themselves the way this company expects?" | If `--company` is set, reference the prep artifact's "values" section. Otherwise generic seniority-fit check. |

## Step 4: Emit per-unit findings

Output format per unit:

```
### Q{N} — {paraphrased question}
- Scores: S__ / St__ / R__ / Cr__ / D__   {[low-confidence] if applicable}
- Self vs coach delta: {dim differences if candidate provided self-assessment, e.g. "Substance: self 4, coach 3 (-1)"}
- What worked: {one specific moment that landed}
- Biggest gap: {the most actionable weakness}
- Root cause pattern: {from taxonomy, or "no clear pattern"}
- Story used: {S0XX if identified, or "none from bank — likely improvised"}
- Tight rewrite direction: {one-sentence instruction for how the answer should change next time}
- Evidence: > "{quoted line from transcript that's the strongest signal}"
```

## Step 5: Emit the full report

Print the assembled analysis:

```
## Transcript Analysis — {Company or "unknown"} {round-type}, {date of interview}

## Overall
- Hire Signal: Strong Hire / Hire / Mixed / No Hire
- Weight-adjusted average (round-type-aware): __
- Self-assessment delta: {if provided — net direction; e.g. "candidate over-scored Substance by 0.6 on average"}

## Triage Priority — Fix In This Order
1. {Dim flagged first — with the units affected}
2. {Dim flagged second}
3. {...}

(If a dim has no failing units, omit it. If only one dim is flagged, that's a signal — say so.)

## Multi-Lens Read

**Hiring Manager:** {verdict + tipping moment}

**Skeptic:** {strongest case to pass, with quoted evidence}

**Values Alignment:** {fit verdict, with reference to prep artifact if loaded}

## Per-Unit Findings
{Step 4 output for each unit}

## Patterns Across the Round
- Strength: {one or two patterns that landed consistently}
- Weakness: {one or two patterns that dropped scores}
- Root cause: {if 2+ units show the same cause, name it; flag for revisit queue}

## Storybank Updates (proposed)
- Stories identified as used: {list with story IDs}
- Increment Use Count + Last Used? [y / n / pick specific]
- Strength recalibration: {if a 5-rated story landed weakly, propose downgrade with reasoning}

## Recommendations
- Drill: {one specific drill type to run in `practice` next, based on triage priority}
- Bank work: {if gaps surface — "consider adding a story about X" — point to specific question types the bank didn't cover}
- Active Strategy update: {if a root cause shifts the dominant bottleneck, propose updating `data/active-strategy.md`}
```

## Step 6: State writes

Append one row to `data/score-history.md`:
```
{interview-date}	analyze	{company-slug or "unknown"}-{round-type}	{S avg}	{St avg}	{R avg}	{Cr avg}	{D avg}	{Hire Signal}	{root cause}	{brief note}
```

For each story the candidate confirms was used (after the "Storybank Updates" prompt):
- Edit `config/story-bank.md`: increment `Use Count` by 1, set `Last Used` to the interview date (not today, if different).
- If candidate approves a Strength recalibration: edit that field too.

Update `data/revisit-queue.md` if a cross-unit root cause was detected.

If `--company` is set, optionally append a "Real Round Notes — {date}" section to `data/interview-prep/{company-slug}-*.md` with the lessons. Ask first.

If `--company` is set and `data/applications.md` has a row for this company, propose updating the Notes field with one-line lessons. Ask first; do not write silently.

---

## Calibration drift (future)

Once `data/score-history.md` has ≥3 rows of `type=analyze` with the same candidate, a drift report becomes possible: practice-mock scores vs. real-interview-analyze scores per dim. **Drift detection is deferred** — too little data right now. When the data exists, this mode can grow a `--drift-report` flag.

## Rules

- **Self-assessment first, scoring second.** Capturing the candidate's read before showing yours produces honest deltas. After showing scores, the self-assessment is anchored.
- **Quote evidence verbatim.** Every per-unit finding cites a real line from the transcript.
- **Apply triage stack — don't dump all weaknesses.** Recommend ONE drill, the highest-priority one.
- **Storybank writes require confirmation.** Propose, don't apply.
- **Low-confidence is a real label.** Don't pretend to score units whose transcript text is unrecoverable — mark them.

## Anti-patterns (do NOT do)

- Score without seniority calibration — produces 3s for senior answers that are strong-for-band.
- Recommend Differentiation work when Relevance or Substance is failing — fixes nothing.
- Generate findings that don't reference transcript text — they're fiction.
- Update Use Count / Last Used without confirmation — destroys the freshness signal if guessed wrong.
- Write to `applications.md` from this mode without explicit user approval.

## When to use which mode

| Goal | Mode |
|------|------|
| Score a real-interview transcript | `analyze` (this) |
| Full interview simulation | `mock` |
| Focused drill | `practice` |
| Maintain the story bank | `storybank` |
