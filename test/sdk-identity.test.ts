import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagedService, createManagedApp, type ManagedAgent } from "../src/matrix/managed.js";
import { AgentRouterClient, taskText } from "../packages/sdk/src/index.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import type { RoomEvent } from "../src/matrix/protocol.js";

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllGlobals();});
async function setup(){
 const dir=mkdtempSync(join(tmpdir(),"router-sdk-"));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const actualFetch=globalThis.fetch,accounts=new Map<string,Record<string,unknown>>(),requests:Array<{url:string;token:string}>=[];
 let eligible=true,active=true;
 const signing=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
 const privateJwk={...await crypto.subtle.exportKey("jwk",signing.privateKey),kid:"router-test",alg:"ES256"};
 // Keep the server configuration strict: only the actual private JWK fields.
 const {kty,crv,x,y,d,kid,alg}=privateJwk;
 let audience="";

 vi.stubGlobal("fetch",async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input),token=new Headers(init?.headers).get("Authorization")??"";
  if(url.startsWith("https://identity.example/")||url.startsWith("https://matrix.example/"))requests.push({url,token});
  if(url==="https://identity.example/.well-known/openid-configuration")return Response.json({issuer:"https://identity.example",introspection_endpoint:"https://identity.example/introspect"});
  if(url==="https://identity.example/introspect"){
   const params=new URLSearchParams(String(init?.body));
   expect(params.get("client_id")).toBe("native-router-verifier");
   expect(params.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
   const parts=params.get("client_assertion")!.split(".");
   const header=JSON.parse(Buffer.from(parts[0]!,"base64url").toString());
   const assertion=JSON.parse(Buffer.from(parts[1]!,"base64url").toString());
   expect(header.kid).toBe("router-test");expect(assertion.iss).toBe("native-router-verifier");
   expect(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},signing.publicKey,Buffer.from(parts[2]!,"base64url"),Buffer.from(parts.slice(0,2).join(".")))).toBe(true);
   if(params.get("token")!=="eligible-session" || !active)return Response.json({active:false});
   return Response.json({active:true,iss:"https://identity.example",sub:"7",client_id:"native-router",aud:audience,scope:"openid profile router.connect",exp:Math.floor(Date.now()/1000)+900,roles:eligible?["member","agent-network-user"]:["member"]});
  }
  if(url.startsWith("https://matrix.example/_synapse/admin/v2/users/")){
   if(token!=="Bearer synthetic-matrix-admin")return Response.json({}, {status:401});
   const user=decodeURIComponent(url.split("/").at(-1)!);
   if(init?.method==="PUT"){
    const body=JSON.parse(String(init.body));accounts.set(user,{name:user,admin:false,deactivated:false,external_ids:body.external_ids});
    expect(body.admin).toBe(false);expect(body.password).toBeUndefined();return Response.json({name:user},{status:201});
   }
   return accounts.has(user)?Response.json(accounts.get(user)):Response.json({}, {status:404});
  }
  return actualFetch(input,init);
 });
 let inbox:ApplicationInbox;
 const history=new Map<string,RoomEvent[]>();
 function deliver(room:string,event:RoomEvent){
  const events=history.get(room)??[];events.push(event);history.set(room,events);
  inbox.receive(randomUUID(),{events:[{...event,room_id:room}]});
 }
 function transport(agent:ManagedAgent,box:ApplicationInbox):MatrixTransport{
  inbox=box;
  return {identity:async()=>agent.matrixId,sync:async(since)=>{await new Promise(r=>setTimeout(r,10));return box.next(agent.id,since)??{next_batch:since??"0"};},
   state:async(room)=>history.get(room)??[],history:async()=>({events:[]}),
   createRoom:async(target)=>{const room=`!${randomUUID()}:test`;for(const user of [agent.matrixId,target])deliver(room,{event_id:`$${randomUUID()}`,type:"m.room.member",sender:user,state_key:user,content:{membership:"join"}});return room;},
   join:async()=>{},send:async(room,type,content)=>{const id=`$${randomUUID()}`;deliver(room,{event_id:id,type,sender:agent.matrixId,content});return id;},stop:()=>{},
  };
 }
 const config={serverName:"127.0.0.1",homeserver:"https://matrix.example",publicUrl:"https://example.test/_agent-router/v1",stateDir:dir,asToken:"a".repeat(48),hsToken:"h".repeat(48),externalIdentity:{adminToken:"synthetic-matrix-admin",providers:{example:{issuer:"https://identity.example",oidcIssuer:"https://identity.example",clientId:"native-router",introspectionClientId:"native-router-verifier",privateJwk:{kty,crv,x,y,d,kid,alg},requiredRoles:["agent-network-user"]}}}};
 const service=new ManagedService(config,{provision:async()=>{},transport});cleanup.push(()=>service.close());
 const server=createManagedApp(service).listen(0,"127.0.0.1");await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
 cleanup.push(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 const address=server.address();if(!address||typeof address==="string")throw new Error("no address");
 config.serverName=`127.0.0.1:${address.port}`;config.publicUrl=`http://${config.serverName}/_agent-router/v1`;
 audience=config.publicUrl;
 const bootstrap=new AgentRouterClient({baseUrl:config.publicUrl,accessToken:"",allowLocalHTTP:true});
 return {service,bootstrap,accounts,requests,config,deny:()=>{eligible=false;},revokeGrant:()=>{active=false;},wrongAudience:()=>{audience="https://other.example/_agent-router/v1";}};
}
describe("public SDK and identity-provider contract",()=>{
 it("rejects missing login and ineligible roles before provisioning; maps repeat logins to one account without names",async()=>{
  const f=await setup();
  await expect(f.bootstrap.exchange({provider:"example",accessToken:"invalid"})).rejects.toMatchObject({status:401});expect(f.accounts.size).toBe(0);
  await expect(f.bootstrap.exchange({provider:"constructor",accessToken:"eligible-session"})).rejects.toMatchObject({status:401,code:"external_session_invalid"});
  const [a,b]=await Promise.all([f.bootstrap.exchange({provider:"example",accessToken:"eligible-session"}),f.bootstrap.exchange({provider:"example",accessToken:"eligible-session"})]);
  expect(a.owner).toBe(b.owner);expect(a.agent.id).toBe(b.agent.id);expect(f.accounts.size).toBe(1);expect(a.owner).toMatch(/^@ext_[a-f0-9]{32}:/);expect(a.owner).not.toContain("NeverUse");
  expect(f.requests.filter(r=>r.url.startsWith("https://matrix.example/")).every(r=>r.token==="Bearer synthetic-matrix-admin")).toBe(true);
  const client=new AgentRouterClient({baseUrl:f.config.publicUrl,accessToken:a.accessToken,allowLocalHTTP:true});
  expect((await client.agents()).length).toBe(1);await client.revokeSession();await expect(client.agents()).rejects.toMatchObject({status:401});
  f.deny();await expect(f.bootstrap.exchange({provider:"example",accessToken:"eligible-session"})).rejects.toMatchObject({status:403,code:"external_role_required"});expect(f.accounts.size).toBe(1);
 });
 it("checks live revocation and resource binding on every authenticated request",async()=>{
  const f=await setup();
  const session=await f.bootstrap.exchange({provider:"example",accessToken:"eligible-session"});
  const client=new AgentRouterClient({baseUrl:f.config.publicUrl,accessToken:session.accessToken,allowLocalHTTP:true});
  expect((await client.agents()).length).toBe(1);
  f.revokeGrant();await expect(client.agents()).rejects.toMatchObject({status:401});
  await client.revokeSession().catch(()=>{});
 });
 it("rejects primary and wrong-resource credentials before creating an owner",async()=>{
  const f=await setup();
  await expect(f.bootstrap.exchange({provider:"example",accessToken:"primary-login-token"})).rejects.toMatchObject({status:401});
  f.wrongAudience();await expect(f.bootstrap.exchange({provider:"example",accessToken:"eligible-session"})).rejects.toMatchObject({status:401});
  expect(f.accounts.size).toBe(0);
 });
 it("sends through actual A2A gateway, continues a context, polls real replies and cancels without CLI",async()=>{
  const f=await setup(),session=await f.bootstrap.exchange({provider:"example",accessToken:"eligible-session"});let reads=0;
  const sdk=new AgentRouterClient({baseUrl:f.config.publicUrl,accessToken:()=>{reads++;return session.accessToken;},allowLocalHTTP:true});
  const target=await sdk.createAgent("echo"),runtime=await f.service.runtime(target.id);
  await runtime.connector.updateContact({address:session.agent.matrixId,receive:"allow",execution:"allow"});
  expect((await sdk.resolve(target.address)).matrixId).toBe(target.matrixId);
  const first=await sdk.send({agentId:session.agent.id,address:target.address,text:"remember 42",messageId:"stable-message-1"});
  expect(first.contextId).toBeTruthy();
  await vi.waitFor(()=>expect(runtime.connector.cli!.list().length).toBe(1),{timeout:5000});
  const issued=f.service.issue(target.id,"worker");
  const worker=async(path:string,body:unknown)=>{const res=await fetch(`${f.config.publicUrl}/agents/${target.id}/gateway/api/work${path}`,{method:"POST",headers:{Authorization:`Bearer ${issued.token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});expect(res.status).toBe(200);return res.json();};
  const claim=await worker("/claim",{worker:"worker"});await worker(`/${claim.claimId}/update`,{action:"reply",text:"Remembered 42"});
  let completed=first;
  for await(const task of sdk.watch({agentId:session.agent.id,address:target.address,taskId:first.id,intervalMs:100})){completed=task;}
  expect(taskText(completed)).toBe("Remembered 42");
  const second=await sdk.send({agentId:session.agent.id,address:target.address,text:"what number?",messageId:"stable-message-2",contextId:first.contextId});
  expect(second.contextId).toBe(first.contextId);
  const repeated=await sdk.send({agentId:session.agent.id,address:target.address,text:"what number?",messageId:"stable-message-2",contextId:first.contextId});expect(repeated.id).toBe(second.id);
  await sdk.cancel({agentId:session.agent.id,address:target.address,taskId:second.id});
  await vi.waitFor(async()=>expect((await sdk.get({agentId:session.agent.id,address:target.address,taskId:second.id})).status.state).toBe("TASK_STATE_CANCELED"),{timeout:5000});
  expect(reads).toBeGreaterThan(4);
 },15000);
 it("keeps directory discovery credential-free, rejects malformed task payloads and does not retry sends",async()=>{
  const calls:Array<{url:string;headers:Headers}>=[];
  const sdk=new AgentRouterClient({baseUrl:"https://home.example/_agent-router/v1",accessToken:"secret",fetch:async(input,init)=>{calls.push({url:String(input),headers:new Headers(init?.headers)});return Response.json({id:"r",owner:"@alice:other.example",name:"echo",address:"alice/echo@other.example",matrixId:"@remote:other.example"});}});
  await sdk.resolve("alice/echo@other.example");expect(calls[0]?.headers.has("Authorization")).toBe(false);
  const {parseTask}=await import("../packages/sdk/src/index.js");expect(()=>parseTask({id:"1",contextId:"c",status:{state:"invented"}})).toThrow("invalid_response");
 });
});
