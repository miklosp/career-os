# Recruitee - apply-path playbook

Per-ATS mechanics reference loaded by `modes/apply.md` when an application form is hosted on Recruitee.

**Host pattern:** `{company}.recruitee.com`; the real form lives at `/c/new` after clicking Apply on the job page.

apply-mode via the **cmux browser** (preferred path, `CMUX_WORKSPACE_ID` set) is far more capable than the agent-browser WKWebView fallback documented in `modes/_ats/README.md`. Verified on Hostaway's **Recruitee** form (#279, 2026-06-08):

- `cmux browser surface:N fill --selector '<css>' --text "..."` works for text inputs and textareas. Use **attribute selectors** (`input[name="candidate.email"]`) to avoid escaping dots in Recruitee's dotted field names.
- **Radios click fine** here (`click --selector 'input[id="...flag-19-0"]'`) - the WKWebView "radios are candidate-manual" limitation does NOT apply to cmux. Verify with `eval ...checked`.
- `eval` runs arbitrary JS and is the workhorse for enumerating fields and reading back values; pass long answers via `--text "$(cat /tmp/file)"` to dodge shell-quoting of apostrophes.
- Recruitee flow: job page -> click **Apply** button (`eval` to `.click()` the `button` whose text is exactly "Apply", not "Apply with Indeed") -> navigates to `/c/new` with the real form.
- Phone **country selector auto-corrects** from the number prefix (filling `+46 ...` flipped Spain to Sweden by itself).
- Cover letter: a **"Write it here instead"** button (type=submit but React-intercepts, URL stays put - safe to click) toggles a `candidate.coverLetter` textarea; paste there instead of fighting the file dropzone.
- **Still can't drive the file picker** - candidate attaches the CV PDF manually in the visible surface. That remains the one cmux gap. **Never close the surface** (persistent session, no teardown).
