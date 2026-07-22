package screens

import (
	"os"
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"career-ops/dashboard/internal/theme"
)

// ViewerClosedMsg is emitted when the viewer is dismissed.
type ViewerClosedMsg struct{}

// ViewerNavigateMsg is emitted when the user wants to move to the adjacent job
// in the pipeline list while staying in the report viewer. Delta is -1 for the
// previous job, +1 for the next.
type ViewerNavigateMsg struct{ Delta int }

// ViewerOpenURLMsg is emitted when the user asks to open the current job's URL.
type ViewerOpenURLMsg struct{}

// ViewerDiscardMsg is emitted when the user asks to discard the current job.
type ViewerDiscardMsg struct{}

// ViewerTailorMsg is emitted when the user asks for the interactive tailor
// session for the current job (t). Main routes it to PipelineTailorMsg.
type ViewerTailorMsg struct{}

// ViewerChangeStatusMsg is emitted when the user asks to change the status of
// the current job. Main routes this back to the pipeline's status picker.
type ViewerChangeStatusMsg struct{}

// ViewerModel implements an integrated file viewer screen.
//
// lines holds the raw source lines; visualLines holds those re-flowed and
// styled to the current width, and is what the viewport scrolls over. Long
// prose lines are word-wrapped so nothing runs off the right edge, and the
// whole thing is recomputed whenever the width changes (see recomputeVisual).
type ViewerModel struct {
	lines        []string
	visualLines  []string
	wrappedWidth int
	title        string
	scrollOffset int
	width        int
	height       int
	theme        theme.Theme
}

// NewViewerModel creates a new file viewer for the given path.
func NewViewerModel(t theme.Theme, path, title string, width, height int) ViewerModel {
	content, err := os.ReadFile(path)
	if err != nil {
		content = []byte("Error reading file: " + err.Error())
	}

	m := ViewerModel{
		lines:  strings.Split(string(content), "\n"),
		title:  title,
		width:  width,
		height: height,
		theme:  t,
	}
	m.recomputeVisual()
	return m
}

func (m ViewerModel) Init() tea.Cmd {
	return nil
}

func (m *ViewerModel) Resize(width, height int) {
	m.width = width
	m.height = height
	if m.wrappedWidth != width {
		m.recomputeVisual()
	}
	m.clampScroll()
}

