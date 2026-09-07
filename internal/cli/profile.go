package cli

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	_ "modernc.org/sqlite"
)

type backend struct {
	CardURL    string `json:"cardUrl"`
	Token      string `json:"token"`
	AllowLocal bool   `json:"allowLocal"`
}
type profile struct {
	Version      int      `json:"version"`
	Homeserver   string   `json:"homeserver"`
	UserID       string   `json:"userId"`
	DeviceID     string   `json:"deviceId"`
	AccessToken  string   `json:"accessToken,omitempty"`
	RefreshToken string   `json:"refreshToken,omitempty"`
	GatewayToken string   `json:"gatewayToken"`
	ConnectorURL string   `json:"connectorUrl"`
	Backend      *backend `json:"backend,omitempty"`
}
type profileStore struct{ name, dir, path string }

var profileName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
var matrixID = regexp.MustCompile(`^@[^\s:]+:[^\s]+$`)

func newStore(name string) (*profileStore, error) {
	if name == "" {
		name = os.Getenv("MATRIX_PROFILE")
	}
	if name == "" {
		name = "default"
	}
	if !profileName.MatchString(name) {
		return nil, errors.New("invalid_profile_name")
	}
	base := os.Getenv("MATRIX_CONFIG_DIR")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		base = filepath.Join(home, ".config", "agent-router", "matrix")
	}
	dir, err := filepath.Abs(filepath.Join(base, name))
	if err != nil {
		return nil, err
	}
	return &profileStore{name, dir, filepath.Join(dir, "session.json")}, nil
}
func privateInfo(info os.FileInfo, dir bool) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm()&0077 != 0 || (dir && !info.IsDir()) || (!dir && !info.Mode().IsRegular()) {
		return errors.New("profile_paths_must_be_owned_by_this_user_with_0700_directories_and_0600_files")
	}
	return nil
}
func (s *profileStore) ensure() error {
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	for _, path := range []string{filepath.Dir(s.dir), s.dir} {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if err = privateInfo(info, true); err != nil {
			return err
		}
	}
	return nil
}
func (p *profile) validate() error {
	if p.Version != 1 || !matrixID.MatchString(p.UserID) || p.DeviceID == "" || len(p.GatewayToken) < 16 {
		return errors.New("invalid_saved_profile")
	}
	if _, err := homeserverURL(p.Homeserver, true); err != nil {
		return err
	}
	if _, err := connectorAddress(p.ConnectorURL); err != nil {
		return err
	}
	if p.Backend != nil {
		if _, err := backendURL(p.Backend.CardURL); err != nil {
			return err
		}
	}
	return nil
}
func (s *profileStore) load() (*profile, error) {
	if _, err := os.Lstat(s.path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	if err := s.ensure(); err != nil {
		return nil, err
	}
	fd, err := syscall.Open(s.path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, errors.New("cannot_open_private_session")
	}
	file := os.NewFile(uintptr(fd), s.path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if err = privateInfo(info, false); err != nil {
		return nil, err
	}
	var p profile
	d := json.NewDecoder(io.LimitReader(file, 1<<20))
	d.DisallowUnknownFields()
	if err = d.Decode(&p); err != nil {
		return nil, errors.New("invalid_saved_profile_json")
	}
	if err = d.Decode(new(any)); err != io.EOF {
		return nil, errors.New("invalid_saved_profile_json")
	}
	if err = p.validate(); err != nil {
		return nil, err
	}
	return &p, nil
}
func (s *profileStore) require() (*profile, error) {
	p, err := s.load()
	if err != nil {
		return nil, err
	}
	if p == nil || p.AccessToken == "" {
		return nil, errors.New("not_logged_in: run agent-router login ADDRESS or agent-router register SERVER USERNAME")
	}
	return p, nil
}
func (s *profileStore) save(p *profile) error {
	if err := p.validate(); err != nil {
		return err
	}
	if err := s.ensure(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".session-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(append(data, '\n')); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), s.path); err != nil {
		return err
	}
	dir, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Share the connector's SQLite owner ledger. Transactions prevent two languages from
// stealing a live lock; a dead local process can be recovered without deleting state.
func (s *profileStore) lock() (func(), error) {
	if err := s.ensure(); err != nil {
		return nil, err
	}
	path := filepath.Join(s.dir, "profile-lock.sqlite")
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, errors.New("cannot_open_profile_lock")
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	f.Close()
	if err != nil {
		return nil, err
	}
	if err = privateInfo(info, false); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	failure := func(err error) (func(), error) { db.Exec("ROLLBACK"); db.Close(); return nil, err }
	if _, err = db.Exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); BEGIN IMMEDIATE"); err != nil {
		return failure(errors.New("cannot_acquire_profile_lock"))
	}
	type owner struct {
		PID   int    `json:"pid"`
		Host  string `json:"host"`
		Nonce string `json:"nonce"`
	}
	host, err := os.Hostname()
	if err != nil {
		return failure(err)
	}
	var previous string
	err = db.QueryRow("SELECT value FROM owner WHERE id=1").Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return failure(err)
	}
	if err == nil {
		var old owner
		if json.Unmarshal([]byte(previous), &old) != nil || old.Host != host || old.PID <= 0 {
			return failure(errors.New("profile_is_locked_on_another_host"))
		}
		if err = syscall.Kill(old.PID, 0); !errors.Is(err, syscall.ESRCH) {
			return failure(errors.New("profile_is_in_use: stop its connector before login, logout or changing its binding"))
		}
	}
	nonce, err := randomHex(16)
	if err != nil {
		return failure(err)
	}
	value, err := json.Marshal(owner{os.Getpid(), host, nonce})
	if err != nil {
		return failure(err)
	}
	if _, err = db.Exec("INSERT INTO owner VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", string(value)); err != nil {
		return failure(err)
	}
	if _, err = db.Exec("COMMIT"); err != nil {
		return failure(err)
	}
	released := false
	return func() {
		if !released {
			released = true
			db.Exec("DELETE FROM owner WHERE id=1 AND value=?", string(value))
			db.Close()
		}
	}, nil
}
func (s *profileStore) public(p *profile) map[string]any {
	var endpoint any
	if p.Backend != nil {
		endpoint = p.Backend.CardURL
	}
	return map[string]any{"profile": s.name, "userId": p.UserID, "homeserver": p.Homeserver, "deviceId": p.DeviceID, "loggedIn": p.AccessToken != "", "connectorUrl": p.ConnectorURL, "backend": endpoint}
}
func connectorAddress(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" && u.Hostname() != "localhost") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("connector_url_must_be_a_loopback_http_origin")
	}
	return u.Scheme + "://" + u.Host, nil
}
func homeserverURL(value string, allowHTTP bool) (string, error) {
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "https" && !(allowHTTP && u.Scheme == "http")) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("homeserver_requires_https_without_credentials_query_or_fragment")
	}
	return strings.TrimRight(u.String(), "/"), nil
}
func backendURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("invalid_a2a_agent_card_url")
	}
	return u, nil
}
