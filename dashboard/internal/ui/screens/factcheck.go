package screens

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"career-ops/dashboard/internal/model"
	"career-ops/dashboard/internal/theme"
)

// FactCheckClosedMsg fires when the user quits the screen with q/Esc without
// finalizing. The review JSON is preserved on disk so the next session can
// resume the walkthrough.
type FactCheckClosedMsg struct {
	AppKey          string
	App             model.CareerApplication
	OpenReportAfter bool
}

// FactCheckFinalizeMsg fires when the user confirms `f` finalize. The review
// JSON has been deleted by the screen; main is responsible for triggering PDF
// render and refreshing the row status.
type FactCheckFinalizeMsg struct {
	AppKey          string
	App             model.CareerApplication
	CVPath          string
	OpenReportAfter bool
}

// findingState is the per-finding lifecycle within the screen.
type findingState int

const (
	fsPending findingState = iota
	fsApplied
	fsEdited
	fsRejected
	fsStale // generated_text no longer in CV (already-handled on resume)
)

// finding mirrors one entry in the review JSON plus a derived in-memory state.
type finding struct {
	ID            string
	Severity      string // "fabricated" | "stretched"
	Section       string
	GeneratedText string
	SourceCV      string
	Issue         string
	ProposedFix   string

	State findingState
	// AppliedText is the replacement currently in the CV markdown (proposed_fix
	// for `apply`, user input for `edit`). Empty otherwise.
	AppliedText string
}

// reviewFile mirrors the on-disk JSON.
type reviewFile struct {
	Findings []reviewFinding `json:"findings"`
	Summary  reviewSummary   `json:"summary"`
}

type reviewFinding struct {
	ID            string `json:"id"`
	Severity      string `json:"severity"`
	Section       string `json:"section"`
	GeneratedText string `json:"generated_text"`
	SourceCV      string `json:"source_cv_evidence"`
	Issue         string `json:"issue"`
	ProposedFix   string `json:"proposed_fix"`
}

type reviewSummary struct {
	FabricatedCount int    `json:"fabricated_count"`
	StretchedCount  int    `json:"stretched_count"`
	OverallVerdict  string `json:"overall_verdict"`
}

// FactCheckModel is the split-view review screen.
type FactCheckModel struct {
	cvPath         string
	reviewJSONPath string
	careerOpsPath  string
	title          string
	appKey         string
	app            model.CareerApplication

	cvContent      string
	findings       []finding
	overallVerdict string

	cursor           int
	leftScrollOffset int

	// visualLines is cvContent split by logical \n, then word-wrapped to fit
	// the left pane width. Recomputed on resize and after every CV mutation.
	visualLines []string
	// visualOrigin[i] is the logical-line index that visualLines[i] came from.
	visualOrigin []int
	// findingBlocks[k] is the [startLogical, endLogical) range of the
	// paragraph/bullet that contains finding k's match. (-1, -1) when no
	// match was found (e.g., stale).
	findingBlocks [][2]int
	wrappedWidth  int // width used to compute the cache (invalidation key)

	editing  bool
	editArea textarea.Model
	// editingOriginalBlock is the snapshot of the paragraph/bullet that was
	// loaded into the textarea when `e` was pressed. On apply we replace this
	// exact text in the CV — not the narrow generated_text — so the user can
	// rewrite the whole sentence context, not just the flagged phrase.
	editingOriginalBlock string

	confirmingFinalize bool

	openReportAfter bool

	width, height int
	theme         theme.Theme

	loadErr string
}

