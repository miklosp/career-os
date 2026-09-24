# Mode: cover-letter — One-Page Cover Letter

Generates a one-page cover letter PDF (plus a paste-ready `.txt`) for a specific
application. Runs standalone via `/career-ops cover-letter [NUM | company]`, or
is called by `apply` when a form has a cover-letter field or upload.

Source-material discipline is the same as `apply` free-text answers: closed-world
over the evaluation report, `user/config/cv.json`, and `user/config/story-bank.md`. The JD
steers emphasis and wording — it never adds a claim about the candidate.

## Inputs

Resolve the target before writing anything.

- **With a NUM** (`/career-ops cover-letter 064`, or handed in by `apply`): a
  scored pipeline entry. Glob `user/data/reports/{NUM}-*.md` for the report and derive
  `{slug}` from that filename (`{NUM}-{slug}-{date}.md`).
- **Cold** (a pasted JD, no NUM): no report on disk yet. Work from the JD text
  plus `user/config/cv.json`. Derive `{slug}` kebab-case from the company name.
- **No args**: ask which application — offer the most recent `Evaluated` /
  `Applied` rows from `user/data/applications.md`, or accept a pasted JD.

Voice, signature details, stories and the sample letter all arrive through
`lib/letter-context.mjs` in Step 1.

## Source discipline (light provenance)

Every concrete claim — a metric, a named system, an outcome — must trace to one of:

- the evaluation report's **Block A** matches or `[evidenced]` Criteria-ledger
  items (with their `[src: id]` evidence), when a report exists;
- a `user/config/cv.json` bullet or a `user/config/story-bank.md` story;
- `user/config/profile.md` narrative.

No `[src:]` tags and no validator — this is prose, not the CV. But the rule is
the same as `apply` Step 4: the JD says *what to emphasise*, never supplies a new
fact. If the JD asks for something the candidate cannot evidence from the sources
above, do not claim it — reframe around an adjacent strength.

## What the letter does

Two jobs, in this order:

1. **Pitch what I bring and the evidence for it.** The capability (stated as
   what I do, not what I did), one story per paragraph that shows it working,
   and the lesson that story left. The CV rides alongside and already lists
   the outcomes; the letter never repeats them.
2. **Show I understood their problem.** One or two sentences that could only
   be written after reading *their* JD, using their words. **Only if the JD
   gives enough to be specific.** A generic JD gets no problem line.

`user/config/cover-letters/` holds every letter the candidate accepted and edited
(Step 1 hands you the two most recent). They share one pattern; match it:

