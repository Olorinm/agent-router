import type { HostCall } from "../execution/host.js";
export interface InteractionView { text: string; choices: Array<{ label: string; result: unknown }>; sensitive?: boolean; answer(text: string): unknown; }
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** Translate chat gestures to the exact native response; keep each kernel's semantics. */
export function interaction(call: HostCall): InteractionView {
  const p = object(call.input), questions = p.questions ?? p.input?.questions;
  let questionText = Array.isArray(questions) ? questions.map((q: any) => [`${q.id ?? q.qid ?? q.question ?? q.header}: ${q.question ?? q.header}`, ...(q.options ?? []).map((o: any, i: number) => `${i + 1}. ${o.label}${o.description ? `：${o.description}` : ""}`)].join("\n")).join("\n\n") :
    p.question ?? p.prompt ?? p.message ?? p.reason ?? p.description ?? p.toolCall?.title ?? p.command ?? p.name ?? call.name;
  const details = [p.command, p.toolCall?.rawInput, p.input, p.permissions, p.changes].filter((value) => value !== undefined);
  if (details.length && (call.name === "permission" || /requestApproval$/.test(call.name) || call.name === "session/request_permission" || call.name === "approval")) questionText += "\n" + details.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
  if (call.name === "session/request_permission") {
    const choices = (p.options ?? []).map((option: any) => ({ label: option.name ?? option.kind, result: { outcome: { outcome: "selected", optionId: option.optionId } } }));
    return { text: String(questionText), choices, answer: (text) => choose(text, choices) };
  }
  if (call.name === "approval") {
    const choices = [{ label: "允许一次", result: { choice: "once" } }, { label: "拒绝", result: { choice: "deny" } }];
    return { text: String(questionText), choices, answer: (text) => decision(text, choices) };
  }
  if (call.name === "permission" || /requestApproval$/.test(call.name)) {
    const allow = call.name === "permission" ? { behavior: "allow", updatedInput: p.input ?? {}, toolUseID: p.toolUseID } :
      call.name === "item/permissions/requestApproval" ? { permissions: p.permissions ?? {}, scope: "turn" } : { decision: "accept" };
    const deny = call.name === "permission" ? { behavior: "deny", message: "User declined", toolUseID: p.toolUseID } :
      call.name === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: "decline" };
    const choices = [{ label: "同意", result: allow }, { label: "拒绝", result: deny }];
    return { text: String(questionText), choices, answer: (text) => decision(text, choices) };
  }
  if (call.name === "clarify") return { text: questionText, choices: [], answer: (text) => {
    if (Array.isArray(questions)) {
      let answers; try { answers = JSON.parse(text); } catch { if (questions.length !== 1) throw new Error("structured_answers_required"); answers = { [questions[0].id ?? questions[0].qid]: text }; }
      return { answers };
    }
    return { answer: text };
  } };
  if (["sudo", "secret", "vault.code", "vault.password", "vault.unlock_prompt"].includes(call.name)) return { text: "执行内核需要敏感输入。请通过 Host 原生交互入口完成，不要在聊天中发送密码或令牌。", choices: [], sensitive: true, answer: () => { throw new Error("sensitive_input_requires_native_entry"); } };
  if (Array.isArray(questions)) {
    const answer = (text: string) => {
      let values: Record<string, unknown>;
      try { values = object(JSON.parse(text)); } catch { if (questions.length !== 1) throw new Error("structured_answers_required"); const option = questions[0].options?.[Number(text.trim()) - 1]; values = { [questions[0].id ?? questions[0].question]: option?.label ?? text }; }
      if (call.name === "AskUserQuestion") return { behavior: "allow", updatedInput: { ...p.input, answers: values } };
      return { answers: Object.fromEntries(questions.map((q: any) => {
        const value = values[q.id ?? q.question]; if (value === undefined) throw new Error("question_answer_missing");
        return [q.id, { answers: Array.isArray(value) ? value : [String(value)] }];
      })) };
    };
    const choices = questions.length === 1 ? (questions[0].options ?? []).map((o: any) => ({ label: o.label, result: answer(o.label) })) : [];
    return { text: questionText, choices, answer };
  }
  if (["elicitation/create", "mcpServer/elicitation/request"].includes(call.name)) {
    const schema = object(p.requestedSchema), properties = object(schema.properties);
    const fields = Object.keys(properties);
    return { text: `${questionText}${fields.length > 1 ? `\n请填写 JSON：${fields.join("、")}` : ""}`, choices: [], answer: (text) => {
      let content: unknown; try { content = JSON.parse(text); } catch { if (fields.length !== 1) throw new Error("structured_answers_required"); content = { [fields[0]!]: text }; }
      if (fields.length === 1 && (typeof content !== "object" || content === null)) content = { [fields[0]!]: content };
      return { action: "accept", content };
    } };
  }
  return { text: `${questionText}\n请使用 /answer 后跟原生响应 JSON。`, choices: [], answer: (text) => JSON.parse(text) };
}
function choose(text: string, choices: InteractionView["choices"]) {
  const choice = choices.find((item) => item.label === text.trim()) ?? choices[Number(text.trim()) - 1];
  if (!choice) throw new Error("interaction_choice_required"); return choice.result;
}
function decision(text: string, choices: InteractionView["choices"]) {
  if (/^(同意|允许|继续|yes|y|approve|允许一次)$/i.test(text.trim())) return choices[0]!.result;
  if (/^(拒绝|不同意|不允许|no|n|deny)$/i.test(text.trim())) return choices[1]!.result;
  return choose(text, choices);
}
