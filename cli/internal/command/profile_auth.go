package command

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Olorinm/agent-router/cli/internal/config"
	"github.com/Olorinm/agent-router/cli/internal/routerapi"
	"github.com/Olorinm/agent-router/cli/internal/secret"
	"github.com/spf13/cobra"
)

func (a *app) profileCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "profile", Short: "Manage Router profiles"}
	var makeCurrent bool
	add := &cobra.Command{
		Use:   "add NAME DOMAIN_OR_URL",
		Short: "Discover and save a Router",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			name, err := config.NormalizeName(args[0])
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(cmd, 15*time.Second)
			defer cancel()
			domain, baseURL, err := routerapi.Discover(ctx, args[1])
			if err != nil {
				return err
			}
			cfg, err := a.store.Load()
			if err != nil {
				return err
			}
			cfg.Profiles[name] = config.Profile{Domain: domain, BaseURL: baseURL, TaskAgents: map[string]string{}}
			if cfg.CurrentProfile == "" || makeCurrent {
				cfg.CurrentProfile = name
			}
			if err := a.store.Save(cfg); err != nil {
				return err
			}
			return a.print(map[string]any{"name": name, "domain": domain, "baseUrl": baseURL, "current": cfg.CurrentProfile == name}, func() string {
				return fmt.Sprintf("Saved %s (%s)", name, baseURL)
			})
		},
	}
	add.Flags().BoolVar(&makeCurrent, "use", false, "make this the current profile")

	list := &cobra.Command{
		Use: "list", Short: "List Router profiles", Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := a.store.Load()
			if err != nil {
				return err
			}
			names := make([]string, 0, len(cfg.Profiles))
			for name := range cfg.Profiles {
				names = append(names, name)
			}
			sort.Strings(names)
			rows := make([]map[string]any, 0, len(names))
			for _, name := range names {
				p := cfg.Profiles[name]
				rows = append(rows, map[string]any{"name": name, "domain": p.Domain, "baseUrl": p.BaseURL, "current": name == cfg.CurrentProfile, "identity": p.ActiveIdentity})
			}
			return a.print(rows, func() string {
				if len(rows) == 0 {
					return "No profiles. Run 'agent-router profile add NAME DOMAIN'."
				}
				var lines []string
				for _, row := range rows {
					marker := " "
					if row["current"].(bool) {
						marker = "*"
					}
					lines = append(lines, fmt.Sprintf("%s %s\t%s", marker, row["name"], row["baseUrl"]))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	use := &cobra.Command{
		Use: "use NAME", Short: "Select a Router profile", Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			name, err := config.NormalizeName(args[0])
			if err != nil {
				return err
			}
			cfg, err := a.store.Load()
			if err != nil {
				return err
			}
			if _, ok := cfg.Profiles[name]; !ok {
				return fmt.Errorf("unknown profile %q", name)
			}
			cfg.CurrentProfile = name
			if err := a.store.Save(cfg); err != nil {
				return err
			}
			return a.print(map[string]string{"currentProfile": name}, func() string { return "Using " + name })
		},
	}
	cmd.AddCommand(add, list, use)
	return cmd
}

func (a *app) authCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "auth", Short: "Store and select Router credentials"}
	var tokenStdin bool
	login := &cobra.Command{
		Use: "login", Short: "Save an administrator token in the operating-system credential store", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !tokenStdin {
				return errors.New("pass the token through stdin and add --token-stdin")
			}
			token, err := readStdin()
			if err != nil {
				return err
			}
			s, err := a.session(false)
			if err != nil {
				return err
			}
			api := routerapi.New(s.Profile.BaseURL, token)
			var result any
			ctx, cancel := requestContext(cmd, 15*time.Second)
			defer cancel()
			if err := api.Do(ctx, http.MethodGet, "/v1/whoami", nil, &result); err != nil {
				return err
			}
			if err := secret.Set(s.Name, "admin", token); err != nil {
				return err
			}
			p := s.Config.Profiles[s.Name]
			p.ActiveIdentity = "admin"
			s.Config.Profiles[s.Name] = p
			if err := a.store.Save(s.Config); err != nil {
				return err
			}
			return a.print(result, func() string { return "Administrator credential stored for " + s.Name })
		},
	}
	login.Flags().BoolVar(&tokenStdin, "token-stdin", false, "read the token from stdin")

	status := &cobra.Command{Use: "status", Short: "Verify the active credential", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		return a.runWhoami(cmd)
	}}
	logout := &cobra.Command{
		Use: "logout", Short: "Remove the active credential from the credential store", Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			s, err := a.session(false)
			if err != nil {
				return err
			}
			identity := s.Profile.ActiveIdentity
			if identity == "" {
				identity = "admin"
			}
			if err := secret.Delete(s.Name, identity); err != nil {
				return err
			}
			return a.print(map[string]string{"removed": identity}, func() string { return "Removed credential for " + identity })
		},
	}
	use := &cobra.Command{
		Use: "use IDENTITY", Short: "Select admin or a registered agent address", Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			s, err := a.session(false)
			if err != nil {
				return err
			}
			identity := strings.ToLower(strings.TrimSpace(args[0]))
			if _, err := secret.Get(s.Name, identity); err != nil && os.Getenv("AGENT_ROUTER_TOKEN") == "" {
				return err
			}
			p := s.Config.Profiles[s.Name]
			p.ActiveIdentity = identity
			s.Config.Profiles[s.Name] = p
			if err := a.store.Save(s.Config); err != nil {
				return err
			}
			return a.print(map[string]string{"identity": identity}, func() string { return "Using identity " + identity })
		},
	}
	cmd.AddCommand(login, status, logout, use)
	return cmd
}

