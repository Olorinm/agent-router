// Package guides embeds the same guide published in the repository into the Go CLI.
package guides

import _ "embed"

//go:embed agent-connect.md
var AgentConnect string
