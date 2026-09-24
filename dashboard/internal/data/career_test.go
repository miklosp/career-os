package data

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"career-ops/dashboard/internal/model"
	"career-ops/dashboard/internal/paths"
)

func TestSetStatusCell(t *testing.T) {
	tests := []struct {
		name      string
		line      string
		newStatus string
		want      string
		wantOK    bool
	}{
		{
			name:      "normal evaluated row",
			line:      "| 431 | 2026-05-08 | Acme | PM | 4.2/5 | Evaluated | ❌ | [431](data/reports/431-acme.md) | good fit |",
			newStatus: "Applied",
			want:      "| 431 | 2026-05-08 | Acme | PM | 4.2/5 | Applied | ❌ | [431](data/reports/431-acme.md) | good fit |",
			wantOK:    true,
		},
		{
			name:      "empty status cell (fetched row)",
			line:      "| 257 | 2026-04-30 | Guerrilla | Director |  |  | ❌ |  |  |",
			newStatus: "Skipped-Location",
			want:      "| 257 | 2026-04-30 | Guerrilla | Director |  | Skipped-Location | ❌ |  |  |",
			wantOK:    true,
		},
		{
			name:      "status string also present in notes must not be touched",
			line:      "| 204 | 2026-04-23 | Lovable | PM Enterprise | 4.4/5 | Applied | ❌ | [204](r.md) | Applied 2026-04-23 via Ashby |",
			newStatus: "Responded",
			want:      "| 204 | 2026-04-23 | Lovable | PM Enterprise | 4.4/5 | Responded | ❌ | [204](r.md) | Applied 2026-04-23 via Ashby |",
			wantOK:    true,
		},
		{
			name:      "status token in role cell must not be touched",
			line:      "| 99 | 2026-05-01 | Co | PM Evaluation Platform | 3.0/5 | Evaluated | ❌ | [99](r.md) | n |",
			newStatus: "Applied",
			want:      "| 99 | 2026-05-01 | Co | PM Evaluation Platform | 3.0/5 | Applied | ❌ | [99](r.md) | n |",
			wantOK:    true,
		},
		{
			name:      "malformed row with too few cells",
			line:      "| 1 | only three |",
			newStatus: "Applied",
			want:      "| 1 | only three |",
			wantOK:    false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := setStatusCell(tt.line, tt.newStatus)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if got != tt.want {
				t.Errorf("got:\n%q\nwant:\n%q", got, tt.want)
			}
		})
	}
}

func TestRowMatches(t *testing.T) {
	fetched := "| 257 | 2026-04-30 | Guerrilla | Director |  | Skipped-Location | ❌ |  |  |"
	scored := "| 431 | 2026-05-08 | Acme | PM | 4.2/5 | Evaluated | ❌ | [431](r.md) | n |"

	if !rowMatches(fetched, model.CareerApplication{Number: 257}) {
		t.Error("should match a report-less row by tracker number")
	}
	if rowMatches(fetched, model.CareerApplication{Number: 25}) {
		t.Error("must not match a different tracker number (no substring matching)")
	}
	if !rowMatches(scored, model.CareerApplication{Number: 431, ReportNumber: "431"}) {
		t.Error("should match a scored row by tracker number")
	}
	// Legacy fallback: number unparalleled, rely on report link.
	if !rowMatches(scored, model.CareerApplication{ReportNumber: "431"}) {
		t.Error("should fall back to report number when Number is zero")
	}
}

