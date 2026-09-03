package command

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/Olorinm/agent-router/cli/internal/routerapi"
	"github.com/Olorinm/agent-router/cli/internal/secret"
	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/spf13/cobra"
)

type registrationResult struct {
	Data struct {
		ID                string          `json:"id"`
		Address           string          `json:"address"`
		AgentCard         json.RawMessage `json:"agentCard"`
		MachineCredential string          `json:"machineCredential"`
	} `json:"data"`
	Warning string `json:"warning"`
}

func (a *app) agentCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "agent", Short: "Validate, register, and manage an agent"}
	validate := &cobra.Command{
		Use: "validate CARD_URL", Short: "Fetch and validate an official A2A v1 Agent Card", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := requestContext(cmd, 20*time.Second)
			defer cancel()
			card, err := routerapi.FetchExternalCard(ctx, args[0], os.Getenv("AGENT_ENDPOINT_TOKEN"))
			if err != nil {
				return err
			}
			return a.print(card, func() string {
				return fmt.Sprintf("Valid A2A %s Agent Card: %s (%d interface(s), %d skill(s))", a2a.Version, card.Name, len(card.SupportedInterfaces), len(card.Skills))
			})
		},
	}

	var address, cardURL string
	var enrollmentStdin, noStore bool
	register := &cobra.Command{
		Use: "register", Short: "Register an A2A agent using admin access or a one-time enrollment token", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if address == "" || cardURL == "" {
				return errors.New("--address and --card are required")
			}
			if noStore && !a.jsonOutput {
				return errors.New("--no-store requires --json so the one-time credential can be captured")
			}
			s, err := a.session(false)
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(cmd, 30*time.Second)
			defer cancel()
			card, err := routerapi.FetchExternalCard(ctx, cardURL, os.Getenv("AGENT_ENDPOINT_TOKEN"))
			if err != nil {
				return err
			}
			body := map[string]any{
				"address": address, "displayName": card.Name, "description": card.Description, "agentCard": card,
			}
			if endpointToken := os.Getenv("AGENT_ENDPOINT_TOKEN"); endpointToken != "" {
				body["endpointBearerToken"] = endpointToken
			}
			path := "/v1/agents"
			token := ""
			if enrollmentStdin {
				token, err = readStdin()
				path = "/v1/enrollments/register"
			} else {
				identity := s.Profile.ActiveIdentity
				if identity == "" {
					identity = "admin"
				}
				token, err = secret.Get(s.Name, identity)
			}
			if err != nil {
				return err
			}
			var result registrationResult
			if err := routerapi.New(s.Profile.BaseURL, token).Do(ctx, http.MethodPost, path, body, &result); err != nil {
				return err
			}
			stored := false
			if !noStore {
				if err := secret.Set(s.Name, result.Data.Address, result.Data.MachineCredential); err != nil {
					fmt.Fprintln(a.stderr, "Warning: credential store unavailable; returning the one-time credential in JSON:", err)
					noStore = true
					a.jsonOutput = true
				} else {
					p := s.Config.Profiles[s.Name]
					p.ActiveIdentity = result.Data.Address
					s.Config.Profiles[s.Name] = p
					if err := a.store.Save(s.Config); err != nil {
						return err
					}
					stored = true
				}
			}
			output := map[string]any{"id": result.Data.ID, "address": result.Data.Address, "agentCard": json.RawMessage(result.Data.AgentCard), "credentialStored": stored}
			if noStore {
				output["machineCredential"] = result.Data.MachineCredential
			}
			return a.print(output, func() string {
				if stored {
					return "Registered " + result.Data.Address + " and selected its credential"
				}
				return "Registered " + result.Data.Address + "; capture machineCredential from --json output"
			})
		},
	}
	register.Flags().StringVar(&address, "address", "", "requested localpart or full agent address")
	register.Flags().StringVar(&cardURL, "card", "", "source Agent Card URL")
	register.Flags().BoolVar(&enrollmentStdin, "enrollment-token-stdin", false, "read a one-time enrollment token from stdin")
	register.Flags().BoolVar(&noStore, "no-store", false, "do not store the returned machine credential (use with --json)")

	cmd.AddCommand(validate, register, a.credentialCommand())
	return cmd
}