// clampScroll keeps the scroll offset within the current document bounds, e.g.
// after a resize shrinks the wrapped document or grows the viewport.
func (m *ViewerModel) clampScroll() {
	maxScroll := len(m.visualLines) - m.bodyHeight()
	if maxScroll < 0 {
		maxScroll = 0
	}
	if m.scrollOffset > maxScroll {
		m.scrollOffset = maxScroll
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

func (m ViewerModel) Update(msg tea.Msg) (ViewerModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return ViewerClosedMsg{} }

		case "down", "j":
			maxScroll := len(m.visualLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			if m.scrollOffset < maxScroll {
				m.scrollOffset++
			}

		case "up", "k":
			if m.scrollOffset > 0 {
				m.scrollOffset--
			}

		case "pgdown", "ctrl+d":
			jump := m.bodyHeight() / 2
			maxScroll := len(m.visualLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			m.scrollOffset += jump
			if m.scrollOffset > maxScroll {
				m.scrollOffset = maxScroll
			}

		case "pgup", "ctrl+u":
			jump := m.bodyHeight() / 2
			m.scrollOffset -= jump
			if m.scrollOffset < 0 {
				m.scrollOffset = 0
			}

		case "home":
			m.scrollOffset = 0

		case "end":
			maxScroll := len(m.visualLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			m.scrollOffset = maxScroll

		case "left", "h":
			return m, func() tea.Msg { return ViewerNavigateMsg{Delta: -1} }

		case "right", "l":
			return m, func() tea.Msg { return ViewerNavigateMsg{Delta: 1} }

		case "o":
			return m, func() tea.Msg { return ViewerOpenURLMsg{} }

		case "c":
			return m, func() tea.Msg { return ViewerChangeStatusMsg{} }

		case "d":
			return m, func() tea.Msg { return ViewerDiscardMsg{} }

		case "t":
			return m, func() tea.Msg { return ViewerTailorMsg{} }
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		if m.wrappedWidth != m.width {
			m.recomputeVisual()
		}
		m.clampScroll()
	}

	return m, nil
}

func (m ViewerModel) bodyHeight() int {
	h := m.height - 5 // header + separator + footer + padding
	if h < 3 {
		h = 3
	}
	return h
}

func (m ViewerModel) View() string {
	header := m.renderHeader()
	body := m.renderBody()
	footer := m.renderFooter()

	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m ViewerModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render(m.title)

	right := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	pos := right.Render(strings.TrimRight(
		strings.Repeat(" ", max(0, m.width-lipgloss.Width(m.title)-30)),
		" ",
	))

	lineInfo := right.Render(
		strings.Join([]string{
			"L",
			strings.TrimSpace(lipgloss.NewStyle().Render(
				strings.Join([]string{
					func() string {
						s := m.scrollOffset + 1
						if s > len(m.visualLines) {
							s = len(m.visualLines)
						}
						return string(rune('0'+s/100%10)) + string(rune('0'+s/10%10)) + string(rune('0'+s%10))
					}(),
				}, ""),
			)),
			"/",
			func() string {
				t := len(m.visualLines)
				return string(rune('0'+t/100%10)) + string(rune('0'+t/10%10)) + string(rune('0'+t%10))
			}(),
		}, ""),
	)
	_ = pos
	_ = lineInfo

	scroll := right.Render(func() string {
		if len(m.visualLines) == 0 {
			return ""
		}
		pct := 0
		maxScroll := len(m.visualLines) - m.bodyHeight()
		if maxScroll > 0 {
			pct = m.scrollOffset * 100 / maxScroll
		}
		if m.scrollOffset == 0 {
			return "Top"
		}
		if m.scrollOffset >= maxScroll {
			return "End"
		}
		return func() string {
			s := pct
			return string(rune('0'+s/10%10)) + string(rune('0'+s%10)) + "%"
		}()
	}())

	gap := m.width - lipgloss.Width(m.title) - lipgloss.Width(scroll) - 4
	if gap < 1 {
		gap = 1
	}

	return style.Render(title + strings.Repeat(" ", gap) + scroll)
}

func (m ViewerModel) renderBody() string {
	bh := m.bodyHeight()
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	if len(m.visualLines) == 0 {
		emptyStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		return padStyle.Render(emptyStyle.Render("(empty file)"))
	}

	end := m.scrollOffset + bh
	if end > len(m.visualLines) {
		end = len(m.visualLines)
	}
	styled := append([]string(nil), m.visualLines[m.scrollOffset:end]...)

	// Pad to fill height
	for len(styled) < bh {
		styled = append(styled, "")
	}

	return padStyle.Render(strings.Join(styled, "\n"))
}

// recomputeVisual re-flows the raw document into width-fitted, styled visual
// lines. Tables are rendered as fixed-width blocks (already shrunk to fit by
// computeColumnWidths); every other line is word-wrapped by styleLines so long
// prose no longer runs off the right edge. Called on load and whenever the
// width changes.
func (m *ViewerModel) recomputeVisual() {
	m.wrappedWidth = m.width
	width := m.width - 4 // matches renderBody's Padding(0, 2)
	if width < 8 {
		width = 8
	}
	m.visualLines = m.visualLines[:0]

	i := 0
	for i < len(m.lines) {
		if isTableLine(m.lines[i]) {
			start := i
			for i < len(m.lines) && isTableLine(m.lines[i]) {
				i++
			}
			block := m.lines[start:i]
			colWidths := computeColumnWidths(block, m.width-6)
			m.visualLines = append(m.visualLines, m.renderTableBlock(block, colWidths, start)...)
			continue
		}
		m.visualLines = append(m.visualLines, m.styleLines(m.lines[i], width)...)
		i++
	}

	m.clampScroll()
}

// isTableLine checks if a line is part of a markdown table.
func isTableLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return len(trimmed) > 1 && trimmed[0] == '|'
}

// isTableSeparator checks if a line is a table separator (|---|---|).
func isTableSeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "|") {
		return false
	}
	cleaned := strings.NewReplacer("|", "", "-", "", ":", "", " ", "").Replace(trimmed)
	return cleaned == ""
}

