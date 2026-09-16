# LinkedIn Easy Apply

`www.linkedin.com/jobs/view/{id}` with an **Easy Apply** button. Off-site-apply
postings (`Easy apply: no`) are not this playbook — for those, find the employer
ATS directly and use its own file.

## What works, and what doesn't

`eval` works. This contradicts older notes claiming CSP blocks it; DOM reads,
`querySelector`, `.click()` and value writes all run fine on a cmux Chromium
surface.

`snapshot -i` is useless — it returns only the jump-menu skip-links
("Skip to search", "Skip to main content", …) and never the form. **Enumerate
via `eval`, never via snapshot.**

Screenshots render the modal correctly, but as a double exposure over the page
behind it during the fade-in. Wait ~3s after opening before screenshotting, and
verify field state by reading values back with `eval` rather than by eye.

## React ids contain guillemets

Ids look like `«rj»`, `«rp»`, `«r3»` — French quotation marks, not ASCII.
`#«rj»` is not a valid CSS selector. Use the attribute form:

```bash
cmux browser surface:N eval "document.querySelector('[id=\"«rj»\"]').value"
```

Ids also regenerate between pages of the flow, so re-enumerate after every
`Next`.

## Reaching the form

```bash
cmux --json browser open "https://www.linkedin.com/jobs/view/{id}"   # note surface:N
cmux browser surface:N eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Easy Apply/i.test(x.innerText||''));b.click();return 'clicked';})()"
```

The modal takes a few seconds. It is **not** matched by `[role=dialog]` or
`.artdeco-modal` — both return empty. Find it by content instead:

```bash
cmux browser surface:N eval "(()=>{const m=[...document.querySelectorAll('div')].find(d=>/Apply to /i.test(d.innerText||'')&&d.innerText.length<4000);return m?m.innerText.slice(0,1500):'no modal';})()"
```

That text carries the page counter (`2/4 pages`), the step heading, and every
option — it is the most reliable read of the whole step.

## Enumerating fields

```bash
cmux browser surface:N eval "JSON.stringify([...document.querySelectorAll('input,textarea,select')].map((el,i)=>({i,tag:el.tagName,type:el.type,id:el.id,val:el.value,label:((document.querySelector('label[for=\"'+el.id+'\"]')||{}).innerText||'').trim(),opts:el.tagName==='SELECT'?[...el.options].map(o=>o.text):undefined})))"
```

Four inputs always belong to the page behind the modal, not the form: the
global search box, a checkbox, the footer language `select`, and on some pages
a stray text input. Ignore anything whose label is empty and whose id was
already present before the modal opened.

Radio groups on later pages resolve no `label[for=…]`. Read their question and
option text out of the modal-text dump above instead.

## Page shape

Page 1 is Contact info, prefilled from the profile (email, phone country code,
mobile) — normally nothing to fill. Page 2 is Resume. Later pages are screening
questions when the employer set any, then review, then submit. The counter in
the modal text tells you how many.

## Resume upload is candidate-manual

cmux has no upload command, and page 2 lists only resumes already stored on the
LinkedIn account — a freshly tailored CV will not be among them. Hand the
candidate the exact PDF path and have them click **Upload resume** themselves.

Tell them not to use LinkedIn's **Tailor resume with AI** button on that screen:
it substitutes LinkedIn's own rewrite for the provenance-checked CV, discarding
every `[src:]` grounding.

## Submit

Never click it. Easy Apply's final button sends immediately with no confirm
step, so finish every fill first and hand the surface back.