// NewFactCheckModel builds the model. If loading fails the screen renders an
// error and only `q`/`Esc` are active.
func NewFactCheckModel(
	t theme.Theme,
	careerOpsPath, cvPath, reviewJSONPath, title, appKey string,
	app model.CareerApplication,
	openReportAfter bool,
	width, height int,
) FactCheckModel {
	ta := textarea.New()
	ta.Prompt = ""
	ta.ShowLineNumbers = false
	ta.CharLimit = 0 // unlimited
	ta.FocusedStyle.Base = ta.FocusedStyle.Base.
		Border(lipgloss.RoundedBorder()).
		BorderForeground(t.Sky)
	ta.BlurredStyle.Base = ta.BlurredStyle.Base.
		Border(lipgloss.RoundedBorder()).
		BorderForeground(t.Overlay)
	ta.SetWidth(40) // adjusted in NewFactCheckModel and on resize
	ta.SetHeight(8) // adjusted on resize to fit the right pane
	ta.Blur()

	m := FactCheckModel{
		cvPath:          cvPath,
		reviewJSONPath:  reviewJSONPath,
		careerOpsPath:   careerOpsPath,
		title:           title,
		appKey:          appKey,
		app:             app,
		openReportAfter: openReportAfter,
		width:           width,
		height:          height,
		theme:           t,
		editArea:        ta,
	}

	cvBytes, err := os.ReadFile(cvPath)
	if err != nil {
		m.loadErr = "Could not read CV markdown: " + err.Error()
		return m
	}
	m.cvContent = string(cvBytes)

	jsonBytes, err := os.ReadFile(reviewJSONPath)
	if err != nil {
		m.loadErr = "Could not read review JSON: " + err.Error()
		return m
	}
	var rf reviewFile
	if err := json.Unmarshal(jsonBytes, &rf); err != nil {
		m.loadErr = "Review JSON is malformed: " + err.Error()
		return m
	}

	m.overallVerdict = rf.Summary.OverallVerdict
	for _, rfd := range rf.Findings {
		f := finding{
			ID:            rfd.ID,
			Severity:      rfd.Severity,
			Section:       rfd.Section,
			GeneratedText: rfd.GeneratedText,
			SourceCV:      rfd.SourceCV,
			Issue:         rfd.Issue,
			ProposedFix:   rfd.ProposedFix,
		}
		if strings.Contains(m.cvContent, rfd.GeneratedText) {
			f.State = fsPending
		} else {
			f.State = fsStale
		}
		m.findings = append(m.findings, f)
	}

	m.recomputeVisualLines()
	m.scrollToActive()
	taW := m.rightWidth() - 2
	if taW < 10 {
		taW = 10
	}
	m.editArea.SetWidth(taW)
	return m
}

// Resize updates terminal dimensions.
func (m *FactCheckModel) Resize(width, height int) {
	m.width = width
	m.height = height
	m.recomputeVisualLines()
	m.scrollToActive()
	taW := m.rightWidth() - 4
	if taW < 10 {
		taW = 10
	}
	m.editArea.SetWidth(taW)
}

// Init satisfies tea.Model.
func (m FactCheckModel) Init() tea.Cmd { return nil }

// Update handles input.
func (m FactCheckModel) Update(msg tea.Msg) (FactCheckModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.recomputeVisualLines()
		m.scrollToActive()
		taW := m.rightWidth() - 2 // outer Padding(0,1) on the pane
		if taW < 10 {
			taW = 10
		}
		m.editArea.SetWidth(taW)
		return m, nil
	case tea.KeyMsg:
		if m.confirmingFinalize {
			return m.handleFinalizeConfirm(msg)
		}
		if m.editing {
			return m.handleEdit(msg)
		}
		return m.handleKey(msg)
	}
	return m, nil
}

