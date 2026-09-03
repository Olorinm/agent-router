package main

import (
	"fmt"
	"os"

	"github.com/Olorinm/agent-router/cli/internal/command"
)

func main() {
	if err := command.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
