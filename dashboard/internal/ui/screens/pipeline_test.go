package screens

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"career-ops/dashboard/internal/model"
	"career-ops/dashboard/internal/theme"
)

func TestWithReloadedDataPreservesStateAndSelection(t *testing.T) {
	initialApps := []model.CareerApplication{
		{
			Company:    "Acme",
			Role:       "Backend Engineer",
			Status:     "Evaluated",
			Score:      4.2,
			ReportPath: "data/reports/001-acme.md",
		},
		{
			Company:    "Beta",
			Role:       "Platform Engineer",
			Status:     "Evaluated",
			Score:      4.6,
			ReportPath: "data/reports/002-beta.md",
		},
	}

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		initialApps,
		model.PipelineMetrics{Total: len(initialApps)},
		"..",
		120,
		40,
	)
	pm.sortMode = sortCompany
	pm.activeTab = 0
	pm.viewMode = "flat"
	pm.applyFilterAndSort()
	pm.cursor = 1
	pm.reportCache["data/reports/002-beta.md"] = reportSummary{summary: "cached"}

	refreshedApps := []model.CareerApplication{
		initialApps[0],
		initialApps[1],
		{
			Company:    "Gamma",
			Role:       "AI Engineer",
			Status:     "Evaluated",
			Score:      4.8,
			ReportPath: "data/reports/003-gamma.md",
		},
	}

	reloaded := pm.WithReloadedData(refreshedApps, model.PipelineMetrics{Total: len(refreshedApps)})

	if reloaded.sortMode != sortCompany {
		t.Fatalf("expected sort mode %q, got %q", sortCompany, reloaded.sortMode)
	}
	if reloaded.viewMode != "flat" {
		t.Fatalf("expected view mode to stay flat, got %q", reloaded.viewMode)
	}
	if got := len(reloaded.filtered); got != 3 {
		t.Fatalf("expected 3 filtered apps after refresh, got %d", got)
	}
	if app, ok := reloaded.CurrentApp(); !ok || app.ReportPath != "data/reports/002-beta.md" {
		t.Fatalf("expected selection to stay on beta app, got %+v (ok=%v)", app, ok)
	}
	if reloaded.reportCache["data/reports/002-beta.md"].summary != "cached" {
		t.Fatal("expected cached report summaries to survive refresh")
	}
}

func TestRenderAppLineIncludesDateColumn(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		120,
		40,
	)

	line := pm.renderAppLine(model.CareerApplication{
		Date:    "2026-04-13",
		Company: "Anthropic",
		Role:    "Forward Deployed Engineer",
		Status:  "Applied",
		Score:   4.5,
	}, false)

	if !strings.Contains(line, "04/13") {
		t.Fatalf("expected rendered line to include date column, got %q", line)
	}
}

func TestPruneThresholdStepsWithoutDrift(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		120,
		40,
	)
	pm.pruneConfirm = true
	pm.pruneThreshold = defaultPruneThreshold

	for i := 0; i < 3; i++ {
		pm, _ = pm.handlePruneConfirm(tea.KeyMsg{Type: tea.KeyDown})
	}
	if pm.pruneThreshold != 2.7 {
		t.Fatalf("expected threshold 2.7 after three 0.1 steps down, got %v", pm.pruneThreshold)
	}

	pm, _ = pm.handlePruneConfirm(tea.KeyMsg{Type: tea.KeyUp})
	if pm.pruneThreshold != 2.8 {
		t.Fatalf("expected threshold 2.8 after stepping back up, got %v", pm.pruneThreshold)
	}
}

func TestRenderAppLineAppliedTabShowsAppliedDateAndSV(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		120,
		40,
	)
	app := model.CareerApplication{
		Date:        "2026-04-13",
		AppliedDate: "2026-05-02",
		Company:     "Initech",
		Role:        "Product Manager",
		Status:      "Applied",
		Score:       4.1,
		InSweden:    true,
	}
	for i, tab := range pipelineTabs {
		if tab.filter == filterApplied {
			pm.activeTab = i
		}
	}
	line := pm.renderAppLine(app, false)
	if !strings.Contains(line, "05/02") || strings.Contains(line, "04/13") {
		t.Fatalf("APPLIED tab should show the applied date, got %q", line)
	}
	if !strings.Contains(line, "SV") {
		t.Fatalf("expected SV marker for a Sweden-located job, got %q", line)
	}

	pm.activeTab = 0
	app.InSweden = false
	line = pm.renderAppLine(app, false)
	if !strings.Contains(line, "04/13") || strings.Contains(line, "SV") {
		t.Fatalf("other tabs keep the tracker date and no SV marker, got %q", line)
	}
}
