package routerapi

import (
	"context"
	"encoding/json"
	"iter"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
)

type echoExecutor struct{}

func (*echoExecutor) Execute(_ context.Context, _ *a2asrv.ExecutorContext) iter.Seq2[a2a.Event, error] {
	return func(yield func(a2a.Event, error) bool) {
		yield(a2a.NewMessage(a2a.MessageRoleAgent, a2a.NewTextPart("echo: hello")), nil)
	}
}

func (*echoExecutor) Cancel(_ context.Context, execCtx *a2asrv.ExecutorContext) iter.Seq2[a2a.Event, error] {
	return func(yield func(a2a.Event, error) bool) {
		yield(a2a.NewStatusUpdateEvent(execCtx, a2a.TaskStateCanceled, nil), nil)
	}
}

func TestClientUsesOfficialA2AClientWithBearerAuth(t *testing.T) {
	a2aHandler := a2asrv.NewJSONRPCHandler(a2asrv.NewHandler(&echoExecutor{}))
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/agents/echo@example.com/.well-known/agent-card.json" {
			card := &a2a.AgentCard{
				Name: "Echo", Description: "Echo test agent", Version: "1.0.0",
				SupportedInterfaces:  []*a2a.AgentInterface{a2a.NewAgentInterface(server.URL+"/jsonrpc", a2a.TransportProtocolJSONRPC)},
				SecuritySchemes:      a2a.NamedSecuritySchemes{"RouterCredential": a2a.HTTPAuthSecurityScheme{Scheme: "bearer"}},
				SecurityRequirements: a2a.SecurityRequirementsOptions{{"RouterCredential": {}}},
			}
			_ = json.NewEncoder(w).Encode(card)
			return
		}
		if r.URL.Path == "/jsonrpc" {
			a2aHandler.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := New(server.URL, "test-token")
	a2aClient, ctx, err := client.A2A(context.Background(), "echo@example.com")
	if err != nil {
		t.Fatal(err)
	}
	result, err := a2aClient.SendMessage(ctx, &a2a.SendMessageRequest{Message: a2a.NewMessage(a2a.MessageRoleUser, a2a.NewTextPart("hello"))})
	if err != nil {
		t.Fatal(err)
	}
	message, ok := result.(*a2a.Message)
	if !ok || message.Parts[0].Text() != "echo: hello" {
		t.Fatalf("unexpected A2A result: %#v", result)
	}
}

func TestDiscover(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"baseUrl":"https://router.example.com","serviceVersion":"1.0"}`))
	}))
	defer server.Close()
	domain, baseURL, err := Discover(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if domain != "127.0.0.1" || baseURL != "https://router.example.com" {
		t.Fatalf("unexpected discovery result: %s %s", domain, baseURL)
	}
}
