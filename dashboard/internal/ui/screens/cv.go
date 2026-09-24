package screens

import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"career-ops/dashboard/internal/data"
	"career-ops/dashboard/internal/theme"
)

// CVClosedMsg is emitted when the CV editor is dismissed.
//
// NavDirection lets the editor request a tab change as part of closing:
// -1 → cycle to the tab before CV (PROGRESS), +1 → cycle to the tab after
// CV (wraps to PRIORITY). 0 means "just close" — used by q/Esc.
type CVClosedMsg struct {
	NavDirection int
}

// PipelineOpenCVMsg asks main to open the CV editor screen. The pipeline's
// cycle-key handlers emit this when the user navigates onto the CV pseudo-tab.
type PipelineOpenCVMsg struct {
	CareerOpsPath string
}

// archetypeKeys defines the archetype hotkey vocabulary. q is intentionally
// skipped — it's bound to Quit everywhere. Order matches cv-status.mjs's
// VALID_ARCHETYPES; when that grows, append here and the toggles light up.
var archetypeKeys = []struct {
	Key  string
	Name string
}{
	{"w", "product"},
	{"e", "ai"},
	{"r", "design"},
}

// tierKeys maps the 1/2/3 hotkeys to the canonical tier identifiers in
// cv-status.mjs's VALID_TIERS. "0" is the explicit clear; pressing the
// currently-set tier also clears it.
var tierKeys = []struct {
	Key  string
	Tier string
}{
	{"1", "core"},
	{"2", "default"},
	{"3", "depth"},
}

// bulletAnnotRE matches a bullet line annotated by
// `node lib/cv-json-to-md.mjs --annotate-ids`:
//
//	- some bullet text [bullet-id]
//
// Group 1 captures the bullet text; group 2 captures the id. The id charset
// stays narrow on purpose — a stray `[label]` inside bullet text won't
// accidentally match because slugified ids never contain mixed-case or punctuation.
var bulletAnnotRE = regexp.MustCompile(`^(-\s+.*?)\s+\[([a-z0-9][a-z0-9-]*)\]\s*$`)

// CVModel is the split-view CV editor. Left pane: the actual rendered CV
// markdown with the active bullet's row(s) highlighted via a soft full-width
// background; right pane: the focused edit panel (id, role, tier toggles,
// archetype toggles, agent walkthrough tip, cv-status checklist).
//
// Layout is composed row-by-row so a continuous vertical divider runs from the
// header through the hrule and body down to the footer separator, with T-
// junctions at the horizontal crossings.
type CVModel struct {
	careerOpsPath string

	cv      *data.CV
	status  *data.CVStatus
	loadErr string

	// tabCounts is captured from PipelineModel at construction time. CV
	// never mutates application state, so the snapshot stays accurate.
	tabCounts map[string]int

	// bodyText is the CV rendered by lib/cv-json-to-md.mjs with [id] markers
	// stripped — exactly what the user expects their CV to look like.
	bodyText string
	// bulletLogical[i] is the logical-line index in bodyText of bullet i
	// (parallel to cv.Bullets order). -1 when the annotated render didn't
	// expose this bullet (shouldn't happen for valid cv.json).
	bulletLogical []int

	// visualLines is bodyText word-wrapped to fit the left-pane width;
	// visualOrigin[i] is the logical-line index of visualLines[i].
	// Recomputed on resize.
	visualLines  []string
	visualOrigin []int
	wrappedWidth int

	cursor           int // index into cv.Bullets
	leftScrollOffset int

	// statusStale flips on after the first save; the score header gains a `*`
	// marker so the user knows to press R for a refreshed number.
	statusStale bool

	width, height int
	theme         theme.Theme
}