func TestUpdateApplicationStatus_FetchedRowNoReport(t *testing.T) {
	dir := t.TempDir()
	md := "# Applications Tracker\n\n" +
		"| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n" +
		"|---|------|---------|------|-------|--------|-----|--------|-------|\n" +
		"| 257 | 2026-04-30 | Guerrilla | Director |  | Fetched | ❌ |  |  |\n"
	path := paths.Data(dir, "applications.md")
	os.MkdirAll(filepath.Dir(path), 0755)
	if err := os.WriteFile(path, []byte(md), 0644); err != nil {
		t.Fatal(err)
	}

	app := model.CareerApplication{Number: 257, Status: "Fetched"}
	if err := UpdateApplicationStatus(dir, app, "Skipped-Location"); err != nil {
		t.Fatalf("update failed: %v", err)
	}

	out, _ := os.ReadFile(path)
	if !strings.Contains(string(out), "| Skipped-Location |") {
		t.Errorf("status not updated, file:\n%s", out)
	}
	if strings.Contains(string(out), "| Fetched |") {
		t.Errorf("old status still present, file:\n%s", out)
	}
}

func TestUpdateApplicationStatus_NotFound(t *testing.T) {
	dir := t.TempDir()
	md := "| 1 | 2026-01-01 | Co | PM | 4.0/5 | Evaluated | ❌ | [1](r.md) | n |\n"
	path := paths.Data(dir, "applications.md")
	os.MkdirAll(filepath.Dir(path), 0755)
	os.WriteFile(path, []byte(md), 0644)

	err := UpdateApplicationStatus(dir, model.CareerApplication{Number: 999}, "Applied")
	if err == nil {
		t.Fatal("expected not-found error for missing tracker number")
	}
}

func TestAppsBelowScore(t *testing.T) {
	apps := []model.CareerApplication{
		{Number: 1, Status: "Evaluated", Score: 2.5},      // prune: scored, below, not committed
		{Number: 2, Status: "Evaluated", Score: 3.0},      // keep: at threshold (strict <)
		{Number: 3, Status: "Evaluated", Score: 4.2},      // keep: above
		{Number: 4, Status: "Fetched", Score: 0},          // keep: unscored
		{Number: 5, Status: "Skipped-Location", Score: 0}, // keep: unscored
		{Number: 6, Status: "Applied", Score: 2.0},        // keep: committed
		{Number: 7, Status: "Interview", Score: 1.5},      // keep: committed
		{Number: 8, Status: "Rejected", Score: 1.0},       // keep: terminal
		{Number: 9, Status: "Discarded", Score: 1.0},      // keep: already discarded
		{Number: 10, Status: "SKIP", Score: 2.9},          // keep: manual skip
		{Number: 11, Status: "Evaluated", Score: 2.9},     // prune: just below
	}

	got := AppsBelowScore(apps, 3.0)
	gotNums := make(map[int]bool, len(got))
	for _, a := range got {
		gotNums[a.Number] = true
	}

	want := map[int]bool{1: true, 11: true}
	if len(got) != len(want) {
		t.Fatalf("AppsBelowScore returned %d apps, want %d (%v)", len(got), len(want), gotNums)
	}
	for n := range want {
		if !gotNums[n] {
			t.Errorf("expected app #%d to be pruned, but it was not", n)
		}
	}
}

