# Answer Rubrics — Shared Reference

<!-- ============================================================
     Read this file in: practice, mock, analyze, and any future
     coaching mode that scores candidate answers.

     Do NOT read it in the auto-pipeline (fetch/gate/eval) — that
     pipeline scores JOBS, not ANSWERS. This rubric is only for
     scoring how the candidate delivers a story or response.
     ============================================================ -->

## The 5 Dimensions

Every analyzed answer is scored on five dimensions, 1-5:

| Dim | What it measures | One-line test |
|-----|------------------|---------------|
| **Substance** | Evidence, quantification, depth | Would a senior peer believe this without follow-up? |
| **Structure** | Narrative arc, clarity | Could you summarize this answer in one sentence? |
| **Relevance** | Question fit | Did every sentence serve the question that was asked? |
| **Credibility** | Believability, ownership | Is the candidate's specific contribution clear and proportionate? |
| **Differentiation** | Uniqueness, earned POV | Could any competent candidate have given this answer? |

## Score Anchors (verbatim 1 / 3 / 5)

### Substance
| Score | Description |
|-------|-------------|
| 1 | Generic platitude, no evidence. *"I'm a great collaborator."* |
| 3 | Specific claim, missing quantification. *"I redesigned onboarding and reduced drop-off."* |
| 5 | Quantified + alternatives weighed + decision rationale + outcome. *"Drop-off fell from 40% to 25%, validated over 10K users; we picked the contextual-prompt pattern over a tour because the data showed users skipped tours."* |

### Structure
| Score | Description |
|-------|-------------|
| 1 | Stream of consciousness; interviewer has to piece it together. |
| 3 | Clear STAR but choppy transitions; setup-conflict-resolution is recognizable but uneven. |
| 5 | Crisp arc: setup → conflict → resolution → impact. Length matches stakes. Lands the punchline. |

### Relevance
| Score | Description |
|-------|-------------|
| 1 | Doesn't address the question that was asked. |
| 3 | Addresses it but ~40% of the answer is irrelevant context or detour. |
| 5 | Laser-focused. Every sentence serves the answer. Volunteers nothing the interviewer didn't ask for. |

### Credibility
| Score | Description |
|-------|-------------|
| 1 | Claims with no support, or obvious exaggeration. Reflexive "we" — contribution unclear. |
| 3 | Specific events but missing numbers, missing acknowledgement of luck/help, or proportionality unclear. |
| 5 | Numbers + artifacts + third-party validation + realistic constraints. Owns the contribution; credits others where due. |

### Differentiation
| Score | Description |
|-------|-------------|
| 1 | Generic answer any candidate could give. Textbook or borrowed insight. |
| 3 | Real details but no earned perspective. The story is theirs; the lesson isn't. |
| 5 | Unmistakably this candidate. Earned secret + spiky POV. Reshapes how the interviewer thinks for a beat. |

## Seniority Calibration

Scoring is NOT absolute — the same answer scores differently by career stage.

| Band | "4 on Substance" looks like | "4 on Differentiation" looks like |
|------|-----------------------------|------------------------------------|
| **Early career (0-3 yr)** | Specific examples with one metric | Learning velocity, taste forming |
| **Mid-career (4-8 yr)** | Quantified impact + alternatives considered | Earned secrets starting to crystallize |
| **Senior / Lead (8-15 yr)** | Systems-level thinking + second-order effects | Reshapes how interviewer thinks about the problem |
| **Executive (15+ yr)** | Business-level P&L impact + strategic context | Leadership philosophy applied across contexts |

For this project Miklós is **Senior / Lead → Executive** (15+ yr). Use that band by default unless a specific role JD pulls down the seniority bar.

## Hire Signal (Mock + Analyze)

After scoring all units in a mock or analyzed transcript, roll up to one signal:

| Signal | Criteria |
|--------|----------|
| **Strong Hire** | Multiple 4-5 scores across dims, no major gaps, unique value clearly demonstrated |
| **Hire** | Mostly 3-4, minor gaps, coachable in the role |
| **Mixed** | Inconsistent scores, real strengths but concerning gaps |
| **No Hire** | Multiple low scores, significant evidence gaps, red flags |

`practice` rounds emit Hire Signal only if it's a full scored round (skip for warmup).

## Triage Priority Stack (for analyze + coaching strategy)

When multiple dimensions score weak, fix in this order — earlier fixes unblock later ones:

1. **Relevance** (highest priority) — if the answer is wrong-question, nothing else matters. Drill: question-decoding.
2. **Substance** — not enough raw material. Drill: story improvement ladder (3 → 4), proof-point mining.
3. **Structure** — content is there but disorganized. Drill: constraint ladder (force 30s/60s/90s versions).
4. **Credibility** — root causes: over-claiming, reflexive "we", missing proof. Drill: I/we audit, constraint practice.
5. **Differentiation** (lowest priority) — sounds generic. Drill: spiky POV practice, earned secret extraction.

Differentiation last because it requires Substance + Credibility to land. Polishing a 2-Substance answer with a spiky POV produces an answer that sounds clever and proves nothing.

## Root Cause Taxonomy (cross-dimensional)

When the same weakness shows up across multiple answers, name the root cause — fix the cause, not each affected dimension separately.

| Root cause | How it manifests | Affected dims | Targeted fix |
|------------|------------------|----------------|--------------|
| Can't identify question core | Answers miss the point; wrong story selected | Relevance, Structure | Question-decoding drills |
| Reflexive "we" framing | Individual contribution unclear | Credibility, Substance | I/we audit: replace each "we" with specific actor |
| Conflict avoidance | Stories lack tension/stakes; resolution feels effortless | Substance, Differentiation | Tension-mining: make the hardest moment the centerpiece |
| Status anxiety / over-claiming | Inflated claims interviewers don't believe | Credibility, Differentiation | Constraint practice: add realistic limits, timelines, trade-offs |
| Narrative hoarding | Answers run long, structure collapses near the end | Structure, Relevance | Constraint ladder: 30s / 60s / 90s versions of the same story |
| Fear of being wrong | Generic, safe answers; no stance | Differentiation, Substance | Spiky POV practice; take a real position |
| Anxiety / performance stress | Structure breaks; retrieval fails; spiral after a stumble | All dimensions | Psychological readiness: warmup routine, mid-answer recovery script |
| Cultural communication style | Indirect framing; modesty norms reading as low confidence | Credibility, Structure, Substance | Adaptation coaching — frame as register, not deficit |
| Linguistic formality | Overly formal tone reads as distant | Differentiation, Credibility | Register calibration — match the interviewer's energy |

When a root cause is detected in **two or more** rounds within a session (or two consecutive practice sessions), flag it in `data/revisit-queue.md`. One drill targets the cause, not the affected dims separately.

## How modes use this file

- `modes/practice.md` — read score anchors + root cause taxonomy. Score each round, flag root causes, surface revisit queue.
- `modes/mock.md` — read score anchors + Hire Signal criteria. Score the whole mock at the end (no mid-mock scoring).
- `modes/analyze.md` — read everything. Walks the triage priority stack explicitly in the multi-lens analysis.
- `modes/storybank.md` — read Strength anchors only (Score 1/3/5 on Substance maps to story Strength 1/3/5 in the bank).

## Anti-patterns (do NOT do)

- Scoring without seniority calibration → produces 3s for senior-level answers that are actually strong-for-band.
- Fixing Differentiation before Substance → produces clever-sounding answers with no proof.
- Reporting root causes per-answer instead of pattern-level → noise, no actionable insight.
- Inventing dimension scores when there isn't enough evidence in the answer — better to say "insufficient signal" and re-prompt.
