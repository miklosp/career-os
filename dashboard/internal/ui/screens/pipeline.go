package screens

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"career-ops/dashboard/internal/data"
	"career-ops/dashboard/internal/model"
	"career-ops/dashboard/internal/theme"
)

// hasPendingReview returns true when a cv-review.json file exists for the
// given app — signalling that the user has not yet walked through the review.
// The artifact base is resolved from the generated CV on disk, not from
// data/jds/, so a pending review still opens after its source JD is deleted.
// Returns false for apps with no report, no derivable NUM, or no generated CV.
func hasPendingReview(careerOpsPath string, app model.CareerApplication) bool {
	num := data.LeadingNum(app.ReportPath)
	if num == "" {
		return false
	}
	base := data.CustomizedCVBase(careerOpsPath, num)
	if base == "" {
		return false
	}
	reviewPath := filepath.Join(careerOpsPath, "output", "customized-cvs", base+"-cv-review.json")
	_, err := os.Stat(reviewPath)
	return err == nil
}

// PipelineClosedMsg is emitted when the pipeline screen is dismissed.
type PipelineClosedMsg struct{}

// PipelineOpenReportMsg is emitted when a report should be opened in FileViewer.
type PipelineOpenReportMsg struct {
	Path   string
	Title  string
	JobURL string
}

// PipelineOpenURLMsg is emitted when a job URL should be opened in browser.
type PipelineOpenURLMsg struct {
	URL string
}

// PipelineApplyMsg is emitted when the user starts the live apply flow for the
// selected app. When the dashboard runs inside cmux it spawns a new cmux
// workspace (tab) running an interactive Claude Code session primed with
// `/career-ops apply` for this row. Outside cmux it degrades to opening the
// job URL in the host browser.
type PipelineApplyMsg struct {
	CareerOpsPath string
	App           model.CareerApplication
}

// PipelineLoadReportMsg requests lazy loading of a report summary.
type PipelineLoadReportMsg struct {
	CareerOpsPath string
	ReportPath    string
}

// PipelineUpdateStatusMsg requests a status update for an application.
type PipelineUpdateStatusMsg struct {
	CareerOpsPath string
	App           model.CareerApplication
	NewStatus     string
}

// PipelinePruneMsg requests a bulk discard of every scored app below Threshold.
type PipelinePruneMsg struct {
	CareerOpsPath string
	Threshold     float64
}

// PipelineRefreshMsg requests a full tracker reload from disk.
type PipelineRefreshMsg struct{}

// PipelineOpenProgressMsg is emitted when the progress screen should open.
type PipelineOpenProgressMsg struct{}

// PipelineGenerateCVMsg is emitted when the user requests CV generation for the selected app.
type PipelineGenerateCVMsg struct {
	CareerOpsPath string
	App           model.CareerApplication
}

// PipelineMergeMsg is emitted when the user runs `node merge-tracker.mjs`
// to fold pending data/tracker-additions/*.tsv into applications.md.
type PipelineMergeMsg struct {
	CareerOpsPath string
}

// CVGenStartedMsg is emitted when background CV generation has started for an app.
type CVGenStartedMsg struct{ AppKey string }

// CVGenDoneMsg is emitted when background CV generation completes (Err nil = success).
// CVPath is the absolute path to the generated markdown, used by main to
// auto-chain the review phase.
type CVGenDoneMsg struct {
	AppKey string
	CVPath string
	Err    error
}

// ReviewStartedMsg is emitted when the auto-chained review call (Gemini via
// Bifrost) begins for an app. Row status transitions from "generating" to
// "reviewing".
type ReviewStartedMsg struct{ AppKey string }

// ReviewDoneMsg is emitted when the non-interactive review phase completes.
// If Err is nil, the review JSON has been written to disk and the row
// transitions to "review-pending" — awaiting the user's interactive
// walkthrough via `F` or by pressing Enter on the row.
type ReviewDoneMsg struct {
	AppKey string
	Err    error
}

// PipelineFactCheckMsg asks main to open the split-view fact-check screen
// for the given app's generated CV.
//
// OpenReportAfter, when true, signals that main should open the app's report
// viewer once the screen closes. Used by the Enter handler on rows that have
// a pending review: walkthrough first, then report.
type PipelineFactCheckMsg struct {
	CareerOpsPath   string
	App             model.CareerApplication
	OpenReportAfter bool
}

// RenderPDFRequestedMsg asks main to render the PDF for the given app from the
// already-finalized CV markdown. Fired in two paths:
//   - auto-render after a review with zero findings (no JSON on disk)
//   - finalize from the FactCheckModel (JSON deleted, markdown finalized)
type RenderPDFRequestedMsg struct {
	CareerOpsPath string
	AppKey        string
	App           model.CareerApplication
	CVPath        string
	// OpenReportAfter is forwarded from the source flow so that finalize
	// triggered by Enter-on-pending opens the report once the render finishes.
	OpenReportAfter bool
}

// PDFRenderedMsg fires when render-cv-pdf.py completes. Pipeline transitions
// the row's CV status from "rendering" to "done" (or "error" on failure).
type PDFRenderedMsg struct {
	AppKey string
	Err    error
}

type reportSummary struct {
	summary  string
	location string
}

// Sort modes
const (
	sortScore   = "score"
	sortDate    = "date"
	sortCompany = "company"
	sortStatus  = "status"
)

// Filter modes
const (
	filterPriority  = "priority"
	filterFetched   = "fetched"
	filterEvaluated = "evaluated"
	filterApplied   = "applied"
	filterInterview = "interview"
	filterSkip      = "skip"
	filterProgress  = "progress"
	// filterCV is a pseudo-tab that opens the full-screen CV editor rather
	// than filtering applications. Navigating onto it via cycle keys
	// (f/right/l, left/h) emits PipelineOpenCVMsg; main pushes viewCV and
	// pops back to the previous tab on close (see RestoreFromCVTab).
	filterCV = "cv"

	// priorityThreshold is the minimum score for the PRIORITY tab.
	priorityThreshold = 4.0
)

type pipelineTab struct {
	filter string
	label  string
}

var pipelineTabs = []pipelineTab{
	{filterPriority, "PRIORITY"},
	{filterEvaluated, "EVALUATED"},
	{filterFetched, "FETCHED"},
	{filterApplied, "APPLIED"},
	{filterInterview, "INTERVIEW"},
	{filterSkip, "SKIP"},
	{filterProgress, "PROGRESS"},
	{filterCV, "CV"},
}