func (m FactCheckModel) handleKey(msg tea.KeyMsg) (FactCheckModel, tea.Cmd) {
	if m.loadErr != "" {
		switch msg.String() {
		case "q", "esc":
			return m, m.closeCmd()
		}
		return m, nil
	}

	switch msg.String() {
	case "q", "esc":
		return m, m.closeCmd()

	case "down", "j":
		if len(m.findings) > 0 {
			m.cursor = (m.cursor + 1) % len(m.findings)
			m.scrollToActive()
		}

	case "up", "k":
		if len(m.findings) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = len(m.findings) - 1
			}
			m.scrollToActive()
		}

	case "a":
		f := m.activeFinding()
		if f == nil || f.State == fsStale {
			return m, nil
		}
		m.applyReplacement(m.cursor, f.ProposedFix, fsApplied)

	case "r":
		f := m.activeFinding()
		if f == nil || f.State == fsStale {
			return m, nil
		}
		m.findings[m.cursor].State = fsRejected

	case "e":
		f := m.activeFinding()
		if f == nil || f.State == fsStale {
			return m, nil
		}
		// Seed the textarea with the whole enclosing block (paragraph/bullet)
		// so the user can rewrite the surrounding sentence, not just the flagged
		// phrase. Snapshot it for the apply step.
		block := m.activeBlockText()
		if block == "" {
			block = f.GeneratedText
		}
		m.editingOriginalBlock = block
		m.editing = true
		m.editArea.SetValue(block)
		m.editArea.CursorEnd()
		cmd := m.editArea.Focus()
		return m, cmd

	case "f":
		m.confirmingFinalize = true
	}

	return m, nil
}

// applyReplacement substitutes generatedText with replacement in the CV
// markdown, persists to disk, updates state, and refreshes wrap/scroll.
// Returns false if the target text was missing or save failed.
func (m *FactCheckModel) applyReplacement(idx int, replacement string, newState findingState) bool {
	if idx < 0 || idx >= len(m.findings) {
		return false
	}
	f := &m.findings[idx]
	newCV := strings.Replace(m.cvContent, f.GeneratedText, replacement, 1)
	if newCV == m.cvContent {
		f.State = fsStale
		return false
	}
	m.cvContent = newCV
	if err := os.WriteFile(m.cvPath, []byte(m.cvContent), 0o644); err != nil {
		m.loadErr = "Failed to save CV: " + err.Error()
		return false
	}
	f.State = newState
	f.AppliedText = replacement
	m.recomputeVisualLines()
	m.scrollToActive()
	return true
}

func (m FactCheckModel) handleEdit(msg tea.KeyMsg) (FactCheckModel, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEsc:
		m.editing = false
		m.editingOriginalBlock = ""
		m.editArea.Reset()
		m.editArea.Blur()
		return m, nil
	case tea.KeyCtrlD:
		// Submit: replace the snapshotted block with the new buffer content.
		// Enter is reserved for newline inside the textarea.
		newText := m.editArea.Value()
		m.applyBlockReplacement(m.cursor, m.editingOriginalBlock, newText)
		m.editing = false
		m.editingOriginalBlock = ""
		m.editArea.Reset()
		m.editArea.Blur()
		return m, nil
	}
	var cmd tea.Cmd
	m.editArea, cmd = m.editArea.Update(msg)
	return m, cmd
}

// activeBlockText returns the text of the paragraph/bullet enclosing the
// active finding's match. Returns "" if no block is known.
func (m FactCheckModel) activeBlockText() string {
	if m.cursor < 0 || m.cursor >= len(m.findingBlocks) {
		return ""
	}
	br := m.findingBlocks[m.cursor]
	if br[0] == -1 {
		return ""
	}
	logical := strings.Split(m.cvContent, "\n")
	if br[1] > len(logical) {
		return ""
	}
	return strings.Join(logical[br[0]:br[1]], "\n")
}

// applyBlockReplacement substitutes the snapshotted original block with
// `newBlock` in the CV, persists, and updates state to fsEdited.
func (m *FactCheckModel) applyBlockReplacement(idx int, originalBlock, newBlock string) bool {
	if idx < 0 || idx >= len(m.findings) {
		return false
	}
	if originalBlock == "" {
		return false
	}
	f := &m.findings[idx]
	updated := strings.Replace(m.cvContent, originalBlock, newBlock, 1)
	if updated == m.cvContent {
		f.State = fsStale
		return false
	}
	m.cvContent = updated
	if err := os.WriteFile(m.cvPath, []byte(m.cvContent), 0o644); err != nil {
		m.loadErr = "Failed to save CV: " + err.Error()
		return false
	}
	f.State = fsEdited
	f.AppliedText = newBlock
	m.recomputeVisualLines()
	m.scrollToActive()
	return true
}

