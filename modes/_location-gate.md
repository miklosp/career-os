# Mode: _location-gate — Skip roles that don't fit the user's geography

Runs after `modes/_fetch.md` has saved a JD under `data/jds/{NUM}-*.md` and before
`modes/_eval.md` spends tokens scoring it. Cheap, deterministic, honest —
when a role can't work geographically, skip it with the evidence quoted.

**Deterministic short-circuit first.** The auto-pipeline (via
`lib/prep-jds.mjs`, or the solo-agent flow directly) calls
`node lib/location-gate.mjs {NUM}` before this LLM gate runs. That script
fires SKIP for any JD written outside `jd_languages`, for any JD whose
`**Remote scope:** onsite:City` / `hybrid:City` header points at a country
outside `home_country` (and not literally listed in `remote_allowed_scopes`),
and for any `unspecified`-scope JD whose `**Location:**` names such a country
while the body never mentions remote work (Rule 8).
If it returns ALLOW or SKIP, this file is not read. It only falls through to
this LLM gate on `NEEDS_LLM` — i.e. when the JD's language is undetermined, or
its structured scope is missing or ambiguous and the body needs human-style
judgment for Rules 0 / 3 / 4 / 5 / 6 below.

## Input

- `NUM` from the fetch stage
- `data/jds/{NUM}-*.md` (the saved JD with its populated location header fields)

## Step 1 — Load policy

Read `config/profile.md` frontmatter → `location_policy` block. If the block is missing:

- Log one warning: `location_policy missing from config/profile.md — gate disabled, everything passes`.
- Return `ALLOW`.

If present, pull these fields (with defaults in case of partial config):

| Field | Used by rule(s) |
|-------|-----------------|
| `home_country` | rules 1, 2, 6 |
| `home_timezone` | rule 5 |
| `timezone_tolerance_hours` (default 1) | rule 5 |
| `us_work_authorization` (default true) | rule 3 |
| `relocation_open` (default false) | rule 4 |
| `remote_allowed_scopes` (default `[home_country]`) | rules 1, 6 |
| `jd_languages` (default: rule off) | rule 0 |
| `skip_on` (list of rule ids) | which rules are enabled (ids: `jd_language_not_allowed`, `remote_scope_excludes_home_country`, `onsite_outside_home_country`, `us_work_auth_required`, `onsite_and_relocation_required`, `timezone_outside_home_tolerance`, `residency_required_outside_home_country`, `hybrid_outside_home_country`, `location_unspecified_outside_home_country`) |

## Step 2 — Read the JD header

From `data/jds/{NUM}-*.md` take the five location header fields:

- `**Location:**`
- `**Remote scope:**`
- `**Timezone:**`
- `**Visa/authorization:**`
- `**Relocation offered:**`

Plus the body text — you may need a direct quote for the evidence string.

## Step 3 — Apply the enabled rules

Check each rule in `skip_on`. Stop at the first SKIP and report it. If all
enabled rules pass, return ALLOW.

### Rule 0: `jd_language_not_allowed`

Fail if the JD body prose is written in a language that is not listed in
`jd_languages`. Check this first — a JD the candidate can't read is out
regardless of geography.

Judge the **body prose only**. The fetcher writes the header block
(`**Location:**`, `**Remote scope:**`, …) in English on every posting, and job
titles, tool names and company boilerplate are often English inside an
otherwise foreign-language ad.

- Mixed ads: if a full description exists in an allowed language (side-by-side
  translation, or an allowed-language section covering role + requirements),
  pass. Only skip when the substantive content is exclusively in a
  non-allowed language.
- Fewer than ~60 words of prose, or genuinely borderline → **ALLOW**. Never
  skip on ambiguity.

Evidence: quote the first substantive non-allowed-language sentence, prefixed
with the language you detected — `German — Wir suchen einen erfahrenen …`.

### Rule 1: `remote_scope_excludes_home_country`

Fail if **both** of these are true:

- `Remote scope` indicates a restricted remote list that the home country is NOT in.
  - Examples that fail: `full-remote-countries:US,CA` when home is Sweden; `full-remote-region:EU` is OK (EU includes Sweden, pass); `full-remote-countries:Spain,Portugal,Poland` when home is Sweden fails.
- None of `remote_allowed_scopes` match the scope tokens.

If the posting is `full-remote-global` or `full-remote-region:{X}` where `{X}` is listed in `remote_allowed_scopes` (e.g. `EMEA`, `EU`, `Europe`, `Nordics`), pass. The policy file is the source of truth for which region tokens count as supersets — don't hardcode region membership here.

**Upstream check:** if the JD header lists 10+ countries in `full-remote-countries:...` but the JD body says "anywhere in EMEA / EU / region X", the fetcher mis-transcribed the JSON-LD payroll list. The fix belongs in `modes/_fetch.md` (prose wins over JSON-LD country enumerations), not in this gate.

### Rule 2: `onsite_outside_home_country`

Fail if `Remote scope` starts with `onsite:` and the city is outside `home_country`.

Evidence: quote the exact sentence from the JD that names the on-site city, or the `**Remote scope:** onsite:{city}` header line if the body is silent.

### Rule 3: `us_work_auth_required`

Fail if `Visa/authorization` indicates US work authorization required AND `us_work_authorization` is `false` in policy.

Keywords that trigger: "Must have authorization to work in the US", "US citizens only", "H1B / OPT only", "Green card required", "No visa sponsorship available" (when combined with a US-located role).

### Rule 4: `onsite_and_relocation_required`

Fail if `Remote scope` starts with `onsite:` AND `Relocation offered` is `yes` (role requires relocation) AND `relocation_open` is `false` in policy.

