# Workday - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on Workday.

**Host pattern:** `{tenant}.wd{N}.myworkdayjobs.com/{locale}/{site}/...`; the form is a 6-step wizard under `.../job/{slug}/apply/...`.

Applying on Workday via the cmux browser:

- **Use the `/job/{slug}` URL, not `/details/{slug}`.** The `/details/` search-results view never rendered the detail pane or the Apply button in a narrow cmux split. `/job/{slug}` shows `[data-automation-id=adventureButton]` (Apply).
- **Apply opens a new browser surface.** After Apply → Autofill/Manual and sign-in, the form lives in a second `surface:N` in the same pane. Find it with `cmux --json tree | jq '.. | objects | select(.type=="browser")'`.
- Sign-in / account creation is candidate-manual (their credentials).
- **"Autofill with Resume" parses badly.** On #3968 it put company names in title fields, meta lines ("Permanent - Hybrid") in company fields, duplicated a role and added empty blocks. Faster: delete every Work Experience block and rebuild with Add. Dates and the PDF upload come through fine.
- **Workday crashes ("Something went wrong... Error Code: VPS|...") and nothing on the current step survives.** A page saves only on Next (Save and Continue); a refresh can drop back to step 1 with step 2 empty too. Keep the step-3 fill as a rerunnable script, verify, and click Next immediately - don't leave a filled step sitting while the candidate does something else.
- Enumerate with `eval`: field ids are stable-ish (`name--legalName--firstName`, `emailAddress--emailAddress`, `phoneNumber--phoneNumber`, `source--source`, `workExperience-{n}--jobTitle|companyName|location|currentlyWorkHere|roleDescription`, `language-{n}--language|native`). The `{n}` changes on every Add - look up the newest block by its empty `--jobTitle`.
- Dropdowns are `button[aria-haspopup=listbox]`: `click --selector '#id'`, then click the `[role=option]` by text via `eval`. Display text is the button's `innerText`; `.value` holds an opaque id.
- Date sections (`...-dateSectionMonth-input`, `-Day-input`, `-Year-input`) accept `fill --selector ... --text '05'`; verify via the sibling `-display` div.
- Phone number goes in without the country code; Country Phone Code is a separate pill (defaulted from Country).
- Answering Yes to work authorization reveals a required follow-up (citizen / otherwise authorized permanently / student visa). An EU citizen outside their own country = "otherwise authorized".
- The terms-acknowledgement checkbox on Voluntary Disclosures is the candidate's to tick.
- Submission lands back on the job search with `Job_Application_ID=` in the URL - that's the confirmation.

Related: `modes/_ats/greenhouse.md`, `modes/_ats/lever.md`
