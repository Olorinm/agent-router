package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"golang.org/x/term"
)

func secretInput(value string) (string, error) {
	value = strings.TrimSuffix(strings.TrimSuffix(value, "\n"), "\r")
	if value == "" || len(value) > 65536 || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("provide_one_nonempty_line_of_secret_input")
	}
	return value, nil
}
func (a *app) secretFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("cannot_read_secret_file")
	}
	return secretInput(string(data))
}
func (a *app) prompt(label string) (string, error) {
	in, ok := a.in.(*os.File)
	if !ok || !term.IsTerminal(int(in.Fd())) {
		return "", fmt.Errorf("%s requires a terminal; use a secret file or stdin option", label)
	}
	out, ok := a.errOut.(*os.File)
	if !ok || !term.IsTerminal(int(out.Fd())) {
		return "", errors.New("hidden_prompt_requires_a_terminal")
	}
	fmt.Fprintf(a.errOut, "%s: ", label)
	// Restore echo if the process receives SIGINT/SIGTERM during a secret prompt.
	state, err := term.GetState(int(in.Fd()))
	if err != nil {
		return "", err
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-a.ctx.Done():
			term.Restore(int(in.Fd()), state)
			_ = in.Close()
		case <-done:
		}
	}()
	data, err := term.ReadPassword(int(in.Fd()))
	close(done)
	_ = term.Restore(int(in.Fd()), state)
	fmt.Fprintln(a.errOut)
	if a.ctx.Err() != nil {
		return "", a.ctx.Err()
	}
	if err != nil {
		return "", errors.New("secret_input_failed")
	}
	return secretInput(string(data))
}
func (a *app) password(confirm bool) (string, error) {
	o := a.o
	if o.passwordStdin && o.passwordFile != "" {
		return "", errors.New("choose_password_stdin_or_file")
	}
	if o.passwordFile != "" {
		return a.secretFile(o.passwordFile)
	}
	if o.passwordStdin {
		data, err := io.ReadAll(io.LimitReader(a.in, 65539))
		if err != nil {
			return "", err
		}
		return secretInput(string(data))
	}
	value, err := a.prompt("Password")
	if err != nil {
		return "", err
	}
	if confirm {
		again, err := a.prompt("Confirm password")
		if err != nil {
			return "", err
		}
		if value != again {
			return "", errors.New("passwords_do_not_match")
		}
	}
	return value, nil
}
func authError(err error) error {
	var h *httpError
	if !errors.As(err, &h) {
		return err
	}
	messages := map[string]string{"M_FORBIDDEN": "The server rejected the credentials or registration is not permitted.", "M_USER_IN_USE": "That username is already registered. Use login or choose another name.", "M_INVALID_USERNAME": "The server rejected that username.", "M_WEAK_PASSWORD": "The password does not meet the server policy.", "M_UNKNOWN_TOKEN": "The session has expired or been revoked. Log in again.", "M_LIMIT_EXCEEDED": "The server rate limit was reached. Retry later."}
	if message := messages[h.code]; message != "" {
		return errors.New(message)
	}
	return fmt.Errorf("account_request_failed (HTTP %d)", h.status)
}
func unknownToken(err error) bool {
	var h *httpError
	return errors.As(err, &h) && h.code == "M_UNKNOWN_TOKEN"
}
func (a *app) discover(input string) (string, error) {
	domain := input
	if strings.HasPrefix(input, "@") {
		if !matrixID.MatchString(input) {
			return "", errors.New("invalid_agent_address")
		}
		domain = strings.SplitN(input, ":", 2)[1]
	}
	base, err := homeserverURL(domain, a.o.allowHTTP)
	if err != nil {
		return "", err
	}
	c, err := newHTTP(base, "")
	if err != nil {
		return "", err
	}
	if !strings.Contains(domain, "://") {
		data, err := timedRequest(a.ctx, c, base, "/.well-known/matrix/client", "GET", nil)
		var h *httpError
		if err != nil && !(errors.As(err, &h) && h.status == 404) {
			return "", authError(err)
		}
		if err == nil {
			var discovery struct {
				Server struct {
					URL string `json:"base_url"`
				} `json:"m.homeserver"`
			}
			if json.Unmarshal(data, &discovery) != nil || discovery.Server.URL == "" {
				return "", errors.New("invalid_account_server_discovery")
			}
			base, err = homeserverURL(discovery.Server.URL, a.o.allowHTTP)
			if err != nil {
				return "", err
			}
			c, err = newHTTP(base, "")
			if err != nil {
				return "", err
			}
		}
	}
	data, err := timedRequest(a.ctx, c, base, "/_matrix/client/versions", "GET", nil)
	if err != nil {
		return "", authError(err)
	}
	var versions struct {
		Versions []string `json:"versions"`
	}
	if json.Unmarshal(data, &versions) != nil || len(versions.Versions) == 0 {
		return "", errors.New("server_does_not_advertise_client_apis")
	}
	return base, nil
}

