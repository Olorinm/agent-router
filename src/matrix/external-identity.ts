import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "./protocol.js";
import { WorkError } from "./cli-work.js";
import type { ManagedService } from "./managed.js";

const fieldPath=z.array(z.string().min(1).max(80)).min(1).max(8);
const providerSchema = z.object({ issuer:z.string().min(1).max(512), userInfoUrl:z.url().refine(v=>{const u=new URL(v);return u.protocol==="https:"&&!u.username&&!u.password&&!u.hash&&!u.search;}), subjectPath:fieldPath,rolesPath:fieldPath,requiredRoles:z.array(z.string().min(1)).min(1) }).strict();
export const externalIdentityConfigSchema=z.object({providers:z.record(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),providerSchema),adminToken:z.string().min(1)}).strict();
export type ExternalIdentityConfig=z.infer<typeof externalIdentityConfigSchema>;
interface Owner {owner:string;issuer:string;subject:string;active:boolean}
interface Session {owner:string;expiresAt:number}

const accountSchema=z.object({name:z.string(),admin:z.boolean(),deactivated:z.boolean(),locked:z.boolean().optional(),suspended:z.boolean().optional(),external_ids:z.array(z.object({auth_provider:z.string(),external_id:z.string()}))});
const SESSION_MS=10*60*1000;

/** Optional issuer-neutral account bridge. Eligibility rules belong to the configured issuer. */
export class ExternalIdentitySessions {

  private readonly pending=new Map<string,Promise<Owner>>();
  constructor(private readonly service:ManagedService,private readonly config:ExternalIdentityConfig,private readonly now=Date.now){
    externalIdentityConfigSchema.parse(config);
    if(!Object.keys(config.providers).length)throw new Error("external_identity_providers_required");
  }
  private async identify(provider:string,accessToken:string){
    const trusted=Object.hasOwn(this.config.providers,provider)?this.config.providers[provider]:undefined;
    if(!trusted||!accessToken||accessToken.length>8192)throw new WorkError("external_session_invalid",401);
    let response:Response;
    try{response=await fetch(trusted.userInfoUrl,{headers:{Authorization:`Bearer ${accessToken}`,Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(10000)});}
    catch{throw new WorkError("identity_provider_unavailable",503);}
    if(response.status===401)throw new WorkError("external_session_invalid",401);
    if(response.status===403)throw new WorkError("external_access_denied",403);
    if(!response.ok)throw new WorkError("identity_provider_unavailable",503);
    let data:unknown;
    try{data=await response.json();}catch{throw new WorkError("identity_provider_invalid",503);}
    const field=(path:string[])=>{let value:unknown=data;for(const part of path){if(!value||typeof value!=="object"||!Object.hasOwn(value,part))return undefined;value=(value as Record<string,unknown>)[part];}return value;};
    const subject=field(trusted.subjectPath),roles=field(trusted.rolesPath);
    if(typeof subject!=="string"||!subject||subject.length>512||!Array.isArray(roles)||roles.some(r=>typeof r!=="string"))throw new WorkError("identity_provider_invalid",503);
    if(!trusted.requiredRoles.every(role=>roles.includes(role)))throw new WorkError("external_role_required",403);
    return {issuer:trusted.issuer,subject};
  }
  private sweep(){
    const now=this.now();
    for(const collection of ["external_sessions"]){
      for(const row of this.service.store.entries<{expiresAt:number}>(collection))if(row.value.expiresAt<=now)this.service.store.delete(collection,row.id);
    }
  }
  async exchange(provider:string,accessToken:string){
    const identity=await this.identify(provider,accessToken);this.sweep();
    const key=digest(JSON.stringify([identity.issuer,identity.subject]));
    let operation=this.pending.get(key);
    if(!operation){operation=this.provision(key,identity.issuer,identity.subject).finally(()=>this.pending.delete(key));this.pending.set(key,operation);}
    const owner=await operation;
    const agent=await this.service.create(owner.owner,"client");
    const sessionToken=`ars_${randomBytes(32).toString("base64url")}`,expiresAt=this.now()+SESSION_MS;
    this.service.store.set("external_sessions",digest(sessionToken),{owner:owner.owner,expiresAt} satisfies Session);
    return {serviceUrl:this.service.config.publicUrl,accessToken:sessionToken,expiresAt:new Date(expiresAt).toISOString(),owner:owner.owner,agent};
  }
  authenticate(token:string):string{
    const session=this.service.store.get<Session>("external_sessions",digest(token));
    if(!session||session.expiresAt<=this.now()){if(session)this.service.store.delete("external_sessions",digest(token));throw new WorkError("account_session_invalid",401);}
    return session.owner;
  }
  revoke(token:string){this.authenticate(token);this.service.store.delete("external_sessions",digest(token));}
  private async provision(key:string,issuer:string,subject:string):Promise<Owner>{
    let owner=this.service.store.get<Owner>("external_owners",key);
    if(!owner){owner={owner:`@ext_${randomUUID().replaceAll("-","")}:${this.service.config.serverName}`,issuer,subject,active:false};this.service.store.set("external_owners",key,owner);}
    const binding={auth_provider:`agent-router:${issuer}`,external_id:subject};
    const url=`${this.service.config.homeserver}/_synapse/admin/v2/users/${encodeURIComponent(owner.owner)}`;
    const call=async(method:string,body?:unknown)=>{
      try{return await fetch(url,{method,headers:{Authorization:`Bearer ${this.config.adminToken}`,"Content-Type":"application/json"},redirect:"error",signal:AbortSignal.timeout(10000),...(body===undefined?{}:{body:JSON.stringify(body)})});}
      catch{throw new WorkError("account_provisioning_unavailable",503);}
    };
    let response=await call("GET");
    if(response.status===404){
      if(owner.active)throw new WorkError("external_account_unavailable",403);
      const created=await call("PUT",{admin:false,external_ids:[binding]});
      if(created.status!==201)throw new WorkError("account_provisioning_failed",503);
      response=await call("GET");
    }
    if(!response.ok)throw new WorkError("account_provisioning_unavailable",503);
    const result=accountSchema.safeParse(await response.json());
    if(!result.success)throw new WorkError("account_provisioning_invalid",503);
    const account=result.data;
    if(account.name!==owner.owner||account.admin||account.deactivated||account.locked||account.suspended||!account.external_ids.some(id=>id.auth_provider===binding.auth_provider&&id.external_id===binding.external_id))throw new WorkError("external_account_unavailable",403);
    owner={...owner,active:true};this.service.store.set("external_owners",key,owner);return owner;
  }
}
