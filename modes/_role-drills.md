# Role-Specific Drills — Shared Reference

<!-- ============================================================
     Read this file in: practice (when --type pm-lens). Mock can
     reuse the lens questions for system-design and case rounds
     when the archetype is PM.

     Currently PM-only. Engineer / Designer / Data drills are
     deferred until the candidate targets non-PM roles.
     ============================================================ -->

## PM Six-Lens Stress Test

Designed for `practice --type pm-lens` and for the harder probes inside `mock --round-type case-study` or `system-design`.

The candidate describes a recent product decision (real or hypothetical). The coach challenges from six lenses in sequence. The candidate doesn't get to choose which lens comes first — that's the point.

| Lens | The interviewer's stance | What it tests |
|------|--------------------------|----------------|
| Engineering | "How expensive was this to build, really?" | Scoping realism, technical depth, tradeoff with debt |
| Design | "Why this UX over the alternatives?" | Visual judgment, user empathy, craft |
| Data | "What did the numbers actually say?" | Metric literacy, evidence vs. anecdote |
| Business | "How did this make money or save it?" | P&L thinking, business model fit |
| Competitor | "Why didn't [competitor] just copy this?" | Defensibility, moats, second-order thinking |
| Skeptic | "Why should I believe this worked at all?" | Causal reasoning, regression-to-the-mean awareness, intellectual honesty |

### Per-lens probe questions

**Engineering Lens**
- "This sounds like 6 months of work. How did you actually scope it?"
- "What technical debt did this create?"
- "Walk me through the build-vs-buy decision."
- "What did you ship that you'd undo if you had the choice now?"

**Design Lens**
- "Why this interaction pattern over the alternatives?"
- "What did the design system constrain you toward — and what did you push back on?"
- "Talk me through a moment where engineering pushed back on a design call. Who was right?"

**Data Lens**
- "How did you measure success — and what was your null hypothesis?"
- "If I pulled your dashboard right now, what would concern me?"
- "What was the difference between your leading and lagging indicators?"
- "What metric were you intentionally NOT optimizing? Why?"

**Business Lens**
- "What was the business case in one sentence?"
- "Who paid for this — and what would have happened if you'd done nothing?"
- "How did this change pricing, packaging, or sales motion?"

**Competitor Lens**
- "Why didn't [obvious competitor] do this two years ago?"
- "What's the moat?"
- "If a competitor copied this tomorrow, what would your next move be?"

**Skeptic Lens** (hardest — save for last)
- "Your success metrics feel cherry-picked. Convince me they aren't."
- "How do you know this wasn't just regression to the mean?"
- "Sounds like you got lucky. What was actually skill?"
- "If I asked your engineer who really made this work, what would they say?"

### Per-response scoring (3 sub-dims)

Each lens-response is scored on three sub-dimensions, 1-5:

| Sub-dim | Score 1 | Score 3 | Score 5 |
|---------|---------|---------|---------|
| **Acknowledging tension** | Dismisses the challenge or reframes around it | Acknowledges the point but pivots quickly | Names the tradeoff honestly, including the cost of the choice |
| **Specific evidence** | Generic justification, no numbers or artifacts | One concrete reference, partial backup | Multiple specifics, named systems / metrics / decisions, falsifiable |
| **Admitting uncertainty** | Pretends certainty, won't show seams | Hedges generically ("hard to say") | Names the specific thing they don't know, and what would change their mind |

Roll the three sub-dim scores into the parent 5-dim rubric at the end of the round:
- Acknowledging tension + Specific evidence → contributes to **Credibility**
- Specific evidence → contributes to **Substance**
- Admitting uncertainty → contributes to **Differentiation** (a senior PM who knows what they don't know is rare)
- Overall round structure → **Structure**
- Whether the candidate stayed on the actual decision under question → **Relevance**

## Run-mode for PM Lens drill

`practice --type pm-lens` runs the lens drill end-to-end:

1. Coach: "Describe a recent product decision in 60 seconds." Candidate answers.
2. Coach picks 3 lenses (always include Skeptic; default Engineering + Data; rotate the third).
3. For each lens: 1-2 probe questions, candidate answers, coach scores the 3 sub-dims (silently, no mid-round feedback).
4. After all 3 lenses: emit Round Debrief in the standard format from `modes/_rubrics.md`, with an extra **Per-Lens Subscore** table showing the 3 sub-dims × 3 lenses.

Hard mode (`practice --type pm-lens --hard`): pick all 6 lenses. Used right before high-stakes interviews.

## Deferred drill types (not implemented yet)

- Engineer-archetype drills (system-design narration, debugging-as-conversation, code review as a conversation)
- Designer-archetype drills (design critique stress test, user research walk-through under pressure)
- Data-archetype drills (metric design under conflicting goals, experiment readout under skeptical leadership)

Add when needed. The pattern is the same: pick lenses, score 3 sub-dims per lens, roll up to the 5-dim parent rubric.
