# Ashby - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on Ashby.

**Host pattern:** `jobs.ashbyhq.com/{org}/{id}` (the application form is `jobs.ashbyhq.com/{org}/{id}/application`).

## Reaching the form

- **Reveal the form:** the landing URL is the Overview; click "Apply for this Job" -> URL becomes `.../application` and all fields render in the main document (no iframe).
- **The application form is reachable by direct URL** - appending `/application` to the job URL renders the whole form without clicking "Apply for this Job" first.

## Enumerating fields

- **Field labels are NOT in `snapshot -i`** (shows bare inputs only) and refs regenerate every snapshot. Enumerate via read-only `eval` wrapped in `JSON.stringify` (querySelectorAll over `label` for questions; over `input,textarea,button,[role=radio],[role=combobox]` for controls). CSP blocks bare-string `eval` (`unsafe-eval`) but IIFE `(()=>{...})()` runs in the isolated world.
- **UUID element ids start with a digit** -> `#6fc3...` is an INVALID CSS selector and `fill` silently no-ops. Use attribute selectors `[id="6fc3..."]` for every UUID-id field (url inputs, textareas, notice-period text, radios). System fields (`#_systemfield_name`, `#_systemfield_email`) are fine with `#`.
- **Nth-child selectors on `div.ashby-application-form-field-entry` are stable and unique** when a control has no id (the Yes/No buttons don't): `div.ashby-application-form-field-entry:nth-child(N) > div:nth-child(2) > button:nth-child(1|2)`. Confirm the mapping by reading the field entry's `innerText` back before clicking.
- **`setAttribute`-only eval is safe on Ashby.** Tagging elements with a `data-*` attribute does not disturb React state here - unlike Greenhouse, where eval-mutation blanks the SPA (see `modes/_ats/greenhouse.md`). Use it to build stable selectors for id-less controls; it is more reliable than nth-child mapping when a form has repeated widgets.

## Controls

- **Yes/No questions** render as two `<button>`s backing a hidden checkbox; the selected one gets class `_active_...`. Click by fresh `snapshot -i` ref (first Yes in DOM order = first such question). Verify via `button.className.includes("_active_")` AND the backing `input[type=checkbox].checked`.
- **`click --text "Yes"` silently no-ops on the Yes/No buttons** (returns nothing, no `OK`, nothing selected) even though `--text` is the documented flag. `click --selector '.ashby-application-form-input-yesno-option'` works and hits the first such button in DOM order (= Yes). Prefer the class selector over `--text` for these (Filigran, 2026-09-14).
- **Multiple Yes/No groups on one form break the class selector.** `click --selector '.ashby-application-form-input-yesno-option'` always hits the FIRST such button in the document, so it cannot answer four separate Yes/No questions differently (Camunda #3084 had four, needing Yes/Yes/No/Yes). `click --text 'Yes'` exits 1 when several match. Working approach: walk UP from each backing checkbox's UUID `name` to its group, tag both buttons, then click by that tag:
  `(function(){var names=['uuid1','uuid2'];names.forEach(function(n,i){var b=document.querySelector('input[name="'+n+'"]').closest('.ashby-application-form-input-yesno').querySelectorAll('button');b[0].setAttribute('data-ao','yes'+i);b[1].setAttribute('data-ao','no'+i)})})()`
  then `click --selector '[data-ao="yes0"]'`. Get the checkbox UUIDs from the input enumeration; their DOM order matches the label order.
- **A Yes/No checkbox reading `checked:false` is ambiguous** - it means both "No is selected" and "nothing answered yet". Only the `_active_` class on the button distinguishes them. Verify Yes/No selections by class, never by the backing checkbox alone.
- **Single-select (e.g. experience level)** = native `input[type=radio]` with long ids `...-labeled-radio-N`; set with `check '[id="...-labeled-radio-0"]'` (option 0 = first). Verify `radios.findIndex(r=>r.checked)`.
- **Multi-select checkbox groups** (`...-labeled-checkbox-N`): the `input` is `opacity:0` so `check` AND `click` on the input both silently no-op. Click `label[for="...-labeled-checkbox-N"]` instead - that works. It TOGGLES, so click once and verify `.checked`; two "failed" attempts in a row can actually be two successful toggles back to false.
- **Location** is an autocomplete `input[role=combobox]` ("Start typing..."): `click` it, `type` the city, wait ~2s, `snapshot -i` -> click the matching `option` ref (e.g. "Stockholm, Sweden"). Verify combobox `.value`.
- **Comboboxes need a real key event to open.** `fill` alone sets `.value` but fires no dropdown (Location, Pronouns and Country all stayed closed on Camunda #3084). Sequence that works: `fill --selector '[...]' --text 'Stockholm'` then `click --selector '[...]'` then `press Backspace`, wait ~3s, then read `[role=option]` texts. Same real-key-event requirement as the Lever location field (`modes/_ats/lever.md`).
- **Select the option by tag, not by text.** `click --text 'Stockholm, Sweden'` exits 1 (the string also appears inside a longer option). Tag the exact match and click it:
  `(function(){var o=[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()==='Stockholm, Sweden');o.setAttribute('data-ao','loc')})()` then `click --selector '[data-ao="loc"]'`. Reading options via eval does NOT close the dropdown, so tag-then-click is safe.

## Resume / autofill

- **No resume/CV upload field** on some forms - Ashby forms can be URL + free-text only (LinkedIn/GitHub URLs + textareas). Don't assume a file input exists; the customized CV PDF may go unused. Others (Oyster, 2026-07-22) DO have a required `#_systemfield_resume`.
- **"Autofill from resume" box** sits above Personal Information as a SEPARATE `input[type=file]` from `#_systemfield_resume`. When the candidate drops the CV PDF there, Ashby parses it and fills Full Name, Email, LinkedIn, the real Resume field AND the Country combobox - and the candidate often clicks the Yes/No gates themselves while watching. **Read the whole form's state via `eval` BEFORE filling anything**; several fields may already be correct, and re-filling risks clobbering a resolved combobox. Autofill wrote `Stockholm,SE` into "Country of Residence" (label asks for a country) - valid but worth flagging to the candidate.
- **Button indices go stale when a file is attached.** Attaching the resume inserts a "Replace" button into the DOM, shifting every later index - a verification built on `querySelectorAll("button")` slicing silently reads the wrong elements afterwards. Scope by class instead: `button.ashby-application-form-input-yesno-option` for Yes/No, `.ashby-application-form-field-entry` to recover each button's question text. Same reason the candidate can attach the CV mid-flow without telling you: re-read state by class before every verification, never by index.

## Verification and submit

- **cmux `screenshot` always renders from the TOP of the DOM** regardless of scroll position (even after native `scroll --dy` moves `window.scrollY`) - it will NOT capture lower fields. Verify filled values via `eval` reading `.value`/`.checked`, not screenshots.
- **Verify the whole form in one eval read-back before handing over.** Iterate `.ashby-application-form-field-entry`, take each entry's first innerText line as the label, and read the `_active_` Yes/No button, the `:checked` radio's `label[for]`, or the input `.value`. One call produces a complete field/value table - the only trustworthy check, since screenshots render from the top of the DOM.
- **Submit is a SINGLE click with no confirmation step**, and the page immediately shows "Your application was successfully submitted." Finish EVERY fill before handing the form over, and warn the candidate the next click submits. Note: the candidate may edit free-text fields (esp. personal-voice ones) in the live surface before submitting, so the submitted text can differ from what was filled - capture the final submitted values for Section G rather than assuming the filled draft went in.

## Shell mechanics

- **`fill`/`click`/`check` need explicit args**; pass long multi-line answers via `"$(cat file.txt)"`. Filter Sentry stdout noise with `grep -v -iE 'sentry|io\.sentry|NSC|NSU|NSF|Error Domain|couldn|Caches'`.
- **Never shorten the command into a shell variable.** zsh does not word-split unquoted parameters, so `S="cmux browser surface:120"; $S fill ...` dies with `command not found: cmux browser surface:120`. Combined with a habitual `2>/dev/null`, the failure is invisible and you conclude the page is broken. Write the full `cmux browser surface:N ...` every time, and send stderr through `grep -vi sentry` rather than to `/dev/null`.
- **A shell FUNCTION is fine even though a shell variable is not.** The zsh no-word-split trap applies to `S="cmux browser surface:70"; $S fill ...`, but `f(){ cmux browser surface:70 fill --selector "$1" --text "$2"; }` works and keeps batch fills readable. Return `$?` per call instead of piping to `grep -v Sentry` - a trailing grep with no matches exits 1 and makes a whole successful compound command look failed.

## Form content and limits

- **Some Ashby forms are fully factual** - name, email, resume, LinkedIn, work-auth Yes/No, notice period, salary - with no cover letter and no narrative question at all (Weaviate, 2026-08-20). Check the field inventory before drafting anything; the tailored CV may be the entire application.
- **Weaviate caps applications at 3 per 30-day span** across all their jobs, stated on the form itself. Other Ashby orgs may set similar limits - read the banner above the form.
- **Camunda caps applications at 2 per 30-day span** across all their jobs, plus no re-apply to the same role within 60 days without an offer (stated on the form). Same banner pattern as Weaviate's 3-per-30.
- Ashby has **no normalizer in the fill path** -> apply `modes/_writing.md` section 5 Unicode substitutions by hand (straight quotes, no em/en dash) before filling browser text.

## agent-browser (WKWebView) fallback path

When driving Ashby through the agent-browser WKWebView fallback instead of cmux Chromium, the capability set is much narrower:

- **`eval` is CSP-blocked on Ashby pages** (every expression throws `js_error`). Read field labels via `scroll-into-view eN` + `screenshot`, not eval. Snapshot a11y labels are often stripped on Ashby; the screenshot is the source of truth.
- **All JS-locator commands fail on Ashby, not just `eval`.** `find`, `get count --selector`, `click "text=..."` each throw `js_error`. What DOES work: ref-based `fill`/`click eN`, `scroll-into-view eN`, and `get text --selector body` (dumps every label + radio option in DOM order - best way to read the whole form at once). Autocomplete comboboxes work: `fill eN "Stockholm"` -> the option list renders as fresh refs -> `click` the matching option ref.
- **Radio/checkbox groups are NOT exposed as snapshot refs** on Ashby (only textboxes/comboboxes/buttons are). Can't be set by ref, by selector (js_error), or by coordinate (`input mouse` is unsupported on WKWebView). A required radio like "How did you hear about us?" must be ticked by the candidate in the visible surface - flag it explicitly in the handoff.