func TestLeadingNum(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"3-digit report path", "data/reports/516-zyte-2026-05-16.md", "516"},
		{"4-digit report path", "data/reports/1085-zyte-ai-product-manager-owner-2026-06-04.md", "1085"},
		{"4-digit cv filename", "1085-zyte-ai-product-manager-owner-remote-cv.md", "1085"},
		{"bare 4-digit num", "1085", "1085"},
		{"non-digit prefix", "data/reports/abc-foo.md", ""},
		{"too short (2 digits)", "12-foo.md", ""},
		{"exactly 3 digits", "064-legora.md", "064"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := LeadingNum(tt.in); got != tt.want {
				t.Errorf("LeadingNum(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

const outcomeHeader = "# Applications Tracker\n\n" +
	"| # | Date | Company | Role | Score | Status | PDF | Report | Notes | Applied Date | Channel | Furthest Stage | Rejection Reason |\n" +
	"|---|------|---------|------|-------|--------|-----|--------|-------|--------------|---------|----------------|------------------|\n"

func TestParseApplications_OutcomeColumns(t *testing.T) {
	dir := t.TempDir()
	md := outcomeHeader +
		"| 200 | 2026-06-02 | initech | PM | 4.1/5 | Rejected | ✅ |  | n | 2026-06-02 | referral | final | no reason given |\n" +
		"| 201 | 2026-06-02 | Legacy | PM | 4.0/5 | Evaluated | ❌ |  | old row |\n"
	os.MkdirAll(paths.Data(dir, "jds"), 0755)
	os.WriteFile(paths.Data(dir, "applications.md"), []byte(md), 0644)
	os.WriteFile(paths.Data(dir, "jds", "200-initech.md"),
		[]byte("# initech — PM\n\n**Location:** Stockholm, Stockholm County, Sweden\n"), 0644)
	os.WriteFile(paths.Data(dir, "jds", "201-legacy.md"),
		[]byte("# Legacy — PM\n\n**Location:** Berlin, Germany\n"), 0644)

	apps := ParseApplications(dir)
	if len(apps) != 2 {
		t.Fatalf("want 2 apps, got %d", len(apps))
	}
	if !apps[0].InSweden || apps[1].InSweden {
		t.Errorf("InSweden: want true/false, got %v/%v", apps[0].InSweden, apps[1].InSweden)
	}
	a := apps[0]
	if a.Notes != "n" || a.AppliedDate != "2026-06-02" || a.Channel != "referral" ||
		a.FurthestStage != "final" || a.RejectionReason != "no reason given" {
		t.Errorf("outcome not parsed: %+v", a)
	}
	if apps[1].Notes != "old row" || apps[1].AppliedDate != "" {
		t.Errorf("legacy row misparsed: %+v", apps[1])
	}
}

func TestUpdateApplicationStatus_AppliedFillsDateOnce(t *testing.T) {
	dir := t.TempDir()
	md := outcomeHeader +
		"| 300 | 2026-06-02 | Acme | PM | 4.1/5 | Evaluated | ✅ |  | n |  |  |  |  |\n" +
		"| 301 | 2026-06-02 | Beta | PM | 4.1/5 | Evaluated | ✅ |  | n | 2026-05-01 | referral | none |  |\n"
	path := paths.Data(dir, "applications.md")
	os.MkdirAll(filepath.Dir(path), 0755)
	os.WriteFile(path, []byte(md), 0644)

	for _, n := range []int{300, 301} {
		if err := UpdateApplicationStatus(dir, model.CareerApplication{Number: n}, "Applied"); err != nil {
			t.Fatal(err)
		}
	}
	out, _ := os.ReadFile(path)
	today := time.Now().Format("2006-01-02")
	if !strings.Contains(string(out), "| Applied | ✅ |  | n | "+today+" |  |  |  |") {
		t.Errorf("applied date not filled on #300:\n%s", out)
	}
	if !strings.Contains(string(out), "| Applied | ✅ |  | n | 2026-05-01 | referral | none |  |") {
		t.Errorf("recorded applied date overwritten on #301:\n%s", out)
	}
}

func TestSwedenRegex(t *testing.T) {
	yes := []string{
		"Stockholm, Stockholm County, Sweden", "Sweden (Remote)", "Malmö, Skåne County, Sweden",
		"Göteborg", "Stockholm HQ", "Solna, Stockholm County, SE", "Gothenburg | Munich , Germany",
	}
	no := []string{
		"Berlin, Berlin, Germany", "Oslo, Norway", "Remote (EU)", "Lundby, Denmark", "London, Seattle",
	}
	for _, s := range yes {
		if !reSweden.MatchString(s) {
			t.Errorf("want Sweden match for %q", s)
		}
	}
	for _, s := range no {
		if reSweden.MatchString(s) {
			t.Errorf("unexpected Sweden match for %q", s)
		}
	}
}
