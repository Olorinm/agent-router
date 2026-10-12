// Package guides embeds the same guides published in the repository into the Go CLI.
package guides

import _ "embed"

//go:embed agent-connect.en.md
var AgentConnect string

//go:embed agent-connect.md
var AgentConnectChinese string

//go:embed onboarding.md
var Setup string

//go:embed onboarding.zh-CN.md
var SetupChinese string
