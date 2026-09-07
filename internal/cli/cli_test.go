package cli

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func run(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	err := Run(context.Background(), args, strings.NewReader(""), &out, &errOut, "test")
	return out.String(), errOut.String(), err
}
func isolated(t *testing.T) {
	t.Helper()
	base := t.TempDir()
	if err := os.Chmod(base, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MATRIX_CONFIG_DIR", base)
	for _, key := range []string{"MATRIX_PROFILE", "CONNECTOR_API_TOKEN", "CONNECTOR_API_TOKEN_FILE", "CONNECTOR_URL", "PUBLIC_BASE_URL", "NODE_EXTRA_CA_CERTS"} {
		t.Setenv(key, "")
	}
}
func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func testProfile() *profile {
	return &profile{Version: 1, Homeserver: "https://hs.example", UserID: "@alice:hs.example", DeviceID: "DEVICE", AccessToken: "synthetic-access-token", RefreshToken: "synthetic-refresh-token", GatewayToken: "synthetic-gateway-token", ConnectorURL: "http://127.0.0.1:8787"}
}
func newApp(ctx context.Context) *app {
	return &app{ctx: ctx, in: strings.NewReader(""), out: io.Discard, errOut: io.Discard}
}

func TestHelpGuideVersionNeedNoRuntimeOrLogin(t *testing.T) {
	isolated(t)
	t.Setenv("PATH", t.TempDir())
	for _, arg := range []string{"--help", "agent-guide", "--version"} {
		out, _, err := run(t, arg)
		if err != nil || out == "" {
			t.Fatalf("%s: %v", arg, err)
		}
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("MATRIX_CONFIG_DIR"), "default")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("informational commands created a profile")
	}
}
func TestUsageAndSecretInputs(t *testing.T) {
	isolated(t)
	for _, args := range [][]string{{"unknown"}, {"send", "@b:hs.example"}, {"register", "hs.example"}, {"claim", "--worker", "w", "--wait", "-1"}, {"login", "--password", "secret"}} {
		_, out, err := run(t, args...)
		if err == nil {
			t.Fatalf("accepted %v", args)
		}
		if strings.Contains(out, "secret") {
			t.Fatal("exposed secret")
		}
	}
	for _, input := range []string{"", "line\nline", "nul\x00value", strings.Repeat("x", 65537)} {
		if _, err := secretInput(input); err == nil {
			t.Fatal("accepted invalid secret")
		}
	}
	if result, err := secretInput(" spaces preserved \r\n"); err != nil || result != " spaces preserved " {
		t.Fatalf("%q %v", result, err)
	}
	o, pos, err := parse([]string{"contact-add", "@a:hs.example", "--tag", "first", "--profile", "bob", "--tag", "second", "--allow-execution"}, io.Discard)
	if err != nil || len(o.tags) != 2 || !o.execution || o.profile != "bob" || len(pos) != 2 {
		t.Fatal("interspersed flags were lost")
	}
}
func TestRegistrationUIAAndPrivateProfileWithoutNode(t *testing.T) {
	isolated(t)
	t.Setenv("PATH", t.TempDir())
	password := "synthetic password value"
	invitation := "synthetic invitation"
	var registerCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&b)
		}
		switch r.URL.Path {
		case "/_matrix/client/versions":
			jsonResponse(w, 200, map[string]any{"versions": []string{"v1.11"}})
		case "/_matrix/client/v3/register":
			registerCalls++
			if b["password"] != password {
				t.Error("password changed")
			}
			auth, _ := b["auth"].(map[string]any)
			challenge := map[string]any{"session": "SESSION", "flows": []any{map[string]any{"stages": []string{"m.login.registration_token", "m.login.dummy"}}}}
			if auth == nil {
				jsonResponse(w, 401, challenge)
				return
			}
			if auth["session"] != "SESSION" {
				t.Error("session changed")
			}
			if auth["type"] == "m.login.registration_token" {
				if auth["token"] != invitation {
					t.Error("token changed")
				}
				challenge["completed"] = []string{"m.login.registration_token"}
				jsonResponse(w, 401, challenge)
				return
			}
			if auth["type"] != "m.login.dummy" {
				t.Error("unexpected stage")
			}
			jsonResponse(w, 200, credentials{UserID: "@alice:hs.example", DeviceID: "DEVICE", AccessToken: "synthetic-access-token", RefreshToken: "synthetic-refresh-token"})
		case "/_matrix/client/v3/account/whoami":
			if r.Header.Get("Authorization") != "Bearer synthetic-access-token" {
				t.Error("missing auth")
			}
			jsonResponse(w, 200, credentials{UserID: "@alice:hs.example", DeviceID: "DEVICE"})
		default:
			t.Errorf("unexpected %s", r.URL.Path)
			jsonResponse(w, 404, map[string]any{})
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	pw, invite := filepath.Join(dir, "password"), filepath.Join(dir, "invitation")
	os.WriteFile(pw, []byte(password+"\n"), 0600)
	os.WriteFile(invite, []byte(invitation), 0600)
	out, stderr, err := run(t, "register", server.URL, "alice", "--allow-http", "--password-file", pw, "--registration-token-file", invite)
	if err != nil {
		t.Fatal(err)
	}
	if registerCalls != 3 {
		t.Fatalf("calls: %d", registerCalls)
	}
	for _, secret := range []string{password, invitation, "synthetic-access-token", "synthetic-refresh-token"} {
		if strings.Contains(out+stderr, secret) {
			t.Fatal("credential exposed")
		}
	}
	s, _ := newStore("")
	p, err := s.require()
	if err != nil {
		t.Fatal(err)
	}
	if p.DeviceID != "DEVICE" {
		t.Fatal("lost device")
	}
	for _, path := range []string{s.path, s.dir} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm()&0077 != 0 {
			t.Fatal("insecure saved profile")
		}
	}
	data, _ := os.ReadFile(s.path)
	if bytes.Contains(data, []byte(password)) {
		t.Fatal("password persisted")
	}
	if _, _, err = run(t, "whoami"); err != nil {
		t.Fatal(err)
	}
}
func TestRegistrationRejectsUnsupportedOrRepeatedChallenge(t *testing.T) {
	for _, stage := range []string{"m.login.email.identity", "m.login.registration_token"} {
		t.Run(stage, func(t *testing.T) {
			isolated(t)
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				jsonResponse(w, 401, map[string]any{"session": "s", "flows": []any{map[string]any{"stages": []string{stage}}}})
			}))
			defer server.Close()
			invite := filepath.Join(t.TempDir(), "token")
			os.WriteFile(invite, []byte("synthetic-invite"), 0600)
			a := newApp(context.Background())
			a.o.registrationTokenFile = invite
			_, err := a.register(server.URL, "alice", "password", "device")
			if err == nil || calls > 2 {
				t.Fatalf("%v (%d calls)", err, calls)
			}
		})
	}
}
func TestRedirectAndOriginGuardNeverForwardCredentials(t *testing.T) {
	isolated(t)
	var leaked atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1); w.WriteHeader(200) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer source.Close()
	c, _ := newHTTP(source.URL, "synthetic-secret")
	if _, err := timedRequest(context.Background(), c, source.URL, "/account", "GET", nil); err == nil {
		t.Fatal("redirect accepted")
	}
	if _, err := c.Get(destination.URL); err == nil {
		t.Fatal("origin guard bypassed")
	}
	if leaked.Load() != 0 {
		t.Fatal("credentials sent to another origin")
	}
}
func TestAuthenticationErrorsAreSanitized(t *testing.T) {
	isolated(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			jsonResponse(w, 200, map[string]any{"flows": []any{map[string]string{"type": "m.login.password"}}})
			return
		}
		jsonResponse(w, 403, map[string]string{"errcode": "M_FORBIDDEN", "error": "reflected-secret"})
	}))
	defer server.Close()
	_, err := newApp(context.Background()).login(server.URL, "alice", "reflected-secret", "device")
	if err == nil || strings.Contains(err.Error(), "reflected-secret") {
		t.Fatal("reflected password leaked")
	}
}
func TestFailedSaveRevokesNewDeviceAndPreservesIdentity(t *testing.T) {
	isolated(t)
	var revoked atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "logout") {
			revoked.Add(1)
			jsonResponse(w, 200, map[string]any{})
			return
		}
		jsonResponse(w, 200, credentials{UserID: "@other:hs.example", DeviceID: "NEW"})
	}))
	defer server.Close()
	s, _ := newStore("")
	p := testProfile()
	p.Homeserver = server.URL
	if err := s.save(p); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(s.path)
	_, err := newApp(context.Background()).saveLogin(s, server.URL, credentials{UserID: "@other:hs.example", DeviceID: "NEW", AccessToken: "new-token"})
	after, _ := os.ReadFile(s.path)
	if err == nil || revoked.Load() != 1 || !bytes.Equal(before, after) {
		t.Fatal("failed save left a device or replaced the existing profile")
	}
}
func TestSharedProfileLockAndDeadOwnerRecovery(t *testing.T) {
	isolated(t)
	s, _ := newStore("")
	if err := s.save(testProfile()); err != nil {
		t.Fatal(err)
	}
	release, err := s.lock()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err = s.lock(); err == nil {
		t.Fatal("concurrent writer acquired profile lock")
	}
	if _, err = s.require(); err != nil {
		t.Fatal("read-only commands cannot read while connector owns lock")
	}
	release()
	db, err := sql.Open("sqlite", filepath.Join(s.dir, "profile-lock.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	host, _ := os.Hostname()
	value, _ := json.Marshal(map[string]any{"pid": 2147483647, "host": host, "nonce": "dead"})
	if _, err = db.Exec("INSERT INTO owner VALUES(1,?)", string(value)); err != nil {
		t.Fatal(err)
	}
	again, err := s.lock()
	if err != nil {
		t.Fatal(err)
	}
	again()
}
func TestPrivateProfileRejectsSymlinkAndLoosePermissions(t *testing.T) {
	isolated(t)
	s, _ := newStore("")
	if err := s.save(testProfile()); err != nil {
		t.Fatal(err)
	}
	os.Chmod(s.path, 0644)
	if _, err := s.load(); err == nil {
		t.Fatal("world-readable credentials accepted")
	}
	os.Remove(s.path)
	os.Symlink("/dev/null", s.path)
	if _, err := s.load(); err == nil {
		t.Fatal("symlink accepted")
	}
	for _, name := range []string{"../escape", "a/b", "."} {
		if _, err := newStore(name); err == nil {
			t.Fatal("unsafe profile name")
		}
	}
	for _, value := range []string{"http://0.0.0.0:8787", "https://127.0.0.1:8787", "http://localhost:8787/path", "http://u:p@localhost:8787"} {
		if _, err := connectorAddress(value); err == nil {
			t.Fatal("invalid local gateway")
		}
	}
}
func TestRefreshPersistsRotationWithoutReplacingOtherState(t *testing.T) {
	isolated(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "refresh") {
			jsonResponse(w, 200, map[string]any{"access_token": "rotated-access", "refresh_token": "rotated-refresh", "expires_in_ms": 60000})
			return
		}
		if r.Header.Get("Authorization") == "Bearer rotated-access" {
			jsonResponse(w, 200, credentials{UserID: "@alice:hs.example"})
			return
		}
		jsonResponse(w, 401, map[string]any{"errcode": "M_UNKNOWN_TOKEN", "soft_logout": true})
	}))
	defer server.Close()
	s, _ := newStore("")
	p := testProfile()
	p.Homeserver = server.URL
	p.Backend = &backend{CardURL: "http://127.0.0.1:8080/card", Token: "endpoint-token", AllowLocal: true}
	if err := s.save(p); err != nil {
		t.Fatal(err)
	}
	release, err := s.lock()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err = newApp(context.Background()).profileRequest(s, p, "/_matrix/client/v3/account/whoami", "GET", nil); err != nil {
		t.Fatal(err)
	}
	saved, err := s.require()
	if err != nil || saved.AccessToken != "rotated-access" || saved.RefreshToken != "rotated-refresh" || saved.Backend.Token != "endpoint-token" || saved.GatewayToken != testProfile().GatewayToken {
		t.Fatal("rotation lost profile state")
	}
}
func TestGatewayPolicyAndWorkResultPreserveInput(t *testing.T) {
	isolated(t)
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.EscapedPath())
		if r.Header.Get("Authorization") != "Bearer synthetic-gateway-token" {
			t.Error("missing auth")
		}
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		if strings.HasSuffix(r.URL.Path, "contacts") {
			if b["receive"] != "ask" || b["execution"] != "allow" {
				t.Error("contact permissions conflated")
			}
			if len(b["tags"].([]any)) != 2 {
				t.Error("lost tags")
			}
		}
		if strings.HasSuffix(r.URL.Path, "update") {
			if b["text"] != "line one\nline two" || b["data"].(map[string]any)["count"] != float64(2) {
				t.Error("lost result content")
			}
		}
		jsonResponse(w, 200, map[string]any{"ok": true})
	}))
	defer server.Close()
	t.Setenv("CONNECTOR_URL", server.URL)
	t.Setenv("CONNECTOR_API_TOKEN", "synthetic-gateway-token")
	if _, _, err := run(t, "contact-add", "@alice:hs.example", "--allow-execution", "--tag", "one", "--tag", "two"); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(t.TempDir(), "result.json")
	os.WriteFile(data, []byte(`{"count":2}`), 0600)
	var out, errOut bytes.Buffer
	if err := Run(context.Background(), []string{"reply", "claim/with slash", "-", "--data-file", data}, strings.NewReader("line one\nline two"), &out, &errOut, "test"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(paths[1], "%2F") {
		t.Fatal("path identifier was not escaped")
	}
}
func TestWatchDecodesChunkedSSEAndStopsOnCancellation(t *testing.T) {
	isolated(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("since") != "12" {
			t.Error("lost resume cursor")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "id: 13\ndata: {\"text\":\"中文\"}\n\n: keepalive\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	t.Setenv("CONNECTOR_URL", server.URL)
	t.Setenv("CONNECTOR_API_TOKEN", "synthetic-gateway-token")
	var out, errOut bytes.Buffer
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, []string{"watch", "--since", "12"}, strings.NewReader(""), &out, &errOut, "test")
	}()
	time.AfterFunc(100*time.Millisecond, cancel)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("watch ignored cancellation")
	}
	if strings.TrimSpace(out.String()) != `{"text":"中文"}` {
		t.Fatalf("bad JSON lines: %q", out.String())
	}
}
func TestBackendRejectsPrivateAddressesAndCrossOriginCard(t *testing.T) {
	isolated(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]any{"supportedInterfaces": []any{map[string]string{"url": "http://elsewhere.example/a2a", "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0"}}})
	}))
	defer server.Close()
	if _, err := backendHTTP(server.URL, "secret", false); err == nil {
		t.Fatal("insecure backend accepted")
	}
	c, err := backendHTTP(server.URL, "secret", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = loadCard(context.Background(), c, server.URL+"/card"); err == nil {
		t.Fatal("cross-origin card accepted")
	}
}
