# Lever - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on Lever.

**Host pattern:** `jobs.lever.co/{company}/{id}`; the form is at `{job-url}/apply`.

Applying on Lever via the cmux browser:

- Apply form is at `{job-url}/apply` - navigate directly, don't click through.
- `snapshot -i` is near-useless on Lever (returned 5 refs, none of them form fields). Enumerate with read-only `eval` over `input,textarea,select`; labels come from `.application-question .application-label`.
- **Location autocomplete is the one trap.** `fill` sets `.value` without firing the events the geocoder listens to, so hidden `#selected-location` stays empty and the required field fails validation silently. Fix: `click` the input, then `press --key Backspace` to fire a real input event; `.dropdown-results` populates after ~3s; click the result by id (`#location-0`). Verify `#selected-location` holds a JSON blob with a geocode id, not just display text.
- Yes/No questions are **checkbox** groups, not radios: `check --selector 'input[name="cards[{uuid}][field0]"][value="No"]'`.
- Field names are stable and selectable: `name`, `email`, `phone`, `org`, `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `opportunityLocationId` (office select).
- Spotify's Lever form (#1811) had **zero free-text fields** - no cover letter, no "why this role", one file input. Check `document.querySelectorAll("textarea").length` before generating a cover letter; on such forms the CV carries the whole pitch.
- File upload stays candidate-manual on the cmux path. EEO surveys, pronouns, and marketing-consent checkboxes are the candidate's to answer.
- zsh does not word-split a variable holding the command prefix - write `cmux browser surface:N ...` in full on every line.

Related: `modes/_ats/ashby.md`, `modes/_ats/greenhouse.md`, `modes/_ats/recruitee.md`, `modes/_ats/teamtailor.md`
