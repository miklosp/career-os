package data

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"career-ops/dashboard/internal/paths"
)

// CV is the in-memory editable mirror of config/cv.json.
//
// Only `work` is deserialized into typed structs (because we need to mutate
// per-bullet tier/archetypes). Every other top-level field is held as
// json.RawMessage so it round-trips byte-identical — preserving cv.json's
// JS-derived top-level key order (basics, skills_inventory, languages_line,
// evidence_refs, work, education), which Go's map encoder would otherwise
// reorder alphabetically.
type CV struct {
	Path string
	file cvFile

	Bullets []*CVBullet // flat list across roles + sub-entries, in source order
}

type cvFile struct {
	Basics          json.RawMessage `json:"basics,omitempty"`
	SkillsInventory json.RawMessage `json:"skills_inventory,omitempty"`
	LanguagesLine   json.RawMessage `json:"languages_line,omitempty"`
	EvidenceRefs    json.RawMessage `json:"evidence_refs,omitempty"`
	Work            []*cvWork       `json:"work"`
	Education       json.RawMessage `json:"education,omitempty"`
}

// cvWork mirrors lib/cv-schema.mjs's parseCvMarkdown output. Field order
// matters: Go marshals struct fields in declaration order, so this matches the
// canonical layout produced by `pnpm cv-migrate`.
type cvWork struct {
	HeadingRaw  string         `json:"headingRaw"`
	Position    string         `json:"position"`
	Company     string         `json:"company"`
	Slug        string         `json:"slug"`
	Highlights  []*cvHighlight `json:"highlights"`
	SubEntries  []*cvSubEntry  `json:"subEntries,omitempty"`
	DateRange   string         `json:"dateRange,omitempty"`
	MetaRaw     string         `json:"metaRaw,omitempty"`
	Description string         `json:"description,omitempty"`
}

type cvSubEntry struct {
	HeadingRaw string         `json:"headingRaw"`
	Slug       string         `json:"slug"`
	Highlights []*cvHighlight `json:"highlights"`
}

type cvHighlight struct {
	ID         string   `json:"id"`
	Text       string   `json:"text"`
	Tier       string   `json:"tier,omitempty"`
	Archetypes []string `json:"archetypes,omitempty"`
}

// CVBullet is a presentation handle pointing at a cvHighlight inside the
// loaded file. Mutations write through to the backing struct so CV.Save()
// persists them.
type CVBullet struct {
	h         *cvHighlight
	RoleLabel string // "Position @ Company" (sub-entries append " / SubName")
	RoleSlug  string
	SubSlug   string // "" for direct-on-role bullets
}

// ID returns the bullet's stable id from cv.json.
func (b *CVBullet) ID() string { return b.h.ID }

// Text returns the bullet's text body.
func (b *CVBullet) Text() string { return b.h.Text }

// Tier returns the authored tier ("core" | "default" | "depth"), or "" when
// untagged.
func (b *CVBullet) Tier() string { return b.h.Tier }

// Archetypes returns a copy of the bullet's archetype tags.
func (b *CVBullet) Archetypes() []string {
	out := make([]string, len(b.h.Archetypes))
	copy(out, b.h.Archetypes)
	return out
}

// SetTier updates the bullet's tier. An empty string clears it so omitempty
// drops the field on save (matching the JS-side `delete h.tier`).
func (b *CVBullet) SetTier(t string) {
	b.h.Tier = t
}

// ToggleArchetype adds `name` if absent, removes it if present. When the
// resulting set is empty, the slice is nil'd so omitempty drops the field
// rather than emitting `"archetypes": []`.
func (b *CVBullet) ToggleArchetype(name string) {
	for i, a := range b.h.Archetypes {
		if a == name {
			b.h.Archetypes = append(b.h.Archetypes[:i], b.h.Archetypes[i+1:]...)
			if len(b.h.Archetypes) == 0 {
				b.h.Archetypes = nil
			}
			return
		}
	}
	b.h.Archetypes = append(b.h.Archetypes, name)
}

