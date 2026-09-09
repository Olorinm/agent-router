export interface Agent { id: string; owner: string; name: string; address: string; matrixId: string }
export interface NetworkSession { serviceUrl: string; accessToken: string; expiresAt: string; owner: string; agent: Agent }
export type TaskState = "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING" | "TASK_STATE_INPUT_REQUIRED" | "TASK_STATE_AUTH_REQUIRED" | "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELED" | "TASK_STATE_REJECTED";
export interface Message { role?: string; parts: Array<{text?: string; [key: string]: unknown}> }
export interface Task { id: string; contextId: string; status: {state: TaskState; message?: Message}; artifacts?: Array<{parts: Message["parts"]}>; history?: Message[] }
export interface RequestOptions { signal?: AbortSignal }
/** Public routing identity returned by resolve; safe to persist with the contact. */
export interface ResolvedTarget { address: string; matrixId: string }
export interface TargetOptions extends RequestOptions { resolvedTarget?: ResolvedTarget }
export interface TaskTarget extends TargetOptions { agentId: string; address: string; taskId: string }
export interface SendOptions extends TargetOptions { agentId: string; address: string; text: string; messageId: string; contextId?: string; taskId?: string }
export class AgentRouterError extends Error {
  constructor(readonly code: string, readonly status: number = 0) { super(code); this.name = "AgentRouterError"; }
}
export interface ClientOptions {
  /** Service root, including /_agent-router/v1. Credentials go only to this origin. */
  baseUrl: string;
  /** Called on every authenticated request. Applications own refresh and account switching. */
  accessToken: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Local development only: permit plain HTTP to a loopback service. */
  allowLocalHTTP?: boolean;
}
const states = new Set<TaskState>(["TASK_STATE_SUBMITTED","TASK_STATE_WORKING","TASK_STATE_INPUT_REQUIRED","TASK_STATE_AUTH_REQUIRED","TASK_STATE_COMPLETED","TASK_STATE_FAILED","TASK_STATE_CANCELED","TASK_STATE_REJECTED"]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentRouterError("invalid_response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string" || !value) throw new AgentRouterError("invalid_response"); return value; }
function parseAgent(value: unknown): Agent {
  const a=record(value); return {id:string(a.id),owner:string(a.owner),name:string(a.name),address:string(a.address),matrixId:string(a.matrixId)};
}
function parts(value: unknown): Message["parts"] {
  if (!Array.isArray(value)) throw new AgentRouterError("invalid_response");
  return value.map(p=>{const r=record(p);if(r.text!==undefined && typeof r.text!=="string")throw new AgentRouterError("invalid_response");return r as Message["parts"][number];});
}
function message(value: unknown): Message {
  const m=record(value); return {...(m.role===undefined?{}:{role:string(m.role)}),parts:parts(m.parts??[])};
}
export function parseTask(value: unknown): Task {
  const t=record(value),s=record(t.status),state=string(s.state) as TaskState;
  if(!states.has(state))throw new AgentRouterError("invalid_response");
  if(t.artifacts!==undefined && !Array.isArray(t.artifacts) || t.history!==undefined && !Array.isArray(t.history)) throw new AgentRouterError("invalid_response");
  return {id:string(t.id),contextId:string(t.contextId),status:{state,...(s.message?{message:message(s.message)}:{})},
    artifacts:((t.artifacts??[]) as unknown[]).map(a=>({parts:parts(record(a).parts??[])})),history:((t.history??[]) as unknown[]).map(message)};
}
/** Actual Agent content only. Task progress and completion labels belong to taskStatusText. */
export function taskText(task: Task): string {
  const question=taskStatusText(task);
  if(question && (task.status.state==="TASK_STATE_INPUT_REQUIRED" || task.status.state==="TASK_STATE_AUTH_REQUIRED"))return question;
  const text=task.artifacts?.flatMap(a=>a.parts).flatMap(p=>p.text?[p.text]:[]).join("\n\n");
  if(text)return text;
  return [...(task.history??[])].reverse().find(m=>m.role==="ROLE_AGENT")?.parts.flatMap(p=>p.text?[p.text]:[]).join("\n\n")??"";
}
/** Remote status detail, for the execution-status area. Never synthesizes progress text. */
export function taskStatusText(task: Task): string {return task.status.message?.parts.flatMap(p=>p.text?[p.text]:[]).join("\n\n")??"";}
export function isTaskSettled(task: Task): boolean {return task.status.state!=="TASK_STATE_SUBMITTED" && task.status.state!=="TASK_STATE_WORKING";}
function endpoint(value: string, allowLocalHTTP=false): URL {
  const u=new URL(value);
  if(u.username||u.password||u.search||u.hash||!(u.protocol==="https:"||(allowLocalHTTP&&u.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(u.hostname)))) throw new AgentRouterError("invalid_service_url");
  return u;
}
const pathPart=(s:string)=>{if(!s||s.length>1024)throw new AgentRouterError("invalid_request");return encodeURIComponent(s);};
function addressHost(address:string):string {
  const match=/^[^\s/@]+\/[a-z][a-z0-9-]{0,47}@([a-zA-Z0-9.-]+(?::[0-9]+)?)$/.exec(address);
  if(!match)throw new AgentRouterError("invalid_agent_address");
  return match[1]!;
}
function validateTarget(target:ResolvedTarget,address:string):ResolvedTarget {
  const host=addressHost(address),colon=target.matrixId.indexOf(":");
  if(target.address!==address || !target.matrixId.startsWith("@") || colon<2 || /\s/.test(target.matrixId) || target.matrixId.slice(colon+1)!==host)throw new AgentRouterError("invalid_agent_target");
  return target;
}
export class AgentRouterClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: ClientOptions) {
    this.baseUrl=endpoint(options.baseUrl,options.allowLocalHTTP).href.replace(/\/$/,"");
    this.fetcher=options.fetch??globalThis.fetch;
  }
  private async request(url:string,method:string,body:unknown,auth:boolean,options:RequestOptions={}):Promise<unknown>{
    options.signal?.throwIfAborted();
    const headers: Record<string,string>={Accept:"application/json","A2A-Version":"1.0"};
    if(body!==undefined)headers["Content-Type"]="application/json";
    if(auth){
      if(new URL(url).origin!==new URL(this.baseUrl).origin)throw new AgentRouterError("credential_origin_mismatch");
      const token=typeof this.options.accessToken==="function"?await this.options.accessToken():this.options.accessToken;
      if(!token)throw new AgentRouterError("account_login_required",401);
      headers.Authorization=`Bearer ${token}`;
    }
    const timeout=AbortSignal.timeout(this.options.timeoutMs??30000);
    const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
    let response:Response;
    try {response=await this.fetcher(url,{method,headers,redirect:"error",credentials:"omit",signal,...(body===undefined?{}:{body:JSON.stringify(body)})});}
    catch(error){if(signal.aborted)throw signal.reason;throw new AgentRouterError("connection_unavailable");}
    if(response.status===204)return undefined;
    let data:unknown;try{data=await response.json();}catch{throw new AgentRouterError(response.ok?"invalid_response":"request_failed",response.status);}
    if(!response.ok){const e=record(data).error;throw new AgentRouterError(typeof e==="string"&&/^[a-z0-9_]+$/.test(e)?e:"request_failed",response.status);}
    return data;
  }
  async exchange(input:{provider:string;accessToken:string},options:RequestOptions={}):Promise<NetworkSession>{
    const s=record(await this.request(`${this.baseUrl}/auth/exchange`,"POST",input,false,options));
    const result={serviceUrl:string(s.serviceUrl),accessToken:string(s.accessToken),expiresAt:string(s.expiresAt),owner:string(s.owner),agent:parseAgent(s.agent)};
    if(result.serviceUrl!==this.baseUrl||!Number.isFinite(Date.parse(result.expiresAt))||result.agent.owner!==result.owner)throw new AgentRouterError("invalid_response");
    return result;
  }
  async revokeSession(options:RequestOptions={}):Promise<void>{await this.request(`${this.baseUrl}/auth/session`,"DELETE",undefined,true,options);}
  async agents(options:RequestOptions={}):Promise<Agent[]>{const r=record(await this.request(`${this.baseUrl}/agents`,"GET",undefined,true,options));if(!Array.isArray(r.data))throw new AgentRouterError("invalid_response");return r.data.map(parseAgent);}
  async createAgent(name:string,options:RequestOptions={}):Promise<Agent>{return parseAgent(await this.request(`${this.baseUrl}/agents`,"POST",{name},true,options));}
  async resolve(address:string,options:RequestOptions={}):Promise<Agent>{
    const host=addressHost(address),local=new URL(this.baseUrl);
    const root=host===local.host?this.baseUrl:`https://${host}/_agent-router/v1`;
    const a=parseAgent(await this.request(`${root}/directory?address=${encodeURIComponent(address)}`,"GET",undefined,false,options));
    try{validateTarget(a,address);}catch{throw new AgentRouterError("invalid_response");}
    return a;
  }
  private async rpc(agentId:string,address:string,method:string,params:unknown,options:TargetOptions):Promise<unknown>{
    const target=options.resolvedTarget?validateTarget(options.resolvedTarget,address):await this.resolve(address,options),id=globalThis.crypto.randomUUID();
    const r=record(await this.request(`${this.baseUrl}/agents/${pathPart(agentId)}/gateway/agents/${pathPart(target.matrixId)}/a2a/jsonrpc`,"POST",{jsonrpc:"2.0",id,method,params},true,options));
    if(r.jsonrpc!=="2.0"||r.id!==id)throw new AgentRouterError("invalid_response");
    if(r.error){const e=record(r.error);throw new AgentRouterError(`a2a_${typeof e.code==="number"?e.code:"error"}`,200);}
    return r.result;
  }
  async send(input:SendOptions):Promise<Task>{
    if(!input.messageId||!input.text||input.text.length>32000)throw new AgentRouterError("invalid_message");
    const r=record(await this.rpc(input.agentId,input.address,"SendMessage",{message:{messageId:input.messageId,role:"ROLE_USER",parts:[{text:input.text}],...(input.contextId?{contextId:input.contextId}:{}),...(input.taskId?{taskId:input.taskId}:{})},configuration:{returnImmediately:true,historyLength:20}},input));
    return parseTask(r.task);
  }
  async get(input:TaskTarget):Promise<Task>{return parseTask(await this.rpc(input.agentId,input.address,"GetTask",{id:input.taskId,historyLength:20},input));}
  async cancel(input:TaskTarget):Promise<Task>{return parseTask(await this.rpc(input.agentId,input.address,"CancelTask",{id:input.taskId},input));}
  /** Polls durable state; stops for input/auth-required as well as terminal states. No automatic send retries. */
  async *watch(input:TaskTarget & {intervalMs?:number}):AsyncGenerator<Task>{
    for(;;){const task=await this.get(input);yield task;if(isTaskSettled(task))return;
      await new Promise<void>((resolve,reject)=>{
        const done=()=>{input.signal?.removeEventListener("abort",abort);resolve();};
        const timer=setTimeout(done,Math.max(100,input.intervalMs??1200));
        const abort=()=>{clearTimeout(timer);input.signal?.removeEventListener("abort",abort);reject(input.signal?.reason);};
        if(input.signal?.aborted)abort();else input.signal?.addEventListener("abort",abort,{once:true});
      });
    }
  }
}
