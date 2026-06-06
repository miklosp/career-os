package screens

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

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
	Severity      string // "fabricated" | "stretched" | "bridge"
	Section       string
	GeneratedText string // verbatim from the review JSON — what the reviewer claimed is in the CV
	SourceCV      string
	Issue         string
	Replacement   string // literal drop-in text spliced in place of GeneratedText

	State findingState
	// MatchedText is the actual CV substring that GeneratedText resolves to.
	// LLM output is whitespace-imprecise: it may quote a phrase with single
	// spaces where the CV has double, may include or omit hard newlines, etc.
	// MatchedText is resolved at load time via a whitespace-tolerant search
	// and is guaranteed to be a verbatim substring of cvContent. All downstream
	// substitution and block-range logic uses MatchedText, not GeneratedText.
	// Empty string means no resolution was possible (→ fsStale).
	MatchedText string
	// AppliedText is the replacement currently in the CV markdown (replacement
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
	Replacement   string `json:"replacement"`
	// LegacyFix captures the pre-rename `proposed_fix` key so a review JSON
	// cached before the schema rename still resolves. Prefer Replacement.
	LegacyFix string `json:"proposed_fix"`
}

type reviewSummary struct {
	FabricatedCount int    `json:"fabricated_count"`
	StretchedCount  int    `json:"stretched_count"`
	BridgeCount     int    `json:"bridge_count"`
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

	cvContent string
	findings  []finding

	// generatedAt is the CV's generation date, shown in the header. Read once
	// from the review JSON's mtime — cv-fact-check.mjs writes that file once and
	// never rewrites it, so the date stays stable across resume sessions, unlike
	// the CV markdown which this screen mutates on every apply/edit.
	generatedAt time.Time

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
	// guardNote is a one-line warning shown above the edit textarea when the
	// apply-time guard bounced a prose-shaped replacement into the edit flow.
	// Cleared when the edit session ends.
	guardNote string

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

	// Generation date for the header — see the generatedAt field comment.
	if fi, err := os.Stat(reviewJSONPath); err == nil {
		m.generatedAt = fi.ModTime()
	} else if fi, err := os.Stat(cvPath); err == nil {
		m.generatedAt = fi.ModTime()
	}

	for _, rfd := range rf.Findings {
		rep := rfd.Replacement
		if rep == "" {
			rep = rfd.LegacyFix
		}
		f := finding{
			ID:            rfd.ID,
			Severity:      rfd.Severity,
			Section:       rfd.Section,
			GeneratedText: rfd.GeneratedText,
			SourceCV:      rfd.SourceCV,
			Issue:         rfd.Issue,
			Replacement:   rep,
		}
		f.MatchedText = resolveMatch(m.cvContent, rfd.GeneratedText)
		if f.MatchedText != "" {
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

	case "down":
		if len(m.findings) > 0 {
			m.cursor = (m.cursor + 1) % len(m.findings)
			m.scrollToActive()
		}

	case "up":
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
		// Guard: a `replacement` that reads as a recommendation sentence
		// ("Could upgrade to 'X' — defensible from id") would splice the whole
		// sentence into the CV. Surface it instead of blind-applying — bounce
		// into the edit flow with the enclosing block pre-seeded (best-guess
		// clean phrase already swapped in when one could be extracted). Nothing
		// reaches disk until the user confirms with Ctrl+D.
		if clean, suspicious := vetReplacement(f.Replacement, f.MatchedText); suspicious {
			block := m.activeBlockText()
			if block == "" {
				block = f.MatchedText
			}
			if block == "" {
				block = f.GeneratedText
			}
			seeded := block
			if clean != "" && f.MatchedText != "" {
				seeded = strings.Replace(block, f.MatchedText, clean, 1)
			}
			m.editingOriginalBlock = block
			m.editing = true
			m.guardNote = "Replacement looked like prose, not a drop-in — review before applying."
			m.editArea.SetValue(seeded)
			m.editArea.CursorEnd()
			return m, m.editArea.Focus()
		}
		m.applyReplacement(m.cursor, f.Replacement, fsApplied)

	case "k":
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
			block = f.MatchedText
		}
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

// applyReplacement substitutes the matched text with `replacement` in the CV
// markdown, persists to disk, updates state, and refreshes wrap/scroll.
// Uses MatchedText (the resolved canonical substring), not GeneratedText (the
// raw reviewer claim), so whitespace-imprecise quotes still apply correctly.
// Returns false if the target text was missing or save failed.
func (m *FactCheckModel) applyReplacement(idx int, replacement string, newState findingState) bool {
	if idx < 0 || idx >= len(m.findings) {
		return false
	}
	f := &m.findings[idx]
	target := f.MatchedText
	if target == "" {
		// Late-resolve in case the CV was mutated since load.
		target = resolveMatch(m.cvContent, f.GeneratedText)
		f.MatchedText = target
	}
	if target == "" {
		f.State = fsStale
		return false
	}
	newCV := strings.Replace(m.cvContent, target, replacement, 1)
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
		m.guardNote = ""
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
		m.guardNote = ""
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
		needle := f.MatchedText
		if needle == "" {
			needle = f.GeneratedText
		}
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
	h := m.height - 5 // header + header rule + footer (rule + row) + padding
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
	return lipgloss.JoinVertical(lipgloss.Left, header, m.renderHRule(), body, footer)
}

// renderHRule is the full-width horizontal divider used under the header and
// above the footer.
func (m FactCheckModel) renderHRule() string {
	return lipgloss.NewStyle().
		Foreground(m.theme.Overlay).
		Padding(0, 1).
		Render(strings.Repeat("─", max0(m.width-2)))
}

func (m FactCheckModel) renderHeader() string {
	bg := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue)
	metaStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	counter := fmt.Sprintf("%d/%d", m.cursor+1, len(m.findings))
	if len(m.findings) == 0 {
		counter = "0/0"
	}

	// Right side, left-to-right: CV generation date, one dot per finding
	// (severity-colored while pending, hollow once decided), the cursor
	// counter, then the live send verdict.
	var rightParts []string
	if !m.generatedAt.IsZero() {
		rightParts = append(rightParts, metaStyle.Render("Generated: "+m.generatedAt.Format("01/02")))
	}
	if dots := m.renderFindingDots(); dots != "" {
		rightParts = append(rightParts, dots)
	}
	rightParts = append(rightParts, metaStyle.Render(counter), m.renderVerdictPill())

	left := titleStyle.Render(m.title)
	right := strings.Join(rightParts, "  ")
	gap := m.width - lipgloss.Width(left) - lipgloss.Width(right) - 4
	if gap < 1 {
		gap = 1
	}
	return bg.Render(left + strings.Repeat(" ", gap) + right)
}

// renderFindingDots draws one dot per finding in list order: a filled,
// severity-colored ● while the finding is still pending a decision, a dimmed
// hollow ○ once the user has applied, edited, kept, or it went stale. The row
// reads as a live progress bar of the walkthrough.
func (m FactCheckModel) renderFindingDots() string {
	var b strings.Builder
	for i := range m.findings {
		if m.findings[i].State == fsPending {
			b.WriteString(lipgloss.NewStyle().
				Foreground(severityColor(m.theme, m.findings[i].Severity)).
				Render("●"))
		} else {
			b.WriteString(lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("○"))
		}
	}
	return b.String()
}

// renderVerdictPill renders the send-readiness pill from the live verdict.
func (m FactCheckModel) renderVerdictPill() string {
	label, color := m.currentVerdict()
	return lipgloss.NewStyle().Foreground(color).Render("● " + label)
}

// currentVerdict derives a human-readable send verdict from the findings still
// pending a decision, so the header improves as the user works the list. A
// pending fabricated finding holds it at "Do not send"; a pending stretched or
// bridge finding yields "Caution"; once every finding is decided the CV clears
// to "Send".
func (m FactCheckModel) currentVerdict() (string, lipgloss.Color) {
	pendingHard, pendingSoft := false, false
	for i := range m.findings {
		if m.findings[i].State != fsPending {
			continue
		}
		switch m.findings[i].Severity {
		case "stretched", "bridge":
			pendingSoft = true
		default: // fabricated and unknown — treat conservatively
			pendingHard = true
		}
	}
	switch {
	case pendingHard:
		return "Do not send", m.theme.Red
	case pendingSoft:
		return "Caution", m.theme.Yellow
	default:
		return "Send", m.theme.Green
	}
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
		fg = severityColor(m.theme, f.Severity)
	}

	subtextStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	matchStyle := lipgloss.NewStyle().Foreground(fg)
	if active {
		matchStyle = matchStyle.Bold(true)
	}

	// Color only the flagged phrase, not the whole enclosing block. The
	// left-edge marker still spans every line of the active block so the
	// finding is locatable even on lines the phrase doesn't touch.
	needle := f.MatchedText
	if needle == "" {
		needle = f.GeneratedText
	}
	if f.State == fsApplied || f.State == fsEdited {
		needle = f.AppliedText
	}

	var content string
	if s, e, ok := matchSpanInLine(line, needle); ok {
		content = subtextStyle.Render(line[:s]) +
			matchStyle.Render(line[s:e]) +
			subtextStyle.Render(line[e:])
	} else {
		content = subtextStyle.Render(line)
	}

	if active {
		marker := lipgloss.NewStyle().Foreground(fg).Bold(true).Render("▌ ")
		return marker + content
	}
	return "  " + content
}

