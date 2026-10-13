package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

type setupJob struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	State     string `json:"state"`
	ExpiresAt string `json:"expiresAt"`
	URL       string `json:"url,omitempty"`
	QR        string `json:"qr,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Setup uses the saved owner account and the existing service authentication.
// Runtime instance credentials cannot change the owner's channels or Host.
func (a *app) setupSession(requireAgent bool) (*agentSelection, error) {
	s, err := newStore(a.o.profile)
	if err != nil {
		return nil, err
	}
	selected, err := s.selection()
	if err != nil {
		return nil, err
	}
	if selected != nil && selected.Token != "" {
		return nil, errors.New("owner_account_required: use an account profile")
	}
	p, err := a.ownerSession(s)
	if err != nil {
		return nil, err
	}
	root := a.o.serviceURL
	if root == "" && selected != nil {
		root = selected.ServiceURL
	}
	root, err = accountService(p, root, a.o.allowHTTP)
	if err != nil {
		return nil, err
	}
	if requireAgent && (selected == nil || selected.Agent.Owner != p.UserID || selected.ServiceURL != root) {
		return nil, errors.New("select_an_owned_agent_first: run setup NAME or agent-use NAME")
	}
	a.base = root
	a.http, err = newHTTP(root, p.AccessToken)
	if err != nil {
		return nil, err
	}
	binding := selected
	if binding == nil {
		binding = &agentSelection{Agent: managedAgent{Owner: p.UserID}}
	}
	a.http.Transport = &managedOwnerTransport{app: a, store: s, selected: binding, next: a.http.Transport}
	return selected, nil
}
func (a *app) setupRequest(path, method string, body any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	data, err := request(ctx, a.http, a.base, path, method, body)
	var response *httpError
	if errors.As(err, &response) && response.status == 404 && response.code == "not_found" {
		return nil, errors.New("cli_setup_not_enabled: ask the operator to configure AGENT_ROUTER_ONBOARDING_FILE on a matching Router version")
	}
	return data, err
}
func (a *app) setupAPI(path, method string, body any) error {
	data, err := a.setupRequest(path, method, body)
	if err != nil {
		return err
	}
	if data == nil {
		return nil
	}
	return a.output(data)
}
func setupPath(selected *agentSelection) string {
	return "/agents/" + url.PathEscape(selected.Agent.ID) + "/setup"
}
func (a *app) setupCommand(command string, args []string) (bool, error) {
	switch command {
	case "environment-create", "environment-status", "environment-resume", "environment-pause", "environment-destroy", "environment-reconcile", "setup", "setup-options", "setup-check", "channels", "channel-connect", "channel-jobs", "channel-job", "channel-pair", "channel-auth":
	default:
		return false, nil
	}
	return true, a.runSetup(command, args)
}
func (a *app) runSetup(command string, args []string) error {
	if a.o.environmentProfile != "" && command != "setup" {
		return errors.New("environment_option_requires_setup")
	}
	if a.o.environmentProfile != "" && a.o.noWait && a.o.channel != "" {
		return errors.New("connect_channel_after_environment_ready_or_omit_no_wait")
	}

	if command == "setup" && len(args) == 1 {
		// Creation is already idempotent and selects the existing Agent with this name.
		previous := a.out
		a.out = io.Discard
		err := a.runAgentCommand("agent-create", args)
		a.out = previous
		if err != nil {
			return err
		}
	}
	selected, err := a.setupSession(command != "setup-options")
	if err != nil {
		return err
	}
	if command == "setup-options" {
		return a.setupAPI("/setup", "GET", nil)
	}
	path := setupPath(selected)
	switch command {
	case "environment-status":
		return a.setupAPI(path+"/environment", "GET", nil)
	case "environment-create", "environment-resume", "environment-pause", "environment-destroy", "environment-reconcile":
		target, body := path+"/environment", any(map[string]any{})
		if command == "environment-create" {
			body = map[string]string{"profileId": args[0]}
		} else {
			target += "/" + strings.TrimPrefix(command, "environment-")
		}
		data, err := a.setupRequest(target, "POST", body)
		if err != nil {
			return err
		}
		return a.finishEnvironment(path, data)
	case "channels":
		return a.setupAPI(path, "GET", nil)
	case "setup-check":
		return a.setupAPI(path+"/check", "POST", map[string]any{})
	case "channel-jobs":
		return a.setupAPI(path+"/jobs", "GET", nil)
	case "channel-job":
		data, err := a.setupRequest(path+"/jobs/"+url.PathEscape(args[0]), "GET", nil)
		if err != nil {
			return err
		}
		return a.finishConnection(path, data)
	case "channel-pair":
		code, err := a.pairingCode()
		if err != nil {
			return err
		}
		return a.setupAPI(path+"/jobs/"+url.PathEscape(args[0])+"/pairing", "POST", map[string]string{"code": code})
	case "channel-auth":
		action := "status"
		if len(args) == 2 {
			action = args[1]
		}
		if action != "status" && action != "begin" && action != "complete" {
			return errors.New("authorization_action_must_be_status_begin_or_complete")
		}
		auth := "/agents/" + url.PathEscape(selected.Agent.ID) + "/communication/connections/" + url.PathEscape(args[0]) + "/authorization"
		method, body := "GET", any(nil)
		if action != "status" {
			auth += "/" + action
			method = "POST"
			body = map[string]any{}
		}
		data, err := a.setupRequest(auth, method, body)
		if err != nil {
			return err
		}
		var view struct {
			VerificationURL string `json:"verificationUrl"`
		}
		if json.Unmarshal(data, &view) == nil && view.VerificationURL != "" {
			if err = a.consent(view.VerificationURL, ""); err != nil {
				return err
			}
		}
		return a.output(data)
	case "channel-connect":
		return a.connectChannel(path, args[0])
	case "setup":
		if a.o.environmentProfile != "" {
			data, err := a.setupRequest(path+"/environment", "POST", map[string]string{"profileId": a.o.environmentProfile})
			if err != nil {
				return err
			}
			previous := a.out
			if !a.o.noWait {
				a.out = io.Discard
			}
			err = a.finishEnvironment(path, data)
			a.out = previous
			if err != nil {
				return err
			}
			if a.o.noWait {
				return nil
			}
		}
		if a.o.channel != "" {
			return a.connectChannel(path, a.o.channel)
		}
		summary, err := a.setupRequest(path, "GET", nil)
		if err != nil {
			return err
		}
		choices, err := a.setupRequest("/setup", "GET", nil)
		if err != nil {
			return err
		}
		checks, err := a.setupRequest(path+"/check", "POST", map[string]any{})
		if err != nil {
			return err
		}
		var checkList struct {
			Checks json.RawMessage `json:"checks"`
		}
		if json.Unmarshal(checks, &checkList) != nil {
			return errors.New("invalid_setup_checks")
		}
		return a.output(map[string]any{"configuration": summary, "options": choices, "checks": json.RawMessage(checkList.Checks)})
	}
	return errors.New("unknown_setup_command")
}
func (a *app) connectChannel(path, kind string) error {
	body := map[string]any{"kind": kind}
	switch kind {
	case "feishu":
		if a.o.domain != "feishu" && a.o.domain != "lark" {
			return errors.New("domain_must_be_feishu_or_lark")
		}
		body["domain"] = a.o.domain
		body["personalTools"] = !a.o.messagingOnly
	case "telegram":
		token, err := a.channelSecret(a.o.botTokenFile, "Telegram bot token")
		if err != nil {
			return err
		}
		body["token"] = token
	case "grove-mail":
		if a.o.mailService == "" || a.o.inboxID == "" || a.o.ownerEmail == "" {
			return errors.New("mail_requires_service_inbox_and_owner_email")
		}
		token, err := a.channelSecret(a.o.apiKeyFile, "Mail API key")
		if err != nil {
			return err
		}
		body["serviceId"] = a.o.mailService
		body["inboxId"] = a.o.inboxID
		body["ownerEmail"] = a.o.ownerEmail
		body["apiKey"] = token
	case "weixin", "matrix":
	default:
		return errors.New("channel_must_be_feishu_weixin_telegram_grove_mail_or_matrix")
	}
	data, err := a.setupRequest(path+"/connections", "POST", body)
	if err != nil {
		return err
	}
	if kind == "matrix" || kind == "grove-mail" {
		return a.output(data)
	}
	return a.finishConnection(path, data)
}
func (a *app) channelSecret(file, label string) (string, error) {
	if file != "" {
		return a.secretFile(file)
	}
	return a.prompt(label)
}
func (a *app) pairingCode() (string, error) {
	code, err := a.channelSecret(a.o.pairingCodeFile, "Weixin pairing code")
	if err != nil {
		return "", err
	}
	if len(code) < 1 || len(code) > 12 || strings.Trim(code, "0123456789") != "" {
		return "", errors.New("invalid_pairing_code")
	}
	return code, nil
}
func (a *app) consent(raw, qr string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(raw) > 4096 || strings.ContainsAny(raw, "\x1b\r\n\x00") {
		return errors.New("invalid_authorization_url")
	}
	fmt.Fprintln(a.errOut, "Open or scan to authorize:", raw)
	if qr != "" {
		if len(qr) > 65536 || strings.Trim(qr, " █▀▄\n") != "" {
			return errors.New("invalid_terminal_qr")
		}
		fmt.Fprintln(a.errOut, qr)
	}
	return nil
}
func (a *app) finishConnection(path string, data json.RawMessage) error {
	shown, announced := "", false
	for {
		var job setupJob
		if json.Unmarshal(data, &job) != nil || job.ID == "" {
			return errors.New("invalid_setup_job")
		}
		if !announced {
			fmt.Fprintln(a.errOut, "Connection job:", job.ID, "— resume with channel-job JOB_ID")
			announced = true
		}
		if job.URL != "" && job.URL != shown {
			if err := a.consent(job.URL, job.QR); err != nil {
				return err
			}
			shown = job.URL
		}
		switch job.State {
		case "ready":
			return a.output(job)
		case "failed":
			if err := a.output(job); err != nil {
				return err
			}
			if safeCode.MatchString(job.Error) {
				return errors.New(job.Error)
			}
			return errors.New("connection_setup_failed")
		case "pairing":
			input, ok := a.in.(*os.File)
			if a.o.noWait || (a.o.pairingCodeFile == "" && (!ok || !term.IsTerminal(int(input.Fd())))) {
				fmt.Fprintln(a.errOut, "Resume with channel-pair JOB_ID --pairing-code-file FILE, then channel-job JOB_ID.")
				return a.output(job)
			}
			code, err := a.pairingCode()
			if err != nil {
				return err
			}
			if _, err = a.setupRequest(path+"/jobs/"+url.PathEscape(job.ID)+"/pairing", "POST", map[string]string{"code": code}); err != nil {
				return err
			}
		case "starting", "waiting", "application", "authorization", "telegram_pairing":
		default:
			return errors.New("invalid_setup_job_state")
		}
		if a.o.noWait {
			return a.output(job)
		}
		expiry, err := time.Parse(time.RFC3339, job.ExpiresAt)
		if err != nil || !expiry.After(time.Now()) {
			return errors.New("connection_setup_expired")
		}
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-a.ctx.Done():
			timer.Stop()
			return a.ctx.Err()
		case <-timer.C:
		}
		data, err = a.setupRequest(path+"/jobs/"+url.PathEscape(job.ID), "GET", nil)
		if err != nil {
			return err
		}
	}
}

// Provisioning is server-side and durable. Interrupting this poll does not cancel creation.
func (a *app) finishEnvironment(path string, data json.RawMessage) error {
	announced := false
	deadline := time.Now().Add(15 * time.Minute)
	for {
		var status struct {
			OperationID string `json:"operationId"`
			State       string `json:"state"`
			Busy        bool   `json:"busy"`
			Error       string `json:"error"`
		}
		if json.Unmarshal(data, &status) != nil || status.OperationID == "" {
			return errors.New("invalid_environment_status")
		}
		if !announced {
			fmt.Fprintln(a.errOut, "Environment operation:", status.OperationID, "— inspect with environment-status; recover with environment-reconcile")
			announced = true
		}
		if !status.Busy {
			if err := a.output(data); err != nil {
				return err
			}
			if status.Error != "" {
				if safeCode.MatchString(status.Error) {
					return errors.New(status.Error)
				}
				return errors.New("environment_needs_action")
			}
			if status.State == "ready" || status.State == "paused" || status.State == "deleted" {
				return nil
			}
			return errors.New("environment_needs_action")
		}
		if a.o.noWait {
			return a.output(data)
		}
		if time.Now().After(deadline) {
			return errors.New("environment_still_pending_use_environment_status")
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-a.ctx.Done():
			timer.Stop()
			return a.ctx.Err()
		case <-timer.C:
		}
		var err error
		data, err = a.setupRequest(path+"/environment", "GET", nil)
		if err != nil {
			return err
		}
	}
}
