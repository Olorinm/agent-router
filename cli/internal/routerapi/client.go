package routerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
)

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

type Discovery struct {
	BaseURL           string `json:"baseUrl"`
	ServiceVersion    string `json:"serviceVersion,omitempty"`
	FederationVersion string `json:"federationVersion,omitempty"`
}

type Error struct {
	Status int
	Code   string
}

func (e *Error) Error() string { return fmt.Sprintf("Router returned HTTP %d: %s", e.Status, e.Code) }

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

func Discover(ctx context.Context, input string) (string, string, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", "", errors.New("Router domain is empty")
	}
	domain := input
	baseURL := ""
	if strings.Contains(input, "://") {
		u, err := url.Parse(input)
		if err != nil || u.Host == "" {
			return "", "", errors.New("invalid Router URL")
		}
		domain, baseURL = u.Hostname(), strings.TrimRight(u.String(), "/")
	} else {
		domain = strings.ToLower(input)
		baseURL = "https://" + domain
	}
	discoveryURL := strings.TrimRight(baseURL, "/") + "/.well-known/agent-router"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, discoveryURL, nil)
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", "", fmt.Errorf("discover Router: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("discover Router: HTTP %d", resp.StatusCode)
	}
	var document Discovery
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&document); err != nil {
		return "", "", fmt.Errorf("decode Router discovery: %w", err)
	}
	if document.BaseURL == "" {
		return "", "", errors.New("Router discovery document has no baseUrl")
	}
	discovered, err := url.Parse(document.BaseURL)
	if err != nil || discovered.Host == "" || (discovered.Scheme != "https" && discovered.Scheme != "http") {
		return "", "", errors.New("Router discovery baseUrl is invalid")
	}
	return domain, strings.TrimRight(document.BaseURL, "/"), nil
}

func (c *Client) Do(ctx context.Context, method, path string, body, target any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var result struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result)
		if result.Error == "" {
			result.Error = http.StatusText(resp.StatusCode)
		}
		return &Error{Status: resp.StatusCode, Code: result.Error}
	}
	if target == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(target)
}

func (c *Client) FetchCard(ctx context.Context, address string) (*a2a.AgentCard, error) {
	path := "/agents/" + url.PathEscape(address) + "/.well-known/agent-card.json"
	var card a2a.AgentCard
	if err := c.Do(ctx, http.MethodGet, path, nil, &card); err != nil {
		return nil, err
	}
	return &card, nil
}

func FetchExternalCard(ctx context.Context, cardURL, token string) (*a2a.AgentCard, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cardURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Agent Card returned HTTP %d", resp.StatusCode)
	}
	var card a2a.AgentCard
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&card); err != nil {
		return nil, fmt.Errorf("decode Agent Card: %w", err)
	}
	if err := ValidateCard(&card); err != nil {
		return nil, err
	}
	return &card, nil
}

func ValidateCard(card *a2a.AgentCard) error {
	if strings.TrimSpace(card.Name) == "" || strings.TrimSpace(card.Description) == "" || strings.TrimSpace(card.Version) == "" {
		return errors.New("Agent Card requires name, description, and version")
	}
	if len(card.SupportedInterfaces) == 0 {
		return errors.New("Agent Card has no supported interfaces")
	}
	for _, endpoint := range card.SupportedInterfaces {
		if endpoint == nil || endpoint.URL == "" || endpoint.ProtocolVersion != a2a.Version {
			continue
		}
		if _, err := url.ParseRequestURI(endpoint.URL); err == nil {
			return nil
		}
	}
	return fmt.Errorf("Agent Card has no valid A2A %s interface", a2a.Version)
}

func (c *Client) A2A(ctx context.Context, address string) (*a2aclient.Client, context.Context, error) {
	card, err := c.FetchCard(ctx, address)
	if err != nil {
		return nil, ctx, err
	}
	store := a2aclient.NewInMemoryCredentialsStore()
	sessionID := a2aclient.SessionID("agent-router-cli")
	for scheme := range card.SecuritySchemes {
		store.Set(sessionID, scheme, a2aclient.AuthCredential(c.Token))
	}
	client, err := a2aclient.NewFromCard(
		ctx,
		card,
		a2aclient.WithCallInterceptors(&a2aclient.AuthInterceptor{Service: store}),
	)
	if err != nil {
		return nil, ctx, err
	}
	return client, a2aclient.AttachSessionID(ctx, sessionID), nil
}
