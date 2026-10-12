package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setupFixture(t *testing.T, handler http.HandlerFunc) (*profileStore, *agentSelection) {
	t.Helper()
	isolated(t)
	agent := managedAgent{ID: "agent-one", Owner: "@alice:example.test", Name: "helper", Address: "alice/helper@example.test", MatrixID: "@_ar_one:example.test"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-access-token" {
			t.Error("owner token missing")
		}
		switch r.URL.Path {
		case "/_matrix/client/v3/account/whoami":
			jsonResponse(w, 200, map[string]string{"user_id": agent.Owner})
		case "/_agent-router/v1/agents":
			jsonResponse(w, 201, agent)
		default:
			handler(w, r)
		}
	}))
	t.Cleanup(server.Close)
	store, _ := newStore("owner")
	p := testProfile()
	p.Homeserver = server.URL
	p.UserID = agent.Owner
	if err := store.save(p); err != nil {
		t.Fatal(err)
	}
	selected := &agentSelection{Version: 1, ServiceURL: server.URL + "/_agent-router/v1", Agent: agent}
	return store, selected
}
func TestSetupReusesAccountAndCreatesAgentWithOptionalHostAndNoPlatform(t *testing.T) {
	var host bool
	store, selected := setupFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/_agent-router/v1/setup":
			jsonResponse(w, 200, map[string]any{"hosts": []any{map[string]string{"id": "personal"}}})
		case "/_agent-router/v1/agents/agent-one/setup/host":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["hostId"] != "personal" || len(body) != 1 {
				t.Errorf("unexpected host binding %v", body)
			}
			host = true
			jsonResponse(w, 200, map[string]any{})
		case "/_agent-router/v1/agents/agent-one/setup":
			jsonResponse(w, 200, map[string]any{"agent": selectedAgent(), "connections": []any{}})
		case "/_agent-router/v1/agents/agent-one/setup/check":
			jsonResponse(w, 200, map[string]any{"checks": []any{}})
		default:
			t.Errorf("setup contacted unselected platform: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	out, _, err := run(t, "--profile", "owner", "--allow-http", "setup", "helper", "--host", "personal")
	if err != nil || !host || !strings.Contains(out, "connections") {
		t.Fatalf("%s %v", out, err)
	}
	saved, err := store.selection()
	if err != nil || saved.Agent.ID != selected.Agent.ID || saved.Token != "" {
		t.Fatalf("selection %v %v", saved, err)
	}
	if strings.Contains(out, "synthetic-access-token") {
		t.Fatal("owner credential exposed")
	}
}
func selectedAgent() managedAgent { return managedAgent{ID: "agent-one", Name: "helper"} }
func TestChannelConnectKeepsSecretsInRequestAndShowsTerminalConsent(t *testing.T) {
	secret := "123456789:" + strings.Repeat("fixture", 5)
	store, selected := setupFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_agent-router/v1/agents/agent-one/setup/connections" {
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["token"] != secret || body["kind"] != "telegram" {
			t.Errorf("wrong channel request %v", body)
		}
		jsonResponse(w, 202, setupJob{ID: "job-one", Kind: "telegram", State: "telegram_pairing", URL: "https://t.me/fixture?start=proof", QR: "██\n▀▄", ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339)})
	})
	if err := store.selectAgent(selected); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "bot-token")
	os.WriteFile(file, []byte(secret), 0600)
	out, diag, err := run(t, "--profile", "owner", "--allow-http", "channel-connect", "telegram", "--bot-token-file", file, "--no-wait")
	if err != nil || !strings.Contains(out, "job-one") || !strings.Contains(diag, "https://t.me/fixture") || !strings.Contains(diag, "▀▄") {
		t.Fatalf("%s %s %v", out, diag, err)
	}
	if strings.Contains(out+diag, secret) {
		t.Fatal("bot token leaked")
	}
}
func TestSetupCanListAssignedServicesBeforeSelectingAgent(t *testing.T) {
	_, _ = setupFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_agent-router/v1/setup" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		jsonResponse(w, 200, map[string]any{"hosts": []any{}})
	})
	if _, _, err := run(t, "--profile", "owner", "--allow-http", "setup-options"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, "--profile", "owner", "--allow-http", "channel-connect", "matrix"); err == nil || !strings.Contains(err.Error(), "select_an_owned_agent_first") {
		t.Fatalf("%v", err)
	}
}
func TestSetupRejectsWorkerCredentialsAndDifferentServiceOrigin(t *testing.T) {
	store, selected := setupFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Errorf("unexpected mutation %s", r.URL.Path) })
	selected.InstanceID = "worker"
	selected.Token = "ari_" + strings.Repeat("x", 43)
	if err := store.selectAgent(selected); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, "--profile", "owner", "--allow-http", "host-use", "personal"); err == nil || !strings.Contains(err.Error(), "owner_account_required") {
		t.Fatal(err)
	}
	selected.InstanceID = ""
	selected.Token = ""
	store.selectAgent(selected)
	if _, _, err := run(t, "--profile", "owner", "--allow-http", "setup-options", "--service-url", "https://evil.fixture/_agent-router/v1"); err == nil || !strings.Contains(err.Error(), "origin") {
		t.Fatal(err)
	}
}
func TestConnectionJobCanResumePairingAndCannotInjectTerminalControls(t *testing.T) {
	var paired bool
	store, selected := setupFixture(t, func(w http.ResponseWriter, r *http.Request) {
		path := "/_agent-router/v1/agents/agent-one/setup/jobs/job-one"
		if r.URL.Path == path+"/pairing" {
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["code"] != "123456" {
				t.Error("wrong pairing code")
			}
			paired = true
			w.WriteHeader(204)
			return
		}
		if r.URL.Path == path {
			jsonResponse(w, 200, setupJob{ID: "job-one", Kind: "weixin", State: "pairing", ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339)})
			return
		}
		t.Errorf("unexpected request %s", r.URL.Path)
		w.WriteHeader(404)
	})
	store.selectAgent(selected)
	out, diag, err := run(t, "--profile", "owner", "--allow-http", "channel-job", "job-one")
	if err != nil || !strings.Contains(out, "pairing") || !strings.Contains(diag, "channel-pair") {
		t.Fatalf("%s %s %v", out, diag, err)
	}
	file := filepath.Join(t.TempDir(), "pair-code")
	os.WriteFile(file, []byte("123456"), 0600)
	out, diag, err = run(t, "--profile", "owner", "--allow-http", "channel-pair", "job-one", "--pairing-code-file", file)
	if err != nil || !paired || strings.Contains(out+diag, "123456") {
		t.Fatalf("%s %s %v", out, diag, err)
	}
	a := &app{ctx: context.Background(), out: new(bytes.Buffer), errOut: new(bytes.Buffer)}
	if err = a.consent("https://fixture.test/\x1b[2J", ""); err == nil {
		t.Fatal("accepted terminal controls")
	}
	if err = a.consent("https://fixture.test", "\x1b[2J"); err == nil {
		t.Fatal("accepted QR terminal controls")
	}
}

func TestSetupGuideIsBundledInBothLanguagesWithoutLogin(t *testing.T) {
	isolated(t)
	for _, language := range []string{"en", "zh"} {
		out, _, err := run(t, "setup-guide", language)
		if err != nil || !strings.Contains(out, "agent-router setup helper --host personal") {
			t.Fatalf("%s %v", out, err)
		}
	}
}
