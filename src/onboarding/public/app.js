const $ = (id) => document.getElementById(id);
const root = "/_agent-router/setup/api";
const words = {
  en: {
    title: "Your Agent, connected.",
    intro: "Sign in, choose an Agent, and connect the platforms you use.",
    account: "1. Your account",
    productLogin: "Sign in through your existing app",
    username: "Username",
    password: "Password",
    invitation: "Registration token, if required by this service",
    signIn: "Sign in",
    register: "Create account",
    accountHint:
      "Accounts belong to this service's existing Matrix backend. Your administrator controls registration.",
    signOut: "Sign out",
    agent: "2. Your Agent",
    chooseAgent: "Choose your Agent",
    createAgent: "Create Agent",
    execution: "Execution service",
    connectHost: "Connect",
    hostHint:
      "Your administrator provides execution services. Calling a friend's Agent uses their execution service.",
    platforms: "3. Connect platforms (optional)",
    optional: "Connect one, several, or none. You can also chat here.",
    region: "Platform",
    personalTools:
      "Authorize my calendar, documents and other personal services",
    feishuHint:
      "Scan to create the bot. Personal services require a second consent step and a connected execution service.",
    startConnection: "Connect",
    weixin: "Weixin",
    weixinHint:
      "Scan with Weixin and confirm. If a pairing code appears on your phone, enter it below.",
    botToken: "Bot token from BotFather",
    telegramHint:
      "Open your personal link and press Start. This binds your Telegram identity to this Agent.",
    mailService: "Mail service",
    inbox: "Agent inbox address",
    mailKey: "Inbox API key",
    ownerEmail: "Your sender email address",
    mailHint:
      "Use an inbox on a Grove Mail service configured by your administrator.",
    matrixHint: "Use your existing Matrix account to message this Agent.",
    check: "Check connections",
    verifyHint:
      "A successful access check is not a conversation test. Send a message from your chosen platform and confirm that the Agent replies.",
    chat: "4. Talk to an Agent",
    target: "Agent address (yours or a friend's)",
    openChat: "Open",
    message: "Message",
    send: "Send",
    cancel: "Stop task",
    newChat: "New conversation",
    share: "Let a friend use your Agent",
    shareHint:
      "Ask your friend to sign in here and send you their caller address. Allow that address on your Agent, then share your Agent address.",
    allow: "Allow",
    ask: "Ask",
    deny: "Deny",
    saveAccess: "Save access",
    footer:
      "Agent Router connects accounts, Agents and conversations. Agent Host runs the Agent.",
    none: "Create an Agent, or open a friend's address below.",
    noHost:
      "No execution service connected. Select one, or ask your administrator to provide a worker.",
    connectedHost: "Connected execution service: ",
    caller: "Your caller address (share this with your friend): ",
    noProfiles: "No execution service assigned to this account",
    chooseHost: "Choose an execution service",
    noMail: "Your administrator has not configured a Grove Mail service.",
    connected: "Connected",
    consent: "Personal authorization",
    noConnections: "No platforms connected yet.",
    openConsent: "Open consent link",
    pairing: "Pairing code shown on your phone",
    confirm: "Confirm",
    saved: "Saved.",
    selectFirst: "Create or select your Agent first.",
    starting: "Preparing connection…",
    application: "Scan to create the Feishu / Lark app.",
    authorization: "Approve access to your personal services.",
    telegram_pairing: "Open this Telegram link and press Start.",
    waiting: "Scan and confirm on your phone.",
    ready: "Connected. Send a message from this platform to verify the reply.",
    failed: "Connection failed: ",
    expired: "This link expired. Start the connection again.",
    noTasks: "No messages yet.",
    sender: "You",
    agentReply: "Agent",
    retry: "Retry the same message",
    uncertain:
      "The response was not confirmed. Check the conversation or retry the same message. Do not start another copy.",
    accessSaved: "Access updated.",
    signInAgain: "Please sign in again.",
    statuses: {
      TASK_STATE_SUBMITTED: "Queued",
      TASK_STATE_WORKING: "Working",
      TASK_STATE_COMPLETED: "Completed",
      TASK_STATE_FAILED: "Failed",
      TASK_STATE_CANCELED: "Stopped",
      TASK_STATE_REJECTED: "Rejected",
      TASK_STATE_INPUT_REQUIRED: "Waiting for your reply",
      TASK_STATE_AUTH_REQUIRED: "Waiting for authorization",
    },
  },
  zh: {
    title: "把你的 Agent 连起来。",
    intro: "登录账号，选择 Agent，再连接你常用的平台。",
    account: "1. 登录账号",
    productLogin: "通过已有应用登录",
    username: "用户名",
    password: "密码",
    invitation: "注册邀请码（如果服务要求）",
    signIn: "登录",
    register: "注册账号",
    accountHint:
      "账号由这个服务已有的 Matrix 后端管理。是否开放注册由管理员决定。",
    signOut: "退出登录",
    agent: "2. 选择 Agent",
    chooseAgent: "你的 Agent",
    createAgent: "创建 Agent",
    execution: "执行端",
    connectHost: "连接",
    hostHint:
      "执行端由管理员提供。使用朋友的 Agent 时，会使用朋友为它配置的执行端。",
    platforms: "3. 连接平台（可选）",
    optional: "可以连接一个、多个，也可以暂时不连接。你也能直接在这里对话。",
    region: "平台",
    personalTools: "授权访问我的日历、文档等个人服务",
    feishuHint:
      "先扫码创建机器人。个人服务还需要一次用户授权，并先连接执行端。",
    startConnection: "连接",
    weixin: "微信",
    weixinHint: "用微信扫码确认。如果手机显示配对码，请在下方输入。",
    botToken: "BotFather 提供的机器人 Token",
    telegramHint:
      "打开专属链接，点击 Start，确认将你的 Telegram 身份绑定到这个 Agent。",
    mailService: "邮件服务",
    inbox: "Agent 收件箱地址",
    mailKey: "收件箱 API Key",
    ownerEmail: "你的发件邮箱地址",
    mailHint: "使用管理员配置的 Grove Mail 服务中的收件箱。",
    matrixHint: "用你已有的 Matrix 账号向这个 Agent 发消息。",
    check: "检查连接",
    verifyHint:
      "连接检查通过后，还需要从所选平台发送一条消息，确认 Agent 能收到并回复。",
    chat: "4. 开始对话",
    target: "Agent 地址（自己的或朋友的）",
    openChat: "打开",
    message: "消息",
    send: "发送",
    cancel: "停止任务",
    newChat: "新对话",
    share: "让朋友使用你的 Agent",
    shareHint:
      "让朋友先在这里登录，把他的调用者地址发给你。为该地址开放使用权限后，再把你的 Agent 地址分享给他。",
    allow: "允许",
    ask: "需批准",
    deny: "拒绝",
    saveAccess: "保存",
    footer: "Agent Router 连接账号、Agent 和消息；Agent Host 执行 Agent。",
    none: "先创建 Agent，或者在下方打开朋友的 Agent 地址。",
    noHost: "还未连接执行端。请选择一个，或让管理员提供执行端。",
    connectedHost: "已连接执行端：",
    caller: "你的调用者地址（把它发给朋友）：",
    noProfiles: "管理员尚未为这个账号分配执行端",
    chooseHost: "选择执行端",
    noMail: "管理员尚未配置 Grove Mail 服务。",
    connected: "已连接",
    consent: "个人授权",
    noConnections: "尚未连接平台。",
    openConsent: "打开授权链接",
    pairing: "输入手机上显示的配对码",
    confirm: "确认",
    saved: "已保存。",
    selectFirst: "请先创建或选择自己的 Agent。",
    starting: "正在准备连接…",
    application: "扫码创建飞书 / Lark 应用。",
    authorization: "同意个人服务授权。",
    telegram_pairing: "打开 Telegram 链接并点击 Start。",
    waiting: "请用手机扫码并确认。",
    ready: "已连接。请从这个平台发消息，确认收到回复。",
    failed: "连接失败：",
    expired: "链接已过期，请重新连接。",
    noTasks: "还没有消息。",
    sender: "你",
    agentReply: "Agent",
    retry: "重试同一条消息",
    uncertain:
      "还未确认提交结果。请查看对话，或重试同一条消息，避免重复提交新任务。",
    accessSaved: "已更新使用权限。",
    signInAgain: "请重新登录。",
    statuses: {
      TASK_STATE_SUBMITTED: "排队中",
      TASK_STATE_WORKING: "执行中",
      TASK_STATE_COMPLETED: "已完成",
      TASK_STATE_FAILED: "失败",
      TASK_STATE_CANCELED: "已停止",
      TASK_STATE_REJECTED: "已拒绝",
      TASK_STATE_INPUT_REQUIRED: "等待你的回复",
      TASK_STATE_AUTH_REQUIRED: "等待授权",
    },
  },
};
const errors = {
  host_runtime_unavailable: [
    "The selected runtime is unavailable. Ask your administrator to check it.",
    "所选执行环境不可用，请管理员检查。",
  ],
  host_binding_configuration_changed: [
    "This Agent has already established its execution bindings. Create a new Agent to change the runtime or personal tools.",
    "这个 Agent 已绑定原来的执行环境和工具。更换执行端或个人工具请创建新 Agent。",
  ],
  agent_has_active_or_unknown_run: [
    "Finish or reconcile the active task before changing configuration.",
    "请先结束正在执行的任务，或核对结果未知的任务，再修改配置。",
  ],
  select_host_before_personal_tools: [
    "Connect an execution service before authorizing personal tools.",
    "请先连接执行端，再授权个人工具。",
  ],
  platform_already_connected: [
    "This platform is already connected.",
    "这个平台已经连接。",
  ],
  registration_token_or_external_client_required: [
    "Registration requires an invitation token or a supported Matrix client.",
    "注册需要邀请码，或使用支持该认证流程的 Matrix 客户端。",
  ],
  feishu_creation_outcome_unknown: [
    "App creation was interrupted. Ask the administrator to recover the existing app before starting another.",
    "应用创建过程已中断，请管理员先核对并恢复已有应用，避免重复创建。",
  ],
  invalid_login: [
    "Username or password was not accepted.",
    "用户名或密码不正确。",
  ],
  agent_not_found: [
    "Agent not found on this service, or this account cannot manage it.",
    "此服务上找不到这个 Agent，或当前账号不能管理它。",
  ],
};
let language = "en",
  session = null,
  selected = "",
  address = "",
  tasks = [],
  activeTask = null,
  pendingSend = null,
  jobTimer = null,
  chatTimer = null,
  accountEpoch = 0;
