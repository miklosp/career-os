# Interview Round Taxonomy — Shared Reference

<!-- ============================================================
     Read this file in: mock. Optional for analyze (when --company
     and prior prep exist) and a future interview-prep refactor.

     This file describes the *shape* of each round — what gets
     asked, what the interviewer is testing, and which scoring
     dimensions weight heavier. Question content lives in the
     prep artifact for a specific company; this is the format.
     ============================================================ -->

## Round Types (taxonomy)

| Round | Typical length | What the interviewer is testing | Weight shift |
|-------|----------------|----------------------------------|--------------|
| **Recruiter screen** | 30-45 min | Background fit, motivation, salary alignment, basic comms | Structure + Relevance highest |
| **Hiring manager 1:1** | 45-60 min | Vision alignment, leadership style, "would I work for/with this person" | Relevance + Differentiation highest |
| **Deep behavioral** | 45-60 min | Sustain stories through probing, ownership clarity, learning depth | Substance + Credibility highest |
| **Panel** | 45-60 min | Energy across multiple personas, adaptability, consistency | All dims + stamina/adaptability |
| **System design / architecture** | 45-60 min | Structured thinking in real time, tradeoff articulation, scoping | Structure + Substance |
| **Case study (PM/strategy)** | 45-60 min | Framework selection, hypothesis discipline, prioritization under uncertainty | Substance + Structure |
| **Presentation round** | 30-45 min + Q&A | Prepared narrative + ability to hold ground under challenge | Structure + Differentiation |
| **Bar raiser / culture fit** | 45-60 min | Judgment, values alignment, "is this person at our bar?" | Credibility + Differentiation |
| **Technical + behavioral mix** | 60 min | Context-switching, register appropriateness, depth + breadth in one round | Substance + Structure |

## Per-round interviewer character (for `mock` mode)

The coach plays the interviewer in character. Tone matters — a recruiter does not behave like a bar raiser.

- **Recruiter screen** — warm, breadth, lots of "tell me about yourself" framing, sells the company in the back half. Doesn't go deep on any single answer. Watches for red flags more than for brilliance.
- **Hiring manager** — fit-focused, more conversational than rigid. Probes vision: "where do you want to take this product / function in 12 months?" Listens for whether the candidate matches the team's altitude. Less story-based, more thinking-style based.
- **Deep behavioral** — calm, persistent. Follows up with "and then what?", "what did you specifically do?", "what would you do differently?" until the answer either holds or cracks. Tests whether the story is real.
- **Panel** — multiple named personas. Default cast: Skeptic (challenges every claim), Ally (warm, gives the candidate room), Silent Observer (says little, watches everything). Each persona asks 1-2 questions. The mock should rotate.
- **System design / architecture** — coach asks for scoping first, then narrows to a sub-problem. Probes tradeoffs ("why this over X?"), constraints ("what breaks at 10× scale?"). For non-engineering candidates (PM/design), focuses on *thinking process*, not technical correctness.
- **Case study (PM/strategy)** — coach gives a prompt (e.g. "design metrics for X product", "prioritize this backlog"). Watches for: framework selection, assumption-naming, structured hypothesis vs. opinion. Does not let the candidate skip scoping.
- **Presentation round** — candidate presents first (3-5 min); coach plays informed audience and challenges through Q&A. Tests whether the candidate can defend choices, not just describe them.
- **Bar raiser / culture fit** — direct, slightly contrarian. Asks values questions ("tell me about a time you disagreed with your manager"), tests for self-awareness, looks for "would I want this person on my team?" signal.
- **Technical + behavioral mix** — coach intentionally switches modes mid-round. Tests how well the candidate re-registers when the question type shifts.

## High-Signal Question Themes (round-agnostic)

Used by `mock` when no company-specific prep artifact is loaded. Pulled from Lenny Rachitsky's high-signal patterns; lightly adapted.

1. **"How do they handle hard stuff?"**
   - "Talk me through your biggest product flop."
   - "Tell me about the hardest thing you've ever done at work."
   - "Describe a controversial product decision you owned."
   - "Tell me about a time you disagreed with your manager."

2. **"How do they think?"**
   - "What's something everyone in your field takes for granted that you think is wrong?"
   - "What's a counterintuitive lesson you've learned about your craft?"
   - "Tell me about something that worked but not for the reason you thought it would."

3. **"How do they build, ship, drive impact?"**
   - "Tell me about your most significant professional accomplishment."
   - "What's something that wouldn't exist if you hadn't pushed for it?"
   - "Walk me through a 3-9 month project, start to finish."

4. **"Who are they as people?"**
   - "When I talk to people you've worked with, what will I hear?"
   - "Fast-forward three years. What's different about you?"
   - "What question should I have asked you?"

## PM-Specific Patterns (for archetype = Product Leadership / AI PM)

Lenny's 10 core PM questions — useful as a question source for `mock --round-type deep-behavioral` when the role is PM:

1. Impact — "Most important product you shipped and why?"
2. Collaboration — "Tell me about disagreeing with an engineer. How did you resolve it?"
3. Ownership — "Tell me about a product that failed. Why?"
4. Leadership — "Team didn't gel. What was the issue, how did you handle it?"
5. Execution — "Pick a 3-9 month project. Walk me through start to finish."
6. Strategy — "What was your product strategy for [one you worked on]?"
7. Customer Insights — "Tell me about user research that significantly shifted your direction."
8. Vision — "What's your vision for [recent project or team]?"
9. Planning — "How do you get a team to commit to a deadline?"
10. Communication — assessed throughout (clarity, conciseness, persuasiveness).

For system design / case rounds at PM altitude, see also Ben Erez's Product Sense Framework (motivation → segmentation → problem → solution → V1) and Analytical Thinking Framework (assumptions → product rationale → metric framework → goal-setting → tradeoff evaluation). Defer full inclusion until a case round is actually run.

## How modes use this file

- `modes/mock.md` — reads round taxonomy + per-round character + question themes (uses prep artifact for company-specific questions if loaded; falls back to themes here).
- `modes/analyze.md` — optional. If the transcript identifies its round type, applies the round's weight shift to scoring.
- Future `modes/interview-prep.md` refactor — will read taxonomy and produce a round-aware prep artifact.

## Non-generic questions to ask the interviewer (output of every prep + mock)

Each round type has a different set of questions the candidate should ask back. Mock and prep can both produce these.

| Round | Ask back (examples) |
|-------|---------------------|
| Recruiter | "What's the hiring committee looking for in the strongest candidate?" "What's the timeline and decision process?" |
| Hiring manager | "What does success look like in this role in 12 months?" "What's the highest-leverage problem on your plate that this hire unlocks?" |
| Deep behavioral | "What's a recent example of someone in this role doing something that exceeded your expectations?" |
| Panel | (tailored per panelist after the round — usually saved for the closer or follow-up email) |
| System design | "What were the riskiest decisions you made when building [system X]?" |
| Case study | "How do you decide when a metric stops being useful?" |
| Bar raiser | "What separates an at-bar hire from a hire that gets promoted in 18 months?" |