// matchSpanInLine locates the portion of a single rendered visual line that
// belongs to `needle`, tolerant of word-wrap whitespace collapsing. It returns
// byte offsets into `line`. Because wrapping splits a logical line into visual
// lines at word boundaries, the needle either sits fully inside the line, fully
// contains the line, or straddles one edge — the four cases handled below.
func matchSpanInLine(line, needle string) (int, int, bool) {
	needleN := normalizeWhitespace(strings.TrimSpace(needle))
	if needleN == "" {
		return 0, 0, false
	}
	lineN, n2o := normWithMap(line)
	if lineN == "" {
		return 0, 0, false
	}
	// 1. Whole needle inside this line.
	if p := strings.Index(lineN, needleN); p >= 0 {
		return n2o[p], n2o[p+len(needleN)], true
	}
	// 2. Whole line interior to the needle (a middle wrap row).
	if strings.Contains(needleN, lineN) {
		return n2o[0], n2o[len(lineN)], true
	}
	// 3. Needle begins partway through this line (line ends mid-needle):
	//    some suffix of the line is a prefix of the needle.
	for s := 0; s < len(lineN); s++ {
		if strings.HasPrefix(needleN, lineN[s:]) {
			return n2o[s], n2o[len(lineN)], true
		}
	}
	// 4. Needle ends partway through this line (line starts mid-needle):
	//    some prefix of the line is a suffix of the needle.
	for e := len(lineN); e > 0; e-- {
		if strings.HasSuffix(needleN, lineN[:e]) {
			return n2o[0], n2o[e], true
		}
	}
	return 0, 0, false
}

