import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl } from "../lib/scan-linkedin.mjs";

// Distinct postings on one host must not collapse to one dedup key.
test("job-identity query params survive canonicalization", () => {
  for (const [a, b] of [
    ["https://www.dalux.com/careers/job?hr=show-job%2F345541&locale=en_US", "https://www.dalux.com/careers/job?hr=show-job%2F333765&locale=en_US"],
    ["https://www.datavant.com/about/careers/open-roles-ireland/job?job_id=5045985008", "https://www.datavant.com/about/careers/open-roles-ireland/job?job_id=5430238008"],
    ["https://system.erecruiter.pl/FormTemplates/RecruitmentForm.aspx?WebID=7416bd", "https://system.erecruiter.pl/FormTemplates/RecruitmentForm.aspx?WebID=6068a4"],
    ["https://candidate.hr-manager.net/ApplicationInit.aspx?cid=1333&ProjectId=145583&MediaId=5", "https://candidate.hr-manager.net/ApplicationInit.aspx?cid=3293&ProjectId=143576&MediaId=5"],
  ]) assert.notEqual(canonicalizeUrl(a), canonicalizeUrl(b));
});

test("doubleclick redirect unwraps to the target posting", () => {
  const wrap = (id) =>
    `https://ad.doubleclick.net/ddm/trackclk/N4789.466581LINKEDIN.COM/B31862527.393708536;dc_trk_aid=614418922;dc_transparent=1;?https%3A%2F%2Fjobs.citi.com%2Fjob%2F-%2F-%2F287%2F${id}%3Fsource=APPLICANT_SOURCE-3-354&ss=paid`;
  assert.equal(canonicalizeUrl(wrap("100117049056")), "https://jobs.citi.com/job/-/-/287/100117049056");
  assert.notEqual(canonicalizeUrl(wrap("100117049056")), canonicalizeUrl(wrap("98789736192")));
});
