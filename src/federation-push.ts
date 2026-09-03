import type { StreamResponse, Task, TaskPushNotificationConfig } from "@a2a-js/sdk";
import {
  V1PushNotificationSerializer,
  type PushNotificationSender,
  type PushNotificationStore,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import type { RouterUser } from "./auth.js";
import type { FederationService } from "./federation.js";

export class RouterPushNotificationSender implements PushNotificationSender {
  private readonly serializer = new V1PushNotificationSerializer();
  private readonly notificationChain = new Map<string, Promise<void>>();

  constructor(
    private readonly store: PushNotificationStore,
    private readonly federation: FederationService,
  ) {}

  async send(response: StreamResponse, context: ServerCallContext, task?: Task): Promise<void> {
    const user = context.user as RouterUser | undefined;
    const identity = user?.federationIdentity;
    const taskId = taskIdFromResponse(response);
    if (!taskId) return;
    const chainKey = `${user?.userName ?? context.tenant}:${taskId}`;
    const previous = this.notificationChain.get(chainKey) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => this.dispatch(response, context, identity, task));
    this.notificationChain.set(chainKey, pending);
    return pending.finally(() => {
      if (this.notificationChain.get(chainKey) === pending) this.notificationChain.delete(chainKey);
    });
  }

  private async dispatch(
    response: StreamResponse,
    context: ServerCallContext,
    identity: RouterUser["federationIdentity"],
    task?: Task,
  ): Promise<void> {
    const taskId = taskIdFromResponse(response);
    if (!taskId) return;
    const configs = this.store.loadWithMetadata
      ? await this.store.loadWithMetadata(taskId, context)
      : (await this.store.load(taskId, context)).map((config) => ({ config, wireVersion: "1.0" }));
    const serialized = this.serializer.serialize(response, task);
    await Promise.all(configs.map(async ({ config }) => {
      const headers: Record<string, string> = { "Content-Type": serialized.contentType };
      if (identity) {
        await this.federation.assertCallbackUrl(identity, config.url);
        const authorization = await this.federation.mintToken(
          `router@${this.federation.domain}`,
          new URL(config.url).origin,
        );
        headers.Authorization = `Bearer ${authorization}`;
      } else {
        Object.assign(headers, notificationAuthenticationHeaders(config));
      }
      const result = await this.federation.request(config.url, {
        method: "POST",
        headers,
        body: serialized.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok) throw new Error(`push_notification_http_${result.status}`);
    }));
  }
}

function notificationAuthenticationHeaders(config: TaskPushNotificationConfig): Record<string, string> {
  if (config.authentication?.scheme && config.authentication.credentials) {
    return { Authorization: `${config.authentication.scheme} ${config.authentication.credentials}` };
  }
  return config.token ? { "X-A2A-Notification-Token": config.token } : {};
}

function taskIdFromResponse(response: StreamResponse): string {
  switch (response.payload?.$case) {
    case "task":
      return response.payload.value.id;
    case "statusUpdate":
    case "artifactUpdate":
    case "message":
      return response.payload.value.taskId;
    default:
      return "";
  }
}