// normWithMap collapses whitespace runs the same way normalizeWhitespace does,
// and returns a parallel index map: m[i] is the byte offset in the original
// string that normalized byte i came from, with a final sentinel m[len] =
// len(s) so a normalized end-index maps back to an original end-index.
func normWithMap(s string) (string, []int) {
	var b strings.Builder
	b.Grow(len(s))
	m := make([]int, 0, len(s)+1)
	prevWS := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			if prevWS {
				continue
			}
			b.WriteByte(' ')
			m = append(m, i)
			prevWS = true
		} else {
			b.WriteByte(c)
			m = append(m, i)
			prevWS = false
		}
	}
	m = append(m, len(s))
	return b.String(), m
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

	// Flagged phrase — what's currently in the CV. Use the resolved MatchedText
	// (the actual CV substring after whitespace-tolerant matching) so the user
	// sees what will actually be replaced, not what the reviewer typed.
	lines = append(lines, m.hotkeyLabel("K", "eep"))
	displayPhrase := f.MatchedText
	if displayPhrase == "" {
		displayPhrase = f.GeneratedText // fallback for stale findings
	}
	if strings.TrimSpace(displayPhrase) == "" {
		lines = append(lines, subtext.Italic(true).Render("(no specific phrase recorded)"))
	} else {
		phraseStyle := lipgloss.NewStyle().Foreground(severityColor(m.theme, f.Severity))
		// Preserve logical line breaks (multi-line matches) but wrap each line
		// to the pane width. No substitution, no splicing — just verbatim.
		for _, ln := range strings.Split(displayPhrase, "\n") {
			for _, vl := range wrapPlainLine(ln, rw-2) {
				lines = append(lines, phraseStyle.Render(vl))
			}
		}
	}
	lines = append(lines, "")

	// Replacement — what the apply would put in place. Shown as a standalone
	// block, NOT spliced into the surrounding line context (that ambiguity is
	// the source of "did this concatenate or substitute?" confusion). The
	// left pane shows the bullet/paragraph in context with the match highlighted.
	lines = append(lines, m.hotkeyLabel("A", "pply fix"))
	switch {
	case displayPhrase == "":
		lines = append(lines, subtext.Italic(true).Render("(no replacement available)"))
	case f.Replacement == "":
		// Empty fix = delete. Render the would-be-removed text with strikethrough.
		strike := lipgloss.NewStyle().Foreground(m.theme.Subtext).Strikethrough(true)
		lines = append(lines, subtext.Italic(true).Render("(the phrase above is removed)"))
		for _, ln := range strings.Split(displayPhrase, "\n") {
			for _, vl := range wrapPlainLine(ln, rw-2) {
				lines = append(lines, strike.Render(vl))
			}
		}
	default:
		fixStyle := lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true)
		for _, ln := range strings.Split(f.Replacement, "\n") {
			for _, vl := range wrapPlainLine(ln, rw-2) {
				lines = append(lines, fixStyle.Render(vl))
			}
		}
	}
	if f.Severity == "bridge" {
		lines = append(lines, "")
		lines = append(lines, subtext.Italic(true).Render("Default: keep CV text. Press `a` to upgrade."))
	}
	lines = append(lines, "")

	// State
	lines = append(lines, label.Render("State")+"  "+m.renderStatePill(f))

	// Edit textarea (if active)
	if m.editing {
		lines = append(lines, "")
		if m.guardNote != "" {
			warn := lipgloss.NewStyle().Foreground(m.theme.Yellow).Bold(true)
			for _, ln := range wrap("⚠ "+m.guardNote, rw-2) {
				lines = append(lines, warn.Render(ln))
			}
		}
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

// resolveMatch finds `target` in `content` and returns the actual content
// substring that matches. LLM-produced `generated_text` is whitespace-
// imprecise: it may collapse double spaces to single, swap hard newlines for
// spaces, or vice versa. Exact substring matching fails on these — silently
// stale-ing findings the reviewer correctly identified.
//
// Strategy:
//  1. Exact match. Cheap, covers the typical case.
//  2. Whitespace-normalized match: collapse runs of any whitespace to a single
//     space on both sides, locate the normalized target in the normalized
//     content, then map the normalized range back to original byte offsets.
//
// Returns "" if no match. The returned string is guaranteed to be a verbatim
// substring of `content`, so downstream strings.Replace / strings.Contains
// operations on it cannot silently fail.
func resolveMatch(content, target string) string {
	if target == "" {
		return ""
	}
	if strings.Contains(content, target) {
		return target
	}
	normTarget := normalizeWhitespace(target)
	if normTarget == "" {
		return ""
	}
	// Build normalized content alongside a map from normalized-byte-index back
	// to original-byte-index. Each entry in normToOrig is the start of the run
	// of original bytes that the normalized byte at the same index came from.
	var normBuf strings.Builder
	normBuf.Grow(len(content))
	normToOrig := make([]int, 0, len(content))
	prevWS := false
	for i := 0; i < len(content); i++ {
		c := content[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			if prevWS {
				continue
			}
			normBuf.WriteByte(' ')
			normToOrig = append(normToOrig, i)
			prevWS = true
		} else {
			normBuf.WriteByte(c)
			normToOrig = append(normToOrig, i)
			prevWS = false
		}
	}
	normContent := normBuf.String()
	hit := strings.Index(normContent, normTarget)
	if hit < 0 {
		return ""
	}
	endIdx := hit + len(normTarget)
	if hit >= len(normToOrig) || endIdx-1 >= len(normToOrig) {
		return ""
	}
	origStart := normToOrig[hit]
	// The original-byte range ends at the last byte of the last run included
	// in the normalized match. To capture trailing whitespace inside that run,
	// extend origEnd up to (but not past) the next normalized byte's origin.
	var origEnd int
	if endIdx < len(normToOrig) {
		origEnd = normToOrig[endIdx]
	} else {
		origEnd = len(content)
	}
	if origStart < 0 || origEnd > len(content) || origStart >= origEnd {
		return ""
	}
	return content[origStart:origEnd]
}

// normalizeWhitespace collapses any run of [space, tab, newline, CR] to a
// single ASCII space. Used as the indexing key in resolveMatch.
func normalizeWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevWS := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			if prevWS {
				continue
			}
			b.WriteByte(' ')
			prevWS = true
		} else {
			b.WriteByte(c)
			prevWS = false
		}
	}
	return b.String()
}

