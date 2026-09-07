package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
	a2apb "github.com/a2aproject/a2a-go/v2/a2apb/v1"
	"github.com/a2aproject/a2a-go/v2/a2apb/v1/pbconv"
	"google.golang.org/protobuf/encoding/protojson"
)

// Both Agent Card models and A2A protocol requests use the official Go SDK.
func loadCard(ctx context.Context, c *http.Client, cardURL string) (*a2a.AgentCard, error) {
	u, err := url.Parse(cardURL)
	if err != nil {
		return nil, errors.New("invalid_agent_card_url")
	}
	data, err := timedRequest(ctx, c, u.Scheme+"://"+u.Host, u.EscapedPath(), "GET", nil, http.Header{"A2A-Version": {"1.0"}})
	if err != nil {
		return nil, err
	}
	// Parse the official protobuf JSON representation, including StringList
	// security scopes, then use the SDK conversion instead of inventing wire types.
	var wire a2apb.AgentCard
	if (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(data, &wire) != nil {
		return nil, errors.New("invalid_agent_card")
	}
	card, err := pbconv.FromProtoAgentCard(&wire)
	if err != nil || card == nil || len(card.SupportedInterfaces) == 0 {
		return nil, errors.New("invalid_agent_card")
	}
	for _, iface := range card.SupportedInterfaces {
		if iface == nil {
			return nil, errors.New("invalid_agent_interface")
		}
		endpoint, err := backendURL(iface.URL)
		if err != nil || !sameOrigin(u, endpoint) {
			return nil, errors.New("a2a_card_interfaces_must_use_configured_origin")
		}
	}
	return card, nil
}
func newA2A(ctx context.Context, card *a2a.AgentCard, c *http.Client) (*a2aclient.Client, error) {
	return a2aclient.NewFromCard(ctx, card, a2aclient.WithDefaultsDisabled(), a2aclient.WithRESTTransport(c), a2aclient.WithJSONRPCTransport(c))
}
func (a *app) verifyBackend(cardURL, token string, allowLocal bool) error {
	c, err := backendHTTP(cardURL, token, allowLocal)
	if err != nil {
		return err
	}
	card, err := loadCard(a.ctx, c, cardURL)
	if err != nil {
		return errors.New("a2a_backend_verification_failed: check the card URL, token, TLS and network policy")
	}
	client, err := newA2A(a.ctx, card, c)
	if err != nil {
		return errors.New("a2a_backend_has_no_compatible_interface")
	}
	defer client.Destroy()
	return nil
}
func (a *app) taskCommand(command, target, arg string) error {
	if !matrixID.MatchString(target) {
		return errors.New("invalid_agent_address")
	}
	wait, err := a.o.waitSeconds(600)
	if err != nil {
		return err
	}
	card, err := loadCard(a.ctx, a.http, a.base+"/agents/"+url.PathEscape(target)+"/.well-known/agent-card.json")
	if err != nil {
		return err
	}
	client, err := newA2A(a.ctx, card, a.http)
	if err != nil {
		return errors.New("gateway_has_no_compatible_a2a_interface")
	}
	defer client.Destroy()
	length := 20
	get := func(ctx context.Context, id a2a.TaskID) (*a2a.Task, error) {
		ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		return client.GetTask(ctx, &a2a.GetTaskRequest{ID: id, HistoryLength: &length})
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	switch command {
	case "list":
		result, err := client.ListTasks(ctx, &a2a.ListTasksRequest{PageSize: 100, ContextID: a.o.contextID, IncludeArtifacts: true})
		if err != nil {
			return taskError(err)
		}
		return a.output(result)
	case "get":
		result, err := get(ctx, a2a.TaskID(arg))
		if err != nil {
			return taskError(err)
		}
		return a.output(result)
	case "cancel":
		result, err := client.CancelTask(ctx, &a2a.CancelTaskRequest{ID: a2a.TaskID(arg)})
		if err != nil {
			return taskError(err)
		}
		return a.output(result)
	}
	text, err := a.text(arg)
	if err != nil {
		return err
	}
	message := a2a.NewMessage(a2a.MessageRoleUser, a2a.NewTextPart(text))
	message.ContextID = a.o.contextID
	message.TaskID = a2a.TaskID(a.o.taskID)
	if a.o.messageID != "" {
		message.ID = a.o.messageID
	}
	result, err := client.SendMessage(ctx, &a2a.SendMessageRequest{Message: message, Config: &a2a.SendMessageConfig{ReturnImmediately: true, HistoryLength: &length}})
	if err != nil {
		return taskError(err)
	}
	task, ok := result.(*a2a.Task)
	if !ok || wait == 0 {
		return a.output(result)
	}
	fmt.Fprintf(a.errOut, "Task %s; context %s\n", task.ID, task.ContextID)
	waitCtx, stop := context.WithTimeout(a.ctx, time.Duration(wait)*time.Second)
	defer stop()
	for !task.Status.State.Terminal() && task.Status.State != a2a.TaskStateInputRequired && task.Status.State != a2a.TaskStateAuthRequired {
		select {
		case <-waitCtx.Done():
			if a.ctx.Err() != nil {
				return a.ctx.Err()
			}
			return errors.New("wait_timed_out_task_remains_available")
		case <-time.After(500 * time.Millisecond):
		}
		task, err = get(waitCtx, task.ID)
		if err != nil {
			if waitCtx.Err() != nil && a.ctx.Err() == nil {
				return errors.New("wait_timed_out_task_remains_available")
			}
			return taskError(err)
		}
	}
	return a.output(task)
}
func taskError(err error) error {
	// Remote error descriptions may reflect submitted credentials/content. Emit only
	// recognized SDK errors; detailed state remains available through task/history.
	for _, known := range []struct {
		err     error
		message string
	}{{a2a.ErrTaskNotFound, "task_not_found"}, {a2a.ErrTaskNotCancelable, "task_not_cancelable"}, {a2a.ErrInvalidParams, "invalid_task_parameters"}, {a2a.ErrInvalidRequest, "invalid_task_request"}} {
		if errors.Is(err, known.err) {
			return errors.New(known.message)
		}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return errors.New("a2a_request_failed: check agent-router doctor and the task status")
}