var sortCycle = []string{sortScore, sortDate, sortCompany, sortStatus}

// statusOptions are the user-selectable target statuses in the change-status
// modal. Fetched and Skipped-Location are excluded — those are written by
// agents in the pipeline, not by manual user action.
var statusOptions = []string{"Evaluated", "Applied", "Responded", "Interview", "Offer", "Rejected", "Discarded", "SKIP"}

// statusGroupOrder defines display order for grouped view.
var statusGroupOrder = []string{"interview", "offer", "responded", "applied", "evaluated", "fetched", "skipped-location", "skip", "rejected", "discarded"}

// Bulk-prune threshold bounds. The modal opens at the default cutoff and the
// user can nudge it within these bounds before confirming.
const (
	defaultPruneThreshold = 3.0
	pruneThresholdStep    = 0.5
	minPruneThreshold     = 0.5
	maxPruneThreshold     = 5.0
)

// PipelineModel implements the career pipeline dashboard screen.
type PipelineModel struct {
	apps          []model.CareerApplication
	filtered      []model.CareerApplication
	metrics       model.PipelineMetrics
	cursor        int
	scrollOffset  int
	sortMode      string
	activeTab     int
	// prevTabBeforeCV stores the previously focused tab so RestoreFromCVTab
	// can roll the visual highlight back when the user dismisses the CV
	// editor. -1 means "no CV escape in flight".
	prevTabBeforeCV int
	viewMode        string // "grouped" or "flat"
	width, height   int
	theme           theme.Theme
	careerOpsPath   string
	reportCache     map[string]reportSummary
	cvGenStatus     map[string]string // appKey → "started"|"done"|"error"
	// Status picker sub-state
	statusPicker bool
	statusCursor int
	// Prune confirm sub-state. pruneConfirm means the bulk-discard modal is
	// capturing keys; pruneThreshold is the live score cutoff (discard < it).
	pruneConfirm   bool
	pruneThreshold float64
	// Search sub-state. searchEditing means the input bar is capturing keys.
	// searchQuery may persist after Enter dismisses the bar; switching tabs
	// or pressing Esc clears it.
	searchEditing bool
	searchQuery   string
}

// NewPipelineModel creates a new pipeline screen.
func NewPipelineModel(t theme.Theme, apps []model.CareerApplication, metrics model.PipelineMetrics, careerOpsPath string, width, height int) PipelineModel {
	m := PipelineModel{
		apps:            apps,
		metrics:         metrics,
		sortMode:        sortScore,
		activeTab:       0,
		prevTabBeforeCV: -1,
		viewMode:        "grouped",
		width:           width,
		height:          height,
		theme:           t,
		careerOpsPath:   careerOpsPath,
		reportCache:     make(map[string]reportSummary),
		cvGenStatus:     make(map[string]string),
	}
	m.applyFilterAndSort()
	return m
}

// RestoreFromCVTab moves activeTab off the CV pseudo-tab back to whatever was
// focused before opening the editor. Idempotent: a no-op when the current
// tab is anything else.
func (m *PipelineModel) RestoreFromCVTab() {
	if pipelineTabs[m.activeTab].filter != filterCV {
		return
	}
	if m.prevTabBeforeCV >= 0 && m.prevTabBeforeCV < len(pipelineTabs) {
		m.activeTab = m.prevTabBeforeCV
	} else {
		m.activeTab = 0
	}
	m.prevTabBeforeCV = -1
	m.applyFilterAndSort()
	m.cursor = 0
	m.scrollOffset = 0
}

// NavigateFromCVTab cycles off the CV tab in the given direction (-1 = left,
// +1 = right), skipping the CV slot itself so the pipeline always lands on a
// real filter tab. Called by main on CVClosedMsg when the user used left/right
// to leave the editor — distinct from q/Esc which restores via RestoreFromCVTab.
func (m *PipelineModel) NavigateFromCVTab(dir int) {
	if pipelineTabs[m.activeTab].filter != filterCV {
		return
	}
	if dir == 0 {
		return
	}
	for {
		m.activeTab = (m.activeTab + dir + len(pipelineTabs)) % len(pipelineTabs)
		if pipelineTabs[m.activeTab].filter != filterCV {
			break
		}
	}
	m.prevTabBeforeCV = -1
	m.applyFilterAndSort()
	m.cursor = 0
	m.scrollOffset = 0
}

// Init implements tea.Model.
func (m PipelineModel) Init() tea.Cmd {
	return nil
}

