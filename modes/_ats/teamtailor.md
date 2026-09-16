# Teamtailor - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on Teamtailor.

**Host pattern:** `{company}.teamtailor.com`; the clean form URL is `https://{company}.teamtailor.com/jobs/{jobId}/applications/new`.

## Reaching the form

- The "Apply for this job" buttons fire a Stimulus action `careersite--jobs--form-overlay#showFormOverlay`. The apply form is a **lazy-loaded Turbo-frame** whose overlay is `position:fixed` shoved off-screen via `transform: translateY(<viewportH>)` until opened - and it **never renders in cmux screenshots** even when open. Raw `click`/`.click()` on the button often does not populate it.
- **Clean path: navigate the surface directly to the turbo-frame src** `https://{company}.teamtailor.com/jobs/{jobId}/applications/new`. That's a full-page form, all fields in the main document, no overlay gymnastics. Field IDs are stable: `candidate_first_name`, `candidate_last_name`, `candidate_email`, `candidate_phone`, `candidate_job_applications_attributes_0_cover_letter`. CV file input `candidate_resume_remote_url`, plus an optional "Additional files" input.

## Controls

- **Multiple-choice screener questions are native radios**, not react-select: `candidate_answers_attributes_{i}_choice_{n}`, with the question text sitting in the `label[for]` of the **first** choice (e.g. "What are your gross annual salary expectations?*Required"). Select with `check --selector '[id="..."]'` and verify `.checked` - no keyboard/combobox dance. Blackwall #2386 rendered notice period, currency, and a **78-option country list** this way; a country radio list means the whole set is in the DOM at load, so match the label by name rather than trusting choice-number ordering (it is not alphabetical throughout).
- **Per-job custom/screener questions** live at `candidate_answers_attributes_{i}_text` (name `candidate[answers_attributes][{i}][text]`), with sibling hidden `question_id` / `picked_question_id`. This is where a JD's hidden-word attention filter lands (nPlan #2067: "What word shows that you read our job description thoroughly?" -> `crane`). Enumerate them - `snapshot -i` shows unlabeled textboxes, so read labels via `eval` over `f.labels` / `aria-label`.

## Verification

- **Verify every fill via `eval` read-back, not screenshots** - cmux screenshots on this surface render from top-of-DOM regardless of scroll (same failure mode as `modes/_ats/ashby.md`), so you get the job-ad hero, never the form. `snapshot -i` refs, CSS-selector fills (`fill --selector "#candidate_email" --text "..."`), and `getElementById` all work (Teamtailor is Turbo/plain forms, not React) - plain value reads are authoritative.

## Tenant-varying fields - check, don't assume

- *Consent:* some tenants have consent as a hidden field only; others render a real `candidate_consent_given` checkbox (nPlan did). If a real checkbox exists, leave it **candidate-manual** - never tick a policy-agreement box.
- *Location:* some tenants use required location checkboxes `candidate_location_ids_{n}`; others use an optional Google-Places autocomplete `candidate_location` (`candidate[location][query]`) with hidden `place_id`/`city`/`country`. **Programmatic fill does not fire the Places dropdown**, so the hidden fields stay empty - fine when the field is optional (submits on the free-text query alone); if required, the candidate must retype it and pick a suggestion.
- *Phone country default:* not always Sweden - a UK tenant defaulted to +44. Filling the **full international form** `+46701234567` auto-switches the flag to Sweden and reformats to `+46 70 123 45 67`. Safer than filling the national number.

## Session and uploads

- **File upload stays candidate-manual** (cmux has no upload command) - hand over the CV PDF path.
- **Surface can close between turns** across a long review gap; `cmux browser surface:N eval` then returns `Error: Surface is not a browser` / `Missing or invalid surface_id`. Re-open with `cmux --json browser open` and re-fill from scratch - fills do not survive a lost surface.