func (a *app) credentialCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "credential", Short: "Manage an agent's machine credentials"}
	list := &cobra.Command{
		Use: "list ADDRESS", Short: "List credential metadata without revealing secrets", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			var result any
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodGet, "/v1/agents/"+url.PathEscape(args[0])+"/credentials", nil, &result); err != nil {
				return err
			}
			return a.print(result, func() string { return prettyRows(result, "tokenPrefix", "status", "label") })
		},
	}
	var label string
	var expires int
	var activate, noStore bool
	create := &cobra.Command{
		Use: "create ADDRESS", Short: "Create a new machine credential", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if noStore && !a.jsonOutput {
				return errors.New("--no-store requires --json so the one-time credential can be captured")
			}
			s, err := a.session(true)
			if err != nil {
				return err
			}
			body := map[string]any{"label": label}
			if expires > 0 {
				body["expiresInSeconds"] = expires
			}
			var result struct {
				Data map[string]any `json:"data"`
			}
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodPost, "/v1/agents/"+url.PathEscape(args[0])+"/credentials", body, &result); err != nil {
				return err
			}
			token, _ := result.Data["token"].(string)
			stored := false
			if !noStore {
				if err := secret.Set(s.Name, strings.ToLower(args[0]), token); err != nil {
					fmt.Fprintln(a.stderr, "Warning: credential store unavailable; returning the one-time credential in JSON:", err)
					noStore = true
					a.jsonOutput = true
				} else {
					stored = true
				}
			}
			if activate {
				p := s.Config.Profiles[s.Name]
				p.ActiveIdentity = strings.ToLower(args[0])
				s.Config.Profiles[s.Name] = p
				if err := a.store.Save(s.Config); err != nil {
					return err
				}
			}
			if stored {
				delete(result.Data, "token")
			}
			result.Data["credentialStored"] = stored
			return a.print(result, func() string { return fmt.Sprintf("Created credential %v for %s", result.Data["id"], args[0]) })
		},
	}
	create.Flags().StringVar(&label, "label", "", "human-readable credential label")
	create.Flags().IntVar(&expires, "expires-in", 0, "expiration in seconds (default: no expiration)")
	create.Flags().BoolVar(&activate, "activate", false, "select this agent identity after storing the credential")
	create.Flags().BoolVar(&noStore, "no-store", false, "return the secret in JSON instead of storing it")

	var yes bool
	revoke := &cobra.Command{
		Use: "revoke ADDRESS CREDENTIAL_ID", Short: "Revoke one machine credential", Args: cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			if err := requireYes(yes); err != nil {
				return err
			}
			s, err := a.session(true)
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			path := "/v1/agents/" + url.PathEscape(args[0]) + "/credentials/" + url.PathEscape(args[1])
			if err := s.API.Do(ctx, http.MethodDelete, path, nil, nil); err != nil {
				return err
			}
			return a.print(map[string]string{"revoked": args[1]}, func() string { return "Revoked " + args[1] })
		},
	}
	revoke.Flags().BoolVar(&yes, "yes", false, "confirm credential revocation")

	var rotateLabel string
	var rotateExpires int
	var rotateYes, rotateNoStore bool
	rotate := &cobra.Command{
		Use: "rotate ADDRESS", Short: "Replace all active credentials with one new credential", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := requireYes(rotateYes); err != nil {
				return err
			}
			if rotateNoStore && !a.jsonOutput {
				return errors.New("--no-store requires --json so the one-time credential can be captured")
			}
			s, err := a.session(true)
			if err != nil {
				return err
			}
			body := map[string]any{"label": rotateLabel}
			if rotateExpires > 0 {
				body["expiresInSeconds"] = rotateExpires
			}
			var result struct {
				Data map[string]any `json:"data"`
			}
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			path := "/v1/agents/" + url.PathEscape(args[0]) + "/credentials/rotate"
			if err := s.API.Do(ctx, http.MethodPost, path, body, &result); err != nil {
				return err
			}
			token, _ := result.Data["token"].(string)
			if rotateNoStore {
				result.Data["credentialStored"] = false
				return a.print(result, func() string { return "" })
			}
			if err := secret.Set(s.Name, strings.ToLower(args[0]), token); err != nil {
				fmt.Fprintln(a.stderr, "Warning: credential store unavailable; returning the replacement credential in JSON:", err)
				result.Data["credentialStored"] = false
				a.jsonOutput = true
				return a.print(result, func() string { return "" })
			}
			delete(result.Data, "token")
			result.Data["credentialStored"] = true
			p := s.Config.Profiles[s.Name]
			p.ActiveIdentity = strings.ToLower(args[0])
			s.Config.Profiles[s.Name] = p
			if err := a.store.Save(s.Config); err != nil {
				return err
			}
			return a.print(result, func() string { return "Rotated credentials for " + args[0] })
		},
	}
	rotate.Flags().StringVar(&rotateLabel, "label", "rotated", "human-readable credential label")
	rotate.Flags().IntVar(&rotateExpires, "expires-in", 0, "expiration in seconds (default: no expiration)")
	rotate.Flags().BoolVar(&rotateYes, "yes", false, "confirm revocation of all previous credentials")
	rotate.Flags().BoolVar(&rotateNoStore, "no-store", false, "return the secret in JSON instead of storing it")
	cmd.AddCommand(list, create, revoke, rotate)
	return cmd
}

