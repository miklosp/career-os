import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

function scratchUser() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cv-draft-")));
  for (const d of ["config", "data/jds", "data/reports", "output/customized-cvs"])
    mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(
    join(dir, "config/cv.json"),
    JSON.stringify({
      basics: { name: "Jane Smith", label: "Product Lead", contactLine: "", summary: "" },
      skills_inventory: ["Product Strategy"],
      languages_line: "English (fluent)",
      work: [
        {
          headingRaw: "Lead - Acme",
          slug: "acme",
          dateRange: "May 2023 - Present",
          description: "Acme makes things.",
          highlights: [{ id: "acme-b1", text: "Took the product from 0 to $1M ARR" }],
          subEntries: [
            {
              headingRaw: "**Globex** - AI platform, Seed",
              slug: "acme-globex",
              dateRange: "Aug 2023 - Aug 2024",
              highlights: [{ id: "acme-globex-b1", text: "Raised conversion 30% with a new onboarding" }],
            },
          ],
        },
      ],
      education: [{ institution: "KTH", description: "MSc" }],
    }),
  );
  writeFileSync(
    join(dir, "config/profile.md"),
    '---\ncandidate:\n  full_name: "Jane Smith"\n  email: "jane@example.com"\n  location: "Stockholm"\n---\n',
  );
  writeFileSync(join(dir, "data/jds/999-acme-pm.md"), "# Acme — Product Manager\n\nJD body.\n");
  writeFileSync(join(dir, "data/reports/999-acme-2026-09-24.md"), "# Evaluation: Acme\n");
  return dir;
}

const draft = (bullet) => `# Someone Else

bogus contact line

## Summary

Product lead who took a product to $1M ARR. [src: acme-b1]

## Core Competencies

Product Strategy

## Experience

### Lead - Acme

2020 - 2021

::: note
stray div
:::

${bullet}

**Globex** - reworded by the draft

- Raised conversion 30% with a new onboarding [src: acme-globex-b1]

<bridges>
{"bridges": [{"id": "b1", "generated_text": "Took the product", "source_type": "cv"}]}
</bridges>

<gaps>
{"gaps": [{"id": "g1", "requirement": "Kubernetes", "why_no_source": "none"}]}
</gaps>
`;

function finalize(dir, bullet) {
  const path = join(dir, "output/customized-cvs/999-acme-product-manager-cv-draft.md");
  writeFileSync(path, draft(bullet));
  return spawnSync(process.execPath, [join(REPO, "lib/cv-draft.mjs"), "finalize", path], {
    env: { ...process.env, CAREER_OPS_USER_DIR: dir },
    encoding: "utf8",
  });
}

test("passing draft writes the stripped CV and trace", () => {
  const dir = scratchUser();
  const res = finalize(dir, "- Took the product from 0 to $1M ARR [src: acme-b1]");
  assert.equal(res.status, 0, res.stderr);

  const md = readFileSync(join(dir, "output/customized-cvs/999-acme-product-manager-cv.md"), "utf8");
  assert.doesNotMatch(md, /\[src:|<bridges>|<gaps>|Someone Else|bogus contact/);
  assert.match(md, /^# Jane Smith\n\n::: headline\nProduct Lead\n:::\n\n\[jane@example.com\]\(mailto:jane@example.com\) \/ Stockholm\n/);
  assert.match(md, /^- Took the product from 0 to \$1M ARR$/m);
  // Role + sub-entry headers, dates, description, languages, education are
  // projected from cv.json; the draft's variants and stray divs are dropped.
  assert.match(md, /### Lead - Acme\n\nMay 2023 - Present\n\n::: description\nAcme makes things.\n:::\n/);
  assert.match(md, /\*\*Globex\*\* - AI platform, Seed\n\nAug 2023 - Aug 2024\n\n- Raised conversion 30% with a new onboarding\n/);
  assert.match(md, /\*\*Languages:\*\* English \(fluent\)/);
  assert.match(md, /## Education\n\n### KTH/);
  assert.doesNotMatch(md, /2020 - 2021|reworded by the draft|stray div/);

  const trace = JSON.parse(readFileSync(join(dir, "output/customized-cvs/999-acme-product-manager-trace.json"), "utf8"));
  assert.equal(trace.num, "999");
  assert.equal(trace.jd, "999-acme-pm.md");
  assert.equal(trace.report, "999-acme-2026-09-24.md");
  assert.deepEqual(trace.bullets, [
    { text: "Took the product from 0 to $1M ARR", src: ["acme-b1"] },
    { text: "Raised conversion 30% with a new onboarding", src: ["acme-globex-b1"] },
  ]);
  assert.equal(trace.bridges.length, 1);
  assert.equal(trace.gaps.length, 1);
  assert.equal(trace.validator.passed, true);
  assert.equal(existsSync(join(dir, "output/customized-cvs/999-acme-product-manager-cv-draft.md")), false);
});

test("26-word bullet fails non-zero, prints the constraint, writes nothing", () => {
  const dir = scratchUser();
  const res = finalize(dir, `- Took the product to $1M ARR ${words(20)} [src: acme-b1]`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /<failed_constraints>/);
  assert.match(res.stderr, /\[HARD L\] bullet is 26 words/);
  assert.equal(existsSync(join(dir, "output/customized-cvs/999-acme-product-manager-cv.md")), false);
  assert.equal(existsSync(join(dir, "output/customized-cvs/999-acme-product-manager-trace.json")), false);
  assert.equal(existsSync(join(dir, "output/customized-cvs/999-acme-product-manager-cv-draft.md")), true);
});

test("draft heading not in cv.json fails non-zero and writes nothing", () => {
  const dir = scratchUser();
  const path = join(dir, "output/customized-cvs/999-acme-product-manager-cv-draft.md");
  writeFileSync(path, draft("- Took the product from 0 to $1M ARR [src: acme-b1]").replace("### Lead - Acme", "### Invented - Initech"));
  const res = spawnSync(process.execPath, [join(REPO, "lib/cv-draft.mjs"), "finalize", path], {
    env: { ...process.env, CAREER_OPS_USER_DIR: dir },
    encoding: "utf8",
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not in cv\.json[\s\S]*### Invented - Initech/);
  assert.equal(existsSync(join(dir, "output/customized-cvs/999-acme-product-manager-cv.md")), false);
});

test("context prints the filled contract and the draft path", () => {
  const dir = scratchUser();
  const res = spawnSync(process.execPath, [join(REPO, "lib/cv-draft.mjs"), "context", "999"], {
    env: { ...process.env, CAREER_OPS_USER_DIR: dir },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /999-acme-product-manager-cv-draft\.md/);
  assert.match(res.stdout, /Took the product from 0 to \$1M ARR \[acme-b1\]/);
  assert.match(res.stdout, /JD body\./);
  assert.doesNotMatch(res.stdout, /\{cv_content\}|\{job_content\}/);
});
