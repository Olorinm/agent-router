package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Profile struct {
	Domain         string            `json:"domain"`
	BaseURL        string            `json:"baseUrl"`
	ActiveIdentity string            `json:"activeIdentity,omitempty"`
	TaskAgents     map[string]string `json:"taskAgents,omitempty"`
}

type Config struct {
	CurrentProfile string             `json:"currentProfile,omitempty"`
	Profiles       map[string]Profile `json:"profiles"`
}

type Store struct {
	path string
}

func NewStore() (*Store, error) {
	dir := os.Getenv("AGENT_ROUTER_CONFIG_DIR")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(base, "agent-router")
	}
	return &Store{path: filepath.Join(dir, "config.json")}, nil
}

func (s *Store) Load() (*Config, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return &Config{Profiles: map[string]Profile{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	if cfg.Profiles == nil {
		cfg.Profiles = map[string]Profile{}
	}
	return &cfg, nil
}

func (s *Store) Save(cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) Selected(name string) (string, Profile, *Config, error) {
	cfg, err := s.Load()
	if err != nil {
		return "", Profile{}, nil, err
	}
	if name == "" {
		name = cfg.CurrentProfile
	}
	profile, ok := cfg.Profiles[name]
	if !ok || name == "" {
		return "", Profile{}, nil, errors.New("no Router profile selected; run 'agent-router profile add NAME DOMAIN'")
	}
	if profile.TaskAgents == nil {
		profile.TaskAgents = map[string]string{}
	}
	return name, profile, cfg, nil
}

func NormalizeName(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || strings.ContainsAny(value, " \t\r\n/") {
		return "", errors.New("profile name must be a non-empty word")
	}
	return value, nil
}

func (s *Store) Path() string { return s.path }
