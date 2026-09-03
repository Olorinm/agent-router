package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStoreRoundTripAndSelection(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AGENT_ROUTER_CONFIG_DIR", dir)
	store, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	want := &Config{
		CurrentProfile: "work",
		Profiles: map[string]Profile{
			"work": {Domain: "agents.example.com", BaseURL: "https://router.example.com"},
		},
	}
	if err := store.Save(want); err != nil {
		t.Fatal(err)
	}
	name, profile, _, err := store.Selected("")
	if err != nil {
		t.Fatal(err)
	}
	if name != "work" || profile.BaseURL != "https://router.example.com" || profile.TaskAgents == nil {
		t.Fatalf("unexpected selected profile: %s %#v", name, profile)
	}
	info, err := os.Stat(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config permissions = %o, want 600", info.Mode().Perm())
	}
}

func TestNormalizeName(t *testing.T) {
	if got, err := NormalizeName(" Work "); err != nil || got != "work" {
		t.Fatalf("NormalizeName = %q, %v", got, err)
	}
	if _, err := NormalizeName("two words"); err == nil {
		t.Fatal("NormalizeName accepted whitespace")
	}
}
