# Mode: storybank — Interactive Story Bank Management

When the user runs `/career-ops storybank {review|add|status}`, run this mode. It manages `config/story-bank.md` — the canonical bank of STAR+R stories used by `practice`, `mock`, `analyze`, and any future interview-prep refactor.

This mode is **interactive and dictation-friendly**. The candidate speaks in natural language; you do the formatting. Nothing is written to disk until the candidate explicitly approves.

## Inputs

1. `config/story-bank.md` — the canonical bank (always read at start)
2. `modes/_rubrics.md` — Strength score anchors (read on demand when scoring a story's strength)
3. `data/score-history.md` — optional, only read for `status` if it exists (to surface stories with weak recent performance)

Do NOT read `config/cv.md` or `config/profile.md` here. The storybank is its own surface. The candidate may reference experiences from those files during dictation; that's fine — capture what they say, don't auto-cross-reference.

## Subcommand routing

| Subcommand | Behavior |
|------------|----------|
| `review` (default) | Walk stories with empty/missing fields. Per-story interactive fill-in. |
| `review --all` | Walk every story including already-filled ones (recalibration pass). |
| `review --story S0XX` | Walk one specific story by ID. |
| `add` | Capture a new story from scratch — STAR+R first, then header block. Appends to bottom of `config/story-bank.md`. |
| `status` | Read-only health summary. No edits. |

If no subcommand is given, default to `review`.

---

## `review` — Per-story walkthrough

### Step 0: Identify what to review

Scan `config/story-bank.md`. Build a list of stories where any of these fields is `—` (placeholder):
- Earned Secret
- Strength
- Risk/Stakes
- Domain

Tell the candidate:

> "I have {N} stories in the bank. {M} need filling-in. Walking through them now. You can dictate naturally — I'll format. Any time: type `skip` to leave a story for later, `quit` to stop, `back` to redo the previous story."

If `--all`, include already-filled stories. If `--story S0XX`, jump directly to that one.

### Step 1: Show the story

For each story, print:

```
─── Story {N}/{Total} — {ID} ───

### {Heading from file}

[Show the STAR+R body verbatim from config/story-bank.md]

Current header fields:
  Domain: {value or —}
  Strength: {value or —}
  Earned Secret: {value or —}
  Risk/Stakes: {value or —}
  Best For: {value}

Ready to review this one? [y / skip / quit / back]
```

If `skip`: move to next story, story stays untouched.
If `quit`: exit the loop. Print summary: "Reviewed M stories this session. {N} remain."
If `back`: go back to the previous story (allow re-editing).

### Step 2: Earned Secret — extraction protocol

Walk the candidate through the 5 reflection questions, **one at a time**, dictation-friendly. Do not fire all 5 at once.

> "First — what did you believe before this story that turned out to be wrong?"

Wait for answer. Listen. Don't push for structure. After the candidate replies (in any form — sentence, paragraph, fragment):

> "Got it. Next: what would surprise people who haven't done this work?"

Continue through the 5 questions:
1. "What did you believe before that turned out to be wrong?"
2. "What would surprise people who haven't done this?"
3. "What do most people in your field get wrong about this?"
4. "What counterintuitive lesson did you learn?"
5. "What would you tell your past self?"

If the candidate's first answer already contains a strong earned secret, you can short-circuit:

> "That actually sounds like the earned secret. Want to stop here and draft it, or keep going?"

If they say keep going: continue the protocol. If they say draft: jump to Step 3.

If after Q3 the candidate is repeating themselves or saying "I don't know" / "nothing earned-secret-y here": that's a real answer. Some stories don't have earned secrets. Offer:

> "Sounds like this story is more proof than insight. That's fine — not every story has an earned secret. I can leave that field blank and fill in Strength + Risk/Stakes. Or you can try a different framing. Which?"

### Step 3: Draft the Earned Secret

Take everything the candidate said across the 5 questions and draft:

```
**Earned Secret:** [Two-sentence counterintuitive POV. First sentence states the insight crisply. Second sentence adds the contrarian edge — what most people get wrong.]
  Proof: [The metric, artifact, or counterexample from the candidate's story that backs it up. Pull from the STAR+R body if possible.]
  When to Deploy: [1-3 question types where this earned secret lands hardest.]
```

Show the draft inline. Then:

> "Here's the draft. Pick one: [a]pprove, [e]dit (tell me what to change), [r]edo (try a different framing), [s]kip this field, [q]uit."

Loop until approved or skipped.

**Quality bar for Earned Secrets** (your internal check before showing the draft):
- Not generic advice ("communication is important")
- Not borrowed wisdom ("psychological safety matters")
- Backed by the specific story — defensible if challenged
- 2 sentences, not a paragraph
- Has a sharp edge — names what most people get wrong

If your draft fails any of these, redo it before showing. Don't show weak drafts and hope the candidate edits them up.

### Step 4: Strength — 1 to 5

Read the Strength anchors from `modes/_rubrics.md` (the Substance 1-5 anchors, since Strength tracks Substance for the story).

Show the candidate:

> "Strength on 1-5:
> 1 = Generic, no evidence
> 3 = Specific claim, missing quantification
> 5 = Quantified + alternatives + rationale + outcome
>
> Where does this story land? Just say the number, or describe it and I'll score."

Capture the answer. If they describe rather than number, propose a score and confirm.

### Step 5: Risk/Stakes

> "Risk/Stakes — what could have gone wrong? Why did this matter? One or two sentences."

Capture verbatim, lightly edit for clarity. Show the draft. Approve/edit/redo loop.

### Step 6: Domain

Quick prompt:

> "Domain — pick one: Technical / Product / Business / People."

Capture. No back-and-forth.

### Step 7: Secondary Skill (optional)

> "Optional: a secondary skill tag — anything else this story demonstrates beyond {Primary Skill}? Or skip."

Capture or skip.

### Step 8: Write to file

Once all fields are confirmed (or explicitly skipped), update the story's header block in `config/story-bank.md` via Edit. Replace the fields one block at a time — preserve all other content verbatim. **STAR+R body and heading do not change.**

Confirm to the candidate:

> "Story {ID} saved. Moving to the next one."

### Step 9: Repeat

Loop back to Step 1 with the next story. End condition: list exhausted OR candidate types `quit`.

When the loop ends, print:

```
─── Session summary ───
Reviewed: {N}
Fully filled in: {M}
Skipped: {K}
Remaining (still have empty fields): {L}
```

---

## `add` — Capture a new story end-to-end

Use this when the candidate identifies a story they want to add — usually mid-interview prep when a gap surfaces.

### Step 1: Capture STAR+R

Walk the candidate through STAR+R, one field at a time, dictation-friendly:

> "Let's capture a new story. First: the **Situation** — set the scene in 2-3 sentences. What was going on, what was the context?"

Capture. Draft the formatted version. Show inline. Approve/edit/redo.

Repeat for:
- **Task** — your specific responsibility
- **Action** — what YOU specifically did (not "we" — push back on "we" framing here)
- **Result** — outcome, with metrics if possible
- **Reflection** — what you learned, what you'd do differently

If the candidate says "we" repeatedly in Action: gently surface it.

> "I'm hearing a lot of 'we' — that's fine for context, but interviewers care about what *you* specifically did. What was your contribution inside the 'we'?"

### Step 2: Title and Primary Skill

> "Give this story a memorable title — 5-8 words. And the primary skill it demonstrates (e.g., 'Strategy / Zero-to-One', 'Operational Complexity'). What's the tag?"

Capture both.

### Step 3: Header block

Run the same protocol as `review` (Earned Secret → Strength → Risk/Stakes → Domain → Secondary Skill).

### Step 4: Assign ID and append

Pick the next available ID (highest existing ID + 1, zero-padded). Append the full story (heading + header block + STAR+R body) to the bottom of `config/story-bank.md`. Add a `---` separator above it.

Set:
- `Use Count: 0`
- `Last Used: —`
- `Source:` — ask the candidate where this story came from. Common patterns: "Report #NNN — Company — Role" (from a career-ops evaluation report) or a free-text origin like "Manually added 2026-05-11".
- `Notes:` — leave `—` unless candidate adds context.

Confirm:

> "Story {new_ID} added to the bank. Run `/career-ops storybank status` to see your bank health."

---

## `status` — Read-only health summary

No edits. Print a one-screen summary.

### Fields to surface

1. **Bank size** — total stories
2. **Filled-in completeness** — how many have all required fields (Earned Secret, Strength, Risk/Stakes, Domain). Count stories with one or more `—` fields as "incomplete."
3. **Strength distribution** — count at each band (1-5 and `—`). Surface as a one-line histogram.
4. **Earned Secret coverage** — count of stories with a non-empty Earned Secret.
5. **Overuse warnings** — stories with `Use Count >= 5` (interviewers in the candidate's network may have heard it).
6. **Staleness flags** — stories with `Last Used` more than 6 months ago AND in active interview loops (cross-reference `data/applications.md` if it exists; otherwise skip).
7. **Gap topics** — Primary Skill tags present in the bank vs. tags the recent reports have asked about (only if `data/score-history.md` exists and has analyzed transcripts).

### Output format

```
─── Storybank Health ───

Total stories: 22
Fully filled in: 0/22  ← run `/career-ops storybank review` to fill in headers
Strength distribution: — — — — — — — — — — — — — — — — — — — — — — (22× pending)
Earned Secrets present: 0/22
Overuse warnings (≥5 uses): none
Stale stories (last used >6 mo, active loop): none

Action: run `/career-ops storybank review` to walk through the 22 stories
with empty fields. Estimated time: 30-60 min.
```

If everything is filled in, the action line becomes:

```
Action: bank is healthy. No action needed.
```

---

## Rules

- **Never write to `config/story-bank.md` without explicit candidate approval.** Every field needs an [a]pprove confirmation.
- **Never invent earned secrets.** If the candidate's input doesn't contain a real insight, leave Earned Secret as `—` and move on.
- **STAR+R body and heading are immutable in `review`.** Only header-block fields change.
- **One field at a time during dictation.** Don't fire 5 questions at once — the candidate is talking, not filling a form.
- **Format quietly.** Don't narrate "I'm drafting now" or "let me think" — just show the draft when ready.
- **Edits are first-class.** If the candidate says "no, change X to Y," redraft and re-confirm. Loop until approved.
- **Skip is always available.** Empty fields aren't bugs — some stories never get an earned secret, and that's fine.
- **Do not auto-update Use Count or Last Used in this mode.** Those fields are updated by `practice`, `mock`, and `analyze` when a story is actually used. `storybank review` only touches the static fields (Domain, Strength, Earned Secret, Risk/Stakes, Secondary Skill, Notes).

## When NOT to use this mode

- The candidate wants to *use* stories in a prep or mock — use `interview-prep` or `mock` instead. This mode is for bank maintenance only.
- The candidate wants to score answer quality — use `practice` or `analyze`.
- The candidate wants to draft a cover letter or CV bullet — those mine the bank but live in the CV pipeline; don't fold them into storybank.
