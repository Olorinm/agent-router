import { describe, expect, it } from "vitest";
import { taskText, taskStatusText, type Task } from "../packages/sdk/src/index.js";

describe("SDK reply content", () => {
  it("keeps remote progress and completion labels out of the reply body", () => {
    const task: Task = {
      id: "task", contextId: "context",
      status: { state: "TASK_STATE_WORKING", message: { parts: [{ text: "Connecting to runtime…" }] } },
    };
    expect(taskText(task)).toBe("");
    expect(taskStatusText(task)).toBe("Connecting to runtime…");
    expect(taskText({ ...task, status: { state: "TASK_STATE_COMPLETED", message: { parts: [{ text: "Completed." }] } } })).toBe("");
    expect(taskText({ ...task, artifacts: [{ parts: [{ text: "Actual answer" }] }] })).toBe("Actual answer");
    expect(taskText({ ...task, history: [{ role: "ROLE_AGENT", parts: [{ text: "Partial answer" }] }] })).toBe("Partial answer");
    expect(taskText({ ...task, status: { state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: "Which repository?" }] } } })).toBe("Which repository?");
    expect(taskText({ ...task, artifacts: [{ parts: [{ text: "Previous result" }] }], status: { state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: "Which repository?" }] } } })).toBe("Which repository?");
    expect(taskText({ ...task, artifacts: [{ parts: [{ text: "Which repository?" }] }], status: { state: "TASK_STATE_INPUT_REQUIRED" } })).toBe("Which repository?");
    expect(taskText({ ...task, history: [{ role: "ROLE_AGENT", parts: [{ text: "Please sign in." }] }], status: { state: "TASK_STATE_AUTH_REQUIRED" } })).toBe("Please sign in.");
  });
});
