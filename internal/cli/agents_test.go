package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestManagedOwnerCreatesAgentWithoutAnotherPasswordAndExportsScopedCredentials(t *testing.T) {
	isolated(t)
	agent := managedAgent{ID: "agent-one", Owner: "@alice:example.test", Name: "coder", Address: "alice/coder@example.test", MatrixID: "@_ar_one:example.test"}
	instanceToken := "ari_" + strings.Repeat("s", 43)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-access-token" {
			t.Errorf("wrong owner token")
		}
		switch r.URL.Path {
		case "/_matrix/client/v3/account/whoami":
			jsonResponse(w, 200, map[string]string{"user_id": agent.Owner})
		case "/_agent-router/v1/agents":
			if r.Method == "POST" {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				if len(body) != 1 || body["name"] != "coder" {
					t.Errorf("Agent registration must contain only name: %v", body)
				}
				jsonResponse(w, 201, agent)
			} else {
				jsonResponse(w, 200, map[string]any{"data": []managedAgent{agent}})
			}
		case "/_agent-router/v1/agents/agent-one/instances":
			jsonResponse(w, 201, map[string]any{"instance": map[string]string{"id": "instance-one"}, "token": instanceToken})
		case "/_agent-router/v1/agents/agent-one/gateway/api/status":
			jsonResponse(w, 200, map[string]string{"userId": agent.MatrixID})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	s, _ := newStore("owner")
	p := testProfile()
	p.Homeserver = server.URL
	p.UserID = agent.Owner
	if err := s.save(p); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"agent-create", "coder"}, {"agents"}, {"agent-use", "coder"}, {"agent-current"}, {"status"}} {
		out, _, err := run(t, append([]string{"--profile", "owner", "--allow-http"}, args...)...)
		if err != nil || !strings.Contains(out, "coder") && args[0] != "status" {
			t.Fatalf("%v: %s %v", args, out, err)
		}
	}
	file := filepath.Join(t.TempDir(), "instance.json")
	out, _, err := run(t, "--profile", "owner", "--allow-http", "agent-instance-create", "laptop", "--out", file)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, instanceToken) {
		t.Fatal("credential printed on stdout")
	}
	var selected agentSelection
	if err := readPrivateJSON(file, &selected); err != nil {
		t.Fatal(err)
	}
	if selected.Token != instanceToken || selected.InstanceID != "instance-one" {
		t.Fatal("wrong credential export")
	}
	if p2, _ := s.load(); p2.UserID != agent.Owner || p2.AccessToken != p.AccessToken {
		t.Fatal("Agent creation replaced owner session")
	}
}

func TestManagedInstanceNeedsNoMatrixLoginOrNodeAndCannotManageAgents(t *testing.T) {
	isolated(t)
	token := "ari_" + strings.Repeat("i", 43)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("wrong instance credential")
		}
		if r.URL.Path == "/_agent-router/v1/agents/agent-one/gateway/api/status" || r.URL.Path == "/_agent-router/v1/agents/agent-one/gateway/health/ready" {
			jsonResponse(w, 200, map[string]string{"userId": "@_ar_one:example.test", "status": "ready"})
			return
		}
		t.Errorf("unexpected request %s", r.URL.Path)
		w.WriteHeader(404)
	}))
	defer server.Close()
	selected := agentSelection{Version: 1, ServiceURL: server.URL + "/_agent-router/v1", Agent: managedAgent{ID: "agent-one", Owner: "@alice:example.test", Name: "coder", MatrixID: "@_ar_one:example.test"}, InstanceID: "instance-one", Token: token}
	data, _ := json.Marshal(selected)
	file := filepath.Join(t.TempDir(), "instance.json")
	os.WriteFile(file, data, 0600)
	t.Setenv("PATH", t.TempDir())
	for _, args := range [][]string{{"agent-attach", file, "--allow-http"}, {"status"}, {"connect"}, {"agent-current"}} {
		out, _, err := run(t, append([]string{"--profile", "worker"}, args...)...)
		if err != nil || strings.Contains(out, token) {
			t.Fatalf("%v: %s %v", args, out, err)
		}
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("MATRIX_CONFIG_DIR"), "worker", "session.json")); !os.IsNotExist(err) {
		t.Fatal("instance created a Matrix account profile")
	}
	if _, _, err := run(t, "--profile", "worker", "agent-create", "other"); err == nil || !strings.Contains(err.Error(), "owner_account_required") {
		t.Fatal("instance allowed owner management")
	}
}

func TestManagedSelectionRejectsDifferentOwnerAndInsecureCredentialFile(t *testing.T) {
	isolated(t)
	file := filepath.Join(t.TempDir(), "instance.json")
	os.WriteFile(file, []byte("{}"), 0644)
	if _, _, err := run(t, "agent-attach", file); err == nil {
		t.Fatal("accepted world-readable credential file")
	}
	p := testProfile()
	if _, err := accountService(p, "https://evil.example/_agent-router/v1", false); err == nil {
		t.Fatal("owner token can be forwarded to another origin")
	}
}

func TestManagedGatewayRefreshesAnOwnerTokenThatExpiresDuringUse(t *testing.T) {
	isolated(t)
	var expired atomic.Bool
	var refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/_matrix/client/v3/account/whoami":
			if token != "Bearer refreshed-access" && expired.Load() {
				jsonResponse(w, 401, map[string]string{"errcode": "M_UNKNOWN_TOKEN"})
				return
			}
			jsonResponse(w, 200, map[string]string{"user_id": "@alice:example.test"})
		case "/_matrix/client/v3/refresh":
			refreshes.Add(1)
			jsonResponse(w, 200, map[string]string{"access_token": "refreshed-access", "refresh_token": "refreshed-refresh"})
		case "/_agent-router/v1/agents/agent-one/gateway/api/status":
			if token != "Bearer refreshed-access" {
				expired.Store(true)
				jsonResponse(w, 401, map[string]string{"error": "account_session_invalid"})
				return
			}
			jsonResponse(w, 200, map[string]string{"userId": "@_ar_one:example.test"})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	s, _ := newStore("owner")
	p := testProfile()
	p.Homeserver = server.URL
	p.UserID = "@alice:example.test"
	if err := s.save(p); err != nil {
		t.Fatal(err)
	}
	selected := &agentSelection{Version: 1, ServiceURL: server.URL + "/_agent-router/v1", Agent: managedAgent{ID: "agent-one", Name: "coder", Owner: p.UserID, MatrixID: "@_ar_one:example.test"}}
	if err := s.selectAgent(selected); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, "--profile", "owner", "status"); err != nil {
		t.Fatal(err)
	}
	if refreshes.Load() != 1 {
		t.Fatalf("refreshes: %d", refreshes.Load())
	}
	p, _ = s.load()
	if p.AccessToken != "refreshed-access" {
		t.Fatal("refreshed token was not persisted")
	}
}
