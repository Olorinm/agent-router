package command

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/spf13/cobra"
)

func (a *app) sendCommand() *cobra.Command {
	var messageID, contextID string
	var wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "send ADDRESS MESSAGE",
		Short: "Send an official A2A v1 message",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			messageText := args[1]
			if messageText == "-" {
				messageText, err = readStdin()
				if err != nil {
					return err
				}
			}
			ctx, cancel := requestContext(cmd, timeout)
			defer cancel()
			client, callCtx, err := s.API.A2A(ctx, strings.ToLower(args[0]))
			if err != nil {
				return err
			}
			message := a2a.NewMessage(a2a.MessageRoleUser, a2a.NewTextPart(messageText))
			if messageID != "" {
				message.ID = messageID
			}
			if contextID != "" {
				message.ContextID = contextID
			}
			result, err := client.SendMessage(callCtx, &a2a.SendMessageRequest{Message: message})
			if err != nil {
				return err
			}
			if task, ok := result.(*a2a.Task); ok {
				if err := a.rememberTask(s, string(task.ID), strings.ToLower(args[0])); err != nil {
					return err
				}
				if wait && !task.Status.State.Terminal() {
					task, err = waitForTask(callCtx, client.GetTask, task.ID, time.Second)
					if err != nil {
						return err
					}
					result = task
				}
			}
			return a.print(result, func() string { return summarizeResult(result) })
		},
	}
	cmd.Flags().StringVar(&messageID, "message-id", "", "stable A2A messageId for idempotent retries")
	cmd.Flags().StringVar(&contextID, "context-id", "", "continue an A2A context")
	cmd.Flags().BoolVar(&wait, "wait", false, "wait for a terminal Task state")
	cmd.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "overall timeout")
	return cmd
}

func (a *app) taskCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "task", Short: "Get, list, watch, or cancel A2A Tasks"}
	var agent string
	get := &cobra.Command{
		Use: "get TASK_ID", Short: "Get a Task", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			target, err := resolveTaskAgent(s, args[0], agent)
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(c, 30*time.Second)
			defer cancel()
			client, callCtx, err := s.API.A2A(ctx, target)
			if err != nil {
				return err
			}
			task, err := client.GetTask(callCtx, &a2a.GetTaskRequest{ID: a2a.TaskID(args[0])})
			if err != nil {
				return err
			}
			return a.print(task, func() string { return summarizeTask(task) })
		},
	}
	get.Flags().StringVar(&agent, "agent", "", "agent address (remembered after send)")

	var listAgent string
	var pageSize int
	list := &cobra.Command{
		Use: "list", Short: "List Tasks for one agent using A2A tasks/list", Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			if listAgent == "" {
				return errors.New("--agent is required")
			}
			s, err := a.session(true)
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(c, 30*time.Second)
			defer cancel()
			client, callCtx, err := s.API.A2A(ctx, strings.ToLower(listAgent))
			if err != nil {
				return err
			}
			result, err := client.ListTasks(callCtx, &a2a.ListTasksRequest{PageSize: pageSize})
			if err != nil {
				return err
			}
			return a.print(result, func() string {
				if len(result.Tasks) == 0 {
					return "No tasks."
				}
				lines := make([]string, 0, len(result.Tasks))
				for _, task := range result.Tasks {
					lines = append(lines, summarizeTask(task))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	list.Flags().StringVar(&listAgent, "agent", "", "agent address")
	list.Flags().IntVar(&pageSize, "limit", 50, "maximum Tasks to return")

	var watchAgent string
	var ndjson bool
	var interval, timeout time.Duration
	watch := &cobra.Command{
		Use: "watch TASK_ID", Short: "Poll an A2A Task until it reaches a terminal state", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			s, err := a.session(true)
			if err != nil {
				return err
			}
			target, err := resolveTaskAgent(s, args[0], watchAgent)
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(c, timeout)
			defer cancel()
			client, callCtx, err := s.API.A2A(ctx, target)
			if err != nil {
				return err
			}
			last := a2a.TaskStateUnspecified
			for {
				task, err := client.GetTask(callCtx, &a2a.GetTaskRequest{ID: a2a.TaskID(args[0])})
				if err != nil {
					return err
				}
				if task.Status.State != last {
					if ndjson {
						if err := a.printJSONLine(task); err != nil {
							return err
						}
					} else if !a.jsonOutput {
						fmt.Fprintln(a.stdout, summarizeTask(task))
					}
					last = task.Status.State
				}
				if task.Status.State.Terminal() {
					if a.jsonOutput && !ndjson {
						return a.print(task, func() string { return "" })
					}
					return nil
				}
				select {
				case <-callCtx.Done():
					return callCtx.Err()
				case <-time.After(interval):
				}
			}
		},
	}
	watch.Flags().StringVar(&watchAgent, "agent", "", "agent address (remembered after send)")
	watch.Flags().BoolVar(&ndjson, "ndjson", false, "write one JSON Task per state change")
	watch.Flags().DurationVar(&interval, "interval", time.Second, "poll interval")
	watch.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "overall timeout")

	var cancelAgent string
	var yes bool
	cancelTask := &cobra.Command{
		Use: "cancel TASK_ID", Short: "Cancel an A2A Task", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := requireYes(yes); err != nil {
				return err
			}
			s, err := a.session(true)
			if err != nil {
				return err
			}
			target, err := resolveTaskAgent(s, args[0], cancelAgent)
			if err != nil {
				return err
			}
			ctx, cancel := requestContext(c, 30*time.Second)
			defer cancel()
			client, callCtx, err := s.API.A2A(ctx, target)
			if err != nil {
				return err
			}
			task, err := client.CancelTask(callCtx, &a2a.CancelTaskRequest{ID: a2a.TaskID(args[0])})
			if err != nil {
				return err
			}
			return a.print(task, func() string { return summarizeTask(task) })
		},
	}
	cancelTask.Flags().StringVar(&cancelAgent, "agent", "", "agent address (remembered after send)")
	cancelTask.Flags().BoolVar(&yes, "yes", false, "confirm Task cancellation")
	cmd.AddCommand(get, list, watch, cancelTask)
	return cmd
}