const t = (key) => words[language][key] ?? key;
function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
function errorText(error) {
  return errors[error.message]?.[language === "zh" ? 1 : 0] ?? error.message;
}
async function api(path, body) {
  const epoch = accountEpoch;
  const response = await fetch(root + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      "X-Agent-Router-UI": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(40_000),
  });
  if (epoch !== accountEpoch)
    throw new DOMException("Account changed", "AbortError");
  if (response.status === 204) return null;
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error ?? "request_failed");
    error.status = response.status;
    if (response.status === 401 && session) await signedOut();
    throw error;
  }
  return value;
}
async function action(event, operation) {
  event?.preventDefault();
  const buttons = [
    ...((
      event?.currentTarget?.closest?.("form") ?? event?.currentTarget
    )?.querySelectorAll?.("button") ?? []),
  ];
  if (event?.currentTarget?.tagName === "BUTTON")
    buttons.push(event.currentTarget);
  buttons.forEach((button) => (button.disabled = true));
  notice("");
  try {
    await operation();
  } catch (error) {
    if (error.name !== "AbortError") notice(errorText(error));
  } finally {
    buttons.forEach((button) => (button.disabled = false));
    updateSend();
  }
}
function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function translate() {
  document.documentElement.lang = language;
  document
    .querySelectorAll("[data-i18n]")
    .forEach((node) => (node.textContent = t(node.dataset.i18n)));
  if (session) {
    renderSession();
    renderTasks();
  }
}
async function signedOut() {
  accountEpoch++;
  clearInterval(jobTimer);
  clearInterval(chatTimer);
  session = null;
  selected = "";
  address = "";
  tasks = [];
  activeTask = null;
  pendingSend = null;
  $("workspace").hidden = true;
  $("login").hidden = false;
  [
    "jobs",
    "messages",
    "checks",
    "access",
    "requests",
    "interactions",
    "consents",
  ].forEach((id) => $(id).replaceChildren());
  $("target").value = "";
  $("chat-form").reset();
  $("login-form").reset();
}
async function loadSession() {
  session = await api("/session");
  $("login").hidden = true;
  $("workspace").hidden = false;
  selected =
    session.agents.find((item) => item.agent.id === selected)?.agent.id ??
    session.agents.find((item) => item.agent.name !== "client")?.agent.id ??
    "";
  renderSession();
  await loadAgent();
}
function renderSession() {
  $("identity").textContent = session.owner;
  $("caller").textContent = t("caller") + session.caller.address;
  $("agent-select").replaceChildren(
    option("", t("none")),
    ...session.agents
      .filter((item) => item.agent.name !== "client")
      .map((item) => option(item.agent.id, item.agent.name)),
  );
  $("agent-select").value = selected;
  $("host-select").replaceChildren(
    option("", session.hosts.length ? t("chooseHost") : t("noProfiles")),
    ...session.hosts.map((host) => option(host.id, host.label)),
  );
  $("mail-select").replaceChildren(
    ...session.mailServices.map((mail) => option(mail.id, mail.label)),
  );
  $("mail-form").hidden = !session.mailServices.length;
  let hint = $("mail-empty");
  if (!hint) {
    hint = element("p", undefined, "hint");
    hint.id = "mail-empty";
    $("mail-platform").append(hint);
  }
  hint.textContent = t("noMail");
  hint.hidden = !!session.mailServices.length;
  $("targets").replaceChildren(
    ...[
      ...session.agents
        .filter((item) => item.agent.name !== "client")
        .map((item) => item.agent.address),
      ...session.targets,
    ].map((value) => option(value, value)),
  );
  const item = session.agents.find((item) => item.agent.id === selected);
  $("agent-address").textContent = item?.agent.address ?? "";
  $("host-select").value = item?.host?.profileId ?? "";
  $("host-state").textContent = item?.host
    ? t("connectedHost") + item.host.runtimeId
    : t("noHost");
  for (const form of [$("host-form"), $("create-form"), $("access-form")]) {
    for (const button of form.querySelectorAll("button"))
      button.disabled = form.id !== "create-form" && !selected;
  }
  $("connected").replaceChildren();
  if (!item?.connections.length)
    $("connected").append(element("li", t("noConnections")));
  for (const connection of item?.connections ?? []) {
    const li = element("li", connection.kind + " · " + t("connected"));
    if (connection.kind === "feishu" && connection.personalTools) {
      const button = element("button", t("consent"), "secondary");
      button.addEventListener("click", (event) =>
        action(event, () => authorization(connection.id)),
      );
      li.append(button);
    }
    $("connected").append(li);
  }
  if (!address && item) {
    address = item.agent.address;
    $("target").value = address;
  }
}
async function loadAgent() {
  clearInterval(jobTimer);
  $("jobs").replaceChildren();
  $("checks").replaceChildren();
  $("access").replaceChildren();
  $("requests").replaceChildren();
  $("interactions").replaceChildren();
  $("consents").replaceChildren();
  if (selected) {
    const id = selected;
    const item = await api("/agents/" + id);
    if (id !== selected) return;
    session.agents = session.agents.map((existing) =>
      existing.agent.id === id ? item : existing,
    );
    renderSession();
    const access = await api("/agents/" + id + "/access");
    if (id === selected)
      for (const contact of access.contacts.filter(
        (contact) =>
          contact.address !== session.owner &&
          contact.note !== "Owner's browser",
      ))
        $("access").append(
          element("li", contact.note + " · " + contact.execution),
        );
    await refreshJobs();
    await refreshRequests();
    jobTimer = setInterval(
      () =>
        Promise.all([
          refreshJobs(),
          refreshRequests(),
          refreshInteractions(),
        ]).catch((error) => notice(errorText(error))),
      3000,
    );
  }
}
async function refreshRequests() {
  if (!selected) return;
  const id = selected,
    requests = await api("/agents/" + id + "/requests");
  if (id !== selected) return;
  $("requests").replaceChildren(
    ...requests.data.map((request) => {
      const box = element("div", undefined, "job");
      box.append(
        element("strong", request.sender),
        element(
          "p",
          request.input?.parts
            ?.map((part) => part.text ?? "")
            .filter(Boolean)
            .join("\n") ?? "",
        ),
      );
      for (const decision of ["allow", "deny"]) {
        const button = element("button", t(decision), "secondary");
        button.addEventListener("click", (event) =>
          action(event, async () => {
            await api(
              "/agents/" +
                id +
                "/requests/" +
                encodeURIComponent(request.id) +
                "/decision",
              { decision },
            );
            await refreshRequests();
          }),
        );
        box.append(button);
      }
      return box;
    }),
  );
}
async function refreshInteractions() {
  if (!selected) return;
  const id = selected,
    value = await api("/agents/" + id + "/interactions");
  if (
    id !== selected ||
    (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) &&
      $("interactions").contains(document.activeElement))
  )
    return;
  $("interactions").replaceChildren(
    ...value.data.map((call) => {
      const box = element("div", undefined, "job");
      box.append(element("p", call.text));
      if (call.sensitive) return box;
      const answer = async (body) => {
        await api(
          "/agents/" +
            id +
            "/interactions/" +
            encodeURIComponent(call.id) +
            "/answer",
          body,
        );
        document.activeElement.blur();
        await refreshInteractions();
      };
      if (call.choices.length)
        call.choices.forEach((label, choice) => {
          const button = element(
            "button",
            language === "en"
              ? ({ 同意: "Allow", 允许一次: "Allow once", 拒绝: "Deny" }[
                  label
                ] ?? label)
              : label,
            "secondary",
          );
          button.addEventListener("click", (event) =>
            action(event, () => answer({ choice })),
          );
          box.append(button);
        });
      else {
        const form = element("form"),
          label = element("label", t("message")),
          input = element("textarea"),
          button = element("button", t("confirm"));
        input.required = true;
        input.maxLength = 32000;
        label.append(input);
        form.append(label, button);
        form.addEventListener("submit", (event) =>
          action(event, () => answer({ text: input.value })),
        );
        box.append(form);
      }
      return box;
    }),
  );
}
async function requireAgent() {
  if (!selected) throw new Error(t("selectFirst"));
  return selected;
}
async function connect(body) {
  const id = await requireAgent();
  const value = await api("/agents/" + id + "/connections", body);
  if (value.id && value.state) {
    await refreshJobs();
  } else {
    await loadSession();
    notice(t("saved"));
  }
}
function renderJob(job) {
  const box = element("div", undefined, "job");
  box.append(
    element("strong", job.kind),
    element(
      "p",
      job.state === "failed"
        ? t("failed") + errorText(new Error(job.error))
        : t(job.state),
    ),
  );
  if (job.url) {
    const qr = element("img");
    qr.src = job.qr;
    qr.className = "qr";
    qr.alt = job.kind + " QR";
    const link = element("a", t("openConsent"));
    link.href = job.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    box.append(qr, link);
  }
  if (job.state === "pairing") {
    const form = element("form"),
      label = element("label", t("pairing")),
      input = element("input"),
      button = element("button", t("confirm"));
    input.name = "code";
    input.inputMode = "numeric";
    input.pattern = "[0-9]{1,12}";
    input.required = true;
    input.autocomplete = "off";
    label.append(input);
    form.append(label, button);
    form.addEventListener("submit", (event) =>
      action(event, async () => {
        await api("/agents/" + selected + "/jobs/" + job.id + "/pairing", {
          code: input.value,
        });
        input.value = "";
        input.blur();
        await refreshJobs();
      }),
    );
    box.append(form);
  }
  return box;
}
async function refreshJobs() {
  if (!selected) return;
  const id = selected,
    jobs = await api("/agents/" + id + "/jobs");
  if (id !== selected) return;
  const focused = document.activeElement?.closest(".job");
  if (
    !focused ||
    !focused.contains(document.activeElement) ||
    document.activeElement.tagName !== "INPUT"
  )
    $("jobs").replaceChildren(...jobs.data.map(renderJob));
  if (
    jobs.data.some((job) => job.state === "ready") &&
    session.agents.find((item) => item.agent.id === id)?.connections.length !==
      (await api("/agents/" + id)).connections.length
  ) {
    await loadSession();
  }
}
async function authorization(connectionId) {
  const id = await requireAgent();
  const status = await api(
    "/agents/" + id + "/authorization/" + connectionId + "/status",
    {},
  );
  if (status.authorized && status.verified) {
    notice(t("connected"));
    return;
  }
  const info = await api(
    "/agents/" + id + "/authorization/" + connectionId + "/begin",
    {},
  );
  const box = element("div", undefined, "job"),
    link = element("a", t("openConsent"));
  link.href = info.verificationUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  box.append(link);
  const button = element("button", t("confirm"));
  button.addEventListener("click", (event) =>
    action(event, async () => {
      await api(
        "/agents/" + id + "/authorization/" + connectionId + "/complete",
        {},
      );
      box.remove();
      notice(t("connected"));
    }),
  );
  box.append(button);
  $("consents").append(box);
}
function taskText(task) {
  if (
    ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"].includes(
      task.status.state,
    )
  )
    return (
      task.status.message?.parts
        ?.map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n\n") ?? ""
    );
  const artifacts = task.artifacts
    ?.flatMap((item) => item.parts ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n\n");
  return (
    artifacts ||
    [...(task.history ?? [])]
      .reverse()
      .find((message) => message.role === "ROLE_AGENT")
      ?.parts?.map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n\n") ||
    ""
  );
}
const terminal = (task) =>
  [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(task.status.state);
function renderTasks() {
  const nodes = [];
  for (const task of tasks) {
    for (const message of task.history ?? []) {
      if (message.role !== "ROLE_USER") continue;
      const content =
        message.parts?.map((part) => part.text ?? "").join("\n") ?? "";
      const node = element("div", undefined, "message");
      node.append(element("small", t("sender")), element("div", content));
      nodes.push(node);
    }
    const content = taskText(task);
    if (content) {
      const node = element("div", undefined, "message agent");
      node.append(element("small", t("agentReply")), element("div", content));
      nodes.push(node);
    }
    const state =
      words[language].statuses[task.status.state] ?? task.status.state;
    nodes.push(element("p", state, "status"));
  }
  $("messages").replaceChildren(
    ...(nodes.length ? nodes : [element("p", t("noTasks"), "hint")]),
  );
  $("task-state").textContent = activeTask
    ? (words[language].statuses[activeTask.status.state] ??
      activeTask.status.state)
    : "";
  $("cancel").hidden = !activeTask || terminal(activeTask);
  updateSend();
}
function updateSend() {
  const running =
    activeTask &&
    ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"].includes(
      activeTask.status.state,
    );
  $("send").disabled = !session || !address || !!running;
  $("send").textContent = pendingSend ? t("retry") : t("send");
  $("chat-form").elements.text.readOnly = !!pendingSend;
}
async function openChat() {
  clearInterval(chatTimer);
  activeTask = null;
  pendingSend = null;
  tasks = [];
  const value = await api("/chat/tasks?address=" + encodeURIComponent(address));
  tasks = value.tasks;
  activeTask = tasks.at(-1) ?? null;
  renderTasks();
  if (activeTask && !terminal(activeTask))
    chatTimer = setInterval(
      () => pollTask().catch((error) => notice(errorText(error))),
      1500,
    );
}
async function pollTask() {
  if (!activeTask) return;
  const id = activeTask.id,
    destination = address;
  const task = await api(
    "/chat/tasks/" +
      encodeURIComponent(id) +
      "?address=" +
      encodeURIComponent(destination),
  );
  if (destination !== address || activeTask?.id !== id) return;
  tasks = tasks.map((item) => (item.id === id ? task : item));
  activeTask = task;
  renderTasks();
  if (terminal(task)) clearInterval(chatTimer);
}
async function send() {
  const text = $("chat-form").elements.text.value;
  if (!text.trim()) return;
  if (!pendingSend)
    pendingSend = {
      address,
      text,
      messageId: crypto.randomUUID(),
      ...(activeTask
        ? {
            contextId: activeTask.contextId,
            ...(!terminal(activeTask) ? { taskId: activeTask.id } : {}),
          }
        : {}),
    };
  try {
    const task = await api("/chat/send", pendingSend);
    pendingSend = null;
    $("chat-form").reset();
    tasks = tasks.filter((item) => item.id !== task.id);
    tasks.push(task);
    activeTask = task;
    renderTasks();
    clearInterval(chatTimer);
    if (!terminal(task))
      chatTimer = setInterval(
        () => pollTask().catch((error) => notice(errorText(error))),
        1500,
      );
  } catch (error) {
    if (error.status && error.status < 500) {
      pendingSend = null;
      throw error;
    }
    notice(t("uncertain"));
  } finally {
    updateSend();
  }
}
$("language").addEventListener("change", () => {
  language = $("language").value;
  translate();
});
$("login-form").addEventListener("submit", (event) =>
  action(event, async () => {
    const form = event.currentTarget;
    const input = {
      username: form.elements.username.value,
      password: form.elements.password.value,
    };
    await api("/auth/login", input);
    form.reset();
    await loadSession();
  }),
);
$("register").addEventListener("click", (event) =>
  action(event, async () => {
    const form = $("login-form");
    if (!form.reportValidity()) return;
    await api("/auth/register", {
      username: form.elements.username.value,
      password: form.elements.password.value,
      ...(form.elements.registrationToken.value
        ? { registrationToken: form.elements.registrationToken.value }
        : {}),
    });
    form.reset();
    await loadSession();
  }),
);
$("logout").addEventListener("click", (event) =>
  action(event, async () => {
    await api("/auth/logout", {});
    await signedOut();
  }),
);
$("create-form").addEventListener("submit", (event) =>
  action(event, async () => {
    const item = await api("/agents", {
      name: event.currentTarget.elements.name.value,
    });
    selected = item.agent.id;
    address = item.agent.address;
    $("target").value = address;
    await loadSession();
    await openChat();
  }),
);
$("agent-select").addEventListener("change", (event) =>
  action(event, async () => {
    selected = $("agent-select").value;
    address =
      session.agents.find((item) => item.agent.id === selected)?.agent
        .address ?? "";
    $("target").value = address;
    renderSession();
    await loadAgent();
    if (address) await openChat();
  }),
);
$("host-form").addEventListener("submit", (event) =>
  action(event, async () => {
    await api("/agents/" + (await requireAgent()) + "/host", {
      hostId: $("host-select").value,
    });
    await loadSession();
    notice(t("saved"));
  }),
);
$("feishu-form").addEventListener("submit", (event) =>
  action(event, () =>
    connect({
      kind: "feishu",
      domain: event.currentTarget.elements.domain.value,
      personalTools: event.currentTarget.elements.personalTools.checked,
    }),
  ),
);
$("telegram-form").addEventListener("submit", (event) =>
  action(event, async () => {
    const input = event.currentTarget.elements.token,
      token = input.value;
    input.value = "";
    await connect({ kind: "telegram", token });
  }),
);
$("weixin-connect").addEventListener("click", (event) =>
  action(event, () => connect({ kind: "weixin" })),
);
$("matrix-connect").addEventListener("click", (event) =>
  action(event, () => connect({ kind: "matrix" })),
);
$("mail-form").addEventListener("submit", (event) =>
  action(event, async () => {
    const fields = event.currentTarget.elements,
      body = {
        kind: "grove-mail",
        serviceId: fields.serviceId.value,
        inboxId: fields.inboxId.value,
        apiKey: fields.apiKey.value,
        ownerEmail: fields.ownerEmail.value,
      };
    fields.apiKey.value = "";
    await connect(body);
  }),
);
$("check").addEventListener("click", (event) =>
  action(event, async () => {
    const value = await api("/agents/" + (await requireAgent()) + "/check", {});
    $("checks").replaceChildren(
      ...value.checks.map((check) =>
        element("li", check.kind + " · " + check.status + " · " + check.detail),
      ),
    );
  }),
);
$("target-form").addEventListener("submit", (event) =>
  action(event, async () => {
    address = $("target").value.trim();
    await openChat();
  }),
);
$("chat-form").addEventListener("submit", (event) => action(event, send));
$("new-chat").addEventListener("click", () => {
  clearInterval(chatTimer);
  activeTask = null;
  pendingSend = null;
  tasks = [];
  $("chat-form").reset();
  renderTasks();
});
$("cancel").addEventListener("click", (event) =>
  action(event, async () => {
    await api("/chat/tasks/" + encodeURIComponent(activeTask.id) + "/cancel", {
      address,
    });
    await pollTask();
  }),
);
$("access-form").addEventListener("submit", (event) =>
  action(event, async () => {
    const fields = event.currentTarget.elements;
    await api("/agents/" + (await requireAgent()) + "/access", {
      address: fields.address.value,
      decision: fields.decision.value,
    });
    await loadAgent();
    notice(t("accessSaved"));
  }),
);
async function start() {
  translate();
  const options = await api("/options");
  $("server").textContent = options.serverName;
  $("register").hidden = !options.registration;
  $("invitation").hidden = !options.registration;
  if (options.productLoginUrl) {
    $("product-login").href = options.productLoginUrl;
    $("product-login").hidden = false;
  }
  const fragment = new URLSearchParams(location.hash.slice(1)),
    ticket = fragment.get("ticket");
  history.replaceState(null, "", location.pathname);
  if (ticket) {
    const info = await api("/auth/handoff", { ticket });
    $("handoff").hidden = false;
    $("login-form").hidden = true;
    $("handoff-owner").textContent = info.owner;
    $("handoff-continue").textContent =
      language === "zh" ? "使用这个账号继续" : "Continue with this account";
    $("handoff-continue").addEventListener("click", (event) =>
      action(event, async () => {
        await api("/auth/redeem", { ticket });
        $("handoff").hidden = true;
        $("login-form").hidden = false;
        await loadSession();
        if (address) await openChat();
      }),
    );
    return;
  }
  try {
    await loadSession();
    if (address) await openChat();
  } catch (error) {
    if (error.status !== 401) throw error;
  }
}
start().catch((error) => notice(errorText(error)));
