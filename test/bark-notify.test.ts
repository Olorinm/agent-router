import { afterEach, expect, it } from "vitest";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ik, root, setup, until } from "./ledger-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** A local Bark server: it records each push request. */
async function bark() {
  const pushes: Array<{ path: string; fields: Record<string, string> }> = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { pushes.push({ path: req.url!, fields: Object.fromEntries(new URLSearchParams(body)) }); res.end(JSON.stringify({ code: 200, message: "success" })); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const directory = mkdtempSync(join(tmpdir(), "bark-notify-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "device"), "device-1\n"); writeFileSync(join(directory, "key"), "0123456789abcdef\n");
  const connection = { id: "bark", kind: "bark", server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, title: "Assistant",
    deviceKeyFile: join(directory, "device"), encryptionKeyFile: join(directory, "key"), notify: { replyAfterSeconds: 0 } };
  const read = (fields: Record<string, string>) => {
    const decipher = createDecipheriv("aes-128-cbc", Buffer.from("0123456789abcdef"), Buffer.from(fields.iv!));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(fields.ciphertext!, "base64")), decipher.final()]).toString("utf8"));
  };
  return { pushes, connection, read };
}

it("a web turn's answer is pushed to Bark, encrypted, unless the owner has the chat open in a browser", async () => {
  const push = await bark();
  const t = await setup(cleanup, {}, [{ id: "matrix", kind: "matrix" }, push.connection]);
  expect((await t.send({ idempotencyKey: ik("w"), text: "查一下机票" })).status).toBe(200);
  await until(() => push.pushes, (items) => items.length === 1);
  expect(push.pushes[0]!.path).toBe("/device-1");
  expect(push.pushes[0]!.fields).toMatchObject({ level: "active", group: "Assistant" });
  expect(push.read(push.pushes[0]!.fields)).toEqual({ title: "Assistant", body: "回答-1" });
  // The push repeats a recorded answer: no extra transcript event.
  expect((await t.events()).filter((event) => event.kind === "message").map((event) => event.text)).toEqual(["查一下机票", "回答-1"]);

  const { ticket } = (await t.api(`${root}/web/socket-tickets`, "alice", "POST", {})).data;
  const socket = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${ticket}`); cleanup.push(() => socket.close());
  const frames: any[] = []; socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  socket.send(JSON.stringify({ type: "req", id: "1", method: "subscribe", params: { chats: [{ chatId: t.chatId }] } }));
  await until(() => frames, (items) => items.some((frame) => frame.type === "res"));
  await t.send({ idempotencyKey: ik("w"), text: "再查一下酒店" });
  await until(t.events, (items) => items.some((event) => event.kind === "message" && event.text === "回答-2"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(push.pushes).toHaveLength(1);
});

it("schedule notices go where the rule says (ADR 16.6): web only, an explicit push, or a channel without a conversation", async () => {
  const push = await bark();
  const t = await setup(cleanup, {}, [{ id: "matrix", kind: "matrix" }, { ...push.connection, notify: { replies: false } }]);
  await t.send({ idempotencyKey: ik("w"), text: "你好" });
  await until(t.events, (items) => items.some((event) => event.kind === "message" && event.text === "回答-1"));
  const sessions = t.extension().sessions!, session = t.extension().communication!.status().inbox[0]!.conversationId;
  expect(sessions.deliveryConnections()).toEqual(["web", "matrix", "bark"]);
  expect(sessions.deliveryConnection(session)).toBe("web");
  expect(() => sessions.deliver({ eventId: "e0", targetSessionId: session, text: "x", connectionId: "nope" })).toThrow("delivery_connection_not_found");

  // `web`: recorded on the session, delivered to no channel; a web-only notice is pushed while no browser has the chat open.
  expect(sessions.deliver({ eventId: "e1", targetSessionId: session, text: "九点开会", connectionId: "web" })).toMatchObject({ state: "web" });
  await until(() => push.pushes, (items) => items.length === 1);
  expect(push.read(push.pushes[0]!.fields)).toMatchObject({ body: "九点开会" });

  const { ticket } = (await t.api(`${root}/web/socket-tickets`, "alice", "POST", {})).data;
  const socket = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${ticket}`); cleanup.push(() => socket.close());
  const frames: any[] = []; socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  socket.send(JSON.stringify({ type: "req", id: "1", method: "subscribe", params: { chats: [{ chatId: t.chatId }] } }));
  await until(() => frames, (items) => items.some((frame) => frame.type === "res"));

  // A channel the owner never used here: recorded only, with a suppressed receipt; the open chat is not pushed.
  expect(sessions.deliver({ eventId: "e2", targetSessionId: session, text: "十点复盘", connectionId: "matrix" }))
    .toMatchObject({ state: "suppressed", error: "no_conversation_on_connection" });
  // An explicit push target is pushed even with the chat open; its receipt is the push's.
  sessions.deliver({ eventId: "e3", targetSessionId: session, text: "十一点出发", connectionId: "bark" });
  await until(() => sessions.lookupDelivery("e3"), (receipt) => receipt?.state === "accepted");
  expect(push.pushes.map((item) => push.read(item.fields).body)).toEqual(["九点开会", "十一点出发"]);
  expect(sessions.deliver({ eventId: "e3", targetSessionId: session, text: "十一点出发", connectionId: "bark" })).toMatchObject({ state: "accepted" });
  const notices = (await t.events()).filter((event) => event.kind === "notice").map((event) => event.text);
  expect(notices).toEqual(["九点开会", "十点复盘", "十一点出发"]);
});
