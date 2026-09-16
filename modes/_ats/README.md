# ATS apply playbooks

`modes/apply.md` identifies the ATS from the application form's host and reads the matching playbook in this directory before driving the form. Each playbook holds the per-ATS mechanics: how to reach the real form, how to enumerate fields, which widgets are drivable and which stay candidate-manual, and how to verify fills. The cross-ATS rules that hold everywhere live at the bottom of this file.

## Index

| ATS | Host pattern | Playbook |
|---|---|---|
| Ashby | `jobs.ashbyhq.com/{org}/{id}` (form at `.../application`) | `modes/_ats/ashby.md` |
| Greenhouse | `job-boards.greenhouse.io`, `boards.greenhouse.io`, `job-boards.eu.greenhouse.io`, company pages embedding it via `?gh_jid=` | `modes/_ats/greenhouse.md` |
| Lever | `jobs.lever.co/{company}/{id}` (form at `{job-url}/apply`) | `modes/_ats/lever.md` |
| Teamtailor | `{company}.teamtailor.com` (form at `/jobs/{jobId}/applications/new`) | `modes/_ats/teamtailor.md` |
| Workable | `apply.workable.com/{subdomain}/j/{shortcode}` (form at `.../apply/`); `jobs.workable.com/view/...` is a listing, not a form | `modes/_ats/workable.md` |
| Recruitee | `{company}.recruitee.com` (form at `/c/new`) | `modes/_ats/recruitee.md` |
| Deel | `jobs.deel.com` (form at `/deel/job-details/{uuid}/application`) | `modes/_ats/deel.md` |
| YC job pages | `www.ycombinator.com/companies/<co>/jobs/<id>` | `modes/_ats/yc.md` |
| LinkedIn Easy Apply | `www.linkedin.com/jobs/view/{id}` with an Easy Apply button | `modes/_ats/linkedin.md` |

## Cross-ATS rules

Driving `cmux browser surface:N` for the apply mode, and the agent-browser (WKWebView) fallback:

- **zsh does NOT word-split unquoted `$var`.** `s="cmux browser surface:80"; $s fill eN "..."` runs a single bogus command token and fails. Write the full command literally each call.
- **cmux `fill`/`click` need explicit `--selector`/`--text` flags.** The two-positional form (`fill "#id" "text"`) silently no-ops (returns `OK`, value stays empty). Use `fill --selector "#id" --text "..."` and `click --selector "#id"`. Broadly applicable to all cmux apply forms.
- **Don't swallow stderr.** Use `2>&1 | grep -vi sentry`, not `2>/dev/null` - a successful fill prints `OK`; a failed one only shows its error on stderr. With `2>/dev/null` a broken fill looks like success. The cmux binary spews Sentry cache-path errors to stdout on macOS, which is what the filter is for.
- **Always verify fills.** Single-line text inputs (Name, Email) silently no-op'd in one run while textareas succeeded; only the verification caught it. On the WKWebView fallback a screenshot is the check; on cmux Chromium surfaces screenshots render from the top of the DOM regardless of scroll, so read values back via `eval` instead (see the per-ATS playbooks).
- **Snapshot refs (`eN`) regenerate on every `snapshot` call.** Take a fresh snapshot immediately before a fill batch; fills/scrolls don't invalidate refs, but a new snapshot does.
- **No upload command** - give the candidate the PDF path and let them attach it; the cmux surface is their persistent browser (no teardown).
- **LinkedIn `snapshot` is useless; `eval` works.** The snapshot returns only jump-menu skip-links, so LinkedIn forms must be enumerated and driven through `eval` - see `modes/_ats/linkedin.md`. For an off-site-apply LinkedIn job (`Easy apply: no`), do NOT try to click LinkedIn's Apply button - discover the employer ATS directly instead (web search `"<company>" jobs ashby/greenhouse/lever`, or check the JD's saved `LinkedIn job URL` / company careers).
- **Handed careers-page URLs can be dead marketing pages.** Duvo's `duvo.ai/careers` had no form/listings; the real board was Ashby `jobs.ashbyhq.com/duvo`. If the form URL renders no application form, find the ATS board before giving up.