// Resize updates dimensions.
func (m *PipelineModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

// Width returns the current width.
func (m PipelineModel) Width() int { return m.width }

// Height returns the current height.
func (m PipelineModel) Height() int { return m.height }

// CopyReportCache copies the report cache from another pipeline model.
func (m *PipelineModel) CopyReportCache(other *PipelineModel) {
	for k, v := range other.reportCache {
		m.reportCache[k] = v
	}
}

// RefreshFromDisk reconciles cvGenStatus with on-disk artifacts. Rows
// currently in an in-flight state (generating/reviewing/rendering) are
// skipped so we don't clobber their status mid-run. `error` rows ARE
// overwritten so a transient Bifrost hiccup can be recovered from by
// pressing `r` after a manual retry of the failed step.
func (m *PipelineModel) RefreshFromDisk(reviewsByNum, cvsByNum map[string]bool) {
	inFlight := map[string]bool{
		"generating": true,
		"reviewing":  true,
		"rendering":  true,
	}
	for _, app := range m.apps {
		num := app.ReportNumber
		if len(num) > 0 && len(num) < 3 {
			num = fmt.Sprintf("%03s", num)
		}
		if num == "" {
			continue
		}
		key := appKey(app)
		if inFlight[m.cvGenStatus[key]] {
			continue
		}
		switch {
		case reviewsByNum[num]:
			m.cvGenStatus[key] = "review-pending"
		case cvsByNum[num]:
			m.cvGenStatus[key] = "done"
		default:
			// No artifacts on disk — clear stale `error` so the row
			// returns to its baseline empty state.
			if m.cvGenStatus[key] == "error" {
				delete(m.cvGenStatus, key)
			}
		}
	}
}

// SetAppCVStatus pre-loads the CV generation status for an app (used at startup
// to reflect CVs that already exist on disk).
func (m *PipelineModel) SetAppCVStatus(app model.CareerApplication, status string) {
	m.cvGenStatus[appKey(app)] = status
}

// CopyCVGenStatus copies the CV generation status map from another pipeline model.
func (m *PipelineModel) CopyCVGenStatus(other *PipelineModel) {
	for k, v := range other.cvGenStatus {
		m.cvGenStatus[k] = v
	}
}

// EnrichReport caches report summary data for preview.
func (m *PipelineModel) EnrichReport(reportPath, summary, location string) {
	m.reportCache[reportPath] = reportSummary{
		summary:  summary,
		location: location,
	}
}

// CursorIndex returns the current cursor position in the filtered list.
func (m PipelineModel) CursorIndex() int { return m.cursor }

// WithReloadedDataAtIndex rebuilds the pipeline with fresh data but pins the
// cursor to the given index (clamped) instead of following the previously
// selected app. Useful after a status change moves the current item to another
// group — the user stays at the same row position and lands on the next item.
func (m PipelineModel) WithReloadedDataAtIndex(apps []model.CareerApplication, metrics model.PipelineMetrics, idx int) PipelineModel {
	reloaded := NewPipelineModel(m.theme, apps, metrics, m.careerOpsPath, m.width, m.height)
	reloaded.sortMode = m.sortMode
	reloaded.activeTab = m.activeTab
	reloaded.viewMode = m.viewMode
	reloaded.applyFilterAndSort()
	reloaded.CopyReportCache(&m)
	reloaded.CopyCVGenStatus(&m)

	if len(reloaded.filtered) == 0 {
		reloaded.cursor = 0
		reloaded.scrollOffset = 0
		return reloaded
	}
	if idx < 0 {
		idx = 0
	}
	if idx >= len(reloaded.filtered) {
		idx = len(reloaded.filtered) - 1
	}
	reloaded.cursor = idx
	reloaded.adjustScroll()
	return reloaded
}

// WithReloadedData rebuilds the pipeline with fresh tracker data while preserving
// the current UI state so manual refresh feels seamless.
func (m PipelineModel) WithReloadedData(apps []model.CareerApplication, metrics model.PipelineMetrics) PipelineModel {
	selectedReportPath := ""
	selectedCompany := ""
	selectedRole := ""
	if app, ok := m.CurrentApp(); ok {
		selectedReportPath = app.ReportPath
		selectedCompany = app.Company
		selectedRole = app.Role
	}

	reloaded := NewPipelineModel(m.theme, apps, metrics, m.careerOpsPath, m.width, m.height)
	reloaded.sortMode = m.sortMode
	reloaded.activeTab = m.activeTab
	reloaded.viewMode = m.viewMode
	reloaded.applyFilterAndSort()
	reloaded.CopyReportCache(&m)
	reloaded.CopyCVGenStatus(&m)

	for i, app := range reloaded.filtered {
		if selectedReportPath != "" && app.ReportPath == selectedReportPath {
			reloaded.cursor = i
			reloaded.adjustScroll()
			return reloaded
		}
		if selectedReportPath == "" && app.Company == selectedCompany && app.Role == selectedRole {
			reloaded.cursor = i
			reloaded.adjustScroll()
			return reloaded
		}
	}

	if len(reloaded.filtered) == 0 {
		reloaded.cursor = 0
		reloaded.scrollOffset = 0
		return reloaded
	}

	if m.cursor >= len(reloaded.filtered) {
		reloaded.cursor = len(reloaded.filtered) - 1
	} else if m.cursor > 0 {
		reloaded.cursor = m.cursor
	}
	reloaded.adjustScroll()
	return reloaded
}

// CurrentApp returns the currently selected application, if any.
func (m PipelineModel) CurrentApp() (model.CareerApplication, bool) {
	if m.cursor < 0 || m.cursor >= len(m.filtered) {
		return model.CareerApplication{}, false
	}
	return m.filtered[m.cursor], true
}

// AppByKey looks up an application by its appKey across the full (unfiltered)
// list. Used when an async chain (review/render) needs to surface the row
// even if the current filter wouldn't include it. Returns the zero value
// when no match is found.
func (m PipelineModel) AppByKey(key string) (model.CareerApplication, bool) {
	for _, a := range m.apps {
		if appKey(a) == key {
			return a, true
		}
	}
	return model.CareerApplication{}, false
}

// AdvanceCursor moves the cursor by delta rows (negative to go up), clamps to
// bounds, and adjusts scroll so the new row stays visible.
func (m *PipelineModel) AdvanceCursor(delta int) {
	if len(m.filtered) == 0 {
		return
	}
	m.cursor += delta
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor >= len(m.filtered) {
		m.cursor = len(m.filtered) - 1
	}
	m.adjustScroll()
}

// OpenStatusPicker opens the status picker overlay on the pipeline.
func (m *PipelineModel) OpenStatusPicker() {
	if len(m.filtered) == 0 {
		return
	}
	m.statusPicker = true
	m.statusCursor = 0
}

// Update handles input for the pipeline screen.
func (m PipelineModel) Update(msg tea.Msg) (PipelineModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		if m.pruneConfirm {
			return m.handlePruneConfirm(msg)
		}
		if m.searchEditing {
			return m.handleSearchInput(msg)
		}
		return m.handleKey(msg)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case CVGenStartedMsg:
		m.cvGenStatus[msg.AppKey] = "generating"
		return m, nil
	case CVGenDoneMsg:
		if msg.Err != nil {
			m.cvGenStatus[msg.AppKey] = "error"
		} else {
			// Don't flip to "done" here — main will auto-chain the review
			// phase immediately, which will set the status to "reviewing".
			// If no auto-chain happens (edge case), the row stays in
			// "generating" until next refresh; fine for now.
			m.cvGenStatus[msg.AppKey] = "done"
		}
		return m, nil
	case ReviewStartedMsg:
		m.cvGenStatus[msg.AppKey] = "reviewing"
		return m, nil
	case ReviewDoneMsg:
		if msg.Err != nil {
			// Review failed (Gemini unreachable, bad JSON, etc.). Leave the
			// CV without a PDF and surface error state — user can press F to
			// retry review manually.
			m.cvGenStatus[msg.AppKey] = "error"
		} else {
			// Main inspects the JSON file on disk to decide between
			// auto-render and review-pending; status here is set by the
			// dedicated messages it emits next.
			m.cvGenStatus[msg.AppKey] = "review-pending"
		}
		return m, nil
	case RenderPDFRequestedMsg:
		m.cvGenStatus[msg.AppKey] = "rendering"
		return m, nil
	case PDFRenderedMsg:
		if msg.Err != nil {
			m.cvGenStatus[msg.AppKey] = "error"
		} else {
			m.cvGenStatus[msg.AppKey] = "done"
		}
		return m, nil
	}
	return m, nil
}