func (m FactCheckModel) handleFinalizeConfirm(msg tea.KeyMsg) (FactCheckModel, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		// Delete the review JSON, then ask main to render the PDF and exit.
		_ = os.Remove(m.reviewJSONPath)
		appKey := m.appKey
		app := m.app
		cvPath := m.cvPath
		openAfter := m.openReportAfter
		return m, func() tea.Msg {
			return FactCheckFinalizeMsg{
				AppKey:          appKey,
				App:             app,
				CVPath:          cvPath,
				OpenReportAfter: openAfter,
			}
		}
	default:
		// Anything else cancels.
		m.confirmingFinalize = false
	}
	return m, nil
}

func (m FactCheckModel) closeCmd() tea.Cmd {
	appKey := m.appKey
	app := m.app
	openAfter := m.openReportAfter
	return func() tea.Msg {
		return FactCheckClosedMsg{
			AppKey:          appKey,
			App:             app,
			OpenReportAfter: openAfter,
		}
	}
}

func (m FactCheckModel) activeFinding() *finding {
	if m.cursor < 0 || m.cursor >= len(m.findings) {
		return nil
	}
	return &m.findings[m.cursor]
}

// recomputeVisualLines word-wraps cvContent to fit the current left pane and
// reindexes per-finding block ranges. Cheap enough to call after every CV
// mutation (typical CV is < 100 lines).
func (m *FactCheckModel) recomputeVisualLines() {
	// Reserve: 2 cols for outer Padding(0,1) + 2 cols for the "▌ " / "  "
	// per-line prefix added by styleVisualLine.
	w := m.leftWidth() - 4
	if w < 10 {
		w = 10
	}
	m.wrappedWidth = w
	m.visualLines = m.visualLines[:0]
	m.visualOrigin = m.visualOrigin[:0]

	logical := strings.Split(m.cvContent, "\n")
	for li, line := range logical {
		wrapped := wrapPlainLine(line, w)
		for _, vl := range wrapped {
			m.visualLines = append(m.visualLines, vl)
			m.visualOrigin = append(m.visualOrigin, li)
		}
	}

	m.findingBlocks = m.findingBlocks[:0]
	for _, f := range m.findings {
		needle := f.GeneratedText
		if f.State == fsApplied || f.State == fsEdited {
			needle = f.AppliedText
		}
		// blockRange only does single-line `Contains`. If the needle is
		// multi-line (typical for an edited block), anchor on its first
		// non-empty line.
		if strings.Contains(needle, "\n") {
			for _, ln := range strings.Split(needle, "\n") {
				if strings.TrimSpace(ln) != "" {
					needle = ln
					break
				}
			}
		}
		m.findingBlocks = append(m.findingBlocks, blockRange(logical, needle))
	}
}

// blockRange returns the [start, end) logical-line range of the block
// (paragraph or bullet) containing `needle`. A block is a run of consecutive
// non-blank lines. Returns (-1,-1) when `needle` is not present.
func blockRange(logical []string, needle string) [2]int {
	if needle == "" {
		return [2]int{-1, -1}
	}
	hit := -1
	for i, ln := range logical {
		if strings.Contains(ln, needle) {
			hit = i
			break
		}
	}
	if hit == -1 {
		return [2]int{-1, -1}
	}
	start := hit
	for start > 0 && strings.TrimSpace(logical[start-1]) != "" {
		start--
	}
	end := hit + 1
	for end < len(logical) && strings.TrimSpace(logical[end]) != "" {
		end++
	}
	return [2]int{start, end}
}

