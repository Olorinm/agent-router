import { ClientFactory, JsonRpcTransportFactory, RestTransportFactory, type Client } from "@a2a-js/sdk/client";
import type { AgentCard, SendMessageRequest, SendMessageResult, Task } from "@a2a-js/sdk";
import { SafeHttpClient } from "../safe-fetch.js";

export interface ExecutionBackend {
  send(request: SendMessageRequest): Promise<SendMessageResult>;
  get(taskId: string): Promise<Task>;
  cancel(taskId: string): Promise<Task>;
}

export class A2ABackend implements ExecutionBackend {
  private client: Promise<Client> | undefined;
  private readonly http: SafeHttpClient;
  private readonly origin: string;
  constructor(private readonly cardUrl: string, private readonly token: string, allowLocal = false) {
    this.origin = new URL(cardUrl).origin;
    this.http = new SafeHttpClient({ allowHttp: allowLocal, allowPrivate: allowLocal });
  }
  private async connect(): Promise<Client> {
    this.client ??= (async () => {
      const guardedFetch: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (new URL(url).origin !== this.origin) throw new Error("a2a_endpoint_origin_mismatch");
        const headers = new Headers(init?.headers);
        if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
        headers.set("A2A-Version", "1.0");
        return this.http.fetch(input, { ...init, headers });
      };
      const response = await guardedFetch(this.cardUrl, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`a2a_card_http_${response.status}`);
      const { AgentCard } = await import("@a2a-js/sdk");
      const card: AgentCard = AgentCard.fromJSON(await response.json());
      if (!card.supportedInterfaces.length || card.supportedInterfaces.some((i) => new URL(i.url).origin !== this.origin)) {
        throw new Error("a2a_card_interfaces_must_use_configured_origin");
      }
      return new ClientFactory({ transports: [new RestTransportFactory({ fetchImpl: guardedFetch }),
        new JsonRpcTransportFactory({ fetchImpl: guardedFetch })] }).createFromAgentCard(card);
    })().catch((error: unknown) => { this.client = undefined; throw error; });
    return this.client;
  }
  async send(request: SendMessageRequest): Promise<SendMessageResult> {
    return (await this.connect()).sendMessage(request, { signal: AbortSignal.timeout(30_000) });
  }
  async verify(): Promise<void> { await this.connect(); }
  async get(taskId: string): Promise<Task> {
    return (await this.connect()).getTask({ id: taskId, tenant: "", historyLength: 20 }, { signal: AbortSignal.timeout(15_000) });
  }
  async cancel(taskId: string): Promise<Task> {
    return (await this.connect()).cancelTask({ id: taskId, tenant: "", metadata: {} }, { signal: AbortSignal.timeout(15_000) });
  }
  async close(): Promise<void> { await this.http.close(); }
}