- **Open with a belief, not a credential.** A flat point of view on the class
  of problem the role is about ("the hardest design problems have always
  lived at the seams"; "PM mostly meant turning ambiguous operational
  problems into something engineering could actually build"). Then what a
  good leader does about it. Then the JD line that confirms it, which doubles
  as the problem line and as a compliment stated as an observation ("which
  shows me good culture", "the part of your JD that made me stop scrolling").
  An "I'm {first name}, ..." intro line is optional; leadership roles skip it.
- **One story paragraph, the elicited one.** A second story never gets a
  paragraph. If it earns a place at all, it is one sentence inside "what I
  bring" (e.g. "Like taking an LLM support agent from
  nothing to a paying pilot"). Two full stories is the CV again.
- **The story paragraph runs choice → mechanism → outcome clause → tie-back.**
  The choice is deliberate ("I ran product and design as one function to give
  a small team velocity and focus"). The mechanism is how it actually worked,
  in at most two concrete sentences ("one discovery pipeline fed both the
  roadmap and the design reviews"; "users would change teams and the report
  kept running under their old permissions"). The outcome is one clause. The
  tie-back ends the paragraph in their words ("the seat you describe next to
  the Product and Engineering Directors"; "roughly the category of problem
  you're hiring for"; "the same problem wearing different clothes").
- **Lessons over outcomes.** Every experience ends in what it taught or what
  it now lets me do ("AI inside a live operational loop behaves nothing like
  AI in a demo"; "that's what allows me to shape what doesn't exist yet").
  Earlier roles get one sentence each with a lesson, never an outcome list.
- **One number per letter.** Both samples carry exactly one (a headline ARR figure).
- **AI-native angle as accelerator, foundation unchanged.** "Now the loop
  runs even faster with AI (prototyping, synthesising research, delivering to
  production) but the foundation remains: solid research, alignment around
  outcomes, an empowered team."
- **"What I bring" is one sentence, not a plan.** It opens the last story
  paragraph or stands on its own; it names the capability and the product it
  produces. No first-90-days plan, no "I'd like to do it at your scale".
- **Close flat.** Practicals only if there is something to say (remote,
  travel, notice period), then `Happy to talk.` No honesty-gap line unless
  the JD forces it; no closing zinger.
- **Shape:** 200-300 words (250 is the
  target), three to five paragraphs of three to five sentences. Sentences may run long and conversational; a fragment ("Like
  taking an LLM support agent from nothing to a paying pilot")
  is fine as an example beat.

## Step 1 — Load context

```bash
node lib/letter-context.mjs {NUM}          # add --stories N for more candidates
```

One call, one read: report (header, Block A, Criteria, any `### Motivation`
and Section G), stories ranked by how often the report cites them, the full
text of the top-ranked stories, the cited CV bullets and notes, the voice
section of `user/config/profile.md`, the sample letter, and the JD. Do not read the
full story bank or CV; if a story you want is not in the output, rerun with
`--stories`.

**Cold path** (pasted JD, no NUM): read the JD, `user/config/story-bank.md`,
`user/config/profile.md` and the newest files in `user/config/cover-letters/`
yourself. Pick stories by hand.

## Step 2 — Elicit

If the report already has a `### Motivation` section, reuse it and skip to
Step 3. Otherwise ask the candidate these three, one message, dictated answers
are fine:

1. **What you bring:** "What do you bring to this team that would make it a
   mistake for them not to talk to you?" (a capability plus the system it
   builds, and the product outcome it produces; not a first-90-days plan)
2. **Story:** "I'd use {top story} as the proof. Right one? And what's the
   moment in it you'd tell over coffee?" (offer the top one or two from the
   ranking; the candidate may name another)
3. **Their problem:** "Is there anything in the JD that tells you what they're
   actually struggling with, or is it generic?"

Append the answers verbatim under `### Motivation` at the bottom of the report
(cold path: keep in-session). **Never invent any of the three.** No answer to
question 3 means no problem line.

## Step 3 — Draft

Draft from the dictation. Keep the candidate's sentences and phrasing wherever
they work; rewrite only what is unclear. Follow the pattern under "What the
letter does" paragraph by paragraph:

1. **Greeting** — `Hi,` (a named hiring manager if known).
2. **Belief → what a good leader does → their JD line.** Never the CV's own
   opening sentence. Swap test: mailable to a competitor unchanged means
   rewrite.
3. **Story paragraph** — exactly one, the story elicited in Step 2: choice →
   mechanism (two sentences max) → outcome clause → tie-back in their words. Frame choices as deliberate,
   never as a forced hand ("could not afford two heads") or cleanup duty
   ("nobody else owned it"). Tie back with the skill stated as what I do,
   never "I recognise this" or "this is familiar".
4. **What I bring** — one sentence, capability and the product it produces,
   then at most one sentence of second evidence and the AI-as-accelerator
   line if the role wants it.
5. **Practicals if any, then `Happy to talk.`**

Budget: 200-300 words, one number in the whole letter, one story paragraph.
No sentence of the form "At X I did A, B and C". No paragraph that only lists outcomes. Anything cut stays in
reserve for the interview.

## Step 4 — Check

Read it once against `modes/_writing.md` §6 and the voice section of
`user/config/profile.md`. Then the sample-letter test: put a paragraph next to an
accepted letter and ask whether the same person wrote both. If the draft is tighter,
cleaner and more impressive than the sample, it is worse; loosen it.

Plain ASCII punctuation by hand (`—`/`–`→`-`, smart quotes→straight,
`…`→`...`): nothing in this path normalises for you.

## Step 5 — Assemble the markdown

Write `user/output/customized-cvs/{NUM}-{slug}-cover-letter.md` (cold: drop the
`{NUM}-` prefix). `style/cover-letter.css` expects exactly this shape:

```markdown
Dear Hiring Team,

[Belief, what a good leader does, their JD line.]

[Story paragraph.]

[What I bring, with its evidence.]

[Practicals if any.]

Happy to talk.

---

::: signature
[Full Name]<br>
[email] · [phone]<br>
[linkedin] · [portfolio url]
:::
```

- Body paragraphs are plain markdown `<p>` — one blank line between.
- `---` renders to the `<hr>` divider the CSS styles.
- The `::: signature :::` fenced div maps to `<div class="signature">`. Markdown
  is **not** processed inside the div, so end every signature line except the
  last with a literal `<br>` — that is what stacks the monospace block (a blank
  line collapses to one run). The renderer converts `<br>` back to newlines in
  the `.txt` sibling. Pull every value from `user/config/profile.md` → `candidate`;
  never invent contact details.

## Step 6 — Render

From the repo root:

```bash
uv run render-cv-pdf.py \
  --in  user/output/customized-cvs/{NUM}-{slug}-cover-letter.md \
  --out user/output/customized-cvs/{NUM}-{slug}-cover-letter.pdf \
  --css style/cover-letter.css --format a4
```

`render-cv-pdf.py` is the shared markdown→PDF renderer (also used for CVs). It
emits a `.txt` sibling automatically — the paste-ready text for free-text form
fields; do not pass `--no-txt`. Do **not** pass `--target-pages` (its
bullet-trimming is CV-specific). The command prints the page count: if it is over
one page, tighten the prose in Step 3 and re-render until it fits.

## Step 7 — Hand off

Report the three paths: `.pdf` (upload), `.txt` (paste), `.md` (source). Show the
letter text in chat as plain paragraphs — no blockquote, no code fence — so the
candidate can read and copy it directly.

## Step 8 — Keep the accepted letter

The candidate edits the `.md` (or the pasted text) before it goes out. Once
they call it final, or `apply` submits it, copy the letter as sent to
`user/config/cover-letters/{NUM}-{slug}.md`: a `# {Company} — {Role} ({date})`
heading, one line on what the letter shows (role type, shape), then the body
from the greeting to `Happy to talk.`, no signature block. That directory is
the only corpus of accepted letters; Step 1 feeds the newest ones back as the
bar for the next draft. Never store a draft the candidate has not accepted.

## Called from `apply`

When `apply` Step 4 hits a cover-letter field or upload: follow this mode for the
application's NUM, then in `apply` upload the `.pdf` or paste the `.txt`. This
mode is the single source of cover-letter logic — `apply` never drafts letters
inline.
