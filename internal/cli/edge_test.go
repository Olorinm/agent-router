package cli

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A Router behind Cloudflare Access with Matrix off: no /_matrix routes, owner requests carry Access headers only.
func edgeRouter(t *testing.T, check func(r *http.Request) bool) *httptest.Server {
	agent := managedAgent{ID: "agent-one", Owner: "@owner:example.test", Name: "helper", Address: "owner/helper@example.test", MatrixID: "@_ar_one:example.test"}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("a bearer token was sent to an edge service")
		}
		if strings.HasPrefix(r.URL.Path, "/_matrix/") {
			t.Errorf("Matrix request in edge mode: %s", r.URL.Path)
		}
		if r.Method != "GET" && r.Header.Get("Origin") != "http://"+r.Host {
			t.Errorf("unsafe edge request without the service Origin: %q", r.Header.Get("Origin"))
		}
		if !check(r) {
			jsonResponse(w, 401, map[string]string{"error": "account_login_required"})
			return
		}
		switch r.URL.Path {
		case "/_agent-router/v1/account":
			jsonResponse(w, 200, map[string]any{"owner": agent.Owner, "via": "edge-service", "matrix": false})
		case "/_agent-router/v1/agents":
			if r.Method == "POST" {
				jsonResponse(w, 201, map[string]any{"id": agent.ID, "owner": agent.Owner, "name": agent.Name, "address": agent.Address, "matrixId": agent.MatrixID,
					"matrix": map[string]any{"state": "none", "userId": nil}})
			} else {
				jsonResponse(w, 200, map[string]any{"data": []managedAgent{agent}})
			}
		case "/_agent-router/v1/agents/agent-one/gateway/api/status":
			jsonResponse(w, 200, map[string]string{"userId": agent.MatrixID})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
}

func secretFile(t *testing.T, value string) string {
	path := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(path, []byte(value+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEdgeLoginWithAccessServiceTokenFiles(t *testing.T) {
	isolated(t)
	server := edgeRouter(t, func(r *http.Request) bool {
		return r.Header.Get("Cf-Access-Client-Id") == "1a2b.access" && r.Header.Get("Cf-Access-Client-Secret") == "s3cret"
	})
	defer server.Close()
	id, secret := secretFile(t, "1a2b.access"), secretFile(t, "s3cret")
	creds := []string{"--access-client-id-file", id, "--access-client-secret-file", secret}
	out, _, err := run(t, append([]string{"--allow-http", "login", "--edge", server.URL}, creds...)...)
	if err != nil || !strings.Contains(out, `"login": "edge"`) || !strings.Contains(out, "@owner:example.test") {
		t.Fatalf("edge login: %s %v", out, err)
	}
	if strings.Contains(out, "s3cret") {
		t.Fatal("secret printed")
	}
	s, _ := newStore("")
	data, err := os.ReadFile(s.edgePath())
	if err != nil || strings.Contains(string(data), "s3cret") || strings.Contains(string(data), "1a2b") {
		t.Fatalf("edge profile must not store credentials: %s %v", data, err)
	}
	for _, args := range [][]string{{"whoami"}, {"agent-create", "helper"}, {"agents"}, {"agent-use", "helper"}, {"status"}} {
		out, _, err := run(t, append(append([]string{"--allow-http"}, args...), creds...)...)
		if err != nil {
			t.Fatalf("%v: %s %v", args, out, err)
		}
	}
	// Without credentials the CLI refuses before any request (no cloudflared on PATH in tests).
	t.Setenv("PATH", t.TempDir())
	if _, _, err := run(t, "agents"); err == nil || !strings.Contains(err.Error(), "access_credentials_required") {
		t.Fatalf("expected access_credentials_required, got %v", err)
	}
	out, _, err = run(t, "logout")
	if err != nil || !strings.Contains(out, `"login": "edge"`) {
		t.Fatalf("logout: %s %v", out, err)
	}
	if _, err := os.Stat(s.edgePath()); !os.IsNotExist(err) {
		t.Fatal("edge profile kept after logout")
	}
}

func TestEdgeLoginWithEnvironmentServiceTokenAndAccessToken(t *testing.T) {
	isolated(t)
	server := edgeRouter(t, func(r *http.Request) bool {
		return (r.Header.Get("Cf-Access-Client-Id") == "env.access" && r.Header.Get("Cf-Access-Client-Secret") == "env-secret") ||
			r.Header.Get("Cf-Access-Token") == "jwt-from-cloudflared"
	})
	defer server.Close()
	t.Setenv("PATH", t.TempDir()) // no cloudflared
	t.Setenv("CF_ACCESS_CLIENT_ID", "env.access")
	t.Setenv("CF_ACCESS_CLIENT_SECRET_FILE", secretFile(t, "env-secret"))
	if out, _, err := run(t, "--allow-http", "login", "--edge", server.URL+"/_agent-router/v1"); err != nil {
		t.Fatalf("%s %v", out, err)
	}
	t.Setenv("CF_ACCESS_CLIENT_ID", "")
	t.Setenv("CF_ACCESS_CLIENT_SECRET_FILE", "")
	if _, _, err := run(t, "agents"); err == nil {
		t.Fatal("expected missing credentials")
	}
	t.Setenv("CF_ACCESS_TOKEN_FILE", secretFile(t, "jwt-from-cloudflared"))
	if out, _, err := run(t, "agents"); err != nil || !strings.Contains(out, "helper") {
		t.Fatalf("%s %v", out, err)
	}
	t.Setenv("CF_ACCESS_CLIENT_ID", "only-id")
	if _, _, err := run(t, "agents"); err == nil || !strings.Contains(err.Error(), "client_id_and_secret") {
		t.Fatalf("expected a pairing error, got %v", err)
	}
}

func TestEdgeServiceURL(t *testing.T) {
	for input, want := range map[string]string{"mau.example.test": "https://mau.example.test/_agent-router/v1",
		"https://mau.example.test/": "https://mau.example.test/_agent-router/v1", "https://mau.example.test/_agent-router/v1": "https://mau.example.test/_agent-router/v1"} {
		if got, err := edgeServiceURL(input, false); err != nil || got != want {
			t.Errorf("%s: %s %v", input, got, err)
		}
	}
	for _, input := range []string{"http://mau.example.test", "https://mau.example.test/other", "https://u:p@mau.example.test", "https://mau.example.test/?q=1"} {
		if _, err := edgeServiceURL(input, false); err == nil {
			t.Errorf("%s accepted", input)
		}
	}
}
