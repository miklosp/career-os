---
# Career-Ops Profile — single source of truth for your personal data.
# Fill this in with your details.
#
# Frontmatter holds the two structured contracts the system parses:
#   candidate       → lib/cv-draft.mjs (CV identity header)
#   location_policy  → modes/_location-gate.md (per-JD skip gate)
# Everything else (archetypes, narrative, voice, scoring) is the markdown body.
candidate:
  full_name: "Jane Smith"
  email: "jane@example.com"
  phone: "+1-555-0123"
  location: "San Francisco, CA"
  linkedin: "linkedin.com/in/janesmith"
  portfolio_url: "https://janesmith.dev"
  github: "github.com/janesmith"
  # (Optional) Canva resume design ID for visual CV generation via /career-ops pdf.
  # Find it in your Canva design URL: https://www.canva.com/design/DAxxxxxxx/...
  # canva_resume_design_id: "DAxxxxxxxxx"

# Optional — read by modes/_location-gate.md to auto-skip roles you can't take.
# Remove or comment out skip_on entries you don't want enforced. Delete the
# whole block to disable the gate (everything will be scored).
location_policy:
  home_country: "United States"
  home_timezone: "PST"
  # Allowed clock offset from home_timezone. Roles naming a timezone outside
  # this band (e.g. "must overlap 9-5 CET") are skipped.
  timezone_tolerance_hours: 3
  # Already have work authorization for home_country? If false and a role
  # requires it ("H1B only", "US citizens only"), it is skipped.
  us_work_authorization: true
  # Would you relocate for the right role? If false and a role requires on-site
  # with relocation, it is skipped.
  relocation_open: false
  # Remote scope labels that are OK for you.
  remote_allowed_scopes:
    - "Global"
    - "Worldwide"
    - "Americas"
    - "US"
    - "United States"
  # Languages the job ad may be written in. A JD in anything else is skipped
  # before scoring. Supported names: English, German, Swedish, Danish,
  # Norwegian, Dutch, French, Spanish, Italian, Portuguese, Polish, Finnish.
  jd_languages:
    - "English"
  # Which rules to enforce. Comment out or remove to disable individual rules.
  skip_on:
    - jd_language_not_allowed
    - remote_scope_excludes_home_country
    - onsite_outside_home_country
    - us_work_auth_required
    - onsite_and_relocation_required
    - timezone_outside_home_tolerance
    # Skip roles that list an office in another country and never mention
    # remote work (the JD is silent, the form then asks "do you live here?").
    - location_unspecified_outside_home_country
---

# User Profile Context — career-ops (Jane Smith)

<!-- THIS FILE IS YOURS. The body is never auto-updated. Coaching session state
     lives in user/data/active-strategy.md, not here. -->

## Target Roles & Archetypes

| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **AI/ML Engineer (Senior/Staff)** | ML pipelines, applied AI, prototyping | Someone who ships production ML with measurable impact |
| **AI Product Manager (Senior)** | LLM products, agentic UX, discovery | Someone who can define and ship AI-native products |
| **Solutions Architect (Mid-Senior)** | Systems design, customer-facing, integrations | Someone who bridges product and engineering for customers |

## Adaptive Framing

| If the role is... | Emphasize about you... | Proof point sources |
|-------------------|------------------------|---------------------|
| Senior/Staff ML  | End-to-end ML pipelines, latency/perf wins | cv.md, profile.md |
| AI Product Manager | Shipped AI features, discovery, real metrics | cv.md |
| Solutions Architect | Cross-functional communication, integrations | cv.md |

## Exit Narrative

<!-- 4-6 lines. Who you are, the 2-3 outcomes that define you, what you're
     seeking now. Lead with concrete numbers and shipped things. -->

[Name] is a [location]-based [role family] with [N]+ years of experience. They have:
- [Outcome with a number — e.g. "Cut inference latency 40% at scale"]
- [Outcome with a number]
- [Current situation / what's next]

Currently seeking: [target role] at a [stage/type] company.

## Cross-cutting Advantage

<!-- The one-sentence reason you beat the median candidate, then 2-4 bullets. -->

[Your bridge — the combination most candidates don't have.]

Key differentiators:
- [Differentiator]
- [Differentiator]

## Voice & Branding

<!-- THIS IS YOURS. The general writing craft lives in modes/_writing.md;
     this section is your personal signature on top of it. Edit freely. -->

How application answers, cover letters, and outbound messages should sound *as me*:

- **First person, plainspoken.** "I owned X and shipped Y." Not résumé-third-person.
- **Proof before claim.** Lead with a concrete outcome, then the takeaway.
- **Builder's register.** Name the system, the tool, the metric.
- **Warm, not corporate.** No "passionate about", no enthusiasm theatre.

Signature themes to surface: [your recurring proof themes].
Avoid for me specifically: [framings that misrepresent you].

## Comp Anchor

Used by `modes/interview-prep.md` for negotiation framing — never invent numbers; anchor here.

- **Target:** $150K–200K total comp
- **Floor (walk-away):** $120K
- **Equity:** Always ask; benchmark against role level
- **Contractor/fractional:** [day rate if relevant]

## Location Policy

Hard skips are handled by `modes/_location-gate.md` (reads this file's frontmatter → `location_policy`). Anything that gets through the gate is factored into **Block C: Cultural Signals**:

- **Remote-first, in-region:** Block C boost
- **Local hybrid:** Block C boost
- Anything stricter gets skipped by the gate before scoring runs.

## Scoring Adjustments

Block weights are owned by `modes/_eval.md`. This section holds only your user-specific bonuses/penalties applied to **Block B: North Star** (unless noted):

- **Stage sweet spot:** [e.g. Series A–C].
- **[Domain you want]:** +0.3
- **[Adjacent strength]:** +0.2
- **[Hard no — deal-breaker]:** -1.0
- **No equity at all (employee role):** -0.2 (applied to Block D: Red Flags)

Location penalties are NOT scored — hard skip via the gate or soft Block C signal.
