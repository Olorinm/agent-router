package cli

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

type managedAgent struct {
	ID       string `json:"id"`
	Owner    string `json:"owner"`
	Name     string `json:"name"`
	Address  string `json:"address"`
	MatrixID string `json:"matrixId"`
}
type agentSelection struct {
	Version    int          `json:"version"`
	ServiceURL string       `json:"serviceUrl"`
	Agent      managedAgent `json:"agent"`
	InstanceID string       `json:"instanceId,omitempty"`
	Token      string       `json:"token,omitempty"`
}

func serviceURL(value string, allowHTTP bool) (string, error) {
	return homeserverURL(value, allowHTTP)
}
func (s *profileStore) selection() (*agentSelection, error) {
	path := filepath.Join(s.dir, "agent.json")
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err := s.ensure(); err != nil {
		return nil, err
	}
	var selected agentSelection
	if err := readPrivateJSON(path, &selected); err != nil {
		return nil, err
	}
	if err := selected.validate(); err != nil {
		return nil, err
	}
	return &selected, nil
}
func readPrivateJSON(path string, value any) error {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return errors.New("cannot_read_private_agent_credentials")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if err = privateInfo(info, false); err != nil {
		return err
	}
	if info.Size() > 65536 {
		return errors.New("agent_credentials_too_large")
	}
	d := json.NewDecoder(f)
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("invalid_agent_credentials_json")
	}
	return nil
}
func (selected *agentSelection) validate() error {
	if selected.Version != 1 || selected.Agent.ID == "" || !matrixID.MatchString(selected.Agent.Owner) || !matrixID.MatchString(selected.Agent.MatrixID) || selected.Agent.Name == "" {
		return errors.New("invalid_agent_selection")
	}
	if _, err := serviceURL(selected.ServiceURL, true); err != nil {
		return err
	}
	if (selected.InstanceID == "") != (selected.Token == "") || (selected.Token != "" && (!strings.HasPrefix(selected.Token, "ari_") || len(selected.Token) < 36)) {
		return errors.New("invalid_instance_credentials")
	}
	return nil
}
func (s *profileStore) selectAgent(selected *agentSelection) error {
	if err := selected.validate(); err != nil {
		return err
	}
	if err := s.ensure(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(selected, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".agent-")
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
	return os.Rename(f.Name(), filepath.Join(s.dir, "agent.json"))
}
func (a *app) ownerSession(s *profileStore) (*profile, error) {
	p, err := s.require()
	if err != nil {
		return nil, err
	}
	c, err := newHTTP(p.Homeserver, p.AccessToken)
	if err != nil {
		return nil, err
	}
	data, err := timedRequest(a.ctx, c, p.Homeserver, "/_matrix/client/v3/account/whoami", "GET", nil)
	if unknownToken(err) {
		release, lockErr := s.lock()
		if lockErr != nil {
			return nil, lockErr
		}
		defer release()
		p, err = s.require()
		if err != nil {
			return nil, err
		}
		data, err = a.profileRequest(s, p, "/_matrix/client/v3/account/whoami", "GET", nil)
	}
	if err != nil {
		return nil, authError(err)
	}
	var identity credentials
	if json.Unmarshal(data, &identity) != nil || identity.UserID != p.UserID {
		return nil, errors.New("account_identity_mismatch")
	}
	return p, nil
}
func accountService(p *profile, selected string, allowHTTP bool) (string, error) {
	if selected == "" {
		selected = strings.TrimRight(p.Homeserver, "/") + "/_agent-router/v1"
	}
	base, err := serviceURL(selected, allowHTTP)
	if err != nil {
		return "", err
	}
	u, _ := url.Parse(base)
	h, _ := url.Parse(p.Homeserver)
	if !sameOrigin(u, h) {
		return "", errors.New("agent_service_must_share_account_server_origin")
	}
	return base, nil
}
func (a *app) managedGateway() (bool, error) {
	if a.o.profile == "" && os.Getenv("MATRIX_PROFILE") == "" && (os.Getenv("CONNECTOR_API_TOKEN") != "" || os.Getenv("CONNECTOR_API_TOKEN_FILE") != "") {
		return false, nil
	}
	s, err := newStore(a.o.profile)
	if err != nil {
		return false, err
	}
	selected, err := s.selection()
	if err != nil || selected == nil {
		return false, err
	}
	token := selected.Token
	if token == "" {
		p, err := a.ownerSession(s)
		if err != nil {
			return true, err
		}
		if p.UserID != selected.Agent.Owner {
			return true, errors.New("selected_agent_belongs_to_another_account")
		}
		if _, err = accountService(p, selected.ServiceURL, true); err != nil {
			return true, err
		}
		token = p.AccessToken
	}
	a.base = selected.ServiceURL + "/agents/" + url.PathEscape(selected.Agent.ID) + "/gateway"
	a.http, err = newHTTP(a.base, token)
	if err == nil && selected.Token == "" {
		a.http.Transport = &managedOwnerTransport{app: a, store: s, selected: selected, next: a.http.Transport}
	}
	return true, err
}

// A long --wait can outlive the Matrix access token. Refresh on the account
// origin, then retry a request rejected by the gateway before it performed work.
type managedOwnerTransport struct {
	app      *app
	store    *profileStore
	selected *agentSelection
	next     http.RoundTripper
	mu       sync.Mutex
}

func (t *managedOwnerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	next := t.next
	t.mu.Unlock()
	response, err := next.RoundTrip(req)
	if err != nil || response.StatusCode != 401 {
		return response, err
	}
	response.Body.Close()
	t.mu.Lock()
	defer t.mu.Unlock()
	p, err := t.app.ownerSession(t.store)
	if err != nil {
		return nil, err
	}
	if p.UserID != t.selected.Agent.Owner {
		return nil, errors.New("account_identity_changed")
	}
	c, err := newHTTP(t.app.base, p.AccessToken)
	if err != nil {
		return nil, err
	}
	t.next = c.Transport
	copy := req.Clone(req.Context())
	if req.Body != nil && req.Body != http.NoBody {
		if req.GetBody == nil {
			return nil, errors.New("session_refreshed_retry_command")
		}
		copy.Body, err = req.GetBody()
		if err != nil {
			return nil, err
		}
	}
	return t.next.RoundTrip(copy)
}
func (a *app) agentCommand(command string, args []string) (bool, error) {
	switch command {
	case "agents", "agent-create", "agent-use", "agent-current", "agent-instances", "agent-instance-create", "agent-instance-revoke", "agent-attach", "agent-resolve":
	default:
		return false, nil
	}
	return true, a.runAgentCommand(command, args)
}
func (a *app) runAgentCommand(command string, args []string) error {
	s, err := newStore(a.o.profile)
	if err != nil {
		return err
	}
	if command == "agent-resolve" {
		id, err := a.resolveAgent(args[0])
		if err != nil {
			return err
		}
		return a.output(map[string]string{"address": args[0], "matrixId": id})
	}
	if command == "agent-attach" {
		var selected agentSelection
		if err = readPrivateJSON(args[0], &selected); err != nil {
			return err
		}
		if err = selected.validate(); err != nil {
			return err
		}
		if selected.Token == "" {
			return errors.New("instance_credentials_required")
		}
		if _, err = serviceURL(selected.ServiceURL, a.o.allowHTTP); err != nil {
			return err
		}
		base := selected.ServiceURL + "/agents/" + url.PathEscape(selected.Agent.ID) + "/gateway"
		c, err := newHTTP(base, selected.Token)
		if err != nil {
			return err
		}
		data, err := timedRequest(a.ctx, c, base, "/api/status", "GET", nil)
		if err != nil {
			return err
		}
		var status struct {
			UserID string `json:"userId"`
		}
		if json.Unmarshal(data, &status) != nil || status.UserID != selected.Agent.MatrixID {
			return errors.New("instance_identity_mismatch")
		}
		if err = s.selectAgent(&selected); err != nil {
			return err
		}
		return a.output(map[string]any{"profile": s.name, "agent": selected.Agent, "instanceId": selected.InstanceID, "connected": true})
	}
	selected, err := s.selection()
	if err != nil {
		return err
	}
	if command == "agent-current" {
		if selected == nil {
			return errors.New("no_agent_selected: run agent-create or agent-use")
		}
		return a.output(map[string]any{"profile": s.name, "agent": selected.Agent, "instanceId": selected.InstanceID, "serviceUrl": selected.ServiceURL})
	}
	if selected != nil && selected.Token != "" {
		return errors.New("owner_account_required: use an account profile")
	}
	p, err := a.ownerSession(s)
	if err != nil {
		return err
	}
	root := a.o.serviceURL
	if root == "" && selected != nil {
		root = selected.ServiceURL
	}
	root, err = accountService(p, root, a.o.allowHTTP)
	if err != nil {
		return err
	}
	c, err := newHTTP(root, p.AccessToken)
	if err != nil {
		return err
	}
	if command == "agent-create" || command == "agent-use" || command == "agents" {
		method, body := "GET", any(nil)
		if command == "agent-create" {
			method = "POST"
			body = map[string]string{"name": args[0]}
		}
		data, err := timedRequest(a.ctx, c, root, "/agents", method, body)
		if err != nil {
			return err
		}
		if command == "agents" {
			return a.output(data)
		}
		var agent managedAgent
		if command == "agent-create" {
			err = json.Unmarshal(data, &agent)
		} else {
			var list struct {
				Data []managedAgent `json:"data"`
			}
			err = json.Unmarshal(data, &list)
			for _, candidate := range list.Data {
				if candidate.Name == args[0] || candidate.ID == args[0] {
					agent = candidate
					break
				}
			}
		}
		if err != nil || agent.ID == "" || agent.Owner != p.UserID {
			return errors.New("owned_agent_not_found")
		}
		if err = s.selectAgent(&agentSelection{Version: 1, ServiceURL: root, Agent: agent}); err != nil {
			return err
		}
		return a.output(agent)
	}
	if selected == nil || selected.Agent.Owner != p.UserID {
		return errors.New("select_an_owned_agent_first")
	}
	path, method := "/agents/"+url.PathEscape(selected.Agent.ID)+"/instances", "GET"
	var body any
	var output *os.File
	if command == "agent-instance-create" {
		if a.o.outputFile == "" {
			return errors.New("instance_create_requires_out_file_for_private_credentials")
		}
		output, err = os.OpenFile(a.o.outputFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return errors.New("cannot_create_credentials_file: choose a new --out path")
		}
		defer output.Close()
		method = "POST"
		body = map[string]string{"name": args[0]}
	} else if command == "agent-instance-revoke" {
		method = "DELETE"
		path += "/" + url.PathEscape(args[0])
	}
	data, err := timedRequest(a.ctx, c, root, path, method, body)
	if err != nil {
		return err
	}
	if output != nil {
		var issued struct {
			Instance struct {
				ID string `json:"id"`
			} `json:"instance"`
			Token string `json:"token"`
		}
		if json.Unmarshal(data, &issued) != nil || issued.Instance.ID == "" || issued.Token == "" {
			return errors.New("invalid_instance_response")
		}
		exported := agentSelection{Version: 1, ServiceURL: root, Agent: selected.Agent, InstanceID: issued.Instance.ID, Token: issued.Token}
		if err = json.NewEncoder(output).Encode(exported); err != nil {
			return err
		}
		if err = output.Sync(); err != nil {
			return err
		}
		return a.output(map[string]string{"agentId": selected.Agent.ID, "instanceId": issued.Instance.ID, "credentialsFile": a.o.outputFile})
	}
	if data == nil {
		return nil
	}
	return a.output(data)
}

func (a *app) resolveAgent(address string) (string, error) {
	if matrixID.MatchString(address) {
		return address, nil
	}
	at := strings.LastIndex(address, "@")
	if at < 1 || !strings.Contains(address[:at], "/") {
		return "", errors.New("use_owner_slash_agent_at_server_address")
	}
	domain := address[at+1:]
	if strings.ContainsAny(domain, "/?#\\") || domain == "" {
		return "", errors.New("invalid_agent_server")
	}
	base := "https://" + domain + "/_agent-router/v1"
	if a.o.serviceURL != "" {
		configured, err := url.Parse(a.o.serviceURL)
		if err != nil || configured.Host != domain {
			return "", errors.New("resolver_origin_mismatch")
		}
		base = strings.TrimRight(a.o.serviceURL, "/")
	}
	c, err := backendHTTP(base, "", a.o.allowHTTP)
	if err != nil {
		return "", err
	}
	data, err := timedRequest(a.ctx, c, base, "/directory?"+url.Values{"address": {address}}.Encode(), "GET", nil)
	if err != nil {
		return "", err
	}
	var agent managedAgent
	if json.Unmarshal(data, &agent) != nil || agent.Address != address || !matrixID.MatchString(agent.MatrixID) || !strings.HasSuffix(agent.MatrixID, ":"+domain) {
		return "", errors.New("invalid_agent_directory_response")
	}
	return agent.MatrixID, nil
}