func (a *app) whoamiCommand() *cobra.Command {
	return &cobra.Command{Use: "whoami", Short: "Show the authenticated Router identity", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		return a.runWhoami(cmd)
	}}
}

func (a *app) runWhoami(cmd *cobra.Command) error {
	s, err := a.session(true)
	if err != nil {
		return err
	}
	var result any
	ctx, cancel := requestContext(cmd, 15*time.Second)
	defer cancel()
	if err := s.API.Do(ctx, http.MethodGet, "/v1/whoami", nil, &result); err != nil {
		return err
	}
	return a.print(result, func() string {
		data := result.(map[string]any)["data"].(map[string]any)
		return fmt.Sprintf("%s (%s)", data["displayName"], data["kind"])
	})
}

func (a *app) doctorCommand() *cobra.Command {
	return &cobra.Command{
		Use: "doctor", Short: "Check discovery, health, and authentication", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			s, err := a.session(false)
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(cmd, 20*time.Second)
			defer cancel()
			domain, baseURL, discoveryErr := routerapi.Discover(ctx, s.Profile.BaseURL)
			health := map[string]any{}
			healthErr := s.API.Do(ctx, http.MethodGet, "/health/ready", nil, &health)
			auth := "missing"
			identity := s.Profile.ActiveIdentity
			if identity == "" {
				identity = "admin"
			}
			if token, tokenErr := secret.Get(s.Name, identity); tokenErr == nil {
				var who any
				if err := routerapi.New(s.Profile.BaseURL, token).Do(ctx, http.MethodGet, "/v1/whoami", nil, &who); err == nil {
					auth = "ok"
				} else {
					auth = "invalid"
				}
			}
			result := map[string]any{"profile": s.Name, "domain": domain, "baseUrl": baseURL, "discovery": status(discoveryErr), "health": status(healthErr), "auth": auth, "configPath": a.store.Path()}
			if discoveryErr != nil || healthErr != nil || auth == "invalid" {
				_ = a.print(result, func() string {
					return fmt.Sprintf("discovery=%s health=%s auth=%s", status(discoveryErr), status(healthErr), auth)
				})
				return errors.New("one or more checks failed")
			}
			return a.print(result, func() string { return fmt.Sprintf("discovery=ok health=ok auth=%s", auth) })
		},
	}
}

func status(err error) string {
	if err == nil {
		return "ok"
	}
	return "failed: " + err.Error()
}

type projectLink struct {
	Profile string `json:"profile"`
	Agent   string `json:"agent,omitempty"`
}

func (a *app) linkCommand() *cobra.Command {
	var agent string
	cmd := &cobra.Command{
		Use: "link", Short: "Link the current directory to a Router profile and optional agent", Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			s, err := a.session(false)
			if err != nil {
				return err
			}
			link := projectLink{Profile: s.Name, Agent: strings.ToLower(strings.TrimSpace(agent))}
			data, err := json.MarshalIndent(link, "", "  ")
			if err != nil {
				return err
			}
			path, err := filepath.Abs(".agent-router.json")
			if err != nil {
				return err
			}
			if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
				return err
			}
			return a.print(map[string]any{"path": path, "profile": s.Name, "agent": link.Agent}, func() string { return "Linked " + path })
		},
	}
	cmd.Flags().StringVar(&agent, "agent", "", "default agent address for this directory")
	return cmd
}