// scrollToActive recenters the left pane on the active finding's enclosing
// block. Always recenters (even when the block is already visible) so each
// up/down press produces visible motion.
func (m *FactCheckModel) scrollToActive() {
	if m.cursor < 0 || m.cursor >= len(m.findings) {
		return
	}
	if m.wrappedWidth != m.leftWidth()-4 {
		m.recomputeVisualLines()
	}
	if m.cursor >= len(m.findingBlocks) {
		return
	}
	br := m.findingBlocks[m.cursor]
	if br[0] == -1 {
		return
	}
	// Find the first visual-line index whose origin is within the block.
	firstVisual := -1
	for i, lo := range m.visualOrigin {
		if lo >= br[0] && lo < br[1] {
			firstVisual = i
			break
		}
	}
	if firstVisual == -1 {
		return
	}
	bh := m.bodyHeight()
	// Center the *first line of the block* a third of the way down so the
	// block has room to extend below.
	off := firstVisual - bh/3
	if off < 0 {
		off = 0
	}
	maxScroll := len(m.visualLines) - bh
	if maxScroll < 0 {
		maxScroll = 0
	}
	if off > maxScroll {
		off = maxScroll
	}
	m.leftScrollOffset = off
}

// wrapPlainLine word-wraps a single logical line to fit maxWidth columns,
// preserving any run of leading whitespace on the original line. Returns at
// least one element (possibly empty) so logical-line indexing stays meaningful.
func wrapPlainLine(line string, maxWidth int) []string {
	if maxWidth <= 1 {
		return []string{line}
	}
	if lipgloss.Width(line) <= maxWidth {
		return []string{line}
	}
	// Capture leading whitespace.
	indent := ""
	for i, r := range line {
		if r == ' ' || r == '\t' {
			indent = line[:i+1]
			continue
		}
		break
	}
	body := strings.TrimLeft(line, " \t")

	words := strings.Fields(body)
	if len(words) == 0 {
		return []string{line}
	}

	var out []string
	var b strings.Builder
	cw := lipgloss.Width(indent)
	b.WriteString(indent)
	for _, word := range words {
		ww := lipgloss.Width(word)
		if cw == lipgloss.Width(indent) {
			b.WriteString(word)
			cw += ww
			continue
		}
		if cw+1+ww > maxWidth {
			out = append(out, b.String())
			b.Reset()
			b.WriteString(indent)
			b.WriteString(word)
			cw = lipgloss.Width(indent) + ww
			continue
		}
		b.WriteString(" ")
		b.WriteString(word)
		cw += 1 + ww
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}

func (m FactCheckModel) bodyHeight() int {
	h := m.height - 4 // header + footer + a little padding
	if h < 5 {
		h = 5
	}
	return h
}

func (m FactCheckModel) leftWidth() int {
	w := m.width * 60 / 100
	if w < 30 {
		w = 30
	}
	return w
}

func (m FactCheckModel) rightWidth() int {
	rw := m.width - m.leftWidth() - 1 // 1 col for divider
	if rw < 20 {
		rw = 20
	}
	return rw
}

// View renders the full screen.
func (m FactCheckModel) View() string {
	if m.loadErr != "" {
		return m.renderHeader() + "\n\n  " +
			lipgloss.NewStyle().Foreground(m.theme.Red).Render(m.loadErr) +
			"\n\n  " + lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("Press q or Esc to return.")
	}
	header := m.renderHeader()
	body := m.renderBody()
	footer := m.renderFooter()
	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m FactCheckModel) renderHeader() string {
	bg := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue)
	counterStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	counter := fmt.Sprintf("%d / %d", m.cursor+1, len(m.findings))
	if len(m.findings) == 0 {
		counter = "0 / 0"
	}

	verdict := m.renderVerdictPill()

	left := titleStyle.Render(m.title)
	right := counterStyle.Render(counter) + "  " + verdict
	gap := m.width - lipgloss.Width(left) - lipgloss.Width(right) - 4
	if gap < 1 {
		gap = 1
	}
	return bg.Render(left + strings.Repeat(" ", gap) + right)
}

