package command

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/Olorinm/agent-router/cli/internal/config"
	"github.com/Olorinm/agent-router/cli/internal/routerapi"
	"github.com/Olorinm/agent-router/cli/internal/secret"
	"github.com/spf13/cobra"
)

var (
	Version = "dev"
	Commit  = "none"
)

type app struct {
	store       *config.Store
	profileFlag string
	jsonOutput  bool
	stdout      io.Writer
	stderr      io.Writer
}

type session struct {
	Name        string
	Profile     config.Profile
	Config      *config.Config
	Token       string
	API         *routerapi.Client
	LinkedAgent string
}

func New() (*cobra.Command, error) {
	store, err := config.NewStore()
	if err != nil {
		return nil, err
	}
	a := &app{store: store, stdout: os.Stdout, stderr: os.Stderr}
	root := &cobra.Command{
		Use:           "agent-router",
		Short:         "Discover, register, and call A2A agents through an Agent Router",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       Version + " (" + Commit + ")",
	}
	root.SetOut(a.stdout)
	root.SetErr(a.stderr)
	root.PersistentFlags().StringVar(&a.profileFlag, "profile", "", "Router profile to use")
	root.PersistentFlags().BoolVar(&a.jsonOutput, "json", false, "write one JSON result to stdout")
	root.AddCommand(
		a.profileCommand(),
		a.authCommand(),
		a.whoamiCommand(),
		a.doctorCommand(),
		a.linkCommand(),
		a.agentCommand(),
		a.directoryCommand(),
		a.sendCommand(),
		a.taskCommand(),
		a.adminCommand(),
		a.schemaCommand(),
	)
	return root, nil
}

func Execute() error {
	root, err := New()
	if err != nil {
		return err
	}
	return root.Execute()
}

func (a *app) session(requireToken bool) (*session, error) {
	selectedProfile := a.profileFlag
	link := readProjectLink()
	if selectedProfile == "" && link.Profile != "" {
		selectedProfile = link.Profile
	}
	name, profile, cfg, err := a.store.Selected(selectedProfile)
	if err != nil {
		return nil, err
	}
	identity := profile.ActiveIdentity
	if identity == "" {
		identity = "admin"
	}
	token := ""
	if requireToken {
		token, err = secret.Get(name, identity)
		if err != nil {
			return nil, err
		}
	}
	return &session{
		Name: name, Profile: profile, Config: cfg, Token: token,
		API: routerapi.New(profile.BaseURL, token), LinkedAgent: link.Agent,
	}, nil
}

func readProjectLink() projectLink {
	data, err := os.ReadFile(".agent-router.json")
	if err != nil {
		return projectLink{}
	}
	var link projectLink
	if json.Unmarshal(data, &link) != nil {
		return projectLink{}
	}
	return link
}

func (a *app) print(value any, human func() string) error {
	if a.jsonOutput {
		encoder := json.NewEncoder(a.stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(value)
	}
	_, err := fmt.Fprintln(a.stdout, human())
	return err
}

func (a *app) printJSONLine(value any) error {
	return json.NewEncoder(a.stdout).Encode(value)
}

func readStdin() (string, error) {
	value, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
	if err != nil {
		return "", err
	}
	text := strings.TrimSpace(string(value))
	if text == "" {
		return "", errors.New("stdin was empty")
	}
	return text, nil
}

func requestContext(command *cobra.Command, timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(command.Context(), timeout)
}

func requireYes(value bool) error {
	if !value {
		return errors.New("this action changes remote state; repeat with --yes")
	}
	return nil
}

func apiData[T any](value T) struct {
	Data T `json:"data"`
} {
	return struct {
		Data T `json:"data"`
	}{Data: value}
}
