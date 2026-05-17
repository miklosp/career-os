package data

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"career-ops/dashboard/internal/model"
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
	path := filepath.Join(dir, "applications.md")
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
	path := filepath.Join(dir, "applications.md")
	os.WriteFile(path, []byte(md), 0644)

	err := UpdateApplicationStatus(dir, model.CareerApplication{Number: 999}, "Applied")
	if err == nil {
		t.Fatal("expected not-found error for missing tracker number")
	}
}
