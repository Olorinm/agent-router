package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

type connectionJob struct {
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
func (a *app) connectionSession(requireAgent bool) (*agentSelection, error) {
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
		return nil, errors.New("select_an_owned_agent_first: run agent-create NAME or agent-use NAME")
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
func (a *app) connectionRequest(path, method string, body any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	data, err := request(ctx, a.http, a.base, path, method, body)
	var response *httpError
	if errors.As(err, &response) && response.status == 404 && response.code == "not_found" {
		return nil, errors.New("channel_connections_unavailable")
	}
	return data, err
}
func (a *app) connectionAPI(path, method string, body any) error {
	data, err := a.connectionRequest(path, method, body)
	if err != nil {
		return err
	}
	if data == nil {
		return nil
	}
	return a.output(data)
}
func connectionPath(selected *agentSelection) string {
	return "/agents/" + url.PathEscape(selected.Agent.ID)
}
func (a *app) connectionCommand(command string, args []string) (bool, error) {
	switch command {
	case "connection-options", "connection-check", "channels", "channel-connect", "channel-jobs", "channel-job", "channel-pair", "channel-auth":
	default:
		return false, nil
	}
	return true, a.runConnections(command, args)
}
func (a *app) runConnections(command string, args []string) error {
	selected, err := a.connectionSession(command != "connection-options")
	if err != nil {
		return err
	}
	if command == "connection-options" {
		return a.connectionAPI("/connection-options", "GET", nil)
	}
	path := connectionPath(selected)
	switch command {
	case "channels":
		return a.connectionAPI(path+"/configuration", "GET", nil)
	case "connection-check":
		return a.connectionAPI(path+"/check", "POST", map[string]any{})
	case "channel-jobs":
		return a.connectionAPI(path+"/connection-jobs", "GET", nil)
	case "channel-job":
		data, err := a.connectionRequest(path+"/connection-jobs/"+url.PathEscape(args[0]), "GET", nil)
		if err != nil {
			return err
		}
		return a.finishConnection(path, data)
	case "channel-pair":
		code, err := a.pairingCode()
		if err != nil {
			return err
		}
		return a.connectionAPI(path+"/connection-jobs/"+url.PathEscape(args[0])+"/pairing", "POST", map[string]string{"code": code})
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
		data, err := a.connectionRequest(auth, method, body)
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

	}
	return errors.New("unknown_connection_command")
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
	data, err := a.connectionRequest(path+"/connections", "POST", body)
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
		var job connectionJob
		if json.Unmarshal(data, &job) != nil || job.ID == "" {
			return errors.New("invalid_connection_job")
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
			if _, err = a.connectionRequest(path+"/connection-jobs/"+url.PathEscape(job.ID)+"/pairing", "POST", map[string]string{"code": code}); err != nil {
				return err
			}
		case "starting", "waiting", "application", "authorization", "telegram_pairing":
		default:
			return errors.New("invalid_connection_job_state")
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
		data, err = a.connectionRequest(path+"/connection-jobs/"+url.PathEscape(job.ID), "GET", nil)
		if err != nil {
			return err
		}
	}
}
