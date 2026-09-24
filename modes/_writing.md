# Writing & ATS Standards — career-ops

<!-- ============================================================
     System file. Self-contained: the app depends on no external
     writing skill. General craft rules live here; personal
     voice/branding lives in user/config/profile.md → Voice & Branding.
     ============================================================ -->

The quality bar for **every piece of generated text that reaches a human reviewer**: CV summaries and bullets, cover letters, application form free-text answers, outbound LinkedIn/email messages.

**Out of scope:** internal evaluation reports (`user/data/reports/*`) and terminal output to the user — working notes, not candidate-facing.

Apply this file together with the candidate's personal voice in `user/config/profile.md` → **Voice & Branding**. This file is the general craft; that section is the individual signature. When the personal section is silent on something, this file governs.

## 1. What good sounds like

A person talking to a peer who knows the field. Not a job posting, not a consulting deck, not a model trying to be helpful.

- **Lead with the result.** The first sentence answers the question or states the outcome. Context comes after, if at all.
- **One idea per sentence.** Around twenty words, with a verb. Start a new sentence instead of joining clauses.
- **Short by leaving things out, not by packing them in.** Pick the one example that proves the point. Everything cut stays in reserve for the interview.
- **Specific beats impressive.** A named system, a real number, a customer, a moment ("users changed teams and the report kept running under their old permissions") over any adjective.
- **Say what the work actually was.** The interesting part is usually the problem definition or the call you made, not the feature list.
- **Opinions stated as opinions.** "This was the wrong bet, in hindsight." Qualify once, not three times.
- **One moment of honesty** per longer piece: a gap, a call you would revisit, a constraint that shaped the outcome. It reads as credibility.
- **Vary the rhythm.** A short claim. Then a longer sentence that takes its time with the evidence. Then short again. Never three sentences of the same shape in a row.
- **Name the actual role.** CISOs, SREs, platform teams, the sales team. Never "stakeholders" or "cross-functional partners".
- **Name the actual tool** when something technical is in the piece. It is proof of hands-on work.
- **First person, active voice.** "I decided", "we shipped". "We" for genuinely collaborative work; "I" for calls that were yours. Neither to inflate or to hide.
- **Plain, native tech English.** Match the JD's language at generation time (EN default).

## 2. Selection

Where the text answers a question (form field, cover letter, outbound message), every sentence answers the literal question. Two proofs is the default ceiling unless the question asks for more. A cover letter is not the CV in prose: the CV rides alongside and already carries the outcomes.

## 3. Tells to strip

Rewrite on sight. The fix is almost always a plainer sentence, not a synonym.

- **Corporate-speak:** "passionate about", "results-oriented", "proven track record", "demonstrated ability to", "best practices" (name the practice), "fast-paced", "synergies", "robust", "seamless", "cutting-edge", "innovative", "world-class", "best-in-class".
- **AI vocabulary:** "leveraged" → "used" · "spearheaded" → "led"/"ran" · "facilitated" → "ran"/"set up" · "delve", "navigate" (figurative), "underscore", "testament to", "tapestry", "landscape" (figurative), "realm", "boasts", "showcase", "elevate", "embark", "foster", "garner", "pivotal", "crucial", "vital" (decorative).
- **Significance inflation:** "marks a pivotal moment", "plays a vital role", "stands as", "setting the stage for". State the fact.
- **Trailing -ing wrap-ups:** "…, highlighting the importance of", "…, ensuring alignment". The fact already carried the point; delete or make it its own sentence.
- **Negative parallelism:** "not just X, it's Y". State Y.
- **Rule of three** when the real number is two or four. Use the real number.
- **"By doing X, we were able to Y."** → "X gave us Y" or "X worked."
- **Copula avoidance:** "serves as" → "is", "boasts" → "has".
- **Synonym cycling:** one concrete noun, repeated, beats "the team… the group… the partners".
- **Filler openers and fake-depth openers:** "It's worth noting", "At the end of the day", present-tense "The real question is".
- **Vague attribution:** "studies show", "widely regarded". Cite the source or drop the claim.
- **Passive voice hiding an actor:** "the roadmap was owned by me" → "I owned the roadmap."
- **Hedging stacks:** "I think this could potentially help to some extent."
- **Manufactured closers:** aphorisms and zingers that read as written, not spoken.
- **Em-dash and en-dash chains.** Two sentences, or a comma. (Mechanically backstopped in §5.)

## 4. Things that are fine

Do not over-correct these:

- Starting a sentence with "And" or "But".
- One-sentence paragraphs; a fragment for emphasis at the end of a beat ("Every contract renewed.").
- Admitting something did not work.
- "We" for collaborative work, especially for Nordic readers, where solo credit-taking reads badly.
- Repeating a concrete noun.
- A short concession, "Not fluent, but committed."
- Naming tools to prove hands-on work.

## 5. ATS Unicode (enforced in code, not by memory)

Em-dashes, en-dashes, smart quotes, ellipses, zero-width chars and nbsp break Workday/Greenhouse/Lever parsers. `lib/normalize-text.mjs` strips them deterministically at every programmatic write point (`cv-draft.mjs finalize`, `cv-fact-check.mjs`). Where text is filled by an agent into a browser form or written straight to a markdown file (no script in the path), apply the substitutions by hand: `—`/`–`→`-`, `"" ''`→`" '`, `…`→`...`, strip zero-width/nbsp.

## 6. Self-check before output

Mandatory for everything a reviewer reads; exempt only short factual fields (name, phone, URL, Yes/No, dropdowns).

1. **"What makes this sound AI-generated?"** Answer honestly: name the remaining tells from §3, and the sterile ones too (every sentence the same length, no opinion, no first person, no moment of honesty). Then fix exactly those.
2. **Read it aloud in your head.** Any sentence awkward to say gets rewritten.
3. **Selection (§2):** every sentence answers the question; proofs at the minimum that proves the point.
4. **Signature:** the personal voice from `user/config/profile.md` is audible. Put a paragraph next to the sample letter or the candidate's own phrasing: would the same person have written both?
5. **Ends on a signal**, not a trailing observation.
