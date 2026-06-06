package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

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
	viewCV
)

type appModel struct {
	pipeline        screens.PipelineModel
	viewer          screens.ViewerModel
	progress        screens.ProgressModel
	factcheck       screens.FactCheckModel
	cv              screens.CVModel
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
		if m.state == viewCV {
			m.cv.Resize(msg.Width, msg.Height)
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

	case screens.PipelineOpenCVMsg:
		m.cv = screens.NewCVModel(
			m.theme,
			msg.CareerOpsPath,
			m.pipeline.TabCounts(),
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewCV
		return m, nil

	case screens.CVClosedMsg:
		// q/Esc → restore the tab the user opened CV from. left/right →
		// cycle off the CV slot directly so the user crosses through into
		// the neighbouring filter tab without first bouncing off prevTab.
		if msg.NavDirection == 0 {
			m.pipeline.RestoreFromCVTab()
		} else {
			m.pipeline.NavigateFromCVTab(msg.NavDirection)
		}
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
		// where to find the markdown. Matches lib/generate-cv-llm.mjs convention:
		// output/customized-cvs/{NUM}-{slug}-cv.md where slug comes from the JD filename.
		jdBase := strings.TrimSuffix(filepath.Base(jdFile), ".md")
		cvPath := filepath.Join(msg.CareerOpsPath, "output", "customized-cvs", jdBase+"-cv.md")
		careerOpsPath := msg.CareerOpsPath
		startedCmd := func() tea.Msg { return screens.CVGenStartedMsg{AppKey: key} }
		bgCmd := func() tea.Msg {
			// Script derives NUM and slug from the JD filename. PDF is
			// deferred to the finalize step (after the user walks the review),
			// so generate markdown only here.
			cmd := exec.Command("node", "lib/generate-cv-llm.mjs",
				"--jd", jdFile, "--format", "a4", "--no-pdf")
			cmd.Dir = careerOpsPath
			err := runSpawn(cmd, careerOpsPath, "cv-generate")
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
			cmd := exec.Command("node", "lib/cv-fact-check.mjs",
				"--review-only", cvPath)
			cmd.Dir = careerOpsPath
			err := runSpawn(cmd, careerOpsPath, "cv-review")
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
		reviewJSON := filepath.Join(m.careerOpsPath, "output", "customized-cvs", jdBase+"-cv-review.json")
		if _, err := os.Stat(reviewJSON); err == nil {
			// Findings exist — wait for the user to walk through.
			return m, pcmd
		}
		// No findings — auto-render PDF.
		cvPath := filepath.Join(m.careerOpsPath, "output", "customized-cvs", jdBase+"-cv.md")
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
		cvPath := filepath.Join(msg.CareerOpsPath, "output", "customized-cvs", jdBase+"-cv.md")
		reviewJSONPath := filepath.Join(msg.CareerOpsPath, "output", "customized-cvs", jdBase+"-cv-review.json")
		if _, err := os.Stat(cvPath); err != nil {
			// No generated CV on disk yet — user must press `g` first.
			return m, nil
		}
		key := msg.App.ReportPath
		if key == "" {
			key = msg.App.Company + "/" + msg.App.Role
		}
		title := fmt.Sprintf("#%s · %s · %s", num, msg.App.Company, msg.App.Role)
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
		// Finalizing returns to the dashboard, not the job report.
		openAfter := false
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
			cssPath := filepath.Join(careerOpsPath, "style/cv-template.css")
			cmd := exec.Command("uv", "run", "--project", careerOpsPath,
				filepath.Join(careerOpsPath, "render-cv-pdf.py"),
				"--in", cvPath,
				"--out", pdfPath,
				"--css", cssPath,
				"--format", "a4")
			cmd.Dir = careerOpsPath
			err := runSpawn(cmd, careerOpsPath, "cv-pdf")
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
			// Inside a reachable cmux workspace, open the link in the cmux
			// browser surface instead of the host OS browser.
			if cmuxBin, ok := cmuxReachable(); ok {
				if err := exec.Command(cmuxBin, "browser", "open", url).Run(); err == nil {
					return nil
				}
				// fall through to the host opener on failure
			}
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

	case screens.PipelineApplyMsg:
		app := msg.App
		careerOpsPath := msg.CareerOpsPath
		return m, func() tea.Msg {
			// Resolve the launcher first: the primed prompt is shaped
			// per agent. Claude Code resolves the repo-local
			// `.claude/skills/career-ops` skill, so it gets the
			// `/career-ops apply …` slash form. Every other agent has no
			// such skill, so it gets a self-contained instruction that
			// points it straight at modes/apply.md + CLAUDE.md. applyPrompt
			// decides from the launcher's leading token.
			launcher := applyLauncher(careerOpsPath)
			prompt := applyPrompt(launcher, careerOpsPath, app)

			// Inside a reachable cmux: spawn a new workspace (tab) running
			// an interactive, primed agent session in the repo.
			//
			// The launcher token comes from applyLauncher() (env →
			// .env CAREER_OPS_APPLY_AGENT → "claude") and is run through an interactive
			// shell (`$SHELL -ic`) so ~/.zshrc is sourced and the user's
			// `claude()` function (→ `safe claude
			// --dangerously-skip-permissions …` Agent Safehouse wrapper)
			// applies. Shell functions/aliases never survive a
			// non-interactive `sh -c`, so the interactive shell wrap is
			// load-bearing.
			//
			// Sandbox bridge: Safehouse deny-by-default blocks the cmux
			// Unix socket (~/Library/Application Support/cmux/, denied
			// path) and strips CMUX_* env, so a sandboxed apply session
			// can't drive cmux. This dashboard runs unsandboxed inside
			// cmux, so its OWN env carries the full CMUX_* set + the
			// socket path — pass them down via Safehouse's env-equivalent
			// knobs (SAFEHOUSE_ENV_PASS / SAFEHOUSE_ADD_DIRS). The user's
			// `safe` wrapper honours them; a plain unsandboxed launcher
			// ignores them. No hardcoded paths, future-proof to new
			// CMUX_* vars.
			if cmuxBin, ok := cmuxReachable(); ok {
				title := "Apply · " + app.Company
				shell := os.Getenv("SHELL")
				if shell == "" {
					shell = "/bin/zsh"
				}

				// Collect every CMUX_* name from our own (unsandboxed)
				// environment so the wrapped session can re-create the
				// caller context cmux needs for socket + workspace target.
				var cmuxNames []string
				for _, kv := range os.Environ() {
					if strings.HasPrefix(kv, "CMUX_") {
						if i := strings.IndexByte(kv, '='); i > 0 {
							cmuxNames = append(cmuxNames, kv[:i])
						}
					}
				}
				sockDir := ""
				if sp := os.Getenv("CMUX_SOCKET_PATH"); sp != "" {
					sockDir = filepath.Dir(sp)
				} else if home, err := os.UserHomeDir(); err == nil {
					sockDir = filepath.Join(home, "Library", "Application Support", "cmux")
				}
				var sbPrefix string
				if len(cmuxNames) > 0 {
					sbPrefix += "SAFEHOUSE_ENV_PASS=" + shellQuote(strings.Join(cmuxNames, ",")) + " "
				}
				if sockDir != "" {
					sbPrefix += "SAFEHOUSE_ADD_DIRS=" + shellQuote(sockDir) + " "
				}

				inner := launcher + " " + shellQuote(prompt)
				launch := sbPrefix + shell + " -ic " + shellQuote(inner)
				c := exec.Command(cmuxBin, "new-workspace",
					"--name", title,
					"--cwd", careerOpsPath,
					"--command", launch,
					"--focus", "true")
				if err := c.Run(); err == nil {
					return nil
				}
				// fall through to host-browser degrade on failure
			}

			// Not in cmux (or spawn failed): degrade to opening the job
			// URL in the host browser — the user runs /career-ops apply
			// manually from a terminal in the repo.
			if app.JobURL == "" {
				return nil
			}
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "darwin":
				cmd = exec.Command("open", app.JobURL)
			case "windows":
				cmd = exec.Command("cmd", "/c", "start", "", app.JobURL)
			default:
				cmd = exec.Command("xdg-open", app.JobURL)
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
		if m.state == viewCV {
			cm, cmd := m.cv.Update(msg)
			m.cv = cm
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
	case viewCV:
		return m.cv.View()
	default:
		return m.pipeline.View()
	}
}

// reportNum extracts the NUM prefix from a report path like
// "data/reports/1085-zyte-ai-product-manager-owner-2026-06-04.md". The NUM is
// a 3+ digit sequence, so this delegates to data.LeadingNum rather than
// assuming exactly 3 digits.
func reportNum(reportPath string) string {
	return data.LeadingNum(reportPath)
}

// findJDFileByNum returns the data/jds/{NUM}-*.md file matching the given number.
func findJDFileByNum(careerOpsPath, num string) string {
	jdsDir := filepath.Join(careerOpsPath, "data", "jds")
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

// reApplyAgentEnv extracts the `CAREER_OPS_APPLY_AGENT` value from the repo
// `.env` file (line-anchored, optional `export `, optional quotes; comment
// lines start with `#` so they don't match). Dependency-free, in the same
// targeted-regex style as internal/data/career.go — the dashboard never needs
// a general dotenv parser, just this one key.
var reApplyAgentEnv = regexp.MustCompile(`(?m)^[ \t]*(?:export[ \t]+)?CAREER_OPS_APPLY_AGENT[ \t]*=[ \t]*["']?([^"'#\n\r]+?)["']?[ \t]*$`)

// applyAgentCmd maps a supported agent key to the command PREFIX that starts
// an interactive session and seeds it with the initial prompt. The call site
// appends ` <shell-quoted prompt>`, so each value is exactly what must precede
// the quoted message:
//
//	claude    "<msg>"   positional → seeds the interactive session
//	codex     "<msg>"   positional → seeds the interactive TUI
//	gemini -i "<msg>"   -i/--prompt-interactive (bare positional is headless)
//	opencode --prompt "<msg>"   pre-fills the TUI composer (no positional form)
//	pi        "<msg>"   interactive is the default; -p would be print mode
var applyAgentCmd = map[string]string{
	"claude":   "claude",
	"codex":    "codex",
	"gemini":   "gemini -i",
	"opencode": "opencode --prompt",
	"pi":       "pi",
}

// applyLauncher resolves the command prefix the dashboard launches for the
// interactive apply flow. Precedence: $CAREER_OPS_APPLY_CMD (process-env
// escape hatch, used verbatim as the prefix) → `.env` CAREER_OPS_APPLY_AGENT
// mapped through applyAgentCmd → "claude". The value is a launcher
// token/command, not a path: it is run through `$SHELL -ic`, so shell
// functions/aliases (e.g. a sandbox wrapper) still resolve. Note this swaps
// only the launcher; the primed prompt is shaped separately by applyPrompt,
// keyed off the launcher's leading token.
func applyLauncher(careerOpsPath string) string {
	if v := strings.TrimSpace(os.Getenv("CAREER_OPS_APPLY_CMD")); v != "" {
		return v
	}
	if b, err := os.ReadFile(filepath.Join(careerOpsPath, ".env")); err == nil {
		if m := reApplyAgentEnv.FindSubmatch(b); m != nil {
			key := strings.ToLower(strings.TrimSpace(string(m[1])))
			if cmd, ok := applyAgentCmd[key]; ok {
				return cmd
			}
		}
	}
	return "claude"
}

// applyPrompt builds the initial message the launched agent is primed with.
// It is adapted per agent because the `/career-ops apply` slash command is
// repo-local Claude-Code skill sugar (`.claude/skills/career-ops/SKILL.md`)
// that nothing else reads:
//
//   - Claude Code (launcher leads with `claude`) → the native
//     `/career-ops apply …` slash form; the skill router loads modes/apply.md.
//   - Any other agent (codex, gemini, opencode, pi, or a custom launcher) →
//     a self-contained instruction that points the agent straight at
//     modes/apply.md + CLAUDE.md, since it has no career-ops command. The
//     workflow itself is identical — apply.md is self-contained and pulls its
//     shared standards via in-file path references.
//
// The dispatch carries exact paths, never globs: app.ReportPath comes straight
// off the tracker link and resolveCustomizedCV() resolves the CV PDF here, so
// the apply agent reads its context directly instead of ls/grep-ing for it.
//
// The leading token is matched on its basename so a wrapped path or a
// `claude --flag …` custom override still resolves to the slash form.
// Both forms keep the hard ethical constraint explicit: fill, never submit.
func applyPrompt(launcher, careerOpsPath string, app model.CareerApplication) string {
	agent := ""
	if fields := strings.Fields(launcher); len(fields) > 0 {
		agent = filepath.Base(fields[0])
	}

	// Exact report path off the tracker link; fall back to a NUM glob only
	// when the row carries no report link at all.
	report := app.ReportPath
	if report == "" && app.ReportNumber != "" {
		report = "data/reports/" + app.ReportNumber + "-*.md"
	}
	cv := resolveCustomizedCV(careerOpsPath, app.ReportNumber)

	var b strings.Builder
	if agent == "claude" {
		// Slash command must lead; apply.md handles the rest (Step 1
		// opens the Form URL itself).
		fmt.Fprintf(&b, "/career-ops apply — application #%d: %s — %s.",
			app.Number, app.Company, app.Role)
		if report != "" {
			fmt.Fprintf(&b, " Report: %s.", report)
		}
		if cv != "" {
			fmt.Fprintf(&b, " CV PDF: %s.", cv)
		}
		if app.JobURL != "" {
			fmt.Fprintf(&b, " Form URL: %s", app.JobURL)
		}
		return b.String()
	}

	fmt.Fprintf(&b, "Read ./modes/apply.md and ./CLAUDE.md, then run the "+
		"career-ops live application assistant for application #%d: %s — %s.",
		app.Number, app.Company, app.Role)
	if report != "" {
		fmt.Fprintf(&b, " Evaluation report: %s.", report)
	}
	if cv != "" {
		fmt.Fprintf(&b, " CV PDF: %s.", cv)
	}
	if app.JobURL != "" {
		fmt.Fprintf(&b, " Form URL: %s.", app.JobURL)
	}
	b.WriteString(" Follow modes/apply.md exactly — fill the form fields with " +
		"customized answers but STOP before Submit/Send so the user reviews " +
		"and submits.")
	return b.String()
}

// resolveCustomizedCV returns the repo-relative path of the customized CV PDF
// for a tracker NUM (output/customized-cvs/{NUM}-*-cv.pdf), or "" when none has
// been generated yet. Passing the exact path spares the apply agent a glob.
func resolveCustomizedCV(careerOpsPath, num string) string {
	if num == "" {
		return ""
	}
	matches, err := filepath.Glob(filepath.Join(
		careerOpsPath, "output", "customized-cvs", num+"-*-cv.pdf"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	rel, err := filepath.Rel(careerOpsPath, matches[0])
	if err != nil {
		return ""
	}
	return rel
}

// cmuxReachable reports whether this process can actually drive cmux, and
// returns the resolved cmux binary path. This is a capability probe, not an
// env-var check: the CMUX_* environment is stripped by the `safe` sandbox and
// the control socket path can be denied by sandbox policy, so a successful
// `cmux current-workspace` round-trip is the only trustworthy signal that
// `cmux browser open` / `cmux new-workspace` will work. The 3s timeout keeps
// a wedged socket from freezing the TUI.
func cmuxReachable() (string, bool) {
	bin, err := exec.LookPath("cmux")
	if err != nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, bin, "current-workspace").Run(); err != nil {
		return "", false
	}
	return bin, true
}

// shellQuote wraps s in POSIX single quotes so it survives as one argument
// when cmux runs `--command` through a shell. Single quotes inside s are
// escaped via the standard '\'' idiom.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// runSpawn runs cmd capturing combined stdout+stderr. On failure it appends a
// diagnostic block to <careerOpsPath>/output/customized-cvs/cvgen.log and
// returns an error carrying the last non-empty output line, so a failed CV
// step surfaces a real reason (in the log) instead of the dashboard's silent
// red "PDF ✗".
func runSpawn(cmd *exec.Cmd, careerOpsPath, label string) error {
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	runErr := cmd.Run()
	if runErr == nil {
		return nil
	}
	out := buf.String()
	dir := filepath.Join(careerOpsPath, "output", "customized-cvs")
	_ = os.MkdirAll(dir, 0o755)
	if f, ferr := os.OpenFile(filepath.Join(dir, "cvgen.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); ferr == nil {
		fmt.Fprintf(f, "\n=== %s · %s ===\n$ %s\n%s\n[error] %v\n",
			time.Now().Format(time.RFC3339), label,
			strings.Join(cmd.Args, " "), out, runErr)
		f.Close()
	}
	if reason := lastNonEmptyLine(out); reason != "" {
		return fmt.Errorf("%s: %s (%w)", label, reason, runErr)
	}
	return fmt.Errorf("%s: %w", label, runErr)
}

// lastNonEmptyLine returns the final non-blank line of s — the most useful
// single line of a failed script's output for a one-line error.
func lastNonEmptyLine(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return t
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
