// Package paths is the dashboard's single resolver for user-data locations,
// mirroring lib/paths.mjs. User data (config/, data/, output/, transcripts/)
// lives in <repo>/user — its own gitignored git repo — unless CAREER_OPS_USER_DIR points
// elsewhere. Paths stored inside user data (tracker report links such as
// `data/reports/…`) are relative to the user dir: resolve them with User.
package paths

import (
	"os"
	"path/filepath"
	"strings"
)

// UserDir returns the user-data root for the career-ops repo at repo.
func UserDir(repo string) string {
	if d := os.Getenv("CAREER_OPS_USER_DIR"); d != "" {
		if abs, err := filepath.Abs(d); err == nil {
			return abs
		}
		return d
	}
	return filepath.Join(repo, "user")
}

// User joins rel (e.g. a stored tracker link) onto the user-data root.
func User(repo string, rel ...string) string {
	return filepath.Join(append([]string{UserDir(repo)}, rel...)...)
}

// Config joins rel onto the user config/ directory.
func Config(repo string, rel ...string) string {
	return User(repo, append([]string{"config"}, rel...)...)
}

// Data joins rel onto the user data/ directory.
func Data(repo string, rel ...string) string {
	return User(repo, append([]string{"data"}, rel...)...)
}

// Output joins rel onto the user output/ directory.
func Output(repo string, rel ...string) string {
	return User(repo, append([]string{"output"}, rel...)...)
}

// Display renders abs for agent prompts that run with cwd=repo: repo-relative
// when abs is inside the repo, otherwise absolute.
func Display(repo, abs string) string {
	rel, err := filepath.Rel(repo, abs)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return abs
	}
	return rel
}