// reQuotedSpan matches text wrapped in straight or smart quotes — the shape of
// a replacement phrase the LLM embedded inside a recommendation sentence.
var reQuotedSpan = regexp.MustCompile(`['"\x{201c}\x{201d}\x{2018}\x{2019}]([^'"\x{201c}\x{201d}\x{2018}\x{2019}]{3,})['"\x{201c}\x{201d}\x{2018}\x{2019}]`)

// reProseTell matches recommendation-sentence telltales that should never
// appear in a literal drop-in replacement.
var reProseTell = regexp.MustCompile(`(?i)(^\s*(could|consider|recommend|you could)\s)|(\bdefensible from\b)|(\bupgrade to\b)`)

// vetReplacement detects a "prose-shaped" replacement — one where the reviewer
// wrote a recommendation sentence ("Could upgrade to 'X' — defensible from id")
// into the replacement field instead of the bare drop-in phrase. Splicing it
// verbatim would inject the whole sentence into the CV. clean is the best-guess
// replacement (the longest quote-wrapped span) or "" when nothing is salvageable.
func vetReplacement(replacement, generatedText string) (clean string, suspicious bool) {
	r := strings.TrimSpace(replacement)
	if r == "" {
		return "", false
	}
	clean = longestQuotedSpan(r)
	hasOutside := clean != "" && strings.TrimSpace(stripQuoteChars(r)) != clean
	telltale := reProseTell.MatchString(r)
	tooLong := generatedText != "" && len(r) > len(generatedText)*2+40
	return clean, (clean != "" && hasOutside) || telltale || tooLong
}

