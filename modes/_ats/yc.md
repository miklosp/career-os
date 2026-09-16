# YC job pages - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on a Y Combinator company job page.

**Host pattern:** `www.ycombinator.com/companies/<co>/jobs/<id>`.

YC company job pages render an **"Apply to role" form modal** plus a structured-metadata block that is **NOT in the JD prose body**: a remote-country **allowlist** (e.g. `US/FR/CA/GB/PT/DE/MC/LU/ES/IT/CZ/PL/SI/SK/LT/LV/CH`), a **Visa** chip (e.g. "US citizen/visa only"), **HQ location**, comp, team size, batch.

`modes/_eval.md` + `modes/_location-gate.md` triage **JD-text-only**, so they never see these chips. A role whose prose says "full remote, international team" can pass the location gate yet be **geo-ineligible** - happened on #778 GojiberryAI (Founding PM, 4.1/5): prose said international, chips excluded Sweden/all Nordics + "US citizen/visa only" + SF HQ + EUR 55-90K comp (shown on the page with a euro sign; below floor). Discarded at apply.

**At apply time on a YC URL, read the chips before filling** (`cmux ... eval` on `document.body.innerText` around "Visa", the euro-sign comp line, and "Remote (" works). The form is a modal - clicking the page heading/`Apply to role` link closes it and wipes filled state, so finish fills before navigating. The chips are the authoritative eligibility signal, not the prose.