// NewCVModel loads cv.json, renders it via cv-json-to-md, and runs cv-status
// synchronously so the screen renders complete data on first paint. Failure
// surfaces as a `loadErr` placeholder — only q/Esc are active in that case.
func NewCVModel(t theme.Theme, careerOpsPath string, tabCounts map[string]int, width, height int) CVModel {
	m := CVModel{
		careerOpsPath: careerOpsPath,
		tabCounts:     tabCounts,
		width:         width,
		height:        height,
		theme:         t,
	}
	cv, err := data.LoadCV(careerOpsPath)
	if err != nil {
		m.loadErr = "Could not load user/config/cv.json: " + err.Error() +
			"\n\nRun `pnpm cv-migrate` to produce it from user/config/cv.md."
		return m
	}
	m.cv = cv

	body, logicalByID, renderErr := renderAnnotatedCV(careerOpsPath)
	if renderErr != nil {
		m.loadErr = "Could not render CV body: " + renderErr.Error() +
			"\n\nCheck that `node lib/cv-json-to-md.mjs --stdout` works in the repo."
		return m
	}
	m.bodyText = body
	m.bulletLogical = make([]int, len(cv.Bullets))
	for i, b := range cv.Bullets {
		if li, ok := logicalByID[b.ID()]; ok {
			m.bulletLogical[i] = li
		} else {
			m.bulletLogical[i] = -1
		}
	}

	m.status = data.LoadCVStatus(careerOpsPath) // nil on failure; render guards
	m.recomputeVisualLines()
	m.scrollToActive()
	return m
}

// renderAnnotatedCV shells out to lib/cv-json-to-md.mjs --annotate-ids, then
// strips the `[id]` suffix off each bullet line, returning the cleaned
// markdown text and a id → logical-line-index map.
func renderAnnotatedCV(careerOpsPath string) (string, map[string]int, error) {
	cmd := exec.Command("node", "lib/cv-json-to-md.mjs", "--annotate-ids", "--stdout")
	cmd.Dir = careerOpsPath
	out, err := cmd.Output()
	if err != nil {
		return "", nil, err
	}
	rawLines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	cleaned := make([]string, 0, len(rawLines))
	idByLine := make(map[string]int, len(rawLines))
	for i, line := range rawLines {
		if mm := bulletAnnotRE.FindStringSubmatch(line); mm != nil {
			cleaned = append(cleaned, mm[1])
			idByLine[mm[2]] = i
			continue
		}
		cleaned = append(cleaned, line)
	}
	return strings.Join(cleaned, "\n"), idByLine, nil
}

// Init satisfies tea.Model.
func (m CVModel) Init() tea.Cmd { return nil }

// Resize handles terminal resize.
func (m *CVModel) Resize(width, height int) {
	m.width = width
	m.height = height
	m.recomputeVisualLines()
	m.scrollToActive()
}

// Update handles input.
func (m CVModel) Update(msg tea.Msg) (CVModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.recomputeVisualLines()
		m.scrollToActive()
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m CVModel) handleKey(msg tea.KeyMsg) (CVModel, tea.Cmd) {
	if m.loadErr != "" || m.cv == nil {
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return CVClosedMsg{} }
		}
		return m, nil
	}

	switch msg.String() {
	case "q", "esc":
		return m, func() tea.Msg { return CVClosedMsg{} }

	// Tab cycling — close CV and let the pipeline land on the neighbouring
	// tab. CV is the rightmost tab, so left lands on PROGRESS and right wraps
	// to PRIORITY.
	case "left", "h":
		return m, func() tea.Msg { return CVClosedMsg{NavDirection: -1} }
	case "right", "l":
		return m, func() tea.Msg { return CVClosedMsg{NavDirection: +1} }

	case "down", "j":
		if m.cursor < len(m.cv.Bullets)-1 {
			m.cursor++
			m.scrollToActive()
		}
		return m, nil

	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
			m.scrollToActive()
		}
		return m, nil

	case "pgdown", "ctrl+d":
		step := m.bodyHeight() / 2
		if step < 1 {
			step = 1
		}
		m.cursor += step
		if m.cursor > len(m.cv.Bullets)-1 {
			m.cursor = len(m.cv.Bullets) - 1
		}
		m.scrollToActive()
		return m, nil

	case "pgup", "ctrl+u":
		step := m.bodyHeight() / 2
		if step < 1 {
			step = 1
		}
		m.cursor -= step
		if m.cursor < 0 {
			m.cursor = 0
		}
		m.scrollToActive()
		return m, nil

	case "g":
		m.cursor = 0
		m.scrollToActive()
		return m, nil

	case "G":
		m.cursor = len(m.cv.Bullets) - 1
		m.scrollToActive()
		return m, nil

	case "0":
		if b := m.active(); b != nil {
			b.SetTier("")
			m.persist()
		}
		return m, nil

	case "R":
		// Re-run cv-status to refresh the health score after edits. Lowercase
		// r is taken by the design archetype; pipeline's lowercase-r-as-refresh
		// muscle memory shifts up one row in this modal screen.
		m.status = data.LoadCVStatus(m.careerOpsPath)
		m.statusStale = false
		return m, nil
	}

	for _, t := range tierKeys {
		if msg.String() == t.Key {
			if b := m.active(); b != nil {
				if b.Tier() == t.Tier {
					b.SetTier("") // pressing the current tier clears it
				} else {
					b.SetTier(t.Tier)
				}
				m.persist()
			}
			return m, nil
		}
	}
	for _, a := range archetypeKeys {
		if msg.String() == a.Key {
			if b := m.active(); b != nil {
				b.ToggleArchetype(a.Name)
				m.persist()
			}
			return m, nil
		}
	}

	return m, nil
}