func (m FactCheckModel) renderVerdictPill() string {
	color := m.theme.Subtext
	label := m.overallVerdict
	if label == "" {
		label = "—"
	}
	switch strings.ToLower(label) {
	case "do_not_send":
		color = m.theme.Red
	case "caution":
		color = m.theme.Yellow
	case "ok", "send":
		color = m.theme.Green
	}
	return lipgloss.NewStyle().Foreground(color).Render("● " + label)
}

func (m FactCheckModel) renderBody() string {
	bh := m.bodyHeight()
	left := m.renderLeft(bh)
	right := m.renderRight(bh)

	div := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Repeat("│\n", bh))
	// Strip trailing newline from div.
	div = strings.TrimRight(div, "\n")

	return lipgloss.JoinHorizontal(lipgloss.Top, left, div, right)
}

// renderLeft renders the CV pane with per-block highlights. Lines are
// word-wrapped to the pane width — no horizontal truncation. Findings color
// their entire enclosing paragraph/bullet; the active finding adds a left-edge
// `▌` marker plus bold so it pops independent of theme.
func (m FactCheckModel) renderLeft(bh int) string {
	lw := m.leftWidth()
	style := lipgloss.NewStyle().Width(lw).Padding(0, 1)

	if m.cvContent == "" {
		return style.Render(lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("(empty CV)"))
	}

	lines := m.visualLines
	end := m.leftScrollOffset + bh
	if end > len(lines) {
		end = len(lines)
	}
	if m.leftScrollOffset > len(lines) {
		m.leftScrollOffset = max0(len(lines) - bh)
	}
	visible := lines[m.leftScrollOffset:end]
	visibleOrigin := m.visualOrigin[m.leftScrollOffset:end]

	var rendered []string
	for i, ln := range visible {
		rendered = append(rendered, m.styleVisualLine(ln, visibleOrigin[i]))
	}
	for len(rendered) < bh {
		rendered = append(rendered, "")
	}
	return style.Render(strings.Join(rendered, "\n"))
}

// styleVisualLine paints a single visual line according to whichever finding's
// block it belongs to (if any). Active finding wins ties.
func (m FactCheckModel) styleVisualLine(line string, logicalIdx int) string {
	// Find the highest-priority finding whose block covers this logical line.
	// Active wins; otherwise iterate in order.
	winner := -1
	for i, br := range m.findingBlocks {
		if br[0] == -1 {
			continue
		}
		if logicalIdx < br[0] || logicalIdx >= br[1] {
			continue
		}
		if i == m.cursor {
			winner = i
			break
		}
		if winner == -1 {
			winner = i
		}
	}
	if winner == -1 {
		return lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(line)
	}

	f := m.findings[winner]
	active := winner == m.cursor

	var fg lipgloss.Color
	switch f.State {
	case fsApplied, fsEdited:
		fg = m.theme.Green
	case fsRejected:
		fg = m.theme.Subtext
	case fsStale:
		fg = m.theme.Subtext
	default: // pending
		fg = m.theme.Red
		if f.Severity == "stretched" {
			fg = m.theme.Yellow
		}
	}

	textStyle := lipgloss.NewStyle().Foreground(fg)
	if active {
		textStyle = textStyle.Bold(true)
	}

	if active {
		marker := lipgloss.NewStyle().Foreground(fg).Bold(true).Render("▌ ")
		return marker + textStyle.Render(line)
	}
	return "  " + textStyle.Render(line)
}


