package cli

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Cloudflare Access login mode (ADR 0005 18.3, 19.6): the owner signs in at the edge instead of with a Matrix
// account. The profile keeps only the service URL and the verified owner; credentials are read on every call from
// files, the environment or `cloudflared access token`, and never stored.
type edgeProfile struct {
	Version    int    `json:"version"`
	ServiceURL string `json:"serviceUrl"`
	Owner      string `json:"owner"`
}

// ownerCredentials authenticate owner requests: a Matrix access token (bearer) or Cloudflare Access headers.
type ownerCredentials struct {
	UserID  string
	token   string
	headers http.Header
	edge    *edgeProfile
	profile *profile
}

func (s *profileStore) edgePath() string { return filepath.Join(s.dir, "edge.json") }
func (s *profileStore) edgeProfile() (*edgeProfile, error) {
	if _, err := os.Lstat(s.edgePath()); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err := s.ensure(); err != nil {
		return nil, err
	}
	var e edgeProfile
	if err := readPrivateJSON(s.edgePath(), &e); err != nil {
		return nil, err
	}
	if e.Version != 1 || !matrixID.MatchString(e.Owner) {
		return nil, errors.New("invalid_edge_profile")
	}
	if _, err := edgeServiceURL(e.ServiceURL, true); err != nil {
		return nil, err
	}
	return &e, nil
}
func (s *profileStore) saveEdge(e *edgeProfile) error {
	if err := s.ensure(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(e, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".edge-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(append(data, '\n')); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), s.edgePath())
}

// edgeServiceURL accepts the product origin (https://mau.example.test) or the Router API root on it.
func edgeServiceURL(value string, allowHTTP bool) (string, error) {
	base, err := homeserverURL(value, allowHTTP)
	if err != nil {
		return "", errors.New("edge_url_requires_https_without_credentials_query_or_fragment")
	}
	u, _ := url.Parse(base)
	switch strings.TrimRight(u.Path, "/") {
	case "", "/_agent-router/v1":
	default:
		return "", errors.New("edge_url_must_be_an_origin_or_its_agent_router_root")
	}
	return u.Scheme + "://" + u.Host + "/_agent-router/v1", nil
}

func readSecretValue(file, env, envFile string) (string, error) {
	if file == "" {
		file = os.Getenv(envFile)
	}
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return "", errors.New("cannot_read_" + strings.ToLower(envFile))
		}
		return secretInput(string(data))
	}
	if value := os.Getenv(env); value != "" {
		return secretInput(value)
	}
	return "", nil
}

// accessHeaders resolves Cloudflare Access credentials: a service token (client id and secret), an Access token
// (from `cloudflared access login`), or `cloudflared access token -app=ORIGIN` when cloudflared is installed.
func (a *app) accessHeaders(serviceURL string) (http.Header, error) {
	id, err := readSecretValue(a.o.accessClientIDFile, "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_ID_FILE")
	if err != nil {
		return nil, err
	}
	secret, err := readSecretValue(a.o.accessClientSecretFile, "CF_ACCESS_CLIENT_SECRET", "CF_ACCESS_CLIENT_SECRET_FILE")
	if err != nil {
		return nil, err
	}
	if (id == "") != (secret == "") {
		return nil, errors.New("access_service_token_requires_client_id_and_secret")
	}
	if id != "" {
		return http.Header{"Cf-Access-Client-Id": {id}, "Cf-Access-Client-Secret": {secret}}, nil
	}
	token, err := readSecretValue(a.o.accessTokenFile, "CF_ACCESS_TOKEN", "CF_ACCESS_TOKEN_FILE")
	if err != nil {
		return nil, err
	}
	if token == "" {
		if path, lookErr := exec.LookPath("cloudflared"); lookErr == nil {
			u, _ := url.Parse(serviceURL)
			ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
			defer cancel()
			out, runErr := exec.CommandContext(ctx, path, "access", "token", "-app="+u.Scheme+"://"+u.Host).Output()
			if runErr == nil {
				token = strings.TrimSpace(string(out))
			}
		}
	}
	if token == "" || strings.ContainsAny(token, "\r\n \t") {
		return nil, errors.New("access_credentials_required: run cloudflared access login URL, or set CF_ACCESS_CLIENT_ID_FILE and CF_ACCESS_CLIENT_SECRET_FILE")
	}
	return http.Header{"Cf-Access-Token": {token}}, nil
}