func (m *CVModel) persist() {
	if err := m.cv.Save(); err != nil {
		m.loadErr = "Failed to save cv.json: " + err.Error()
		return
	}
	m.statusStale = true
}

func (m *CVModel) active() *data.CVBullet {
	if m.cv == nil || m.cursor < 0 || m.cursor >= len(m.cv.Bullets) {
		return nil
	}
	return m.cv.Bullets[m.cursor]
}

// ── geometry ────────────────────────────────────────────────────────────────

func (m CVModel) bodyHeight() int {
	// tabs(2) + footer-sep(1) + footer-hints(1) + 1 row of slack = 5.
	// The slack matches the fact-check pattern: rendering exactly m.height
	// rows makes the bottom line scroll the buffer, pushing the tab bar off
	// the top. Leaving one row reserved keeps the screen pinned.
	h := m.height - 5
	if h < 5 {
		h = 5
	}
	return h
}

// leftWidth is also the column index of the vertical divider — by design,
// every horizontal slice that the divider crosses (header, hrule, body,
// footer-sep) places `│`/`┬`/`┴` at exactly this column.
func (m CVModel) leftWidth() int {
	w := m.width * 60 / 100
	if w < 40 {
		w = 40
	}
	return w
}

func (m CVModel) rightWidth() int {
	rw := m.width - m.leftWidth() - 1 // 1 col for the divider
	if rw < 28 {
		rw = 28
	}
	return rw
}

// recomputeVisualLines word-wraps bodyText to fit the left pane. The
// per-visual-line origin map lets us locate the active bullet's lines when
// rendering and scrolling.
func (m *CVModel) recomputeVisualLines() {
	// Reserve: 2 cols for the per-line "▌ "/"  " prefix + 1 col left padding +
	// 1 col right padding inside the left pane.
	w := m.leftWidth() - 4
	if w < 10 {
		w = 10
	}
	m.wrappedWidth = w
	m.visualLines = m.visualLines[:0]
	m.visualOrigin = m.visualOrigin[:0]

	for li, line := range strings.Split(m.bodyText, "\n") {
		for _, vl := range wrapPlainLine(line, w) {
			m.visualLines = append(m.visualLines, vl)
			m.visualOrigin = append(m.visualOrigin, li)
		}
	}
}

