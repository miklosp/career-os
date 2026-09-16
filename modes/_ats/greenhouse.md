# Greenhouse - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on Greenhouse.

**Host patterns:** `job-boards.greenhouse.io`, `boards.greenhouse.io`, the EU variant `job-boards.eu.greenhouse.io`, and company careers pages that embed Greenhouse in an iframe (URL carries `?gh_jid=...`).

## cmux Chromium path (job-boards.greenhouse.io)

Apply-mode findings for **job-boards.greenhouse.io** driven through the **cmux** browser (full Chromium), from StackBlitz/Bolt.new #1291 (2026-06-15):

- **The `snapshot -i` accessibility tree under-reports Greenhouse job-boards forms.** It surfaced only name/email/phone/URL fields and HID six required custom questions (schedule, sanctions screen, "have you used Bolt.new", years-of-PM, highest-impact approach) plus the "Location (City)" autocomplete. Never trust the `-i` snapshot alone here - enumerate the real field list with a read-only `eval` over `document.querySelectorAll("input, [id^=question_], #candidate-location")`, reading `id`, `aria-label`, the associated `label`, `value`, and `aria-required`.
- **All custom questions are react-select comboboxes - no native `<select>` in the DOM.** Even an open-ended-sounding question ("How do you typically identify the highest-impact product problems?") was a single-select multiple-choice, NOT free text. Confirm there's no `<textarea>` (only `g-recaptcha-response` exists) before assuming a question is free-text.
- **Open a react-select menu with `focus` + `press ArrowDown`** - a plain `click` on the `#question_*` input does NOT open it (`aria-expanded` stays false). After ArrowDown, options live at `[id^="react-select-{id}-option"]`; read their `innerText`. To select, arrow/Enter or click the option element.
- **cmux Chromium supports everything the agent-browser WKWebView blocks on Greenhouse**: CSS selectors, `eval`, `get value`, `get count`, `click`, `fill` all work. (Contrast the WKWebView fallback section below, where only ref-fills work.)
- **No long free-text field** on this form -> the **cover letter is the only narrative surface**; it must carry the whole pitch. There were TWO location fields: the standard "Location (City)" autocomplete AND a separate custom "Where are you located? (State/Province & Country)" text question - fill both.
- File uploads (Resume/CV) stay candidate-manual: cmux has no upload command. See `modes/_ats/README.md` for the broader cmux apply capability map.

## Greenhouse embedded in a company careers page

Additional findings from **ATOSS #1447** (2026-07-06) - Greenhouse **embedded in an iframe on a company careers page** (`atoss.com/...?gh_jid=...`):

- **Greenhouse-embedded-on-company-site -> navigate the surface directly to the iframe `src`.** The outer page's `-i` snapshot and input enumeration returned only nav/footer (0 inputs); the form lived in `iframe[src=job-boards.eu.greenhouse.io/embed/job_app?...&validityToken=...&token=...]`. The embed URL carries its own validityToken + token, so `browser navigate <iframe.src>` loads the same form as the **main document** - all inputs become directly selectable, no nested-frame driving needed. Find it with `eval` -> `document.querySelectorAll('iframe')[i].src`.
- **cmux `fill`/`click` need explicit `--selector`/`--text` flags.** The two-positional form (`fill "#id" "text"`) silently no-ops (returns `OK`, value stays empty). Use `fill --selector "#id" --text "..."` and `click --selector "#id"`. Broadly applicable to all cmux apply forms, not just Greenhouse.
- **react-select: `click --selector "#<inputId>"` DID open the menu here** (contra the ArrowDown-only note above - behavior varies by field/GH version; try click first, fall back to focus+ArrowDown). For a searchable select (Country), after opening, `fill` the same input to filter, then `click` the exact `[id^=react-select-<field>-option]`. **Country renders its selected value as the dial code + country flag glyph (Swedish flag followed by "+46"), not the country name** - verify via screenshot, the `singleValue` text alone reads as just "+46".
- **Phone is intl-tel-input**: filling `#phone` with the full `+46 ...` number auto-sets the country flag; no separate dial-code pick.
- **Fully factual forms exist** (name/email/phone/country/salary/work-auth/EU-residency/LinkedIn/permit + GDPR checkbox) with **no cover-letter or narrative field at all** - no cover letter to generate, no voice/scrub passes to run. Don't force a narrative surface that isn't there.
- `eval` output is JSON-coerced oddly for bare expressions (`.length` came back as `true`); always wrap in `JSON.stringify({...})`. The cmux binary also spews Sentry cache-path errors to stdout on macOS - filter with `grep -vi sentry`.

## agent-browser (WKWebView) fallback path

Distinct failure modes from Ashby; confirmed on Pulumi #1134, 2026-06-07:

- **Ref-based `fill eN` is the ONLY reliable fill path.** The form fields render in a frame/shadow context the top document doesn't own: cmux CSS `--selector` (fill/click/scroll-into-view) fails with `not_found: ... not found or not visible` even while the field is visibly on screen, and `eval`+`document.querySelector('input[name=...]')` is intermittent (finds fields right after a clean `open`, then returns `null`/`[]` after the SPA re-renders). Take a fresh `snapshot -i`, fill by the `eN` refs, verify by screenshot. `get value`/eval value-reads are NOT trustworthy here.
- **NEVER `reload`/`goto` mid-flow.** Both left the SPA a blank document (empty `<body>`, 39-char outerHTML, stale chrome title) and lost every fill - recover only by opening a *fresh* surface (`cmux --json browser open`). Likewise, do NOT eval-mutate a field (native-setter `value=''` + dispatch `input`) to "fix" a mistake - that also blanked the page. Re-fill by ref instead.
- **Two identically-labelled "Enter manually" controls** (Resume widget + Cover Letter widget) sit adjacent; only the **Resume's** gets a snapshot ref. Clicking it + filling the revealed textarea lands text in `resume_text`, NOT the cover letter. Don't paste cover-letter text via "Enter manually" by ref - have the candidate attach the cover-letter PDF (or paste it themselves). Same upload limit as Ashby: resume/CV is candidate-manual.
- **Custom react-select comboboxes are candidate-manual** (like Ashby radios). A required Yes/No such as "require visa sponsorship to work in the US?" is a `type=text` combobox NOT exposed as a snapshot ref and not selector-addressable - flag it in the handoff with the recommended answer (for a remote-from-Sweden EU citizen: **No**, work isn't performed in the US; the real gate is the separate location-eligibility text field).
- **Phone field auto-detects the country code** (`+46 ...` -> Sweden) - no separate country fill needed.
