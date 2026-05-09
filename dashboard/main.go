package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"career-ops/dashboard/internal/data"
	"career-ops/dashboard/internal/model"
	"career-ops/dashboard/internal/theme"
	"career-ops/dashboard/internal/ui/screens"
)

type viewState int

const (
	viewPipeline viewState = iota
	viewReport
	viewProgress
	viewFactCheck
)

type appModel struct {
	pipeline        screens.PipelineModel
	viewer          screens.ViewerModel
	progress        screens.ProgressModel
	factcheck       screens.FactCheckModel
	state           viewState
	careerOpsPath   string
	theme           theme.Theme
	progressMetrics model.ProgressMetrics
}

// openCurrentReport (re)builds the viewer for the pipeline's currently-selected
// application. If no app is selected or it has no report, falls back to the
// pipeline view.
func (m *appModel) openCurrentReport() {
	app, ok := m.pipeline.CurrentApp()
	if !ok || app.ReportPath == "" {
		m.state = viewPipeline
		return
	}
	fullPath := filepath.Join(m.careerOpsPath, app.ReportPath)
	title := fmt.Sprintf("%s — %s", app.Company, app.Role)
	m.viewer = screens.NewViewerModel(m.theme, fullPath, title, m.pipeline.Width(), m.pipeline.Height())
	m.state = viewReport
}

func (m *appModel) reloadPipelineData() {
	apps := data.ParseApplications(m.careerOpsPath)
	metrics := data.ComputeMetrics(apps)
	m.progressMetrics = data.ComputeProgressMetrics(apps)
	m.pipeline = m.pipeline.WithReloadedData(apps, metrics)
}

func (m appModel) Init() tea.Cmd {
	return nil
}