func (a *app) directoryCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "directory", Short: "Search the authenticated Router directory"}
	search := &cobra.Command{
		Use: "search [QUERY]", Short: "Search addresses, descriptions, and skills", Args: cobra.MaximumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			query := ""
			if len(args) == 1 {
				query = args[0]
			}
			var result any
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodGet, "/v1/directory?q="+url.QueryEscape(query), nil, &result); err != nil {
				return err
			}
			return a.print(result, func() string { return prettyRows(result, "address", "displayName", "description") })
		},
	}
	show := &cobra.Command{
		Use: "show ADDRESS", Short: "Show a Router-owned Agent Card", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			var result any
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodGet, "/v1/directory/"+url.PathEscape(args[0]), nil, &result); err != nil {
				return err
			}
			return a.print(result, func() string {
				data := result.(map[string]any)["data"].(map[string]any)
				return fmt.Sprintf("%s\n%s", data["address"], data["description"])
			})
		},
	}
	cmd.AddCommand(search, show)
	return cmd
}

func (a *app) adminCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "admin", Short: "Operate a Router you administer"}
	cmd.AddCommand(a.enrollmentCommand(), a.federationCommand())
	return cmd
}

func (a *app) enrollmentCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "enrollment", Short: "Manage one-time agent enrollment tokens"}
	var address, endpointOrigin, label string
	var expires int
	create := &cobra.Command{
		Use: "create", Short: "Create a scoped, expiring, one-use enrollment token", Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			body := map[string]any{"label": label, "expiresInSeconds": expires}
			if address != "" {
				body["address"] = address
			}
			if endpointOrigin != "" {
				body["endpointOrigin"] = endpointOrigin
			}
			var result any
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodPost, "/v1/enrollments", body, &result); err != nil {
				return err
			}
			return a.print(result, func() string {
				data := result.(map[string]any)["data"].(map[string]any)
				return fmt.Sprintf("Enrollment token (shown once): %s", data["token"])
			})
		},
	}
	create.Flags().StringVar(&address, "address", "", "restrict registration to this address")
	create.Flags().StringVar(&endpointOrigin, "endpoint-origin", "", "restrict every Agent Card interface to this HTTPS origin")
	create.Flags().StringVar(&label, "label", "", "human-readable purpose")
	create.Flags().IntVar(&expires, "expires-in", 900, "expiration in seconds")
	list := &cobra.Command{
		Use: "list", Short: "List enrollment metadata", Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			var result any
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodGet, "/v1/enrollments", nil, &result); err != nil {
				return err
			}
			return a.print(result, func() string { return prettyRows(result, "id", "status", "address", "expiresAt") })
		},
	}
	var yes bool
	revoke := &cobra.Command{
		Use: "revoke ID", Short: "Revoke an unused enrollment token", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := requireYes(yes); err != nil {
				return err
			}
			s, err := a.session(true)
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(c, 15*time.Second)
			defer cancel()
			if err := s.API.Do(ctx, http.MethodDelete, "/v1/enrollments/"+url.PathEscape(args[0]), nil, nil); err != nil {
				return err
			}
			return a.print(map[string]string{"revoked": args[0]}, func() string { return "Revoked " + args[0] })
		},
	}
	revoke.Flags().BoolVar(&yes, "yes", false, "confirm enrollment revocation")
	cmd.AddCommand(create, list, revoke)
	return cmd
}