// scrollToActive recenters the viewport so the active bullet sits in the upper
// third of the left pane. Always recenters even when the bullet is already
// visible, so every ↑/↓ press produces visible motion in the left column.
func (m *CVModel) scrollToActive() {
	if m.wrappedWidth != m.leftWidth()-4 {
		m.recomputeVisualLines()
	}
	if m.cursor < 0 || m.cursor >= len(m.bulletLogical) {
		return
	}
	target := m.bulletLogical[m.cursor]
	if target < 0 {
		return
	}
	firstVisual := -1
	for i, lo := range m.visualOrigin {
		if lo == target {
			firstVisual = i
			break
		}
	}
	if firstVisual == -1 {
		return
	}
	bh := m.bodyHeight()
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

// ── view ────────────────────────────────────────────────────────────────────

// View renders the full screen. Tab bar at top (its own underline already
// reads as a horizontal rule), then body, then footer separator with `┴`,
// then footer hints. The body owns the vertical divider; the visual
// continuation up into the tab underline lands at the same column so the eye
// reads `─` over `│` as a clean junction without an explicit `┬` glyph (which
// would conflict with the active tab's heavy `━` underline).
func (m CVModel) View() string {
	tabs := renderPipelineTabBar(m.theme, filterCV, m.width, m.tabCounts)

	if m.loadErr != "" {
		errStyle := lipgloss.NewStyle().Foreground(m.theme.Red)
		hintStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		body := "\n  " + errStyle.Render(m.loadErr) + "\n\n  " +
			hintStyle.Render("Press q or Esc to return.")
		return lipgloss.JoinVertical(lipgloss.Left, tabs,
			body,
			m.renderHRule('┴'),
			m.renderFooterHints(),
		)
	}

	body := m.renderBody()
	footerSep := m.renderHRule('┴')
	footerHints := m.renderFooterHints()

	return lipgloss.JoinVertical(lipgloss.Left, tabs, body, footerSep, footerHints)
}

// renderHRule draws a full-width horizontal rule with a T-junction at the
// vertical divider's column. Used as the footer separator (`┴`).
func (m CVModel) renderHRule(junction rune) string {
	lw := m.leftWidth()
	cells := make([]rune, m.width)
	for i := range cells {
		cells[i] = '─'
	}
	if lw >= 0 && lw < len(cells) {
		cells[lw] = junction
	}
	return lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(string(cells))
}

// renderBody composes the body row-by-row: left content + divider + right
// content. The divider char sits at the same screen column as the T-junctions
// above and below.
func (m CVModel) renderBody() string {
	bh := m.bodyHeight()
	lw := m.leftWidth()
	rw := m.rightWidth()

	leftLines := m.renderLeftLines(bh, lw)
	rightLines := m.renderRightLines(bh, rw)

	div := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("│")

	rows := make([]string, bh)
	for i := 0; i < bh; i++ {
		l := ""
		if i < len(leftLines) {
			l = leftLines[i]
		}
		r := ""
		if i < len(rightLines) {
			r = rightLines[i]
		}
		rows[i] = l + div + r
	}
	return strings.Join(rows, "\n")
}

// ── left pane ───────────────────────────────────────────────────────────────

// renderLeftLines builds the left pane as a slice of exact-width rows. The
// active bullet's visual lines get a soft Surface background that spans the
// full pane width; inactive lines render with semantic styling per line type
// (heading, sub-entry, bullet by tier, chrome).
func (m CVModel) renderLeftLines(bh, lw int) []string {
	if m.bodyText == "" {
		empty := padToWidth("  (empty CV)", lw, m.theme.Subtext, lipgloss.Color(""))
		out := []string{empty}
		for len(out) < bh {
			out = append(out, padToWidth("", lw, m.theme.Text, lipgloss.Color("")))
		}
		return out
	}

	activeLogical := -1
	if m.cursor >= 0 && m.cursor < len(m.bulletLogical) {
		activeLogical = m.bulletLogical[m.cursor]
	}

	start := m.leftScrollOffset
	if start < 0 {
		start = 0
	}
	if start > len(m.visualLines) {
		start = len(m.visualLines)
	}
	end := start + bh
	if end > len(m.visualLines) {
		end = len(m.visualLines)
	}
	visible := m.visualLines[start:end]
	visibleOrigin := m.visualOrigin[start:end]
	logicalLines := strings.Split(m.bodyText, "\n")

	out := make([]string, 0, bh)
	for i, line := range visible {
		out = append(out, m.renderLeftRow(line, visibleOrigin[i], logicalLines, activeLogical, lw))
	}
	for len(out) < bh {
		out = append(out, padToWidth("", lw, m.theme.Text, lipgloss.Color("")))
	}
	return out
}

// renderLeftRow returns a single styled left-pane row of exactly `lw` cells.
// One style is applied to the whole row in a single Render call — this is
// load-bearing for the active-row background: composing inner-styled segments
// inside an outer Background style lets inner ANSI resets cancel the bg
// mid-row, producing scroll-time streaks.
func (m CVModel) renderLeftRow(visual string, logicalIdx int, logicalLines []string, activeLogical, lw int) string {
	active := logicalIdx == activeLogical

	marker := "  "
	if active {
		marker = "▌ "
	}

	plain := marker + visual
	pw := lipgloss.Width(plain)
	if pw > lw {
		plain = truncateToWidth(plain, lw)
		pw = lipgloss.Width(plain)
	}
	if pw < lw {
		plain += strings.Repeat(" ", lw-pw)
	}

	return m.styleForLeftLine(logicalIdx, logicalLines, active).Render(plain)
}

// styleForLeftLine resolves the foreground / weight / (optional) background
// for a single left-pane row from the underlying logical line. Active rows
// win all styling and add the Surface background; inactive rows get tier-by-
// foreground (for bullets) or section colours (for headings / chrome).
func (m CVModel) styleForLeftLine(logicalIdx int, logicalLines []string, active bool) lipgloss.Style {
	if active {
		return lipgloss.NewStyle().
			Foreground(m.theme.Blue).
			Bold(true).
			Background(m.theme.Surface)
	}
	if logicalIdx < 0 || logicalIdx >= len(logicalLines) {
		return lipgloss.NewStyle().Foreground(m.theme.Subtext)
	}
	trimmed := strings.TrimLeft(logicalLines[logicalIdx], " ")
	switch {
	case strings.HasPrefix(trimmed, "# "):
		return lipgloss.NewStyle().Foreground(m.theme.Mauve).Bold(true)
	case strings.HasPrefix(trimmed, "## "):
		return lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	case strings.HasPrefix(trimmed, "### "):
		return lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	case strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed[2:], "**"):
		return lipgloss.NewStyle().Foreground(m.theme.Peach).Bold(true)
	case strings.HasPrefix(trimmed, "- "):
		return m.bulletStyleByTier(logicalIdx)
	case strings.HasPrefix(trimmed, ":::"):
		return lipgloss.NewStyle().Foreground(m.theme.Overlay)
	default:
		return lipgloss.NewStyle().Foreground(m.theme.Subtext)
	}
}