func (m PipelineModel) handleKey(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		return m, func() tea.Msg { return PipelineClosedMsg{} }

	case "down", "j":
		if m.onProgressTab() {
			m.scrollOffset++
			return m, nil
		}
		if len(m.filtered) > 0 {
			m.cursor++
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "up", "k":
		if m.onProgressTab() {
			if m.scrollOffset > 0 {
				m.scrollOffset--
			}
			return m, nil
		}
		if len(m.filtered) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "s":
		// Cycle sort mode
		for i, s := range sortCycle {
			if s == m.sortMode {
				m.sortMode = sortCycle[(i+1)%len(sortCycle)]
				break
			}
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "f":
		// Open the search input. Existing query (if any) is preserved so the
		// user can refine; Esc clears it.
		m.searchEditing = true
		return m, nil

	case "right", "l":
		prev := m.activeTab
		m.activeTab++
		if m.activeTab >= len(pipelineTabs) {
			m.activeTab = 0
		}
		if pipelineTabs[m.activeTab].filter == filterCV {
			m.prevTabBeforeCV = prev
			path := m.careerOpsPath
			return m, func() tea.Msg { return PipelineOpenCVMsg{CareerOpsPath: path} }
		}
		m.clearSearch()
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "left", "h":
		prev := m.activeTab
		m.activeTab--
		if m.activeTab < 0 {
			m.activeTab = len(pipelineTabs) - 1
		}
		if pipelineTabs[m.activeTab].filter == filterCV {
			m.prevTabBeforeCV = prev
			path := m.careerOpsPath
			return m, func() tea.Msg { return PipelineOpenCVMsg{CareerOpsPath: path} }
		}
		m.clearSearch()
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "v":
		if m.viewMode == "grouped" {
			m.viewMode = "flat"
		} else {
			m.viewMode = "grouped"
		}

	case "enter":
		if app, ok := m.CurrentApp(); ok && app.ReportPath != "" {
			// If there's a pending CV review for this row, open the review
			// walkthrough first — the user needs to deal with findings before
			// reading the report. Main handles the walkthrough via ExecProcess
			// and then opens the report once it exits.
			if hasPendingReview(m.careerOpsPath, app) {
				careerOpsPath := m.careerOpsPath
				return m, func() tea.Msg {
					return PipelineFactCheckMsg{
						CareerOpsPath:   careerOpsPath,
						App:             app,
						OpenReportAfter: true,
					}
				}
			}
			fullPath := filepath.Join(m.careerOpsPath, app.ReportPath)
			title := fmt.Sprintf("%s — %s", app.Company, app.Role)
			jobURL := app.JobURL
			return m, func() tea.Msg {
				return PipelineOpenReportMsg{Path: fullPath, Title: title, JobURL: jobURL}
			}
		}

	case "o":
		if app, ok := m.CurrentApp(); ok && app.JobURL != "" {
			return m, func() tea.Msg {
				return PipelineOpenURLMsg{URL: app.JobURL}
			}
		}

	case "a":
		if app, ok := m.CurrentApp(); ok {
			path := m.careerOpsPath
			return m, func() tea.Msg {
				return PipelineApplyMsg{CareerOpsPath: path, App: app}
			}
		}

	case "r":
		return m, func() tea.Msg { return PipelineRefreshMsg{} }

	case "m":
		if m.metrics.ByStatus["fetched"] > 0 {
			path := m.careerOpsPath
			return m, func() tea.Msg {
				return PipelineMergeMsg{CareerOpsPath: path}
			}
		}

	case "c":
		if len(m.filtered) > 0 {
			m.statusPicker = true
			m.statusCursor = 0
		}

	case "d":
		if app, ok := m.CurrentApp(); ok {
			path := m.careerOpsPath
			return m, func() tea.Msg {
				return PipelineUpdateStatusMsg{
					CareerOpsPath: path,
					App:           app,
					NewStatus:     "Discarded",
				}
			}
		}

	case "p":
		// Bulk prune: open the confirm modal seeded at the default cutoff.
		// Only offered on list tabs (the modal overlays the row body) and when
		// at least one scored, non-committed row exists.
		if !m.onProgressTab() && len(data.AppsBelowScore(m.apps, maxPruneThreshold)) > 0 {
			m.pruneConfirm = true
			m.pruneThreshold = defaultPruneThreshold
		}

	case "g":
		if app, ok := m.CurrentApp(); ok {
			path := m.careerOpsPath
			return m, func() tea.Msg {
				return PipelineGenerateCVMsg{CareerOpsPath: path, App: app}
			}
		}

	case "G":
		if len(m.filtered) > 0 {
			m.cursor = len(m.filtered) - 1
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "pgdown", "ctrl+d":
		if len(m.filtered) > 0 {
			halfPage := m.height / 2
			if halfPage < 1 {
				halfPage = 1
			}
			m.cursor += halfPage
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "pgup", "ctrl+u":
		if len(m.filtered) > 0 {
			halfPage := m.height / 2
			if halfPage < 1 {
				halfPage = 1
			}
			m.cursor -= halfPage
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}
	}

	return m, nil
}

func (m PipelineModel) handleStatusPicker(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.statusPicker = false
		return m, nil

	case "down", "j":
		m.statusCursor++
		if m.statusCursor >= len(statusOptions) {
			m.statusCursor = len(statusOptions) - 1
		}

	case "up", "k":
		m.statusCursor--
		if m.statusCursor < 0 {
			m.statusCursor = 0
		}

	case "enter":
		m.statusPicker = false
		if app, ok := m.CurrentApp(); ok {
			newStatus := statusOptions[m.statusCursor]
			return m, func() tea.Msg {
				return PipelineUpdateStatusMsg{
					CareerOpsPath: m.careerOpsPath,
					App:           app,
					NewStatus:     newStatus,
				}
			}
		}
	}
	return m, nil
}

// handlePruneConfirm captures keys while the bulk-prune modal is open. ↑/↓
// nudge the score cutoff within bounds; Enter discards every matching row; Esc
// cancels without touching anything.
func (m PipelineModel) handlePruneConfirm(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.pruneConfirm = false
		return m, nil

	case "up", "k":
		m.pruneThreshold += pruneThresholdStep
		if m.pruneThreshold > maxPruneThreshold {
			m.pruneThreshold = maxPruneThreshold
		}

	case "down", "j":
		m.pruneThreshold -= pruneThresholdStep
		if m.pruneThreshold < minPruneThreshold {
			m.pruneThreshold = minPruneThreshold
		}

	case "enter":
		m.pruneConfirm = false
		path := m.careerOpsPath
		threshold := m.pruneThreshold
		if len(data.AppsBelowScore(m.apps, threshold)) == 0 {
			return m, nil
		}
		return m, func() tea.Msg {
			return PipelinePruneMsg{CareerOpsPath: path, Threshold: threshold}
		}
	}
	return m, nil
}

// handleSearchInput captures keys while the search input is focused. Esc
// clears the query and exits the bar; Enter commits and exits the bar while
// keeping the filter active; printable runes/backspace edit the query and
// re-narrow the visible rows live.
func (m PipelineModel) handleSearchInput(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.searchEditing = false
		m.searchQuery = ""
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0
		return m, m.loadCurrentReport()

	case "enter":
		m.searchEditing = false
		return m, nil

	case "backspace":
		if r := []rune(m.searchQuery); len(r) > 0 {
			m.searchQuery = string(r[:len(r)-1])
			m.applyFilterAndSort()
			m.cursor = 0
			m.scrollOffset = 0
			return m, m.loadCurrentReport()
		}
		return m, nil

	default:
		if len(msg.Runes) == 0 {
			return m, nil
		}
		m.searchQuery += string(msg.Runes)
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0
		return m, m.loadCurrentReport()
	}
}