// parseTableCells splits a table line into trimmed cells.
func parseTableCells(line string) []string {
	trimmed := strings.TrimSpace(line)
	// Remove leading and trailing pipes
	if len(trimmed) > 0 && trimmed[0] == '|' {
		trimmed = trimmed[1:]
	}
	if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '|' {
		trimmed = trimmed[:len(trimmed)-1]
	}
	parts := strings.Split(trimmed, "|")
	cells := make([]string, len(parts))
	for i, p := range parts {
		cells[i] = strings.TrimSpace(p)
	}
	return cells
}

// computeColumnWidths calculates max width per column across all table rows.
func computeColumnWidths(lines []string, maxTotal int) []int {
	maxCols := 0
	for _, line := range lines {
		if isTableSeparator(line) {
			continue
		}
		cells := parseTableCells(line)
		if len(cells) > maxCols {
			maxCols = len(cells)
		}
	}
	if maxCols == 0 {
		return nil
	}

	widths := make([]int, maxCols)
	for _, line := range lines {
		if isTableSeparator(line) {
			continue
		}
		cells := parseTableCells(line)
		for i, cell := range cells {
			if i < maxCols {
				w := lipgloss.Width(cell)
				if w > widths[i] {
					widths[i] = w
				}
			}
		}
	}

	// Cap individual columns based on column count
	maxColW := 45
	if maxCols > 5 {
		maxColW = 30
	}
	if maxCols > 7 {
		maxColW = 22
	}
	for i := range widths {
		if widths[i] > maxColW {
			widths[i] = maxColW
		}
		if widths[i] < 3 {
			widths[i] = 3
		}
	}

	// Shrink to fit available width
	for {
		total := 1 // trailing border
		for _, w := range widths {
			total += w + 3 // cell padding + border
		}
		if total <= maxTotal {
			break
		}
		// Find the widest column and shrink it by 1
		widestIdx := 0
		widestVal := 0
		for i, w := range widths {
			if w > widestVal {
				widestVal = w
				widestIdx = i
			}
		}
		if widths[widestIdx] <= 3 {
			break // can't shrink further
		}
		widths[widestIdx]--
	}

	return widths
}