// bulletStyleByTier returns the foreground style for an inactive bullet line
// based on its tier. The hierarchy makes tier distribution visible at a glance
// without disrupting the resume layout.
func (m CVModel) bulletStyleByTier(logicalIdx int) lipgloss.Style {
	tier := ""
	for i, li := range m.bulletLogical {
		if li == logicalIdx && i < len(m.cv.Bullets) {
			tier = m.cv.Bullets[i].Tier()
			break
		}
	}
	switch tier {
	case "core":
		return lipgloss.NewStyle().Foreground(m.theme.Text).Bold(true)
	case "default":
		return lipgloss.NewStyle().Foreground(m.theme.Text)
	case "depth":
		return lipgloss.NewStyle().Foreground(m.theme.Subtext)
	default: // untagged
		return lipgloss.NewStyle().Foreground(m.theme.Subtext).Italic(true)
	}
}

// ── right pane ──────────────────────────────────────────────────────────────

// renderRightLines builds the right pane as a slice of exact-width rows. The
// selected bullet's id and role sit at the top; the body text is intentionally
// not duplicated here (the left pane already shows it under the marker).
func (m CVModel) renderRightLines(bh, rw int) []string {
	b := m.active()
	if b == nil {
		out := []string{padToWidth("  (no selection)", rw, m.theme.Subtext, lipgloss.Color(""))}
		for len(out) < bh {
			out = append(out, padToWidth("", rw, m.theme.Text, lipgloss.Color("")))
		}
		return out
	}

	label := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	subtext := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	idStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve)

	dividerLine := lipgloss.NewStyle().
		Foreground(m.theme.Overlay).
		Render(strings.Repeat("─", max(0, rw-2)))

	// indent2 is the gutter for top-level content (id, role, section headings,
	// tip text). Toggle rows and health rows carry their own 4-col indent
	// (`    [w] …`, `    ✅ Files …`) so nested items sit under their parent.
	indent2 := "  "

	lines := []string{
		indent2 + idStyle.Render(b.ID()),
		indent2 + subtext.Render(b.RoleLabel),
		dividerLine,

		indent2 + label.Render("Tier"),
	}
	for _, t := range tierKeys {
		lines = append(lines, renderToggleRow(m.theme, t.Key, t.Tier, b.Tier() == t.Tier))
	}
	lines = append(lines, "", indent2+label.Render("Archetypes"))
	for _, a := range archetypeKeys {
		lines = append(lines, renderToggleRow(m.theme, a.Key, a.Name, b.HasArchetype(a.Name)))
	}

	lines = append(lines, "", dividerLine)
	tipHeader := lipgloss.NewStyle().Foreground(m.theme.Yellow).Bold(true).Render("💡 Need a guided walkthrough?")
	tipCmd := lipgloss.NewStyle().Foreground(m.theme.Green).Render("/career-ops cv optimize")
	lines = append(lines,
		indent2+tipHeader,
		indent2+subtext.Render("Run ")+tipCmd+subtext.Render(" in your agent"),
		indent2+subtext.Render("for prioritized next actions."),
	)

	// CV health checklist — clipped first on short terminals, since the
	// editing controls above are the primary work surface. The heading row
	// inlines the overall score + bar + bullet count (the score header
	// disappeared from the top of the screen with the header chrome).
	if m.status != nil && !m.status.Onboarding && len(m.status.Sections) > 0 {
		lines = append(lines, "", m.renderHealthHeading(rw, label, subtext))
		for _, s := range m.status.Sections {
			lines = append(lines, m.renderHealthRow(s, rw))
		}
	}

	out := make([]string, 0, bh)
	for _, ln := range lines {
		out = append(out, padToWidth(ln, rw, m.theme.Text, lipgloss.Color("")))
	}

	if len(out) > bh {
		out = out[:bh]
	}
	for len(out) < bh {
		out = append(out, padToWidth("", rw, m.theme.Text, lipgloss.Color("")))
	}
	return out
}