// clearSearch resets search state without re-applying the filter (the caller
// runs applyFilterAndSort itself).
func (m *PipelineModel) clearSearch() {
	m.searchEditing = false
	m.searchQuery = ""
}

func (m PipelineModel) loadCurrentReport() tea.Cmd {
	app, ok := m.CurrentApp()
	if !ok || app.ReportPath == "" {
		return nil
	}
	if _, cached := m.reportCache[app.ReportPath]; cached {
		return nil
	}
	path := m.careerOpsPath
	report := app.ReportPath
	return func() tea.Msg {
		return PipelineLoadReportMsg{CareerOpsPath: path, ReportPath: report}
	}
}

// applyFilterAndSort rebuilds the filtered list from apps.
func (m *PipelineModel) applyFilterAndSort() {
	var filtered []model.CareerApplication

	currentFilter := pipelineTabs[m.activeTab].filter
	for _, app := range m.apps {
		norm := data.NormalizeStatus(app.Status)
		switch currentFilter {
		case filterProgress, filterCV:
			// Pseudo-tabs — open dedicated screens, never list rows.
		case filterPriority:
			if norm == filterEvaluated && app.Score >= priorityThreshold {
				filtered = append(filtered, app)
			}
		case filterSkip:
			if norm == "skip" || norm == "skipped-location" {
				filtered = append(filtered, app)
			}
		default:
			if norm == currentFilter {
				filtered = append(filtered, app)
			}
		}
	}

	// Narrow further by the search query (case-insensitive substring against
	// company name or 3-digit ID). Empty query is a no-op.
	if q := strings.ToLower(strings.TrimSpace(m.searchQuery)); q != "" {
		var matched []model.CareerApplication
		for _, app := range filtered {
			if strings.Contains(strings.ToLower(app.Company), q) ||
				strings.Contains(app.ReportNumber, q) {
				matched = append(matched, app)
			}
		}
		filtered = matched
	}

	// Sort
	switch m.sortMode {
	case sortScore:
		sort.SliceStable(filtered, func(i, j int) bool {
			return filtered[i].Score > filtered[j].Score
		})
	case sortDate:
		sort.SliceStable(filtered, func(i, j int) bool {
			return filtered[i].Date > filtered[j].Date
		})
	case sortCompany:
		sort.SliceStable(filtered, func(i, j int) bool {
			return strings.ToLower(filtered[i].Company) < strings.ToLower(filtered[j].Company)
		})
	case sortStatus:
		sort.SliceStable(filtered, func(i, j int) bool {
			return data.StatusPriority(filtered[i].Status) < data.StatusPriority(filtered[j].Status)
		})
	}

	// In grouped mode, always sort by status priority first, then by selected sort within groups
	if m.viewMode == "grouped" {
		sort.SliceStable(filtered, func(i, j int) bool {
			pi := data.StatusPriority(filtered[i].Status)
			pj := data.StatusPriority(filtered[j].Status)
			if pi != pj {
				return pi < pj
			}
			// Within same group, use selected sort
			switch m.sortMode {
			case sortScore:
				return filtered[i].Score > filtered[j].Score
			case sortDate:
				return filtered[i].Date > filtered[j].Date
			case sortCompany:
				return strings.ToLower(filtered[i].Company) < strings.ToLower(filtered[j].Company)
			default:
				return filtered[i].Score > filtered[j].Score
			}
		})
	}

	m.filtered = filtered
}

// adjustScroll updates scrollOffset so the cursor stays visible.
func (m *PipelineModel) adjustScroll() {
	availHeight := m.height - 10 // tabs(2) + help(2) + preview
	if availHeight < 5 {
		availHeight = 5
	}
	line := m.cursorLineEstimate()
	margin := 3

	if line >= m.scrollOffset+availHeight-margin {
		m.scrollOffset = line - availHeight + margin + 1
	}
	if line < m.scrollOffset+margin {
		m.scrollOffset = line - margin
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

func (m PipelineModel) cursorLineEstimate() int {
	if m.viewMode != "grouped" {
		return m.cursor
	}
	// Account for group headers
	line := 0
	prevStatus := ""
	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)
		if norm != prevStatus {
			line++ // group header
			prevStatus = norm
		}
		if i == m.cursor {
			return line
		}
		line++
	}
	return line
}

// -- View --

