package command

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/Olorinm/agent-router/cli/internal/config"
	"github.com/Olorinm/agent-router/cli/internal/routerapi"
	"github.com/Olorinm/agent-router/cli/internal/secret"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

const invitationPrefix = "arj1_"

type invitation struct {
	Version int    `json:"v"`
	Router  string `json:"router"`
	Address string `json:"address"`
	Token   string `json:"token"`
}

type enrollmentCreateResult struct {
	Data struct {
		Address   string `json:"address"`
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
	} `json:"data"`
}

func (a *app) loginCommand() *cobra.Command {
	var tokenStdin bool
	cmd := &cobra.Command{
		Use:   "login [ROUTER]",
		Short: "Connect to a Router and save an administrator login",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var profileName string
			if len(args) == 1 {
				ctx, cancel := requestContext(cmd, 15*time.Second)
				defer cancel()
				var err error
				profileName, err = a.selectDiscoveredProfile(ctx, args[0])
				if err != nil {
					return err
				}
			} else {
				cfg, err := a.store.Load()
				if err != nil {
					return err
				}
				if cfg.CurrentProfile == "" {
					domain, err := a.promptLine("Router domain: ")
					if err != nil {
						return err
					}
					ctx, cancel := requestContext(cmd, 15*time.Second)
					defer cancel()
					profileName, err = a.selectDiscoveredProfile(ctx, domain)
					if err != nil {
						return err
					}
				} else {
					profileName = cfg.CurrentProfile
				}
			}

			token := os.Getenv("AGENT_ROUTER_TOKEN")
			var err error
			if token == "" && tokenStdin {
				token, err = readStdin()
			} else if token == "" {
				token, err = a.promptSecret("Administrator token: ")
			}
			if err != nil {
				return err
			}
			s, err := a.session(false)
			if err != nil {
				return err
			}
			api := routerapi.New(s.Profile.BaseURL, token)
			var who map[string]any
			ctx, cancel := requestContext(cmd, 15*time.Second)
			defer cancel()
			if err := api.Do(ctx, http.MethodGet, "/v1/whoami", nil, &who); err != nil {
				return err
			}
			if err := secret.Set(profileName, "admin", token); err != nil {
				return err
			}
			cfg, err := a.store.Load()
			if err != nil {
				return err
			}
			profile := cfg.Profiles[profileName]
			profile.ActiveIdentity = "admin"
			cfg.Profiles[profileName] = profile
			cfg.CurrentProfile = profileName
			if err := a.store.Save(cfg); err != nil {
				return err
			}
			return a.print(who, func() string { return "Logged in to " + s.Profile.Domain })
		},
	}
	cmd.Flags().BoolVar(&tokenStdin, "token-stdin", false, "read the token from stdin (automation only)")
	return cmd
}

func (a *app) inviteCommand() *cobra.Command {
	var expires int
	cmd := &cobra.Command{
		Use:   "invite ADDRESS ENDPOINT",
		Short: "Create a one-time invitation for an agent",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			origin, err := endpointOrigin(args[1])
			if err != nil {
				return err
			}
			body := map[string]any{
				"address": args[0], "endpointOrigin": origin,
				"expiresInSeconds": expires, "label": "agent-router invite",
			}
			var result enrollmentCreateResult
			ctx, cancel := requestContext(cmd, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodPost, "/v1/enrollments", body, &result); err != nil {
				return err
			}
			code, err := encodeInvitation(invitation{
				Version: 1, Router: s.Profile.Domain, Address: result.Data.Address, Token: result.Data.Token,
			})
			if err != nil {
				return err
			}
			output := map[string]any{
				"address": result.Data.Address, "expiresAt": result.Data.ExpiresAt, "invitation": code,
			}
			return a.print(output, func() string {
				return fmt.Sprintf("Invite for %s (shown once):\n%s\n\nOn the agent machine, run: agent-router join", result.Data.Address, code)
			})
		},
	}
	cmd.Flags().IntVar(&expires, "expires-in", 900, "expiration in seconds")
	return cmd
}