This is stricter than rule 2 — it catches roles that offer relocation packages to Sweden-based candidates but still require them to move.

### Rule 5: `timezone_outside_home_tolerance`

Fail if `Timezone` explicitly names a zone outside `home_timezone ± timezone_tolerance_hours`.

Examples with `home_timezone: CET` and `timezone_tolerance_hours: 1`:

- `"Must overlap 9am-5pm PST"` → PST is CET-9 → SKIP
- `"EU timezones"` → passes (EU includes CET)
- `"CET ±2"` → passes (within tolerance)
- `"Any US timezone"` → PST/MST/CST/EST, range CET-9 to CET-6 → SKIP
- `"Americas timezones"` → SKIP
- `unspecified` → pass (no evidence to act on)

### Rule 7: `hybrid_outside_home_country`

Fail if the role requires **recurring physical office attendance** at a location
outside `home_country`, and `relocation_open` is `false`.

Check both places it shows up:

- **Header** — `Remote scope` starts with `hybrid:{city}` and that city's country
  is outside `home_country`.
- **Body** — the header is `unspecified`, `full-remote-region:{X}`, or silent on
  attendance, but the prose states a recurring on-site expectation tied to a
  named office: "3 days per week in our Munich office", "40% on-site",
  "hybrid, based from our Vilnius office", "one week per month at HQ".

**A region in `remote_allowed_scopes` does NOT excuse this.** Those tokens (`EU`,
`EMEA`, `Europe`, `Nordics`) declare where the candidate may work *remotely*
from — they are not a willingness to commute. A hybrid role in Munich is out
from Stockholm even though both are in the EU. Only an exact **literal country**
match in `remote_allowed_scopes` (e.g. `Sweden`) passes. This mirrors
`lib/location-gate.mjs`, which applies the same literal-country test to
`onsite:`/`hybrid:` headers — keep the two in step.

Stays ALLOW (never skip on ambiguity):

- Optional or aspirational office language: "office available if you want it",
  "we meet in person a few times a year", "occasional travel to HQ"
- Company onsites/offsites at a stated low frequency (quarterly or rarer)
- A named office city with no stated attendance requirement

Evidence: the `**Remote scope:** hybrid:{city}` header line, or the exact JD
sentence stating the office and its attendance cadence.

### Rule 6: `residency_required_outside_home_country`

Fail if the JD **explicitly and as a hard requirement** restricts employment to people who reside in / are based in / hold local work authorization for a *specific named country* that is NOT `home_country` and NOT covered by `remote_allowed_scopes`.

This catches roles that are remote-on-paper (`Remote scope` may be `unspecified` or `full-remote-region:unspecified`) but legally gated to a single non-home country — Rules 1 and 2 miss these because there is no restricted remote-country *list* and no `onsite:` prefix.

**Triggers (hard, explicit residency/eligibility language):**

- "must currently reside in {country}", "candidates must be located in {country}", "based in {country}" (as a requirement, not a preference)
- "must have the legal right to work in {country}" / "local work authorization in {country} required" / "must be a {country} resident", where {country} ≠ home and ∉ allowed scopes
- "{country}-based candidates only", "this role is open to residents of {country}"

**Does NOT trigger (stays ALLOW — soft signal, handled in Block C):**

- Soft preference phrasing: "ideally based in {country}", "{country} preferred", "nice to have: located in {region}"
- A named office city with hybrid/flexible remote and no residency requirement (that is Rule 2 territory only if `onsite:`)
- {country} (or a region containing it) is in `remote_allowed_scopes` (e.g. "based anywhere in the EU" with `EU` allowed → pass)
- Any residency language that is vague or aspirational rather than a stated requirement — **never skip on ambiguity**

Evidence: quote the exact JD sentence stating the residency/eligibility requirement.

### Rule 8: `location_unspecified_outside_home_country`

Fail if `Remote scope` is `unspecified`, `Location` names a country outside
`home_country` (no literal country match in `remote_allowed_scopes`, not the
home city), and the JD body says nothing about remote work. A JD that lists an
office city and never mentions remote is an office role there by default —
the application form usually asks "do you reside in this location?".

`lib/location-gate.mjs` fires this deterministically when the body has no
remote/WFH wording at all. It reaches this LLM gate only when the body does
mention remote somewhere: pass if that wording opens the role to the candidate
(remote from `remote_allowed_scopes`, "remote-first", "work from anywhere");
skip if it is confined to that country ("remote within Germany") or is
incidental ("occasional remote days", "remote-friendly office").

Evidence: the `**Location:**` header line, or the JD sentence tying the role to
the office / country.

## Step 4 — Emit the verdict

### ALLOW

Do nothing to the JD file. Return the string `ALLOW` to the caller. The
orchestrator will invoke `modes/_eval.md` next.

### SKIP

1. Update the `data/applications.md` row for this NUM:
   - `Status` column → `Skipped-Location`
   - `Notes` column → `{rule-id}: "{quoted JD sentence}"`
   - Leave `Score`, `PDF`, and `Report` empty.

2. Return the string `SKIP:{rule-id}: "{quoted JD sentence}"` to the caller.

3. Do NOT create a report. Do NOT drop a TSV in `data/tracker-additions/`.

The quoted sentence is mandatory — it's the candidate's audit trail. Never
say "SKIP: remote restricted" without the exact quoted evidence.

## Rules of the road

- **Never skip on ambiguity.** If a location field is `unspecified` and no rule has hard evidence, return ALLOW. Scoring will handle soft location concerns in Block C (Cultural Signals).
- **One rule, one evidence.** Don't concatenate multiple rule failures. Report the first SKIP cleanly.
- **Quote the JD exactly.** No paraphrasing. The dashboard shows this string verbatim in the SKIP filter.