// View renders the pipeline screen.
func (m PipelineModel) View() string {
	tabs := m.renderTabs()

	// PROGRESS tab: analytics rendered inline under the still-visible tab bar.
	// No preview pane, no footer/help line — just the charts.
	if m.onProgressTab() {
		body := m.renderProgressBody()
		bodyLines := strings.Split(body, "\n")
		if m.scrollOffset > 0 && m.scrollOffset < len(bodyLines) {
			bodyLines = bodyLines[m.scrollOffset:]
		}
		availHeight := m.height - 3 // tabs(2) + padding
		if availHeight < 3 {
			availHeight = 3
		}
		if len(bodyLines) > availHeight {
			bodyLines = bodyLines[:availHeight]
		}
		return lipgloss.JoinVertical(lipgloss.Left, tabs, strings.Join(bodyLines, "\n"))
	}

	body := m.renderBody()
	preview := m.renderPreview()
	help := m.renderHelp()
	searchBar := m.renderSearchBar()

	// Apply scroll to body
	bodyLines := strings.Split(body, "\n")
	if m.scrollOffset > 0 && m.scrollOffset < len(bodyLines) {
		bodyLines = bodyLines[m.scrollOffset:]
	}

	// Calculate available height for body. tabs(2) + help(2) + preview, plus
	// one line for the search bar when it is rendered.
	previewLines := strings.Count(preview, "\n") + 1
	availHeight := m.height - 5 - previewLines
	if searchBar != "" {
		availHeight--
	}
	if availHeight < 3 {
		availHeight = 3
	}
	if len(bodyLines) > availHeight {
		bodyLines = bodyLines[:availHeight]
	}
	body = strings.Join(bodyLines, "\n")

	// Status picker overlay
	if m.statusPicker {
		body = m.overlayStatusPicker(body)
	}
	if m.pruneConfirm {
		body = m.overlayPruneConfirm(body)
	}

	parts := []string{tabs}
	if searchBar != "" {
		parts = append(parts, searchBar)
	}
	parts = append(parts, body, preview, help)
	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

// renderSearchBar returns a single-line table header showing the search
// input. Empty string when no query and not editing — the row collapses out
// of the layout entirely so steady-state pixels are unchanged.
func (m PipelineModel) renderSearchBar() string {
	if !m.searchEditing && m.searchQuery == "" {
		return ""
	}
	cursor := ""
	if m.searchEditing {
		cursor = "█"
	}
	labelStyle := lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	valueStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	hintStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	line := labelStyle.Render("Find: ") + valueStyle.Render(m.searchQuery+cursor)
	if m.searchEditing {
		line += hintStyle.Render("    Enter commit · Esc clear")
	} else {
		matched := len(m.filtered)
		line += hintStyle.Render(fmt.Sprintf("    %d match", matched))
		if matched != 1 {
			line += hintStyle.Render("es")
		}
	}
	return lipgloss.NewStyle().Padding(0, 2).Render(line)
}

func (m PipelineModel) renderTabs() string {
	return renderPipelineTabBar(m.theme, pipelineTabs[m.activeTab].filter, m.width, m.TabCounts())
}

// TabCounts returns a snapshot of the per-filter row counts the tab bar shows.
// CV editor grabs this at construction time so it can render the same tab
// strip with the same numbers while the editor owns the screen.
func (m PipelineModel) TabCounts() map[string]int {
	counts := make(map[string]int, len(pipelineTabs))
	for _, tab := range pipelineTabs {
		counts[tab.filter] = m.countForFilter(tab.filter)
	}
	return counts
}

// renderPipelineTabBar renders the tab strip with `activeFilter` highlighted.
// Shared between the pipeline screen (which owns the active filter) and the CV
// editor (which always renders CV as active). Counts is a lookup by filter
// name — pseudo-tabs (progress, cv) intentionally don't display counts.
func renderPipelineTabBar(t theme.Theme, activeFilter string, width int, counts map[string]int) string {
	var tabs []string
	var underParts []string

	for _, tab := range pipelineTabs {
		label := fmt.Sprintf(" %s ", tab.label)
		if tab.filter != filterProgress && tab.filter != filterCV {
			label = fmt.Sprintf(" %s (%d) ", tab.label, counts[tab.filter])
		}

		if tab.filter == activeFilter {
			style := lipgloss.NewStyle().
				Bold(true).
				Foreground(t.Blue).
				Padding(0, 0)
			tabs = append(tabs, style.Render(label))
			underParts = append(underParts, strings.Repeat("━", lipgloss.Width(label)))
		} else {
			style := lipgloss.NewStyle().
				Foreground(t.Subtext).
				Padding(0, 0)
			tabs = append(tabs, style.Render(label))
			underParts = append(underParts, strings.Repeat("─", lipgloss.Width(label)))
		}
	}

	row := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)
	underlineRaw := strings.Join(underParts, "")
	// Extend the underline to the full terminal width so it matches the
	// bottom bar.
	if pad := width - 2 - lipgloss.Width(underlineRaw); pad > 0 {
		underlineRaw += strings.Repeat("─", pad)
	}
	underline := lipgloss.NewStyle().Foreground(t.Overlay).Render(underlineRaw)

	padStyle := lipgloss.NewStyle().Padding(0, 1)
	return padStyle.Render(row) + "\n" + padStyle.Render(underline)
}

// onProgressTab reports whether the PROGRESS pseudo-tab is currently active.
func (m PipelineModel) onProgressTab() bool {
	return pipelineTabs[m.activeTab].filter == filterProgress
}

// renderProgressBody renders the analytics panels inline as the tab body,
// reusing the progress screen's panel renderers. No header, no footer, no
// summary — just the funnel/score/rate/weekly charts under the tab bar.
func (m PipelineModel) renderProgressBody() string {
	pm := ProgressModel{
		metrics: data.ComputeProgressMetrics(m.apps),
		width:   m.width,
		height:  m.height,
		theme:   m.theme,
	}
	return lipgloss.JoinVertical(lipgloss.Left,
		pm.renderFunnel(),
		"",
		pm.renderScoreDistribution(),
		"",
		pm.renderRates(),
		"",
		pm.renderWeeklyActivity(),
	)
}

func (m PipelineModel) countForFilter(filter string) int {
	count := 0
	for _, app := range m.apps {
		norm := data.NormalizeStatus(app.Status)
		switch filter {
		case filterProgress, filterCV:
			return 0
		case filterPriority:
			if norm == filterEvaluated && app.Score >= priorityThreshold {
				count++
			}
		case filterSkip:
			if norm == "skip" || norm == "skipped-location" {
				count++
			}
		default:
			if norm == filter {
				count++
			}
		}
	}
	return count
}

func (m PipelineModel) renderBody() string {
	if len(m.filtered) == 0 {
		emptyStyle := lipgloss.NewStyle().
			Foreground(m.theme.Subtext).
			Padding(1, 2)
		return emptyStyle.Render("No offers match this filter")
	}

	var lines []string
	prevStatus := ""
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)

		// Group header in grouped mode
		if m.viewMode == "grouped" && norm != prevStatus {
			count := m.countByNormStatus(norm)
			headerStyle := lipgloss.NewStyle().
				Bold(true).
				Foreground(m.theme.Subtext)
			prefix := fmt.Sprintf("── %s (%d) ", strings.ToUpper(statusLabel(norm)), count)
			fillWidth := m.width - 4 - lipgloss.Width(prefix) // 4 = padStyle padding (2 left + 2 right)
			if fillWidth < 0 {
				fillWidth = 0
			}
			lines = append(lines, padStyle.Render(
				headerStyle.Render(prefix+strings.Repeat("─", fillWidth)),
			))
			prevStatus = norm
		}

		selected := i == m.cursor
		line := m.renderAppLine(app, selected)
		lines = append(lines, line)
	}

	return strings.Join(lines, "\n")
}