// renderHealthHeading composes the CV Health section heading: the label on
// the left, then score, progress bar, and bullet count on the right — exactly
// what used to live in the top-of-screen header. The bar adapts to whatever
// horizontal space remains after fixed elements are budgeted; on a tight pane
// the bar shrinks first, then the bullet count drops, leaving the score and
// label as the irreducible minimum.
func (m CVModel) renderHealthHeading(rw int, label, subtext lipgloss.Style) string {
	indent := "  "
	title := label.Render("CV Health")

	pct := 0.0
	if m.status.Max > 0 {
		pct = m.status.Score / m.status.Max
	}
	score := scoreColor(m.theme, pct).
		Render(fmt.Sprintf("%.1f/%.0f", m.status.Score, m.status.Max))

	stale := ""
	if m.statusStale {
		stale = subtext.Render(" *")
	}

	bullets := ""
	if m.cv != nil {
		bullets = subtext.Render(fmt.Sprintf("%d bullets", len(m.cv.Bullets)))
	}

	// Right side budget: pane - (indent + title + 1 col gap before score) -
	// (1 col right gutter). Then we subtract score+stale and try to fit a bar
	// plus the bullet count.
	rightAvail := rw - 1 - lipgloss.Width(indent) - lipgloss.Width(title) - 1 -
		lipgloss.Width(score) - lipgloss.Width(stale)

	// Reserve `2 + len(bullets)` cells for "  N bullets" if it fits.
	bulletsBudget := 2 + lipgloss.Width(bullets)
	barBudget := rightAvail - bulletsBudget - 1 // 1 = space between score and bar
	if barBudget < 4 {
		// Drop the bullet count when the pane is too tight for both.
		bullets = ""
		bulletsBudget = 0
		barBudget = rightAvail - 1
	}
	barW := barBudget
	if barW > 18 {
		barW = 18
	}
	if barW < 0 {
		barW = 0
	}

	var bar string
	if barW > 0 {
		bar = subtext.Render(progressBar(pct, barW))
	}

	parts := []string{indent + title, " ", score + stale}
	if bar != "" {
		parts = append(parts, " ", bar)
	}
	if bullets != "" {
		parts = append(parts, "  ", bullets)
	}
	return strings.Join(parts, "")
}

