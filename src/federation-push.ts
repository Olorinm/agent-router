import type { StreamResponse, Task } from "@a2a-js/sdk";
import {
  DefaultPushNotificationSender,
  V1PushNotificationSerializer,
  type PushNotificationSender,
  type PushNotificationStore,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import type { RouterUser } from "./auth.js";
import type { FederationService } from "./federation.js";

export class RouterPushNotificationSender implements PushNotificationSender {
  private readonly defaultSender: DefaultPushNotificationSender;
  private readonly serializer = new V1PushNotificationSerializer();
  private readonly notificationChain = new Map<string, Promise<void>>();

  constructor(
    private readonly store: PushNotificationStore,
    private readonly federation: FederationService,
  ) {
    this.defaultSender = new DefaultPushNotificationSender(store);
  }

  async send(response: StreamResponse, context: ServerCallContext, task?: Task): Promise<void> {
    const user = context.user as RouterUser | undefined;
    const identity = user?.federationIdentity;
    if (!identity) {
      await this.defaultSender.send(response, context, task);
      return;
    }
    const taskId = taskIdFromResponse(response);
    if (!taskId) return;
    const chainKey = `${user.userName}:${taskId}`;
    const previous = this.notificationChain.get(chainKey) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => this.dispatchFederation(response, context, identity, task));
    this.notificationChain.set(chainKey, pending);
    return pending.finally(() => {
      if (this.notificationChain.get(chainKey) === pending) this.notificationChain.delete(chainKey);
    });
  }

  private async dispatchFederation(
    response: StreamResponse,
    context: ServerCallContext,
    identity: NonNullable<RouterUser["federationIdentity"]>,
    task?: Task,
  ): Promise<void> {
    const taskId = taskIdFromResponse(response);
    if (!taskId) return;
    const configs = this.store.loadWithMetadata
      ? await this.store.loadWithMetadata(taskId, context)
      : (await this.store.load(taskId, context)).map((config) => ({ config, wireVersion: "1.0" }));
    const serialized = this.serializer.serialize(response, task);
    await Promise.all(configs.map(async ({ config }) => {
      await this.federation.assertCallbackUrl(identity, config.url);
      const authorization = await this.federation.mintToken(
        `router@${this.federation.domain}`,
        new URL(config.url).origin,
      );
      const result = await this.federation.request(config.url, {
        method: "POST",
        headers: {
          "Content-Type": serialized.contentType,
          Authorization: `Bearer ${authorization}`,
        },
        body: serialized.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok) throw new Error(`federation_push_http_${result.status}`);
    }));
  }
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