func (m PipelineModel) renderAppLine(app model.CareerApplication, selected bool) string {
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	// Column widths
	numW := 4
	scoreW := 5
	dateW := 5 // MM/DD
	companyW := 16
	statusW := 12
	cvW := 7 // "Gen…" / "Rev…" / "Review" / "PDF ✓" / "PDF ✗" + 1 trailing pad
	// Role gets remaining space (scoreW + dateW + numW + companyW + statusW + cvW + 7 separators/padding)
	roleW := m.width - numW - scoreW - dateW - companyW - statusW - cvW - 11
	if roleW < 15 {
		roleW = 15
	}

	// Apply selection background to every column so the whole row highlights.
	withBg := func(s lipgloss.Style) lipgloss.Style {
		if selected {
			return s.Background(m.theme.Overlay)
		}
		return s
	}
	sep := " "
	if selected {
		sep = lipgloss.NewStyle().Background(m.theme.Overlay).Render(" ")
	}

	numText := app.ReportNumber
	if numText == "" {
		numText = "—"
	}
	numStyle := withBg(lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(numW).Align(lipgloss.Right))

	scoreStyle := withBg(m.scoreStyle(app.Score).Width(scoreW))
	score := scoreStyle.Render(fmt.Sprintf("%.1f", app.Score))

	dateText := formatDateMMDD(app.Date)
	if dateText == "" {
		dateText = "—"
	}
	dateStyle := withBg(lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(dateW))

	company := truncateRunes(app.Company, companyW)
	companyStyle := withBg(lipgloss.NewStyle().Foreground(m.theme.Text).Width(companyW))

	role := truncateRunes(app.Role, roleW)
	roleStyle := withBg(lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(roleW))

	norm := data.NormalizeStatus(app.Status)
	statusColor := m.statusColorMap()[norm]
	statusStyle := withBg(lipgloss.NewStyle().Foreground(statusColor).Width(statusW))
	statusText := statusStyle.Render(statusLabel(norm))

	cvBase := withBg(lipgloss.NewStyle().Width(cvW))
	cvText := cvBase.Render("")
	switch m.cvGenStatus[appKey(app)] {
	case "generating":
		cvText = withBg(lipgloss.NewStyle().Foreground(m.theme.Yellow).Width(cvW)).Render("Gen…")
	case "reviewing":
		cvText = withBg(lipgloss.NewStyle().Foreground(m.theme.Yellow).Width(cvW)).Render("Rev…")
	case "review-pending":
		cvText = withBg(lipgloss.NewStyle().Foreground(m.theme.Blue).Width(cvW)).Render("Review")
	case "rendering":
		cvText = withBg(lipgloss.NewStyle().Foreground(m.theme.Yellow).Width(cvW)).Render("PDF…")
	case "done":
		cvText = withBg(lipgloss.NewStyle().Foreground(m.theme.Green).Width(cvW)).Render("PDF ✓")
	case "error":
		cvText = withBg(lipgloss.NewStyle().Foreground(m.theme.Red).Width(cvW)).Render("PDF ✗")
	}

	line := sep + score + sep +
		dateStyle.Render(truncateRunes(dateText, dateW)) + sep +
		numStyle.Render(truncateRunes(numText, numW)) + sep +
		companyStyle.Render(company) + sep +
		roleStyle.Render(role) + sep +
		statusText + sep + cvText

	if selected {
		rowStyle := lipgloss.NewStyle().Background(m.theme.Overlay).Width(m.width - 4)
		return padStyle.Render(rowStyle.Render(line))
	}
	return padStyle.Render(line)
}

func (m PipelineModel) renderPreview() string {
	app, ok := m.CurrentApp()
	if !ok {
		return ""
	}

	padStyle := lipgloss.NewStyle().Padding(0, 2)
	divider := lipgloss.NewStyle().Foreground(m.theme.Overlay)

	var lines []string
	lines = append(lines, padStyle.Render(divider.Render(strings.Repeat("─", m.width-4))))

	labelStyle := lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	valueStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	// Check report cache — only treat as populated when at least one field is non-empty.
	cached, ok := m.reportCache[app.ReportPath]
	hasCached := ok && (cached.summary != "" || cached.location != "")
	if hasCached {
		if cached.summary != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Summary: ")+valueStyle.Render(cached.summary)))
		}
		if cached.location != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Location: ")+valueStyle.Render(cached.location)))
		}
	} else if app.Notes != "" {
		// Fallback: show notes
		notes := truncateRunes(app.Notes, m.width-10)
		lines = append(lines, padStyle.Render(dimStyle.Render(notes)))
	} else if app.ReportPath != "" {
		lines = append(lines, padStyle.Render(dimStyle.Render("Loading preview...")))
	} else {
		lines = append(lines, padStyle.Render(dimStyle.Render("No report yet")))
	}

	return strings.Join(lines, "\n")
}

