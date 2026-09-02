import {
  TaskPushNotificationConfig,
  type TaskPushNotificationConfig as TaskPushNotificationConfigType,
} from "@a2a-js/sdk";
import type {
  PushNotificationStore,
  ServerCallContext,
  StoredPushNotificationConfig,
} from "@a2a-js/sdk/server";
import type { Pool } from "pg";
import type { RouterConfig } from "./config.js";
import type { RouterUser } from "./auth.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { assertSafeEndpoint } from "./endpoint-policy.js";
import type { FederationService } from "./federation.js";

interface ConfigRow {
  config_ciphertext: string;
  wire_version: string;
}

export class PostgresPushNotificationStore implements PushNotificationStore {
  constructor(
    private readonly pool: Pool,
    private readonly config: RouterConfig,
    private readonly federation?: FederationService,
  ) {}

  async save(
    taskId: string,
    context: ServerCallContext,
    pushNotificationConfig: TaskPushNotificationConfigType,
  ): Promise<void> {
    if (!taskId || (pushNotificationConfig.taskId && pushNotificationConfig.taskId !== taskId)) {
      throw new Error("push_task_id_mismatch");
    }
    pushNotificationConfig.taskId = taskId;
    if (!pushNotificationConfig.id) pushNotificationConfig.id = crypto.randomUUID();
    const user = context.user as RouterUser | undefined;
    if (user?.federationIdentity) {
      if (!this.federation) throw new Error("federation_service_required");
      await this.federation.assertCallbackUrl(user.federationIdentity, pushNotificationConfig.url);
    } else {
      await assertSafeEndpoint(pushNotificationConfig.url, {
        allowHttp: this.config.allowHttpAgentEndpoints,
        allowPrivate: this.config.allowPrivateAgentEndpoints,
      });
    }
    const scope = scopeFromContext(context);
    const canonical = TaskPushNotificationConfig.fromJSON(pushNotificationConfig);
    const encrypted = encryptSecret(JSON.stringify(TaskPushNotificationConfig.toJSON(canonical)), this.config.encryptionKey);
    await this.pool.query(
      `INSERT INTO task_push_notification_configs(
         tenant, owner_principal_id, task_id, config_id, wire_version, config_ciphertext
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant, owner_principal_id, task_id, config_id) DO UPDATE SET
         wire_version = EXCLUDED.wire_version,
         config_ciphertext = EXCLUDED.config_ciphertext,
         updated_at = now()`,
      [scope.tenant, scope.ownerPrincipalId, taskId, canonical.id, context.requestedVersion || "1.0", encrypted],
    );
  }

  async load(taskId: string, context: ServerCallContext): Promise<TaskPushNotificationConfigType[]> {
    return (await this.loadWithMetadata(taskId, context)).map((entry) => entry.config);
  }

  async loadWithMetadata(taskId: string, context: ServerCallContext): Promise<StoredPushNotificationConfig[]> {
    const scope = scopeFromContext(context);
    const result = await this.pool.query<ConfigRow>(
      `SELECT config_ciphertext, wire_version
         FROM task_push_notification_configs
        WHERE tenant = $1 AND owner_principal_id = $2 AND task_id = $3
        ORDER BY created_at, config_id`,
      [scope.tenant, scope.ownerPrincipalId, taskId],
    );
    return result.rows.map((row) => ({
      config: TaskPushNotificationConfig.fromJSON(
        JSON.parse(decryptSecret(row.config_ciphertext, this.config.encryptionKey)),
      ),
      wireVersion: row.wire_version,
    }));
  }

  async delete(taskId: string, context: ServerCallContext, configId?: string): Promise<void> {
    const scope = scopeFromContext(context);
    await this.pool.query(
      `DELETE FROM task_push_notification_configs
        WHERE tenant = $1 AND owner_principal_id = $2 AND task_id = $3 AND config_id = $4`,
      [scope.tenant, scope.ownerPrincipalId, taskId, configId ?? taskId],
    );
  }
}

function scopeFromContext(context: ServerCallContext): { tenant: string; ownerPrincipalId: string } {
  const ownerPrincipalId = context.user?.userName;
  if (!ownerPrincipalId) throw new Error("authenticated_push_owner_required");
  return { tenant: context.tenant ?? "", ownerPrincipalId };
}
