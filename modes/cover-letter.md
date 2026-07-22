# Mode: cover-letter — One-Page Cover Letter

Generates a one-page cover letter PDF (plus a paste-ready `.txt`) for a specific
application. Runs standalone via `/career-ops cover-letter [NUM | company]`, or
is called by `apply` when a form has a cover-letter field or upload.

Source-material discipline is the same as `apply` free-text answers: closed-world
over the evaluation report, `config/cv.json`, and `config/story-bank.md`. The JD
steers emphasis and wording — it never adds a claim about the candidate.

## Inputs

Resolve the target before writing anything.

- **With a NUM** (`/career-ops cover-letter 064`, or handed in by `apply`): a
  scored pipeline entry. Glob `data/reports/{NUM}-*.md` for the report and derive
  `{slug}` from that filename (`{NUM}-{slug}-{date}.md`).
- **Cold** (a pasted JD, no NUM): no report on disk yet. Work from the JD text
  plus `config/cv.json`. Derive `{slug}` kebab-case from the company name.
- **No args**: ask which application — offer the most recent `Evaluated` /
  `Applied` rows from `data/applications.md`, or accept a pasted JD.

Always also read `config/profile.md` (voice, and the `candidate` frontmatter for
the signature) and `config/story-bank.md`.

## Source discipline (light provenance)

Every concrete claim — a metric, a named system, an outcome — must trace to one of:

- the evaluation report's **Block A** matches or `[evidenced]` Criteria-ledger
  items (with their `[src: id]` evidence), when a report exists;
- a `config/cv.json` bullet or a `config/story-bank.md` story;
- `config/profile.md` narrative.

No `[src:]` tags and no validator — this is prose, not the CV. But the rule is
the same as `apply` Step 4: the JD says *what to emphasise*, never supplies a new
fact. If the JD asks for something the candidate cannot evidence from the sources
above, do not claim it — reframe around an adjacent strength.

## Step 1 — Load context

- **NUM path:** read the report. Header → company, role, score, archetype.
  Block A → cited matches. Criteria ledger (bottom of the report) → the
  employer's screening needs as `[evidenced]`/`[gap]` bullets — the letter's
  spine. If the report already has a **Section G** (prior apply answers),
  mine it for phrasing that landed.
- **Cold path:** read the pasted JD. Pull the company, role, and the three or
  four needs it leads with.
- Read `config/cv.json` for the spine of experience and `config/story-bank.md`
  for STAR+R stories.

## Step 2 — Draft

**The letter is a teaser, not a case study.** Its job is to start a conversation,
not to prove everything. Lead with impact and relevancy; implementation detail
earns its place only when it directly supports one of those two, and gets cut
otherwise. The worked examples, the earned secrets, the "how I did it" belong in
the interview — leave the reviewer wanting the call.

One page. Structure:

1. **Greeting** — `Dear Hiring Team,` unless a named hiring manager is known.
2. **Opening** — a concrete hook: why *this* company and role, referencing
   something specific and real from the JD. No generic "I am excited to apply."
3. **Two body paragraphs** — pick the two most important `[evidenced]`
   Criteria-ledger items (cold path: the JD's two lead needs) and prove each
   with its cited evidence. One proof or story per paragraph, two headline
   proofs total — the rest of the ledger stays in reserve for the interview.
   Lead each on outcome and relevance; keep method only where it backs the
   impact, and drop the rest. Numbers and named systems over adjectives.
4. **Close** — confident and forward-looking; an "I'm choosing you" register,
   not a plea. Point at the conversation, not at a closing zinger.

## Step 3 — Voice pass

Rewrite the draft in the candidate's signature per `config/profile.md` →
**Voice & Branding** (first person, proof-before-claim, builder's register,
confident close). Keep the two selected proofs intact; cut anything else the
draft picked up along the way.

## Step 4 — Scrub pass

Enforce `modes/_writing.md` §2–§4 on the result: kill corporate-speak and AI-tell
vocabulary, strip the AI-writing patterns (em-dash / rule-of-three /
negative-parallelism / vague-attribution / filler), fix passive voice, vary
sentence structure. Apply the §5 Unicode substitutions by hand (`—`/`–`→`-`,
smart quotes→straight, `…`→`...`, strip zero-width/nbsp) — nothing in this path
normalises for you. Finish with the §6 self-check.

## Step 5 — Assemble the markdown

Write `output/customized-cvs/{NUM}-{slug}-cover-letter.md` (cold: drop the
`{NUM}-` prefix). `style/cover-letter.css` expects exactly this shape:

```markdown
Dear Hiring Team,

[Opening paragraph.]

[Body paragraph.]

[Body paragraph.]

[Close.]

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
  the `.txt` sibling. Pull every value from `config/profile.md` → `candidate`;
  never invent contact details.

## Step 6 — Render

From the repo root:

```bash
uv run render-cv-pdf.py \
  --in  output/customized-cvs/{NUM}-{slug}-cover-letter.md \
  --out output/customized-cvs/{NUM}-{slug}-cover-letter.pdf \
  --css style/cover-letter.css --format a4
```

`render-cv-pdf.py` is the shared markdown→PDF renderer (also used for CVs). It
emits a `.txt` sibling automatically — the paste-ready text for free-text form
fields; do not pass `--no-txt`. Do **not** pass `--target-pages` (its
bullet-trimming is CV-specific). The command prints the page count: if it is over
one page, tighten the prose in Steps 2–4 and re-render until it fits.

## Step 7 — Hand off

Report the three paths: `.pdf` (upload), `.txt` (paste), `.md` (source). Show the
letter text in chat as plain paragraphs — no blockquote, no code fence — so the
candidate can read and copy it directly.

## Called from `apply`

When `apply` Step 4 hits a cover-letter field or upload: follow this mode for the
application's NUM, then in `apply` upload the `.pdf` or paste the `.txt`. This
mode is the single source of cover-letter logic — `apply` never drafts letters
inline.