func (m PipelineModel) renderHelp() string {
	rowStyle := lipgloss.NewStyle().Padding(0, 1)

	hotkey := lipgloss.NewStyle().Foreground(m.theme.Blue).Underline(true)
	text := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	separator := lipgloss.NewStyle().
		Foreground(m.theme.Overlay).
		Padding(0, 1).
		Render(strings.Repeat("─", max(0, m.width-2)))

	if m.statusPicker {
		hint := func(prefix, key, suffix string) string {
			return text.Render(prefix) + hotkey.Render(key) + text.Render(suffix)
		}
		return separator + "\n" + rowStyle.Render(strings.Join([]string{
			text.Render("↑↓/jk navigate"),
			hint("", "Enter", " confirm"),
			hint("", "Esc", " cancel"),
		}, "  "))
	}

	if m.pruneConfirm {
		hint := func(prefix, key, suffix string) string {
			return text.Render(prefix) + hotkey.Render(key) + text.Render(suffix)
		}
		return separator + "\n" + rowStyle.Render(strings.Join([]string{
			text.Render("↑↓/jk score"),
			hint("", "Enter", " discard"),
			hint("", "Esc", " cancel"),
		}, "  "))
	}

	hint := func(prefix, key, suffix string) string {
		return text.Render(prefix) + hotkey.Render(key) + text.Render(suffix)
	}

	hintParts := []string{
		hint("", "o", "pen"),
		hint("", "a", "pply"),
		hint("", "c", "hange"),
		hint("", "d", "iscard"),
		hint("", "p", "rune"),
		hint("", "g", "enerate CV"),
		hint("", "f", "ind"),
		hint("", "r", "efresh"),
	}
	if fetchedCount := m.metrics.ByStatus["fetched"]; fetchedCount > 0 {
		hintParts = append(hintParts, hint("", "m", fmt.Sprintf("erge (%d)", fetchedCount)))
	}
	hints := strings.Join(hintParts, "  ")

	sortLabel := text.Render("[") + hotkey.Render("s") + text.Render(fmt.Sprintf("ort: %s]", m.sortMode))
	viewLabel := text.Render("[") + hotkey.Render("v") + text.Render(fmt.Sprintf("iew: %s]", m.viewMode))
	right := sortLabel + "  " + viewLabel

	leading := " " + hints
	gap := m.width - 2 - lipgloss.Width(leading) - lipgloss.Width(right)
	if gap < 1 {
		gap = 1
	}

	return separator + "\n" + rowStyle.Render(leading+strings.Repeat(" ", gap)+right)
}

func (m PipelineModel) overlayStatusPicker(body string) string {
	bodyLines := strings.Split(body, "\n")
	bodyHeight := len(bodyLines)
	if bodyHeight < 1 {
		bodyHeight = 1
	}

	itemWidth := 22

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue)
	itemStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Width(itemWidth)
	selectedStyle := lipgloss.NewStyle().
		Foreground(m.theme.Base).
		Background(m.theme.Blue).
		Bold(true).
		Width(itemWidth)
	hintStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	var rows []string
	rows = append(rows, titleStyle.Render("Change status"))
	rows = append(rows, "")
	for i, opt := range statusOptions {
		prefix := "  "
		if i == m.statusCursor {
			prefix = "▸ "
			rows = append(rows, selectedStyle.Render(prefix+opt))
		} else {
			rows = append(rows, itemStyle.Render(prefix+opt))
		}
	}
	rows = append(rows, "")
	rows = append(rows, hintStyle.Render("↑↓ select  Enter confirm  Esc close"))

	modal := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(m.theme.Blue).
		Background(m.theme.Surface).
		Padding(1, 2).
		Render(strings.Join(rows, "\n"))

	return lipgloss.Place(m.width, bodyHeight, lipgloss.Center, lipgloss.Center, modal)
}

func (m PipelineModel) overlayPruneConfirm(body string) string {
	bodyLines := strings.Split(body, "\n")
	bodyHeight := len(bodyLines)
	if bodyHeight < 1 {
		bodyHeight = 1
	}

	count := len(data.AppsBelowScore(m.apps, m.pruneThreshold))

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Red)
	textStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	emphStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)
	hintStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	var rows []string
	rows = append(rows, titleStyle.Render("Prune low-scoring apps"))
	rows = append(rows, "")
	rows = append(rows, textStyle.Render("Discard score < ")+emphStyle.Render(fmt.Sprintf("%.1f", m.pruneThreshold)))
	if count == 0 {
		rows = append(rows, hintStyle.Render("Nothing to discard at this score."))
	} else {
		rows = append(rows, textStyle.Render("Will discard ")+emphStyle.Render(fmt.Sprintf("%d", count))+textStyle.Render(" evaluated app(s)."))
	}
	rows = append(rows, "")
	rows = append(rows, hintStyle.Render("↑↓ score  Enter confirm  Esc cancel"))

	modal := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(m.theme.Red).
		Background(m.theme.Surface).
		Padding(1, 2).
		Render(strings.Join(rows, "\n"))

	return lipgloss.Place(m.width, bodyHeight, lipgloss.Center, lipgloss.Center, modal)
}

// -- Helpers --

func (m PipelineModel) scoreStyle(score float64) lipgloss.Style {
	switch {
	case score >= 4.0:
		return lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true)
	case score >= 3.5:
		return lipgloss.NewStyle().Foreground(m.theme.Yellow)
	case score >= 3.0:
		return lipgloss.NewStyle().Foreground(m.theme.Text)
	default:
		return lipgloss.NewStyle().Foreground(m.theme.Red)
	}
}

func (m PipelineModel) statusColorMap() map[string]lipgloss.Color {
	return map[string]lipgloss.Color{
		"interview":        m.theme.Green,
		"offer":            m.theme.Green,
		"applied":          m.theme.Sky,
		"responded":        m.theme.Blue,
		"evaluated":        m.theme.Text,
		"fetched":          m.theme.Yellow,
		"skipped-location": m.theme.Subtext,
		"skip":             m.theme.Red,
		"rejected":         m.theme.Subtext,
		"discarded":        m.theme.Subtext,
	}
}

func (m PipelineModel) countByNormStatus(status string) int {
	count := 0
	for _, app := range m.filtered {
		if data.NormalizeStatus(app.Status) == status {
			count++
		}
	}
	return count
}

// appKey returns a stable unique key for tracking per-app state.
func appKey(app model.CareerApplication) string {
	if app.ReportPath != "" {
		return app.ReportPath
	}
	return app.Company + "/" + app.Role
}

// formatDateMMDD converts a YYYY-MM-DD date to MM/DD for display. Returns the
// input unchanged if it doesn't match the expected prefix.
func formatDateMMDD(date string) string {
	if len(date) < 10 || date[4] != '-' || date[7] != '-' {
		return date
	}
	return date[5:7] + "/" + date[8:10]
}

// truncateRunes truncates a string to at most maxRunes runes, appending "..." if truncated.
func truncateRunes(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	if maxRunes <= 3 {
		return string(runes[:maxRunes])
	}
	return string(runes[:maxRunes-3]) + "..."
}

func statusLabel(norm string) string {
	switch norm {
	case "interview":
		return "Interview"
	case "offer":
		return "Offer"
	case "responded":
		return "Responded"
	case "applied":
		return "Applied"
	case "evaluated":
		return "Evaluated"
	case "fetched":
		return "Fetched"
	case "skipped-location":
		return "LocSkip"
	case "skip":
		return "Skip"
	case "rejected":
		return "Rejected"
	case "discarded":
		return "Discarded"
	default:
		return norm
	}
}