func (a *app) joinCommand() *cobra.Command {
	var inviteStdin, noStore bool
	cmd := &cobra.Command{
		Use:   "join [CARD_URL]",
		Short: "Join a Router using a one-time invitation",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			code := strings.TrimSpace(os.Getenv("AGENT_ROUTER_INVITE"))
			var err error
			if code == "" && inviteStdin {
				code, err = readStdin()
			} else if code == "" {
				code, err = a.promptSecret("One-time invitation: ")
			}
			if err != nil {
				return err
			}
			invite, err := decodeInvitation(code)
			if err != nil {
				return err
			}
			cardURL := ""
			if len(args) == 1 {
				cardURL = args[0]
			} else {
				cardURL, err = a.promptLine("Agent Card URL: ")
				if err != nil {
					return err
				}
			}
			ctx, cancel := requestContext(cmd, 15*time.Second)
			defer cancel()
			if _, err := a.selectDiscoveredProfile(ctx, invite.Router); err != nil {
				return err
			}
			s, err := a.session(false)
			if err != nil {
				return err
			}
			return a.registerAgent(cmd, s, invite.Address, cardURL, invite.Token, "/v1/enrollments/register", noStore)
		},
	}
	cmd.Flags().BoolVar(&inviteStdin, "invite-stdin", false, "read the invitation from stdin (automation only)")
	cmd.Flags().BoolVar(&noStore, "no-store", false, "return the credential in JSON instead of storing it")
	return cmd
}

func (a *app) findCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "find [QUERY]",
		Short: "Find an agent",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			query := ""
			if len(args) == 1 {
				query = args[0]
			}
			var result any
			ctx, cancel := requestContext(cmd, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodGet, "/v1/directory?q="+url.QueryEscape(query), nil, &result); err != nil {
				return err
			}
			return a.print(result, func() string { return prettyRows(result, "address", "displayName", "description") })
		},
	}
}

func (a *app) selectDiscoveredProfile(ctx context.Context, input string) (string, error) {
	domain, baseURL, err := routerapi.Discover(ctx, input)
	if err != nil {
		return "", err
	}
	name, err := config.NormalizeName(domain)
	if err != nil {
		return "", err
	}
	cfg, err := a.store.Load()
	if err != nil {
		return "", err
	}
	previous := cfg.Profiles[name]
	cfg.Profiles[name] = config.Profile{
		Domain: domain, BaseURL: baseURL, ActiveIdentity: previous.ActiveIdentity, TaskAgents: previous.TaskAgents,
	}
	cfg.CurrentProfile = name
	if err := a.store.Save(cfg); err != nil {
		return "", err
	}
	return name, nil
}

func (a *app) promptLine(label string) (string, error) {
	fmt.Fprint(a.stderr, label)
	value, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && strings.TrimSpace(value) == "" {
		return "", err
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("a value is required")
	}
	return value, nil
}

func (a *app) promptSecret(label string) (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", errors.New("interactive secret input requires a terminal; use the stdin flag or environment variable")
	}
	fmt.Fprint(a.stderr, label)
	value, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(a.stderr)
	if err != nil {
		return "", err
	}
	secretValue := strings.TrimSpace(string(value))
	if secretValue == "" {
		return "", errors.New("a value is required")
	}
	return secretValue, nil
}

func encodeInvitation(value invitation) (string, error) {
	if value.Version != 1 || value.Router == "" || value.Address == "" || value.Token == "" {
		return "", errors.New("invitation is incomplete")
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return invitationPrefix + base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeInvitation(value string) (invitation, error) {
	var invite invitation
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, invitationPrefix) {
		return invite, errors.New("invalid invitation")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, invitationPrefix))
	if err != nil || json.Unmarshal(payload, &invite) != nil {
		return invitation{}, errors.New("invalid invitation")
	}
	if invite.Version != 1 || invite.Router == "" || invite.Address == "" || !strings.HasPrefix(invite.Token, "are_") {
		return invitation{}, errors.New("invalid invitation")
	}
	return invite, nil
}

func endpointOrigin(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.Scheme != "https" {
		return "", errors.New("endpoint must be an HTTPS domain or URL")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}