func (a *app) federationCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "federation", Short: "Manage domain-level federation policy"}
	list := &cobra.Command{Use: "list", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error {
		s, err := a.session(true)
		if err != nil {
			return err
		}
		var result any
		ctx, cancel := requestContext(c, 15*time.Second)
		defer cancel()
		if err := s.API.Do(ctx, http.MethodGet, "/v1/federation/domains", nil, &result); err != nil {
			return err
		}
		return a.print(result, func() string { return prettyRows(result, "domain", "status", "updatedAt") })
	}}
	var yes bool
	set := &cobra.Command{Use: "set DOMAIN STATUS", Args: cobra.ExactArgs(2), RunE: func(c *cobra.Command, args []string) error {
		if err := requireYes(yes); err != nil {
			return err
		}
		if args[1] != "allowed" && args[1] != "blocked" {
			return errors.New("STATUS must be allowed or blocked")
		}
		s, err := a.session(true)
		if err != nil {
			return err
		}
		var result any
		ctx, cancel := requestContext(c, 15*time.Second)
		defer cancel()
		if err := s.API.Do(ctx, http.MethodPut, "/v1/federation/domains/"+url.PathEscape(args[0]), map[string]string{"status": args[1]}, &result); err != nil {
			return err
		}
		return a.print(result, func() string { return args[0] + " is now " + args[1] })
	}}
	set.Flags().BoolVar(&yes, "yes", false, "confirm federation policy change")
	cmd.AddCommand(list, set)
	return cmd
}

func (a *app) schemaCommand() *cobra.Command {
	schemas := map[string]any{
		"send":                    map[string]any{"arguments": []string{"ADDRESS", "MESSAGE"}, "flags": map[string]string{"message-id": "optional stable A2A messageId", "wait": "wait for a terminal Task", "json": "JSON result"}},
		"agent.register":          map[string]any{"requiredFlags": []string{"address", "card"}, "secretInputs": []string{"--enrollment-token-stdin", "AGENT_ENDPOINT_TOKEN"}},
		"admin.enrollment.create": map[string]any{"flags": []string{"address", "endpoint-origin", "expires-in", "label"}, "secretOutput": "data.token is shown once"},
	}
	return &cobra.Command{
		Use: "schema [COMMAND]", Short: "Print machine-readable command contracts", Args: cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			value := any(schemas)
			if len(args) == 1 {
				var ok bool
				value, ok = schemas[args[0]]
				if !ok {
					return fmt.Errorf("unknown command schema %q", args[0])
				}
			}
			return a.print(value, func() string {
				data, _ := json.MarshalIndent(value, "", "  ")
				return string(data)
			})
		},
	}
}

func prettyRows(value any, fields ...string) string {
	root, ok := value.(map[string]any)
	if !ok {
		return fmt.Sprint(value)
	}
	rows, ok := root["data"].([]any)
	if !ok || len(rows) == 0 {
		return "No results."
	}
	lines := make([]string, 0, len(rows))
	for _, item := range rows {
		row, _ := item.(map[string]any)
		values := make([]string, 0, len(fields))
		for _, field := range fields {
			if value := fmt.Sprint(row[field]); value != "<nil>" && value != "" {
				values = append(values, value)
			}
		}
		lines = append(lines, strings.Join(values, "\t"))
	}
	return strings.Join(lines, "\n")
}