// renderTableBlock renders table lines with aligned columns and box-drawing borders.
func (m ViewerModel) renderTableBlock(lines []string, colWidths []int, firstLineIdx int) []string {
	if len(lines) == 0 || len(colWidths) == 0 {
		// Fallback: render as plain text
		var result []string
		for _, line := range lines {
			result = append(result, m.styleLine(line))
		}
		return result
	}

	maxCols := len(colWidths)
	borderStyle := lipgloss.NewStyle().Foreground(m.theme.Overlay)
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	dataStyle := lipgloss.NewStyle().Foreground(m.theme.Text)

	// Build top border
	var result []string
	var topParts []string
	for _, w := range colWidths {
		topParts = append(topParts, strings.Repeat("─", w+2))
	}
	result = append(result, borderStyle.Render("┌"+strings.Join(topParts, "┬")+"┐"))

	isFirstDataRow := true
	for _, line := range lines {
		if isTableSeparator(line) {
			// Render middle separator
			var sepParts []string
			for _, w := range colWidths {
				sepParts = append(sepParts, strings.Repeat("─", w+2))
			}
			result = append(result, borderStyle.Render("├"+strings.Join(sepParts, "┼")+"┤"))
			continue
		}

		cells := parseTableCells(line)
		var paddedCells []string
		for i := 0; i < maxCols; i++ {
			cell := ""
			if i < len(cells) {
				cell = cells[i]
			}
			cellWidth := lipgloss.Width(cell)
			colW := colWidths[i]

			if cellWidth > colW {
				// Truncate — need to handle multi-byte/emoji carefully
				runes := []rune(cell)
				truncated := string(runes)
				for lipgloss.Width(truncated) > colW-3 && len(runes) > 0 {
					runes = runes[:len(runes)-1]
					truncated = string(runes)
				}
				cell = truncated + "..."
				cellWidth = lipgloss.Width(cell)
			}

			padding := colW - cellWidth
			if padding < 0 {
				padding = 0
			}
			paddedCells = append(paddedCells, " "+cell+strings.Repeat(" ", padding)+" ")
		}

		// Build row with borders
		border := borderStyle.Render("│")
		var rowParts []string
		for _, cell := range paddedCells {
			if isFirstDataRow {
				rowParts = append(rowParts, headerStyle.Render(cell))
			} else {
				rowParts = append(rowParts, dataStyle.Render(cell))
			}
		}
		row := border + strings.Join(rowParts, border) + border
		result = append(result, row)
		isFirstDataRow = false
	}

	// Bottom border
	var bottomParts []string
	for _, w := range colWidths {
		bottomParts = append(bottomParts, strings.Repeat("─", w+2))
	}
	result = append(result, borderStyle.Render("└"+strings.Join(bottomParts, "┴")+"┘"))

	return result
}

var reBold = regexp.MustCompile(`\*\*([^*]+)\*\*`)

// styleLine renders one source line as a single styled string. Kept for the
// table-block fallback path; the scrolling body uses styleLines instead.
func (m ViewerModel) styleLine(line string) string {
	return strings.Join(m.styleLines(line, m.width-4), "\n")
}

// styleLines renders one source line into one or more fully-styled visual
// lines, each no wider than width columns. A wrapped line's continuations get a
// hanging indent that aligns under the content, and every returned line is
// self-contained (opens and closes its own SGR) so the viewport can start
// scrolling at any visual line without losing color.
func (m ViewerModel) styleLines(line string, width int) []string {
	if width < 8 {
		width = 8
	}
	trimmed := strings.TrimSpace(line)

	// Horizontal rule — generated at the target width, never wrapped.
	if trimmed == "---" || trimmed == "***" {
		return []string{lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Repeat("─", width))}
	}

	// Leading whitespace (nested lists) is preserved as a plain indent.
	lead := line[:len(line)-len(strings.TrimLeft(line, " \t"))]

	// Decompose the line into: a styled marker shown on the first visual line, a
	// hanging indent applied to continuations, the plain content to wrap, and a
	// styler applied to each wrapped content segment.
	var marker, hang, content string
	var styleFn func(string) string

	switch {
	case strings.HasPrefix(trimmed, "# ") && !strings.HasPrefix(trimmed, "## "):
		marker, hang, content = "  ", "  ", strings.TrimPrefix(trimmed, "# ")
		styleFn = func(s string) string {
			return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render(s)
		}
	case strings.HasPrefix(trimmed, "## ") && !strings.HasPrefix(trimmed, "### "):
		marker, hang, content = "  ", "  ", strings.TrimPrefix(trimmed, "## ")
		styleFn = func(s string) string {
			return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Render(s)
		}
	case strings.HasPrefix(trimmed, "### "):
		marker, hang, content = "  ", "  ", strings.TrimPrefix(trimmed, "### ")
		styleFn = func(s string) string {
			return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky).Render(s)
		}
	case strings.HasPrefix(trimmed, "> "):
		border := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("▎ ")
		marker, hang, content = border, border, strings.TrimPrefix(trimmed, "> ")
		styleFn = func(s string) string {
			return lipgloss.NewStyle().Foreground(m.theme.Subtext).Italic(true).Render(s)
		}
	case strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed, ":**"):
		// Bold fields like **Score:** 4.0/5 — keep the markers for renderInlineBold.
		marker, hang, content = lead, lead, trimmed
		styleFn = func(s string) string { return m.renderInlineBold(s, m.theme.Yellow) }
	case strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* "):
		bullet := lipgloss.NewStyle().Foreground(m.theme.Text).Render(trimmed[:2])
		marker, hang, content = lead+bullet, lead+"  ", trimmed[2:]
		styleFn = func(s string) string { return m.renderInlineBold(s, m.theme.Text) }
	case numberedMarker(trimmed) > 0:
		n := numberedMarker(trimmed)
		mk := lipgloss.NewStyle().Foreground(m.theme.Text).Render(trimmed[:n])
		marker, hang, content = lead+mk, lead+strings.Repeat(" ", n), trimmed[n:]
		styleFn = func(s string) string { return m.renderInlineBold(s, m.theme.Text) }
	default:
		marker, hang, content = lead, lead, strings.TrimLeft(line, " \t")
		styleFn = func(s string) string { return m.renderInlineBold(s, m.theme.Subtext) }
	}

	contentWidth := width - lipgloss.Width(hang)
	if contentWidth < 4 {
		contentWidth = 4
	}

	segs := wrapPlainLine(content, contentWidth)
	out := make([]string, 0, len(segs))
	for i, seg := range segs {
		if i == 0 {
			out = append(out, marker+styleFn(seg))
		} else {
			out = append(out, hang+styleFn(seg))
		}
	}
	return out
}

