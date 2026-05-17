# Writing & ATS Standards — career-ops

<!-- ============================================================
     System file. Self-contained: the app depends on no external
     writing skill. General craft rules live here; personal
     voice/branding lives in config/profile.md → Voice & Branding.
     ============================================================ -->

The complete quality bar for **every piece of generated text that reaches a human reviewer**: CV summaries and bullets, cover letters, application form free-text answers, outbound LinkedIn/email messages.

**Out of scope:** internal evaluation reports (`data/reports/*`) and terminal output to the user — working notes, not candidate-facing.

Apply this file together with the candidate's personal voice in `config/profile.md` → **Voice & Branding**. This file is the general craft; that section is the individual signature. When the personal section is silent on something, this file governs.

## 1. Voice

- **Direct and concrete.** No preamble, no throat-clearing, no meta-commentary ("In this answer I will…"). Open on the substance.
- **Plain, native tech English.** Short sentences. Active voice. Strong verbs. Match the JD's language at generation time (EN default).
- **Earn every sentence.** If a sentence doesn't add a fact, a reason, or a next step, cut it.
- **Specific beats impressive.** Numbers, tools, named systems and outcomes over adjectives.

## 2. Hard bans (rewrite on sight)

**Corporate-speak / clichés:**
"passionate about", "results-oriented", "proven track record", "demonstrated ability to", "best practices" (name the practice), "in today's fast-paced world", "synergies", "robust", "seamless", "cutting-edge", "innovative", "world-class", "game-changer", "best-in-class".

**AI-tell vocabulary:**
"leveraged" → "used" (or name the tool) · "spearheaded" → "led"/"ran" · "facilitated" → "ran"/"set up" · "delve", "navigate" (figurative), "underscore", "testament to", "tapestry", "landscape" (figurative), "realm", "boasts", "showcase", "elevate", "embark", "foster", "garner", "pivotal", "crucial", "vital" (when decorative).

## 3. AI-writing patterns to strip

- **Em-dash / en-dash overuse.** Restructure into two sentences or use a comma/colon. (Mechanically backstopped — see §5 — but don't generate them.)
- **Rule of three.** Not every list needs exactly three items. Use two, or four, or one strong claim. Vary it.
- **Negative parallelism.** "It's not just X, it's Y" / "This isn't about X — it's about Y." Delete the frame; state Y.
- **Inflated symbolism / promotional gloss.** "stands as a testament", "plays a vital role", "rich tapestry of", "a beacon of". Cut entirely.
- **Vague attribution.** "industry experts agree", "studies show", "it is widely regarded". Either cite the specific source or drop the claim.
- **Superficial -ing wrap-ups.** Trailing "…, highlighting the importance of…", "…, showcasing the ability to…", "…, reflecting a commitment to…". Delete; the fact already carried the point.
- **Filler openers.** "It's worth noting that", "It is important to remember", "Needless to say", "At the end of the day", "When it comes to".
- **Passive voice** where an actor exists. "The roadmap was owned by me" → "I owned the roadmap."
- **Hedging stacks.** "I think this could potentially help to some extent." State the claim or qualify it once, not three times.

## 4. Structure

- Don't start consecutive bullets or sentences with the same word.
- Mix sentence lengths deliberately: a short claim, then a longer one with the evidence, then short again.
- Lead with the outcome, then the method. "Cut p95 from 2.1s to 380ms by moving retrieval to pgvector" beats "Worked on performance by exploring vector databases."
- Name tools, projects, customers, and numbers whenever disclosure allows.

## 5. ATS Unicode (enforced in code, not by memory)

Em-dashes, en-dashes, smart quotes, ellipses, zero-width chars and nbsp break Workday/Greenhouse/Lever parsers. `lib/normalize-text.mjs` strips them deterministically at every programmatic write point (`generate-cv-llm.mjs`, `cv-fact-check.mjs`). Treat §3's em-dash rule as a craft preference, not the safety net — the code is the safety net. Where text is filled by an agent into a browser form (no script in the path), apply the substitutions by hand: `—`/`–`→`-`, `"" ''`→`" '`, `…`→`...`, strip zero-width/nbsp.

## 6. Self-check before output

Before any candidate-facing text leaves: re-read once against §2–§4, and confirm the personal signature from `config/profile.md` → Voice & Branding is present. This pass is mandatory for everything a reviewer reads; exempt only short factual fields (name, phone, URL, Yes/No, dropdowns).
