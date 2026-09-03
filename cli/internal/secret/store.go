package secret

import (
	"errors"
	"fmt"
	"os"

	"github.com/zalando/go-keyring"
)

const service = "agent-router"

func Key(profile, identity string) string {
	return profile + ":" + identity
}

func Get(profile, identity string) (string, error) {
	if token := os.Getenv("AGENT_ROUTER_TOKEN"); token != "" {
		return token, nil
	}
	token, err := keyring.Get(service, Key(profile, identity))
	if errors.Is(err, keyring.ErrNotFound) {
		return "", fmt.Errorf("no credential for %s; log in, register an agent, or set AGENT_ROUTER_TOKEN", identity)
	}
	if err != nil {
		return "", fmt.Errorf("read operating-system credential store: %w", err)
	}
	return token, nil
}

func Set(profile, identity, token string) error {
	if token == "" {
		return errors.New("credential is empty")
	}
	if err := keyring.Set(service, Key(profile, identity), token); err != nil {
		return fmt.Errorf("write operating-system credential store: %w", err)
	}
	return nil
}

func Delete(profile, identity string) error {
	err := keyring.Delete(service, Key(profile, identity))
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