// numberedMarker returns the byte length of an ordered-list "N. " marker at the
// start of trimmed (e.g. 3 for "1. "), or 0 if it is not an ordered-list item.
func numberedMarker(trimmed string) int {
	idx := strings.Index(trimmed, ". ")
	if idx <= 0 {
		return 0
	}
	for _, r := range trimmed[:idx] {
		if r < '0' || r > '9' {
			return 0
		}
	}
	return idx + 2
}

// renderInlineBold renders a line with **bold** segments highlighted.
func (m ViewerModel) renderInlineBold(line string, baseColor lipgloss.Color) string {
	baseStyle := lipgloss.NewStyle().Foreground(baseColor)
	boldStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)

	matches := reBold.FindAllStringIndex(line, -1)
	if len(matches) == 0 {
		return baseStyle.Render(line)
	}

	var result strings.Builder
	last := 0
	for _, loc := range matches {
		// Render text before the bold
		if loc[0] > last {
			result.WriteString(baseStyle.Render(line[last:loc[0]]))
		}
		// Extract bold content (without **)
		boldText := line[loc[0]+2 : loc[1]-2]
		result.WriteString(boldStyle.Render(boldText))
		last = loc[1]
	}
	// Render remaining text
	if last < len(line) {
		result.WriteString(baseStyle.Render(line[last:]))
	}

	return result.String()
}

func (m ViewerModel) renderFooter() string {
	rowStyle := lipgloss.NewStyle().Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Foreground(m.theme.Blue).Underline(true)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	separator := lipgloss.NewStyle().
		Foreground(m.theme.Overlay).
		Padding(0, 1).
		Render(strings.Repeat("─", max(0, m.width-2)))

	return separator + "\n" + rowStyle.Render(
		keyStyle.Render("o")+descStyle.Render(" open URL  ")+
			keyStyle.Render("t")+descStyle.Render(" tailor  ")+
			keyStyle.Render("c")+descStyle.Render(" change  ")+
			keyStyle.Render("d")+descStyle.Render(" discard  ")+
			keyStyle.Render("Esc")+descStyle.Render(" back"))
}
