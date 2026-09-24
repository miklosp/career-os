package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestWriteLaunchScriptRunsLongCommandAndSelfDeletes(t *testing.T) {
	prompt := "/career-ops tailor 3240 — application #3240: Mozilla — it's " + strings.Repeat("x", 1200)
	launch := "FOO=" + shellQuote("bar") + " /bin/sh -c " + shellQuote("printf %s \"$FOO\" "+shellQuote(prompt))

	script, err := writeLaunchScript(launch)
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("/bin/sh", script).Output()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(out), "bar"+prompt; got != want {
		t.Fatalf("output mismatch: got %d bytes, want %d", len(got), len(want))
	}
	if _, err := os.Stat(script); !os.IsNotExist(err) {
		t.Fatalf("script not deleted: %v", err)
	}
}
