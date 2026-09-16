# Workable - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on Workable.

**Host patterns:** `apply.workable.com/{subdomain}/j/{SHORTCODE}/` (the employer's own board - the real form is at `.../apply/`) and `jobs.workable.com/view/{opaque-id}/...` (Workable's aggregator listing - **not** a form).

Applying on Workable via the cmux browser:

- **A `jobs.workable.com/view/...` URL is a dead end.** Its two "Apply now" buttons are `<button>` elements with JS handlers and no href; clicking either leaves the URL unchanged and opens nothing the automation can reach. Nothing in the page source, the `__NEXT_DATA__`, or the JSON-LD carries the apply URL. Resolve the employer board instead:
  1. `xh -I --follow "https://apply.workable.com/{guess}/"` - the `<meta name="subdomain">` tag confirms it. The company slug is usually the obvious one.
  2. Navigate the surface there, then read the job links off the DOM: `[...document.querySelectorAll('a[href*="/j/"]')].map(a => ({h: a.href, t: (a.closest("li") || a.parentElement).innerText}))`. Match on title; the link text itself is empty.
  3. Go straight to `{job-url}/apply/`.
- The aggregator listing and the employer board can disagree on posting age (22 days vs "about 2 months" for the same job, #3103). Trust neither for liveness; verify per CLAUDE.md.
- `snapshot -i` returns only chrome (header, footer, cookie settings) - zero form fields. Enumerate with read-only `eval` over `input,textarea,select`. Ids are stable and selectable: `firstname`, `lastname`, `email`, `headline`, `address`, `city`, `postcode`, `country`, `summary`, `cover_letter`; custom fields are `CA_{n}` (account-level) and `QA_{n}` (job-level); phone is `input[type="tel"]` with a separate country-code widget already set from the board's locale.
- Labels do not resolve via `label[for=...]`. Read the question text with `document.querySelector("form").innerText` and map it to the id list by order.
- **Address composites.** Workable folds `address + city + postcode + country` into the single `address` field and blanks the three sub-fields as it does. Put the street alone in `address`, then fill city/postcode/country; the composite assembles itself. Filling the full address string into `address` first produces a doubled value ("Street, 11740, Stockholm, Sweden, Stockholm, 11740, Sweden").
- **Radio ids regenerate on every React re-render.** Re-enumerate immediately before each `check`, and verify by `value` + label, never by the id you read a moment ago: `var r = document.querySelector("input[name=CA_{n}]:checked"); ({val: r.value, lbl: r.closest("label").innerText})`.
- Consent widgets come in two shapes on the same form: a YES/NO radio pair (`QA_{n}`) and a plain checkbox above Submit. Both stay candidate-manual.
- Resume is a required file input; upload stays candidate-manual on the cmux path. The "Import resume from" autofill widget at the top is a separate parsing path - ignore it, it overwrites fields.
- Velsera's form (#3103) was a India-templated instance on a Europe-remote role: "Official Notice Period" in 15/30/45/60/90-day bands, "Current Salary (Fixed and Variable separately)", and a GBP salary question alongside a EUR-market role. Answer literally; don't normalise the question away.
- zsh does not word-split a variable holding the command prefix - write `cmux browser surface:N ...` in full on every line.

Related: `modes/_ats/ashby.md`, `modes/_ats/greenhouse.md`, `modes/_ats/lever.md`, `modes/_ats/recruitee.md`, `modes/_ats/teamtailor.md`