type accountInfo struct {
	Owner string `json:"owner"`
	Via   string `json:"via"`
	Email string `json:"email,omitempty"`
}

func (a *app) edgeAccount(serviceURL string, headers http.Header) (accountInfo, error) {
	var info accountInfo
	c, err := newHTTP(serviceURL, "")
	if err != nil {
		return info, err
	}
	c.Transport = withHeaders(c.Transport, headers)
	data, err := timedRequest(a.ctx, c, serviceURL, "/account", "GET", nil)
	if err != nil {
		return info, err
	}
	if json.Unmarshal(data, &info) != nil || !matrixID.MatchString(info.Owner) {
		return info, errors.New("invalid_account_response")
	}
	return info, nil
}

// edgeLogin: `agent-router login --edge URL [--access-client-id-file F --access-client-secret-file F | --access-token-file F]`.
func (a *app) edgeLogin(s *profileStore, args []string) error {
	if len(args) != 1 {
		return errors.New("use_login_--edge_URL")
	}
	serviceURL, err := edgeServiceURL(args[0], a.o.allowHTTP)
	if err != nil {
		return err
	}
	headers, err := a.accessHeaders(serviceURL)
	if err != nil {
		return err
	}
	info, err := a.edgeAccount(serviceURL, headers)
	if err != nil {
		return err
	}
	if err = s.saveEdge(&edgeProfile{Version: 1, ServiceURL: serviceURL, Owner: info.Owner}); err != nil {
		return err
	}
	return a.output(map[string]any{"profile": s.name, "login": "edge", "serviceUrl": serviceURL, "userId": info.Owner, "via": info.Via,
		"message": "Edge login saved. Run agent-router agent-create NAME, or agent-router agents."})
}

// owner returns the credentials of the profile's owner: the edge login when one is saved, otherwise the Matrix account.
func (a *app) owner(s *profileStore) (*ownerCredentials, error) {
	e, err := s.edgeProfile()
	if err != nil {
		return nil, err
	}
	if e != nil {
		headers, err := a.accessHeaders(e.ServiceURL)
		if err != nil {
			return nil, err
		}
		info, err := a.edgeAccount(e.ServiceURL, headers)
		if err != nil {
			return nil, err
		}
		if info.Owner != e.Owner {
			return nil, errors.New("account_identity_mismatch")
		}
		return &ownerCredentials{UserID: e.Owner, headers: headers, edge: e}, nil
	}
	p, err := a.ownerSession(s)
	if err != nil {
		return nil, err
	}
	return &ownerCredentials{UserID: p.UserID, token: p.AccessToken, profile: p}, nil
}

// service is the Router API root for owner requests; an edge login is bound to its own service URL.
func (o *ownerCredentials) service(selected string, allowHTTP bool) (string, error) {
	if o.edge != nil {
		if selected != "" && strings.TrimRight(selected, "/") != o.edge.ServiceURL {
			return "", errors.New("agent_service_must_match_edge_login")
		}
		return o.edge.ServiceURL, nil
	}
	return accountService(o.profile, selected, allowHTTP)
}

// client is an HTTP client for `base` that carries the owner's credentials (same origin only).
func (o *ownerCredentials) client(base string) (*http.Client, error) {
	c, err := newHTTP(base, o.token)
	if err != nil {
		return nil, err
	}
	if o.headers != nil {
		c.Transport = withHeaders(c.Transport, o.headers)
	}
	return c, nil
}

// withHeaders adds fixed headers inside the origin guard, so they never leave the selected origin.
func withHeaders(next http.RoundTripper, headers http.Header) http.RoundTripper {
	guard, ok := next.(originTransport)
	if !ok {
		return next
	}
	guard.headers = headers
	return guard
}
