package screens

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"

	"career-ops/dashboard/internal/theme"
)

// sampleReport mixes long prose, a long bullet, a bold field, a heading and a
// table — the line shapes a real report contains.
const sampleReport = `# Acme — Head of Product

**Score:** 4.2/5

## Triage

- Alex's B2B SaaS product leadership at scale (0→$2M ARR at Globex, team management, cross-functional execution) maps directly to the role's requirement for managing Product Owners and aligning roadmaps across multiple squads.

This is an ordinary paragraph that keeps going well past the available width so that it must be re-flowed onto several lines instead of disappearing off the right edge of the terminal viewport.

| Block | Weight | Score |
|-------|--------|-------|
| A     | 0.4    | 4.0   |
| B     | 0.6    | 4.5   |
`

func newSampleViewer(t *testing.T, width, height int) ViewerModel {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "report.md")
	if err := os.WriteFile(path, []byte(sampleReport), 0o600); err != nil {
		t.Fatalf("write sample: %v", err)
	}
	return NewViewerModel(theme.NewTheme("mocha"), path, "Acme", width, height)
}

// TestVisualLinesFitWidth is the regression guard for the off-screen-lines bug:
// every re-flowed visual line must fit within the viewport's content area at a
// range of widths (visible width, ANSI-aware).
func TestVisualLinesFitWidth(t *testing.T) {
	for _, width := range []int{40, 60, 80, 120} {
		m := newSampleViewer(t, width, 24)
		limit := width - 4 // renderBody's Padding(0, 2) on each side
		for i, vl := range m.visualLines {
			if w := lipgloss.Width(vl); w > limit {
				t.Errorf("width=%d: visual line %d is %d cols (>%d): %q",
					width, i, w, limit, vl)
			}
		}
	}
}

// TestReflowOnResize confirms the document re-wraps when the width changes:
// narrowing produces more visual lines, widening fewer.
func TestReflowOnResize(t *testing.T) {
	m := newSampleViewer(t, 120, 24)
	wide := len(m.visualLines)

	m.Resize(50, 24)
	narrow := len(m.visualLines)
	if narrow <= wide {
		t.Fatalf("expected more visual lines after narrowing: wide=%d narrow=%d", wide, narrow)
	}

	m.Resize(120, 24)
	if got := len(m.visualLines); got != wide {
		t.Fatalf("re-widening should restore line count: got=%d want=%d", got, wide)
	}
}

// TestLongBulletHangingIndent checks that a wrapped bullet's continuation lines
// are indented under the text (not back at column 0) and that the bullet text
// survives the wrap.
func TestLongBulletHangingIndent(t *testing.T) {
	m := newSampleViewer(t, 50, 24)
	// Locate the bullet's visual lines: first starts with "- ", continuations
	// are indented by two spaces.
	var firstIdx = -1
	for i, vl := range m.visualLines {
		if strings.HasPrefix(stripANSI(vl), "- Alex") {
			firstIdx = i
			break
		}
	}
	if firstIdx == -1 {
		t.Fatal("bullet first line not found")
	}
	cont := stripANSI(m.visualLines[firstIdx+1])
	if !strings.HasPrefix(cont, "  ") || strings.HasPrefix(cont, "  -") {
		t.Errorf("expected hanging indent on continuation, got %q", cont)
	}
}

// stripANSI removes SGR escape sequences so tests can assert on visible text.
func stripANSI(s string) string {
	var b strings.Builder
	inEsc := false
	for _, r := range s {
		switch {
		case r == 0x1b:
			inEsc = true
		case inEsc && r == 'm':
			inEsc = false
		case inEsc:
			// skip escape body
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