// longestQuotedSpan returns the longest quote-wrapped span in s, trimmed.
func longestQuotedSpan(s string) string {
	best := ""
	for _, mt := range reQuotedSpan.FindAllStringSubmatch(s, -1) {
		if c := strings.TrimSpace(mt[1]); len(c) > len(best) {
			best = c
		}
	}
	return best
}

// stripQuoteChars removes straight and smart quote characters from s.
func stripQuoteChars(s string) string {
	return strings.NewReplacer(
		`'`, "", `"`, "",
		"“", "", "”", "",
		"‘", "", "’", "",
	).Replace(s)
}

// severityColor maps a finding severity to its theme color: fabricated → red,
// stretched → yellow, bridge → sky. Unknown severities fall back to red — the
// conservative choice treats an unrecognized flag as a hard problem.
func severityColor(t theme.Theme, severity string) lipgloss.Color {
	switch severity {
	case "stretched":
		return t.Yellow
	case "bridge":
		return t.Sky
	default:
		return t.Red
	}
}

func (m FactCheckModel) renderSeverityPill(f finding) string {
	label := "FABRICATED"
	switch f.Severity {
	case "stretched":
		label = "STRETCHED"
	case "bridge":
		label = "BRIDGE"
	}
	return lipgloss.NewStyle().Bold(true).
		Foreground(severityColor(m.theme, f.Severity)).
		Render("● " + label)
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

// hotkeyLabel renders a right-pane section header whose leading letter doubles
// as the action's hotkey: the key is underlined/blue (matching the footer hint
// style) and the rest keeps the section-label style.
func (m FactCheckModel) hotkeyLabel(key, rest string) string {
	hk := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Underline(true)
	lb := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	return hk.Render(key) + lb.Render(rest)
}

func (m FactCheckModel) renderFooter() string {
	rowStyle := lipgloss.NewStyle().Padding(0, 1)
	hotkey := lipgloss.NewStyle().Foreground(m.theme.Blue).Underline(true)
	text := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	separator := m.renderHRule()

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
		hint("", "k", "eep"),
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