type credentials struct {
	UserID       string `json:"user_id"`
	DeviceID     string `json:"device_id"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func (a *app) login(base, user, password, device string) (credentials, error) {
	var result credentials
	c, err := newHTTP(base, "")
	if err != nil {
		return result, err
	}
	flows, err := loginFlows(a.ctx, c, base)
	if err != nil {
		return result, err
	}
	supported := false
	for _, flow := range flows {
		if flow == "m.login.password" {
			supported = true
		}
	}
	if !supported {
		return result, errors.New("server_does_not_offer_password_login: SSO/OAuth is not yet supported")
	}
	data, err := timedRequest(a.ctx, c, base, "/_matrix/client/v3/login", "POST", map[string]any{"type": "m.login.password", "identifier": map[string]string{"type": "m.id.user", "user": user}, "password": password, "initial_device_display_name": device, "refresh_token": true})
	if err != nil {
		return result, authError(err)
	}
	if json.Unmarshal(data, &result) != nil {
		return result, errors.New("invalid_login_response")
	}
	return result, nil
}
func loginFlows(ctx context.Context, c *http.Client, base string) ([]string, error) {
	data, err := timedRequest(ctx, c, base, "/_matrix/client/v3/login", "GET", nil)
	if err != nil {
		return nil, authError(err)
	}
	var result struct {
		Flows []struct {
			Type string `json:"type"`
		} `json:"flows"`
	}
	if json.Unmarshal(data, &result) != nil {
		return nil, errors.New("invalid_login_flows")
	}
	flows := []string{}
	for _, f := range result.Flows {
		flows = append(flows, f.Type)
	}
	return flows, nil
}
func (a *app) register(base, user, password, device string) (credentials, error) {
	var result credentials
	c, err := newHTTP(base, "")
	if err != nil {
		return result, err
	}
	body := map[string]any{"username": user, "password": password, "initial_device_display_name": device, "refresh_token": true}
	lastStage, token, session := "", "", ""
	for attempt := 0; attempt < 8; attempt++ {
		data, err := timedRequest(a.ctx, c, base, "/_matrix/client/v3/register", "POST", body)
		if err == nil {
			if json.Unmarshal(data, &result) != nil {
				return result, errors.New("invalid_registration_response")
			}
			return result, nil
		}
		var h *httpError
		if !errors.As(err, &h) || h.status != 401 {
			return result, authError(err)
		}
		var challenge struct {
			Session string `json:"session"`
			Flows   []struct {
				Stages []string `json:"stages"`
			} `json:"flows"`
			Completed []string `json:"completed"`
		}
		raw, _ := json.Marshal(h.data)
		if json.Unmarshal(raw, &challenge) != nil || challenge.Session == "" || challenge.Flows == nil {
			return result, authError(err)
		}
		if session != "" && session != challenge.Session {
			return result, errors.New("registration_session_changed")
		}
		session = challenge.Session
		supported := [][]string{}
		for _, f := range challenge.Flows {
			ok := len(f.Stages) > 0
			for _, s := range f.Stages {
				if s != "m.login.dummy" && s != "m.login.registration_token" {
					ok = false
				}
			}
			if ok {
				supported = append(supported, f.Stages)
			}
		}
		sort.SliceStable(supported, func(i, j int) bool { return len(supported[i]) < len(supported[j]) })
		if len(supported) == 0 {
			return result, errors.New("registration_requires_additional_verification: complete it in a compatible client, then login")
		}
		completed := map[string]bool{}
		for _, s := range challenge.Completed {
			completed[s] = true
		}
		stage := ""
		for _, s := range supported[0] {
			if !completed[s] {
				stage = s
				break
			}
		}
		if stage == "" || stage == lastStage {
			return result, errors.New("registration_verification_rejected: check the invitation and retry")
		}
		lastStage = stage
		auth := map[string]string{"type": stage, "session": session}
		if stage == "m.login.registration_token" {
			if token == "" {
				if a.o.registrationTokenFile != "" {
					token, err = a.secretFile(a.o.registrationTokenFile)
				} else {
					token, err = a.prompt("Registration invitation code")
				}
				if err != nil {
					return result, err
				}
			}
			auth["token"] = token
		}
		body["auth"] = auth
	}
	return result, errors.New("registration_verification_steps_exceeded")
}
func (a *app) saveLogin(s *profileStore, base string, cred credentials) (p *profile, err error) {
	if !matrixID.MatchString(cred.UserID) || cred.DeviceID == "" || cred.AccessToken == "" {
		return nil, errors.New("server_did_not_issue_a_device_and_access_token")
	}
	c, err := newHTTP(base, cred.AccessToken)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = request(ctx, c, base, "/_matrix/client/v3/logout", "POST", map[string]any{})
		}
	}()
	data, err := timedRequest(a.ctx, c, base, "/_matrix/client/v3/account/whoami", "GET", nil)
	if err != nil {
		return nil, authError(err)
	}
	var identity credentials
	if json.Unmarshal(data, &identity) != nil || identity.UserID != cred.UserID || (identity.DeviceID != "" && identity.DeviceID != cred.DeviceID) {
		return nil, errors.New("login_identity_verification_failed")
	}
	old, err := s.load()
	if err != nil {
		return nil, err
	}
	if old != nil && (old.UserID != cred.UserID || old.Homeserver != base) {
		return nil, errors.New("profile_belongs_to_another_identity: use --profile NAME")
	}
	p = &profile{Version: 1, Homeserver: base, UserID: cred.UserID, DeviceID: cred.DeviceID, AccessToken: cred.AccessToken, RefreshToken: cred.RefreshToken, ConnectorURL: "http://127.0.0.1:8787"}
	if old != nil {
		p.GatewayToken = old.GatewayToken
		p.ConnectorURL = old.ConnectorURL
		p.Backend = old.Backend
	} else {
		p.GatewayToken, err = randomHex(32)
		if err != nil {
			return nil, err
		}
	}
	if err = s.save(p); err != nil {
		return nil, err
	}
	return p, nil
}

// Only call with the shared profile lock held: refresh tokens may rotate once.
func (a *app) profileRequest(s *profileStore, p *profile, path, method string, body any) (json.RawMessage, error) {
	c, err := newHTTP(p.Homeserver, p.AccessToken)
	if err != nil {
		return nil, err
	}
	data, err := timedRequest(a.ctx, c, p.Homeserver, path, method, body)
	if !unknownToken(err) || p.RefreshToken == "" {
		return data, err
	}
	anonymous, err := newHTTP(p.Homeserver, "")
	if err != nil {
		return nil, err
	}
	refreshed, err := timedRequest(a.ctx, anonymous, p.Homeserver, "/_matrix/client/v3/refresh", "POST", map[string]string{"refresh_token": p.RefreshToken})
	if err != nil {
		return nil, err
	}
	var cred credentials
	if json.Unmarshal(refreshed, &cred) != nil || cred.AccessToken == "" {
		return nil, errors.New("invalid_refresh_response")
	}
	p.AccessToken = cred.AccessToken
	if cred.RefreshToken != "" {
		p.RefreshToken = cred.RefreshToken
	}
	if err = s.save(p); err != nil {
		return nil, err
	}
	c, err = newHTTP(p.Homeserver, p.AccessToken)
	if err != nil {
		return nil, err
	}
	return timedRequest(a.ctx, c, p.Homeserver, path, method, body)
}
func (a *app) account(command string, args []string) (bool, error) {
	switch command {
	case "register", "login", "logout", "whoami", "bind", "configure", "discover", "find", "lookup", "profile-set":
	default:
		return false, nil
	}
	err := a.accountRun(command, args)
	return true, err
}
func (a *app) accountRun(command string, args []string) error {
	s, err := newStore(a.o.profile)
	if err != nil {
		return err
	}
	if command == "discover" {
		base, err := a.discover(args[0])
		if err != nil {
			return err
		}
		c, err := newHTTP(base, "")
		if err != nil {
			return err
		}
		flows, err := loginFlows(a.ctx, c, base)
		if err != nil {
			return err
		}
		return a.output(map[string]any{"homeserver": base, "loginFlows": flows})
	}
	if command == "whoami" || command == "find" || command == "lookup" || command == "profile-set" {
		p, err := s.require()
		if err != nil {
			return err
		}
		c, err := newHTTP(p.Homeserver, p.AccessToken)
		if err != nil {
			return err
		}
		path, method, body := "/_matrix/client/v3/account/whoami", "GET", any(nil)
		switch command {
		case "find":
			path = "/_matrix/client/v3/user_directory/search"
			method = "POST"
			body = map[string]any{"search_term": args[0], "limit": 50}
		case "lookup":
			user := p.UserID
			if len(args) > 0 {
				user = args[0]
			}
			path = "/_matrix/client/v3/profile/" + url.PathEscape(user)
		case "profile-set":
			if strings.TrimSpace(args[0]) == "" || len([]rune(args[0])) > 255 {
				return errors.New("display_name_must_be_1_to_255_characters")
			}
			path = "/_matrix/client/v3/profile/" + url.PathEscape(p.UserID) + "/displayname"
			method = "PUT"
			body = map[string]string{"displayname": args[0]}
		}
		data, err := timedRequest(a.ctx, c, p.Homeserver, path, method, body)
		if unknownToken(err) {
			release, lockErr := s.lock()
			if lockErr != nil {
				return lockErr
			}
			defer release()
			current, loadErr := s.require()
			if loadErr != nil {
				return loadErr
			}
			if current.UserID != p.UserID || current.Homeserver != p.Homeserver {
				return errors.New("profile_identity_changed_during_request")
			}
			p = current
			data, err = a.profileRequest(s, p, path, method, body)
		}
		if err != nil {
			return authError(err)
		}
		switch command {
		case "whoami":
			var id credentials
			if json.Unmarshal(data, &id) != nil || id.UserID != p.UserID {
				return errors.New("saved_identity_does_not_match_server")
			}
			return a.output(s.public(p))
		case "profile-set":
			return a.output(map[string]string{"userId": p.UserID, "displayname": args[0]})
		case "lookup":
			var info map[string]any
			if json.Unmarshal(data, &info) != nil {
				return errors.New("invalid_public_profile")
			}
			info["userId"] = p.UserID
			if len(args) > 0 {
				info["userId"] = args[0]
			}
			return a.output(info)
		default:
			return a.output(data)
		}
	}
	release, err := s.lock()
	if err != nil {
		return err
	}
	defer release()
	if command == "logout" || command == "configure" || command == "bind" {
		p, err := s.require()
		if err != nil {
			return err
		}
		switch command {
		case "logout":
			_, err = a.profileRequest(s, p, "/_matrix/client/v3/logout", "POST", map[string]any{})
			if err != nil && !unknownToken(err) {
				return authError(err)
			}
			p.AccessToken = ""
			p.RefreshToken = ""
			if err = s.save(p); err != nil {
				return err
			}
			return a.output(map[string]any{"loggedOut": p.UserID, "profile": s.name, "historyRetained": true})
		case "configure":
			p.ConnectorURL, err = connectorAddress(a.o.connectorURL)
			if err != nil {
				return err
			}
		case "bind":
			u, err := backendURL(args[0])
			if err != nil {
				return err
			}
			if p.Backend != nil && p.Backend.CardURL != u.String() {
				return errors.New("changing_backend_requires_explicit_context_migration")
			}
			allow := a.o.allowLocal || u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
			token := ""
			if a.o.endpointTokenFile != "" {
				token, err = a.secretFile(a.o.endpointTokenFile)
				if err != nil {
					return err
				}
			}
			if err = a.verifyBackend(u.String(), token, allow); err != nil {
				return err
			}
			p.Backend = &backend{u.String(), token, allow}
		}
		if err = s.save(p); err != nil {
			return err
		}
		return a.output(s.public(p))
	}
	old, err := s.load()
	if err != nil {
		return err
	}
	if command == "register" && old != nil {
		return errors.New("profile_already_has_an_identity: use --profile NAME")
	}
	user, server := "", ""
	fullID := len(args) > 0 && strings.HasPrefix(args[0], "@")
	if fullID {
		user = args[0]
		server = args[0]
	} else if len(args) > 1 {
		server = args[0]
		user = args[1]
	} else if len(args) == 0 && old != nil {
		server = old.Homeserver
		user = old.UserID
		fullID = true
	}
	if a.o.homeserver != "" {
		server = a.o.homeserver
	}
	if user == "" || server == "" || command == "register" && fullID {
		return errors.New("use_register_SERVER_USERNAME_or_login_ADDRESS")
	}
	if old != nil && ((fullID && old.UserID != user) || (!fullID && !strings.HasPrefix(old.UserID, "@"+user+":"))) {
		return errors.New("profile_belongs_to_another_identity: use --profile NAME")
	}
	base, err := a.discover(server)
	if err != nil {
		return err
	}
	if old != nil && old.Homeserver != base {
		return errors.New("profile_belongs_to_another_homeserver")
	}
	if old != nil && old.AccessToken != "" {
		data, err := a.profileRequest(s, old, "/_matrix/client/v3/account/whoami", "GET", nil)
		if err == nil {
			var id credentials
			if json.Unmarshal(data, &id) != nil || id.UserID != old.UserID {
				return errors.New("saved_identity_verification_failed")
			}
			result := s.public(old)
			result["message"] = "Already logged in. Run agent-router agents or agent-router agent-create NAME."
			return a.output(result)
		} else if !unknownToken(err) {
			return authError(err)
		}
	}
	password, err := a.password(command == "register")
	if err != nil {
		return err
	}
	device := a.o.deviceName
	if device == "" {
		device = "Agent Router"
	}
	var cred credentials
	if command == "register" {
		cred, err = a.register(base, user, password, device)
	} else {
		cred, err = a.login(base, user, password, device)
	}
	if err != nil {
		return err
	}
	p, err := a.saveLogin(s, base, cred)
	if err != nil {
		return err
	}
	result := s.public(p)
	result["message"] = "Account saved. Run agent-router agent-create NAME, or agent-router agents."
	return a.output(result)
}