func (m FactCheckModel) renderRight(bh int) string {
	rw := m.rightWidth()
	style := lipgloss.NewStyle().Width(rw).Padding(0, 1)

	if len(m.findings) == 0 {
		return style.Render(lipgloss.NewStyle().Foreground(m.theme.Green).Render("✓ No findings."))
	}

	f := m.findings[m.cursor]
	subtext := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	label := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	body := lipgloss.NewStyle().Foreground(m.theme.Text)

	var lines []string

	// Severity pill
	lines = append(lines, m.renderSeverityPill(f))
	if f.Section != "" {
		lines = append(lines, subtext.Render("Section: ")+body.Render(f.Section))
	}
	lines = append(lines, lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Repeat("─", rw-2)))

	// Issue
	lines = append(lines, label.Render("Issue"))
	lines = append(lines, wrap(body.Render(f.Issue), rw-2)...)
	lines = append(lines, "")

	// Offending text — pinpoints the phrase inside the highlighted block.
	lines = append(lines, label.Render("Offending text"))
	if strings.TrimSpace(f.GeneratedText) == "" {
		lines = append(lines, subtext.Italic(true).Render("(no specific phrase recorded)"))
	} else {
		offending := lipgloss.NewStyle().Foreground(m.theme.Red).Render(f.GeneratedText)
		if f.Severity == "stretched" {
			offending = lipgloss.NewStyle().Foreground(m.theme.Yellow).Render(f.GeneratedText)
		}
		lines = append(lines, wrap(offending, rw-2)...)
	}
	lines = append(lines, "")

	// Proposed fix preview — show the line as it will look post-apply.
	lines = append(lines, label.Render("After apply fix"))
	if f.GeneratedText == "" {
		lines = append(lines, subtext.Italic(true).Render("(no replacement available)"))
	} else {
		preview := m.renderReplacementPreview(f.GeneratedText, f.ProposedFix, rw-2)
		lines = append(lines, preview...)
	}
	lines = append(lines, "")

	// State
	lines = append(lines, label.Render("State")+"  "+m.renderStatePill(f))

	// Edit textarea (if active)
	if m.editing {
		lines = append(lines, "")
		lines = append(lines, label.Render("Edit (Ctrl+D apply, Esc cancel)"))
		// Append textarea view as separate lines so wrapping and cursor render
		// correctly. Width is set by Resize; height defaults to 4 rows.
		taLines := strings.Split(m.editArea.View(), "\n")
		lines = append(lines, taLines...)
	}

	// Finalize confirm (if active)
	if m.confirmingFinalize {
		lines = append(lines, "")
		warn := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)
		lines = append(lines, warn.Render("Finalize and regenerate PDF? [y/N]"))
	}

	if len(lines) > bh {
		lines = lines[:bh]
	}
	for len(lines) < bh {
		lines = append(lines, "")
	}
	return style.Render(strings.Join(lines, "\n"))
}

// renderReplacementPreview returns wrapped right-pane lines showing the CV
// line containing `target` with `target` swapped for `replacement`. The marker
// (replacement, or strikethrough target on remove) is highlighted; the rest of
// the line renders dim so the change stands out in context.
func (m FactCheckModel) renderReplacementPreview(target, replacement string, w int) []string {
	dim := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	green := lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true)
	strike := lipgloss.NewStyle().Foreground(m.theme.Subtext).Strikethrough(true)

	if target == "" {
		return []string{dim.Render("(no target)")}
	}
	idx := strings.Index(m.cvContent, target)
	if idx < 0 {
		return wrap(green.Render(replacement), w)
	}
	lineStart := strings.LastIndex(m.cvContent[:idx], "\n") + 1
	lineEndOff := strings.Index(m.cvContent[idx:], "\n")
	lineEnd := len(m.cvContent)
	if lineEndOff != -1 {
		lineEnd = idx + lineEndOff
	}
	line := m.cvContent[lineStart:lineEnd]
	relIdx := idx - lineStart
	before := line[:relIdx]
	after := line[relIdx+len(target):]

	// Compose the plain projection of the post-change line. For "remove"
	// (empty replacement), keep the target text in place so the user can see
	// what would disappear, struck through.
	var marker string
	var markerStyle lipgloss.Style
	if replacement == "" {
		marker = target
		markerStyle = strike
	} else {
		marker = replacement
		markerStyle = green
	}
	plain := before + marker + after
	visual := wrapPlainLine(plain, w)
	for i, vl := range visual {
		visual[i] = m.styleLineWithMarker(vl, marker, markerStyle, dim)
	}
	return visual
}

