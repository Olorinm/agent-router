package cli

import (
	"fmt"
	"io"
	"strconv"

	"github.com/spf13/pflag"
)

type options struct {
	profile, homeserver, passwordFile, registrationTokenFile, deviceName          string
	connectorURL, endpointTokenFile, connectorRuntime                             string
	serviceURL, outputFile                                                        string
	contextID, taskID, messageID, note, from, since, room, worker, wait, dataFile string
	tags                                                                          []string
	passwordStdin, allowLocal, allowHTTP, receive, execution, all, help, version  bool
}

func parse(args []string, errOut io.Writer) (options, []string, error) {
	var o options
	f := pflag.NewFlagSet("agent-router", pflag.ContinueOnError)
	f.SetOutput(errOut)
	f.StringVar(&o.profile, "profile", "", "Local profile")
	f.StringVar(&o.homeserver, "homeserver", "", "Account server override")
	f.StringVar(&o.passwordFile, "password-file", "", "Read password from a private file")
	f.StringVar(&o.registrationTokenFile, "registration-token-file", "", "Read invitation from a private file")
	f.BoolVar(&o.passwordStdin, "password-stdin", false, "Read password from stdin")
	f.StringVar(&o.deviceName, "device-name", "", "Device name")
	f.StringVar(&o.connectorURL, "connector-url", "", "Local gateway URL")
	f.StringVar(&o.connectorRuntime, "connector-runtime", "", "Path to the installed connector JavaScript entry")
	f.StringVar(&o.serviceURL, "service-url", "", "Agent service URL (defaults to the account server)")
	f.StringVar(&o.outputFile, "out", "", "Write private instance credentials to a new file")
	f.StringVar(&o.endpointTokenFile, "endpoint-token-file", "", "Read optional backend token from a file")
	f.BoolVar(&o.allowLocal, "allow-local", false, "Allow a private A2A backend")
	f.BoolVar(&o.allowHTTP, "allow-http", false, "Allow an explicitly selected HTTP homeserver")
	f.StringVar(&o.contextID, "context-id", "", "Continue a network conversation")
	f.StringVar(&o.taskID, "task-id", "", "Supply input to an existing task")
	f.StringVar(&o.messageID, "message-id", "", "Idempotency identifier")
	f.StringVar(&o.note, "note", "", "Contact note")
	f.StringArrayVar(&o.tags, "tag", nil, "Contact tag (repeatable)")
	f.BoolVar(&o.receive, "allow-receive", false, "Accept invitations from this contact")
	f.BoolVar(&o.execution, "allow-execution", false, "Allow this contact's work to be claimed")
	f.StringVar(&o.from, "from", "", "History page token")
	f.StringVar(&o.since, "since", "", "Event cursor")
	f.StringVar(&o.room, "room", "", "Filter event room")
	f.StringVar(&o.worker, "worker", "", "Stable worker name")
	f.StringVar(&o.wait, "wait", "0", "Wait for work or results, in seconds")
	f.StringVar(&o.dataFile, "data-file", "", "JSON result object")
	f.BoolVar(&o.all, "all", false, "Include completed work")
	f.BoolVarP(&o.help, "help", "h", false, "Show help")
	f.BoolVar(&o.version, "version", false, "Show version")
	if err := f.Parse(args); err != nil {
		return o, nil, err
	}
	return o, f.Args(), nil
}

func (o options) waitSeconds(max int) (int, error) {
	n, err := strconv.Atoi(o.wait)
	if err != nil || n < 0 || n > max {
		return 0, fmt.Errorf("wait_must_be_between_0_and_%d_seconds", max)
	}
	return n, nil
}

const help = `Agent Router — Go CLI
  register SERVER USERNAME       Register your owner account
  login @name:server             Log in (hidden password prompt)
  whoami | logout                Verify identity / revoke this device
  agents                         List Agents owned by this account
  agent-create NAME              Create and select an Agent (no new password)
  agent-use NAME | agent-current  Select an owned Agent / show current selection
  agent-instances                List the selected Agent's runtime instances
  agent-instance-create NAME --out FILE  Issue private instance credentials
  agent-instance-revoke ID        Revoke an instance's access
  agent-attach FILE               Connect this profile using instance credentials
  agent-resolve owner/name@server Resolve a public Agent address
  discover SERVER                Discover server and login methods
  find TEXT | lookup [ADDRESS]    Search directory / read public profile
  profile-set DISPLAY_NAME       Set display name
  bind AGENT_CARD_URL            Optional A2A execution backend
  configure --connector-url URL  Choose the local gateway port
  connect                        Check managed connection, or run a local connector
  doctor | status | contacts | conversations
  contact-add ADDRESS [--note TEXT] [--tag TAG] [--allow-receive] [--allow-execution]
  contact-remove ADDRESS | blocked | block ADDRESS | unblock ADDRESS
  invites | invite-accept ROOM_ID | invite-reject ROOM_ID
  requests | approve REQUEST_ID | reject REQUEST_ID
  inbox [--all]
  claim [WORK_ID] --worker NAME [--wait SECONDS]
  work WORK_OR_CLAIM_ID
  progress CLAIM_ID TEXT | reply CLAIM_ID TEXT [--data-file FILE]
  need-input CLAIM_ID TEXT | fail CLAIM_ID TEXT | cancelled CLAIM_ID
  conversation-open ADDRESS
  history ROOM_ID [--from TOKEN] | read ROOM_ID [EVENT_ID] | leave ROOM_ID
  watch [--since CURSOR] [--room ROOM_ID]
  send ADDRESS TEXT [--context-id ID] [--task-id ID] [--wait SECONDS]
  get ADDRESS TASK_ID | list ADDRESS | cancel ADDRESS TASK_ID
  agent-guide [en|zh]             Print the bundled guide (default: English)

Advanced interoperability: say ADDRESS TEXT sends a native Matrix text event.
Use '-' for message text to read stdin. Operation results are JSON (or empty);
watch emits JSON lines. Help and agent-guide are text; connect is a foreground service.
Errors and diagnostics go to stderr. Exit 0 means the command succeeded, not necessarily the task.
Use --profile NAME for separate local identities (default: default).
One account owns multiple Agents. Managed instances need only this Go CLI;
Matrix credentials stay on the server. New instance credentials use --out FILE.
Automation: --password-stdin or --password-file FILE; --registration-token-file FILE.
Secrets are never accepted as argument values. bind accepts --endpoint-token-file FILE.
The Go CLI needs no Node runtime. The separate local connector service needs Node 24.
connect finds agent-router-connector on PATH, or accepts --connector-runtime FILE.
`