func (a *app) rememberTask(s *session, taskID, agent string) error {
	p := s.Config.Profiles[s.Name]
	if p.TaskAgents == nil {
		p.TaskAgents = map[string]string{}
	}
	p.TaskAgents[taskID] = agent
	if len(p.TaskAgents) > 500 {
		// Task mappings are a convenience cache. Remove an arbitrary old entry
		// rather than letting a frequently used CLI grow the profile forever.
		for id := range p.TaskAgents {
			if id != taskID {
				delete(p.TaskAgents, id)
				break
			}
		}
	}
	s.Config.Profiles[s.Name] = p
	return a.store.Save(s.Config)
}

func resolveTaskAgent(s *session, taskID, explicit string) (string, error) {
	if explicit != "" {
		return strings.ToLower(explicit), nil
	}
	if agent := s.Profile.TaskAgents[taskID]; agent != "" {
		return agent, nil
	}
	if s.LinkedAgent != "" {
		return s.LinkedAgent, nil
	}
	return "", errors.New("agent address is unknown; add --agent ADDRESS")
}

type getTaskFunc func(context.Context, *a2a.GetTaskRequest) (*a2a.Task, error)

func waitForTask(ctx context.Context, get getTaskFunc, id a2a.TaskID, interval time.Duration) (*a2a.Task, error) {
	for {
		task, err := get(ctx, &a2a.GetTaskRequest{ID: id})
		if err != nil {
			return nil, err
		}
		if task.Status.State.Terminal() {
			return task, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}
	}
}

func summarizeResult(result a2a.SendMessageResult) string {
	switch value := result.(type) {
	case *a2a.Task:
		return summarizeTask(value)
	case *a2a.Message:
		parts := textParts(value.Parts)
		if parts != "" {
			return parts
		}
		return "Message " + value.ID
	default:
		return fmt.Sprintf("%T", result)
	}
}

func summarizeTask(task *a2a.Task) string {
	result := fmt.Sprintf("%s\t%s", task.ID, task.Status.State)
	var content []string
	if task.Status.Message != nil {
		if text := textParts(task.Status.Message.Parts); text != "" {
			content = append(content, text)
		}
	}
	for _, artifact := range task.Artifacts {
		if text := textParts(artifact.Parts); text != "" {
			content = append(content, text)
		}
	}
	if len(content) > 0 {
		result += "\t" + strings.Join(content, "\n")
	}
	return result
}

func textParts(parts a2a.ContentParts) string {
	var result []string
	for _, part := range parts {
		if part != nil && part.Text() != "" {
			result = append(result, part.Text())
		}
	}
	return strings.Join(result, "\n")
}
