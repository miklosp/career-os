#!/usr/bin/env python3
# scan-jobspy.py — zero-token LinkedIn discovery + JD prefetch (free, no auth)
#
# Replaces the paid Apify valig(search)+apimaestro(detail) pair. JobSpy returns
# the full JD text in the same pass as discovery, which is everything the
# scan→score half of the pipeline consumes. The employer ATS URL is NOT
# resolved here — that is deferred to apply-time (or to lib/li-voyager.mjs when
# authenticated LinkedIn cookies are present). See
# memory/reference_linkedin_ats_resolution.md for why.
#
# Invocation (from lib/scan-linkedin.mjs):
#   uv run --with python-jobspy lib/scan-jobspy.py   < config.json
#
# stdin  (JSON):
#   { "searches": [ { "name": str,
#                     "search_term": str,
#                     "location": str|null,
#                     "hours_old": int|null,      # derived from f_TPR
#                     "is_remote": bool|null,     # derived from f_WT=2
#                     "results_wanted": int } ],   # default 50
#     "default_results_wanted": int }              # fallback, default 50
#
# stdout (NDJSON, one job per line):
#   { id, title, company, location, job_url, description,
#     is_remote, date_posted, search }
#   id = the LinkedIn numeric job id parsed from job_url (dedup key).
#   Jobs whose id cannot be parsed are dropped (can't dedup them).
#
# stderr: human log lines (consumed/relabelled by the Node caller).
# exit 0 always unless stdin is unparseable (exit 2) or python-jobspy is
# missing (exit 3) — per-search scrape errors are isolated and logged, never
# fatal, so one rate-limited search never sinks the whole run.
#
# Rate-limit note: LinkedIn throttles JobSpy around result page ~10 and the
# result set is sampled/rotating between calls — full coverage comes from
# scheduled runs accumulating into scan-history.db, not one big sweep. Keep
# results_wanted modest (≤50) and hours_old tight per run.

import json
import re
import sys

JOB_ID_RE = re.compile(r"/jobs/view/(?:[^/?#]*?-)?(\d+)")


def log(*a):
    print("[jobspy]", *a, file=sys.stderr, flush=True)


def job_id_from_url(url):
    if not url:
        return None
    m = JOB_ID_RE.search(str(url))
    return m.group(1) if m else None


def main():
    try:
        cfg = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        log(f"FATAL: unreadable stdin config: {e}")
        return 2

    try:
        from jobspy import scrape_jobs
    except Exception as e:  # noqa: BLE001
        log(f"FATAL: python-jobspy not importable ({e}). "
            f"Caller must run this via `uv run --with python-jobspy`.")
        return 3

    searches = cfg.get("searches") or []
    default_rw = int(cfg.get("default_results_wanted") or 50)
    emitted = 0

    for s in searches:
        name = s.get("name") or s.get("search_term") or "?"
        term = s.get("search_term")
        if not term:
            log(f'skip "{name}": no search_term')
            continue
        kwargs = dict(
            site_name=["linkedin"],
            search_term=term,
            results_wanted=int(s.get("results_wanted") or default_rw),
            linkedin_fetch_description=True,
        )
        if s.get("location"):
            kwargs["location"] = s["location"]
        if s.get("hours_old"):
            kwargs["hours_old"] = int(s["hours_old"])
        if s.get("is_remote"):
            kwargs["is_remote"] = True

        log(f'search "{name}": term={term!r} '
            f'location={kwargs.get("location")!r} '
            f'hours_old={kwargs.get("hours_old")} '
            f'want={kwargs["results_wanted"]}')
        try:
            df = scrape_jobs(**kwargs)
        except Exception as e:  # noqa: BLE001 — isolate per-search failures
            log(f'search "{name}" FAILED ({type(e).__name__}: {e}) — skipped')
            continue

        n = 0 if df is None else len(df)
        log(f'search "{name}" → {n} raw rows')
        if not n:
            continue

        cols = set(df.columns)
        for _, r in df.iterrows():
            url = r.get("job_url") if "job_url" in cols else None
            jid = job_id_from_url(url)
            if not jid:
                continue

            def g(col):
                if col not in cols:
                    return None
                v = r.get(col)
                # pandas NaN → None
                return None if v is None or v != v else v

            desc = g("description")
            rec = {
                "id": jid,
                "title": g("title"),
                "company": g("company"),
                "location": g("location"),
                "job_url": f"https://www.linkedin.com/jobs/view/{jid}",
                "description": "" if desc is None else str(desc),
                "is_remote": bool(g("is_remote")) if g("is_remote") is not None else None,
                "date_posted": None if g("date_posted") is None else str(g("date_posted")),
                "search": name,
            }
            sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            emitted += 1

    sys.stdout.flush()
    log(f"emitted {emitted} job records")
    return 0


if __name__ == "__main__":
    sys.exit(main())