// styleLineWithMarker styles a plain visual line by painting the first
// occurrence of `needle` with `markerStyle` and the rest with `baseStyle`.
func (m FactCheckModel) styleLineWithMarker(line, needle string, markerStyle, baseStyle lipgloss.Style) string {
	if needle == "" {
		return baseStyle.Render(line)
	}
	idx := strings.Index(line, needle)
	if idx < 0 {
		return baseStyle.Render(line)
	}
	return baseStyle.Render(line[:idx]) +
		markerStyle.Render(line[idx:idx+len(needle)]) +
		baseStyle.Render(line[idx+len(needle):])
}

func (m FactCheckModel) renderSeverityPill(f finding) string {
	color := m.theme.Red
	label := "FABRICATED"
	if f.Severity == "stretched" {
		color = m.theme.Yellow
		label = "STRETCHED"
	}
	return lipgloss.NewStyle().Bold(true).Foreground(color).Render("● " + label)
}

func (m FactCheckModel) renderStatePill(f finding) string {
	switch f.State {
	case fsApplied:
		return lipgloss.NewStyle().Foreground(m.theme.Green).Render("applied")
	case fsEdited:
		return lipgloss.NewStyle().Foreground(m.theme.Green).Render("edited")
	case fsRejected:
		return lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("kept")
	case fsStale:
		return lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("stale (already handled)")
	default:
		return lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("pending")
	}
}

func (m FactCheckModel) renderFooter() string {
	rowStyle := lipgloss.NewStyle().Padding(0, 1)
	hotkey := lipgloss.NewStyle().Foreground(m.theme.Blue).Underline(true)
	text := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	separator := lipgloss.NewStyle().
		Foreground(m.theme.Overlay).
		Padding(0, 1).
		Render(strings.Repeat("─", max0(m.width-2)))

	hint := func(prefix, key, suffix string) string {
		return text.Render(prefix) + hotkey.Render(key) + text.Render(suffix)
	}

	if m.editing {
		return separator + "\n" + rowStyle.Render(strings.Join([]string{
			hint("", "⌥←/→", " word jump"),
			hint("", "⌥⌫", " del word"),
			hint("", "Enter", " newline"),
			hint("", "^D", " apply"),
			hint("", "Esc", " cancel"),
		}, "  "))
	}
	if m.confirmingFinalize {
		return separator + "\n" + rowStyle.Render(strings.Join([]string{
			hint("", "y", " finalize"),
			hint("", "any", " cancel"),
		}, "  "))
	}

	return separator + "\n" + rowStyle.Render(strings.Join([]string{
		hint("", "↑↓", " next/prev"),
		hint("", "a", "pply fix"),
		hint("", "e", "dit"),
		hint("", "r", " keep"),
		hint("", "f", "inalize"),
		hint("", "q", "uit"),
	}, "  "))
}

// wrap splits text into lines fitting `w` columns. Naive whitespace-aware.
func wrap(s string, w int) []string {
	if w <= 1 {
		return []string{s}
	}
	var out []string
	for _, para := range strings.Split(s, "\n") {
		words := strings.Fields(para)
		if len(words) == 0 {
			out = append(out, "")
			continue
		}
		var line strings.Builder
		lw := 0
		for _, word := range words {
			ww := lipgloss.Width(word)
			if lw == 0 {
				line.WriteString(word)
				lw = ww
				continue
			}
			if lw+1+ww > w {
				out = append(out, line.String())
				line.Reset()
				line.WriteString(word)
				lw = ww
				continue
			}
			line.WriteString(" ")
			line.WriteString(word)
			lw += 1 + ww
		}
		if line.Len() > 0 {
			out = append(out, line.String())
		}
	}
	return out
}

func max0(x int) int {
	if x < 0 {
		return 0
	}
	return x
}