// HasArchetype reports whether `name` is currently set on the bullet.
func (b *CVBullet) HasArchetype(name string) bool {
	for _, a := range b.h.Archetypes {
		if a == name {
			return true
		}
	}
	return false
}

// LoadCV reads config/cv.json into a CV with a flat bullet index. Returns an
// error when the file is missing or malformed — the screen falls back to an
// onboarding prompt in that case.
func LoadCV(careerOpsPath string) (*CV, error) {
	p := paths.Config(careerOpsPath, "cv.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	cv := &CV{Path: p}
	if err := json.Unmarshal(raw, &cv.file); err != nil {
		return nil, fmt.Errorf("parse cv.json: %w", err)
	}
	// Initialize nil highlight slices to non-nil empty so they marshal as `[]`
	// rather than `null` — matches what cv-md-to-json.mjs produces.
	for _, w := range cv.file.Work {
		if w.Highlights == nil {
			w.Highlights = []*cvHighlight{}
		}
		for _, se := range w.SubEntries {
			if se.Highlights == nil {
				se.Highlights = []*cvHighlight{}
			}
		}
	}
	cv.indexBullets()
	return cv, nil
}

func (cv *CV) indexBullets() {
	cv.Bullets = cv.Bullets[:0]
	for _, w := range cv.file.Work {
		roleLabel := roleLabelOf(w)
		for _, h := range w.Highlights {
			cv.Bullets = append(cv.Bullets, &CVBullet{h: h, RoleLabel: roleLabel, RoleSlug: w.Slug})
		}
		for _, se := range w.SubEntries {
			subLabel := roleLabel + " / " + stripBoldMarkers(se.HeadingRaw)
			for _, h := range se.Highlights {
				cv.Bullets = append(cv.Bullets, &CVBullet{h: h, RoleLabel: subLabel, RoleSlug: w.Slug, SubSlug: se.Slug})
			}
		}
	}
}

func roleLabelOf(w *cvWork) string {
	switch {
	case w.Position != "" && w.Company != "":
		return w.Position + " @ " + w.Company
	case w.Position != "":
		return w.Position
	default:
		return w.Company
	}
}

// stripBoldMarkers turns "**Globex** - AI-powered ..." into "Globex - AI-powered ..."
// for human-readable sub-entry labels.
func stripBoldMarkers(s string) string {
	return strings.ReplaceAll(strings.TrimSpace(s), "**", "")
}

// Save writes the CV back to disk. Pretty-printed with 2-space indent and a
// trailing newline, matching what cv-md-to-json.mjs emits.
func (cv *CV) Save() error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(&cv.file); err != nil {
		return err
	}
	return os.WriteFile(cv.Path, buf.Bytes(), 0o644)
}

// ── CV health (cv-status.mjs) ────────────────────────────────────────────────

// CVStatus is the parsed JSON from `node lib/cv-status.mjs --json`. The full
// schema has more detail; we only model what the editor surfaces.
type CVStatus struct {
	Score      float64           `json:"score"`
	Max        float64           `json:"max"`
	Sections   []CVStatusSection `json:"sections"`
	Onboarding bool              `json:"onboarding,omitempty"`
	Message    string            `json:"message,omitempty"`
}

// CVStatusSection is one row in cv-status.mjs's checklist.
type CVStatusSection struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Score    float64  `json:"score"`
	Max      float64  `json:"max"`
	Findings []string `json:"findings"`
}

// LoadCVStatus runs `node lib/cv-status.mjs --json` and parses the result.
// Returns nil on error so the screen falls back to a "(status unavailable)"
// placeholder rather than refusing to open.
func LoadCVStatus(careerOpsPath string) *CVStatus {
	cmd := exec.Command("node", "lib/cv-status.mjs", "--json")
	cmd.Dir = careerOpsPath
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var st CVStatus
	if err := json.Unmarshal(out, &st); err != nil {
		return nil
	}
	return &st
}