// renderHealthRow builds a single CV Health row with a left-aligned icon+label
// and a right-aligned score. Widths are measured in display cells via
// lipgloss.Width so the score never wraps off the pane.
func (m CVModel) renderHealthRow(s data.CVStatusSection, rw int) string {
	pct := 0.0
	if s.Max > 0 {
		pct = s.Score / s.Max
	}
	icon := scoreIcon(pct)
	score := scoreColor(m.theme, pct).Render(fmt.Sprintf("%.1f/%.0f", s.Score, s.Max))

	left := "    " + icon + " "
	// Row width budget: pane width minus right gutter (1) minus icon+label
	// area minus the score string. avail is what's left for the label itself.
	avail := rw - 1 - lipgloss.Width(left) - lipgloss.Width(score) - 1
	if avail < 4 {
		avail = 4
	}
	labelText := truncateToWidth(s.Label, avail)
	label := lipgloss.NewStyle().Foreground(m.theme.Text).Render(labelText)

	gap := avail - lipgloss.Width(label)
	if gap < 1 {
		gap = 1
	}
	return left + label + strings.Repeat(" ", gap) + score
}

// renderToggleRow is the shared visual for tier and archetype rows: 4-col
// indent so the row sits visibly under its 2-col-indented section heading,
// then a hotkey chip, a name, and a green check when active.
func renderToggleRow(t theme.Theme, hotkey, name string, active bool) string {
	key := lipgloss.NewStyle().Foreground(t.Blue).Bold(true).Underline(true)
	label := lipgloss.NewStyle().Foreground(t.Text)
	mark := ""
	if active {
		mark = lipgloss.NewStyle().Foreground(t.Green).Render(" ✓")
	}
	return "    [" + key.Render(hotkey) + "] " + label.Render(name) + mark
}

// ── footer ──────────────────────────────────────────────────────────────────

func (m CVModel) renderFooterHints() string {
	rowStyle := lipgloss.NewStyle().Padding(0, 1)
	hotkey := lipgloss.NewStyle().Foreground(m.theme.Blue).Underline(true)
	text := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	hint := func(prefix, key, suffix string) string {
		return text.Render(prefix) + hotkey.Render(key) + text.Render(suffix)
	}
	parts := []string{
		hint("", "↑↓", " navigate"),
		hint("", "1/2/3", " tier"),
		hint("", "0", " clear tier"),
		hint("", "w/e/r", " archetype"),
		hint("", "R", "efresh"),
		hint("", "q", " back"),
	}
	return rowStyle.Render(strings.Join(parts, "  "))
}

// ── style helpers ────────────────────────────────────────────────────────────

func scoreColor(t theme.Theme, pct float64) lipgloss.Style {
	switch {
	case pct >= 0.9:
		return lipgloss.NewStyle().Foreground(t.Green)
	case pct >= 0.7:
		return lipgloss.NewStyle().Foreground(t.Yellow)
	case pct >= 0.5:
		return lipgloss.NewStyle().Foreground(t.Peach)
	default:
		return lipgloss.NewStyle().Foreground(t.Red)
	}
}

func scoreIcon(pct float64) string {
	switch {
	case pct >= 0.9:
		return "✅"
	case pct >= 0.7:
		return "🟢"
	case pct >= 0.5:
		return "🟡"
	default:
		return "🔴"
	}
}

func progressBar(pct float64, width int) string {
	if width < 1 {
		width = 1
	}
	if pct < 0 {
		pct = 0
	}
	if pct > 1 {
		pct = 1
	}
	n := int(pct*float64(width) + 0.5)
	return strings.Repeat("█", n) + strings.Repeat("░", width-n)
}

// truncateToWidth shrinks `s` to fit into `width` display cells, appending an
// ellipsis when truncated. Uses lipgloss.Width so wide-display runes (emoji,
// CJK) are measured correctly. ANSI-styled strings are truncated by walking
// runes outside-in until the visible width fits; escape sequences are
// preserved verbatim because they have zero display width.
func truncateToWidth(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= width {
		return s
	}
	runes := []rune(s)
	for len(runes) > 0 && lipgloss.Width(string(runes))+1 > width {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}

// padToWidth right-pads `content` to exactly `width` display cells. When
// content exceeds the target, falls back to a non-wrapping truncate — using
// lipgloss `Width` would silently word-wrap the row onto a second visual
// line, which is what makes the tab bar scroll off the top.
func padToWidth(content string, width int, _, _ lipgloss.Color) string {
	cw := lipgloss.Width(content)
	if cw == width {
		return content
	}
	if cw < width {
		return content + strings.Repeat(" ", width-cw)
	}
	return truncateToWidth(content, width)
}