func (m appModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.pipeline.Resize(msg.Width, msg.Height)
		if m.state == viewReport {
			m.viewer.Resize(msg.Width, msg.Height)
		}
		if m.state == viewProgress {
			m.progress.Resize(msg.Width, msg.Height)
		}
		if m.state == viewFactCheck {
			m.factcheck.Resize(msg.Width, msg.Height)
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd

	case screens.PipelineClosedMsg:
		return m, tea.Quit

	case screens.PipelineLoadReportMsg:
		summary, location := data.LoadReportSummary(msg.CareerOpsPath, msg.ReportPath)
		m.pipeline.EnrichReport(msg.ReportPath, summary, location)
		return m, nil

	case screens.PipelineUpdateStatusMsg:
		err := data.UpdateApplicationStatus(msg.CareerOpsPath, msg.App, msg.NewStatus)
		if err != nil {
			// Log the error but still reload data to keep UI consistent
			fmt.Fprintf(os.Stderr, "WARN: status update failed: %v\n", err)
		}
		if strings.EqualFold(msg.NewStatus, "Discarded") {
			data.CleanupDiscardedFiles(msg.CareerOpsPath, msg.App)
		}
		// Keep cursor at the same row index so the selector advances to the next
		// item instead of following the discarded/reclassified row to its new group.
		cursorIdx := m.pipeline.CursorIndex()
		apps := data.ParseApplications(m.careerOpsPath)
		metrics := data.ComputeMetrics(apps)
		m.progressMetrics = data.ComputeProgressMetrics(apps)
		m.pipeline = m.pipeline.WithReloadedDataAtIndex(apps, metrics, cursorIdx)
		return m, nil

	case screens.PipelineRefreshMsg:
		m.reloadPipelineData()
		cvsByNum := data.ScanOutputCVsByNum(m.careerOpsPath)
		reviewsByNum := data.ScanOutputReviewsByNum(m.careerOpsPath)
		m.pipeline.RefreshFromDisk(reviewsByNum, cvsByNum)
		return m, nil

	case screens.PipelineOpenReportMsg:
		m.viewer = screens.NewViewerModel(
			m.theme,
			msg.Path, msg.Title,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewReport
		return m, nil

	case screens.ViewerClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.ViewerNavigateMsg:
		m.pipeline.AdvanceCursor(msg.Delta)
		m.openCurrentReport()
		return m, nil

	case screens.ViewerOpenURLMsg:
		if app, ok := m.pipeline.CurrentApp(); ok && app.JobURL != "" {
			url := app.JobURL
			return m, func() tea.Msg { return screens.PipelineOpenURLMsg{URL: url} }
		}
		return m, nil

	case screens.ViewerChangeStatusMsg:
		m.state = viewPipeline
		m.pipeline.OpenStatusPicker()
		return m, nil

	case screens.ViewerDiscardMsg:
		app, ok := m.pipeline.CurrentApp()
		if !ok {
			return m, nil
		}
		if err := data.UpdateApplicationStatus(m.careerOpsPath, app, "Discarded"); err != nil {
			fmt.Fprintf(os.Stderr, "WARN: status update failed: %v\n", err)
		}
		data.CleanupDiscardedFiles(m.careerOpsPath, app)
		cursorIdx := m.pipeline.CursorIndex()
		apps := data.ParseApplications(m.careerOpsPath)
		metrics := data.ComputeMetrics(apps)
		m.progressMetrics = data.ComputeProgressMetrics(apps)
		m.pipeline = m.pipeline.WithReloadedDataAtIndex(apps, metrics, cursorIdx)
		m.openCurrentReport()
		return m, nil

	case screens.ViewerGenerateCVMsg:
		if app, ok := m.pipeline.CurrentApp(); ok {
			path := m.careerOpsPath
			return m, func() tea.Msg {
				return screens.PipelineGenerateCVMsg{CareerOpsPath: path, App: app}
			}
		}
		return m, nil

	case screens.PipelineOpenProgressMsg:
		m.progress = screens.NewProgressModel(
			theme.NewTheme("catppuccin-mocha"),
			m.progressMetrics,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewProgress
		return m, nil

	case screens.ProgressClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.PipelineGenerateCVMsg:
		key := msg.App.ReportPath
		if key == "" {
			key = msg.App.Company + "/" + msg.App.Role
		}
		num := reportNum(msg.App.ReportPath)
		jdFile := ""
		if num != "" {
			jdFile = findJDFileByNum(msg.CareerOpsPath, num)
		}
		if jdFile == "" {
			// No JD file — ignore silently (status stays empty, user sees nothing happened)
			return m, nil
		}
		// Derive the CV output path so the auto-chained review phase knows
		// where to find the markdown. Matches generate-cv-llm.mjs convention:
		// output/{NUM}-{slug}-cv.md where slug comes from the JD filename.
		jdBase := strings.TrimSuffix(filepath.Base(jdFile), ".md")
		cvPath := filepath.Join(msg.CareerOpsPath, "output", jdBase+"-cv.md")
		careerOpsPath := msg.CareerOpsPath
		startedCmd := func() tea.Msg { return screens.CVGenStartedMsg{AppKey: key} }
		bgCmd := func() tea.Msg {
			// Script derives NUM and slug from the JD filename. PDF is
			// deferred to the finalize step (after the user walks the review),
			// so generate markdown only here.
			cmd := exec.Command("node", "generate-cv-llm.mjs",
				"--jd", jdFile, "--format", "a4", "--no-pdf")
			cmd.Dir = careerOpsPath
			err := cmd.Run()
			return screens.CVGenDoneMsg{AppKey: key, CVPath: cvPath, Err: err}
		}
		return m, tea.Batch(startedCmd, bgCmd)

	case screens.CVGenDoneMsg:
		// Let the pipeline update its status map first.
		pm, pcmd := m.pipeline.Update(msg)
		m.pipeline = pm
		// On success, auto-chain the non-interactive review phase. The user
		// will see status go generating → reviewing → review-pending as
		// Bifrost calls complete.
		if msg.Err != nil || msg.CVPath == "" {
			return m, pcmd
		}
		if _, statErr := os.Stat(msg.CVPath); statErr != nil {
			return m, pcmd
		}
		careerOpsPath := m.careerOpsPath
		cvPath := msg.CVPath
		appKey := msg.AppKey
		reviewStartedCmd := func() tea.Msg {
			return screens.ReviewStartedMsg{AppKey: appKey}
		}
		reviewCmd := func() tea.Msg {
			cmd := exec.Command("node", "cv-fact-check.mjs",
				"--review-only", cvPath)
			cmd.Dir = careerOpsPath
			err := cmd.Run()
			return screens.ReviewDoneMsg{AppKey: appKey, Err: err}
		}
		return m, tea.Batch(pcmd, reviewStartedCmd, reviewCmd)

	case screens.ReviewStartedMsg:
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd

	case screens.ReviewDoneMsg:
		// Forward to pipeline so it sets review-pending or error.
		pm, pcmd := m.pipeline.Update(msg)
		m.pipeline = pm
		if msg.Err != nil {
			return m, pcmd
		}
		// If --review-only deleted the JSON because there were zero findings,
		// the CV is clean and we can auto-render the PDF directly.
		num, jdBase := jobPathParts(m.careerOpsPath, msg.AppKey)
		if num == "" {
			return m, pcmd
		}
		reviewJSON := filepath.Join(m.careerOpsPath, "output", jdBase+"-cv-review.json")
		if _, err := os.Stat(reviewJSON); err == nil {
			// Findings exist — wait for the user to walk through.
			return m, pcmd
		}
		// No findings — auto-render PDF.
		cvPath := filepath.Join(m.careerOpsPath, "output", jdBase+"-cv.md")
		app, _ := m.pipeline.AppByKey(msg.AppKey)
		appKey := msg.AppKey
		careerOpsPath := m.careerOpsPath
		renderRequest := func() tea.Msg {
			return screens.RenderPDFRequestedMsg{
				CareerOpsPath: careerOpsPath,
				AppKey:        appKey,
				App:           app,
				CVPath:        cvPath,
			}
		}
		return m, tea.Batch(pcmd, renderRequest)

	case screens.PipelineFactCheckMsg:
		// Open the new split-view fact-check screen for the given app.
		num := reportNum(msg.App.ReportPath)
		if num == "" {
			return m, nil
		}
		jdFile := findJDFileByNum(msg.CareerOpsPath, num)
		if jdFile == "" {
			return m, nil
		}
		jdBase := strings.TrimSuffix(filepath.Base(jdFile), ".md")
		cvPath := filepath.Join(msg.CareerOpsPath, "output", jdBase+"-cv.md")
		reviewJSONPath := filepath.Join(msg.CareerOpsPath, "output", jdBase+"-cv-review.json")
		if _, err := os.Stat(cvPath); err != nil {
			// No generated CV on disk yet — user must press `g` first.
			return m, nil
		}
		key := msg.App.ReportPath
		if key == "" {
			key = msg.App.Company + "/" + msg.App.Role
		}
		title := fmt.Sprintf("%s · %s", msg.App.Company, msg.App.Role)
		m.factcheck = screens.NewFactCheckModel(
			m.theme,
			msg.CareerOpsPath, cvPath, reviewJSONPath, title, key,
			msg.App, msg.OpenReportAfter,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewFactCheck
		return m, nil

	case screens.FactCheckClosedMsg:
		// User pressed q/Esc without finalizing. Review JSON is preserved.
		m.state = viewPipeline
		return m, nil

	case screens.FactCheckFinalizeMsg:
		// Review JSON has been deleted by the screen. Trigger PDF render.
		m.state = viewPipeline
		appKey := msg.AppKey
		app := msg.App
		cvPath := msg.CVPath
		careerOpsPath := m.careerOpsPath
		openAfter := msg.OpenReportAfter
		renderRequest := func() tea.Msg {
			return screens.RenderPDFRequestedMsg{
				CareerOpsPath:   careerOpsPath,
				AppKey:          appKey,
				App:             app,
				CVPath:          cvPath,
				OpenReportAfter: openAfter,
			}
		}
		return m, renderRequest

	case screens.RenderPDFRequestedMsg:
		// Forward to pipeline so it flips status to "rendering".
		pm, pcmd := m.pipeline.Update(msg)
		m.pipeline = pm
		appKey := msg.AppKey
		app := msg.App
		cvPath := msg.CVPath
		careerOpsPath := msg.CareerOpsPath
		openAfter := msg.OpenReportAfter
		renderCmd := func() tea.Msg {
			pdfPath := strings.TrimSuffix(cvPath, ".md") + ".pdf"
			cssPath := filepath.Join(careerOpsPath, "templates/cv-template.css")
			cmd := exec.Command("uv", "run", "--project", careerOpsPath,
				filepath.Join(careerOpsPath, "render-cv-pdf.py"),
				"--in", cvPath,
				"--out", pdfPath,
				"--css", cssPath,
				"--format", "a4")
			cmd.Dir = careerOpsPath
			err := cmd.Run()
			return pdfRenderResult{appKey: appKey, app: app, openAfter: openAfter, err: err}
		}
		return m, tea.Batch(pcmd, renderCmd)

	case pdfRenderResult:
		// Forward to pipeline as PDFRenderedMsg.
		pm, pcmd := m.pipeline.Update(screens.PDFRenderedMsg{AppKey: msg.appKey, Err: msg.err})
		m.pipeline = pm
		m.reloadPipelineData()
		if msg.openAfter && msg.app.ReportPath != "" {
			fullPath := filepath.Join(m.careerOpsPath, msg.app.ReportPath)
			title := fmt.Sprintf("%s — %s", msg.app.Company, msg.app.Role)
			jobURL := msg.app.JobURL
			openCmd := func() tea.Msg {
				return screens.PipelineOpenReportMsg{
					Path:   fullPath,
					Title:  title,
					JobURL: jobURL,
				}
			}
			return m, tea.Batch(pcmd, openCmd)
		}
		return m, pcmd

	case screens.PipelineRescoreMsg:
		// Re-score the highlighted row. Use case: a Fetched row that never
		// got picked up, or a Skipped-Location the user wants to override.
		// Launches a background Sonnet agent against the saved JD file via
		// modes/_location-gate.md + modes/_eval.md — same path as auto-pipeline.
		num := msg.App.ReportNumber
		if num == "" {
			num = reportNum(msg.App.ReportPath)
		}
		if num == "" {
			return m, nil
		}
		jdFile := findJDFileByNum(msg.CareerOpsPath, num)
		if jdFile == "" {
			return m, nil
		}
		careerOpsPath := msg.CareerOpsPath
		return m, func() tea.Msg {
			prompt := "Re-run modes/_location-gate.md then modes/_eval.md on " + jdFile + ". Write the report to reports/ and drop a TSV in data/tracker-additions/."
			cmd := exec.Command("claude", "-p",
				"--model", "claude-sonnet-4-6",
				"--dangerously-skip-permissions", prompt)
			cmd.Dir = careerOpsPath
			_ = cmd.Start()
			return nil
		}

	case screens.PipelineMergeMsg:
		// Run `node merge-tracker.mjs` synchronously to fold pending TSVs
		// into applications.md, then trigger a full pipeline refresh so the
		// promoted rows (Fetched → Evaluated) show up immediately.
		careerOpsPath := msg.CareerOpsPath
		return m, func() tea.Msg {
			cmd := exec.Command("node", "merge-tracker.mjs")
			cmd.Dir = careerOpsPath
			_ = cmd.Run()
			return screens.PipelineRefreshMsg{}
		}

	case screens.PipelineOpenURLMsg:
		url := msg.URL
		return m, func() tea.Msg {
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "darwin":
				cmd = exec.Command("open", url)
			case "linux":
				cmd = exec.Command("xdg-open", url)
			case "windows":
				cmd = exec.Command("cmd", "/c", "start", "", url)
			default:
				cmd = exec.Command("xdg-open", url)
			}
			_ = cmd.Run()
			return nil
		}

	default:
		if m.state == viewReport {
			vm, cmd := m.viewer.Update(msg)
			m.viewer = vm
			return m, cmd
		}
		if m.state == viewProgress {
			pg, cmd := m.progress.Update(msg)
			m.progress = pg
			return m, cmd
		}
		if m.state == viewFactCheck {
			fm, cmd := m.factcheck.Update(msg)
			m.factcheck = fm
			return m, cmd
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd
	}
}

// pdfRenderResult is an internal message carrying the render-cv-pdf.py exit
// status back to the main update loop, where it is forwarded to the pipeline
// as a PDFRenderedMsg and used to optionally open the report.
type pdfRenderResult struct {
	appKey    string
	app       model.CareerApplication
	openAfter bool
	err       error
}

// jobPathParts derives the 3-digit num and "{NUM}-{slug}" base from an
// appKey (which is usually a report path). Returns ("","") when no JD is
// found on disk.
func jobPathParts(careerOpsPath, appKey string) (string, string) {
	num := reportNum(appKey)
	if num == "" {
		return "", ""
	}
	jdFile := findJDFileByNum(careerOpsPath, num)
	if jdFile == "" {
		return "", ""
	}
	jdBase := strings.TrimSuffix(filepath.Base(jdFile), ".md")
	return num, jdBase
}

func (m appModel) View() string {
	switch m.state {
	case viewReport:
		return m.viewer.View()
	case viewProgress:
		return m.progress.View()
	case viewFactCheck:
		return m.factcheck.View()
	default:
		return m.pipeline.View()
	}
}

// reportNum extracts the 3-digit prefix from a report path like
// "reports/064-legora-product-lead-core-growth-2026-04-17.md".
func reportNum(reportPath string) string {
	name := filepath.Base(reportPath)
	if len(name) < 3 {
		return ""
	}
	prefix := name[:3]
	for _, r := range prefix {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return prefix
}

// findJDFileByNum returns the jds/{NUM}-*.md file matching the given number.
func findJDFileByNum(careerOpsPath, num string) string {
	jdsDir := filepath.Join(careerOpsPath, "jds")
	entries, err := os.ReadDir(jdsDir)
	if err != nil {
		return ""
	}
	prefix := num + "-"
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		if strings.HasSuffix(name, ".md") || strings.HasSuffix(name, ".txt") {
			return filepath.Join(jdsDir, name)
		}
	}
	return ""
}

func main() {
	pathFlag := flag.String("path", ".", "Path to career-ops directory")
	flag.Parse()

	careerOpsPath := *pathFlag

	// Load applications
	apps := data.ParseApplications(careerOpsPath)
	if apps == nil {
		fmt.Fprintf(os.Stderr, "Error: could not find applications.md in %s or %s/data/\n", careerOpsPath, careerOpsPath)
		os.Exit(1)
	}

	// Compute metrics
	metrics := data.ComputeMetrics(apps)
	progressMetrics := data.ComputeProgressMetrics(apps)

	// Batch-load all report summaries
	t := theme.NewTheme("auto")
	pm := screens.NewPipelineModel(t, apps, metrics, careerOpsPath, 120, 40)

	for _, app := range apps {
		if app.ReportPath == "" {
			continue
		}
		summary, location := data.LoadReportSummary(careerOpsPath, app.ReportPath)
		if summary != "" || location != "" {
			pm.EnrichReport(app.ReportPath, summary, location)
		}
	}

	// Pre-populate CV status for apps that already have artifacts on disk.
	// A pending review JSON wins over a done PDF — the user must walk through
	// findings before treating the CV as final.
	cvsByNum := data.ScanOutputCVsByNum(careerOpsPath)
	reviewsByNum := data.ScanOutputReviewsByNum(careerOpsPath)
	pm.RefreshFromDisk(reviewsByNum, cvsByNum)

	m := appModel{
		pipeline:        pm,
		careerOpsPath:   careerOpsPath,
		theme:           t,
		progressMetrics: progressMetrics,
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
