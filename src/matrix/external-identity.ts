import * as oidc from "openid-client";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "./protocol.js";
import { WorkError } from "./cli-work.js";
import type { ManagedService } from "./managed.js";

const httpsUrl = z.url().refine(v => {
 const u = new URL(v);
 return u.protocol === "https:" && !u.username && !u.password && !/[?#]/.test(v);
});
const providerSchema = z.object({
 // Stable account namespace, retained when migrating an existing installation.
 issuer:z.string().min(1).max(512), oidcIssuer:httpsUrl,
 clientId:z.string().min(1), introspectionClientId:z.string().min(1),
 privateJwk:z.object({kty:z.literal("EC"),crv:z.literal("P-256"),x:z.string().min(1),y:z.string().min(1),d:z.string().min(1),kid:z.string().min(1),alg:z.literal("ES256")}).strict(),
 requiredRoles:z.array(z.string().min(1)).min(1),
}).strict();
export const externalIdentityConfigSchema=z.object({providers:z.record(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),providerSchema),adminToken:z.string().min(1)}).strict();
export type ExternalIdentityConfig=z.infer<typeof externalIdentityConfigSchema>;
interface Owner {owner:string;issuer:string;subject:string;active:boolean}
interface Session {owner:string;expiresAt:number;provider:string;accessToken:string;subject:string}

const accountSchema=z.object({name:z.string(),admin:z.boolean(),deactivated:z.boolean(),locked:z.boolean().optional(),suspended:z.boolean().optional(),external_ids:z.array(z.object({auth_provider:z.string(),external_id:z.string()}))});
const SESSION_MS=10*60*1000;

/** Optional issuer-neutral account bridge. Eligibility rules belong to the configured issuer. */
export class ExternalIdentitySessions {

  private readonly sessions=new Map<string,Session>();
  private readonly providers=new Map<string,Promise<oidc.Configuration>>();
  private readonly pending=new Map<string,Promise<Owner>>();
  constructor(private readonly service:ManagedService,private readonly config:ExternalIdentityConfig,private readonly now=Date.now){
    externalIdentityConfigSchema.parse(config);
    if(!Object.keys(config.providers).length)throw new Error("external_identity_providers_required");
  }
  private configuration(provider:string, trusted:ExternalIdentityConfig["providers"][string]){
    let pending=this.providers.get(provider);
    if(!pending){
      pending=(async()=>{
        const key=await crypto.subtle.importKey("jwk",trusted.privateJwk,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
        const config=await oidc.discovery(new URL(trusted.oidcIssuer),trusted.introspectionClientId,
          {token_endpoint_auth_method:"private_key_jwt"},oidc.PrivateKeyJwt({key,kid:trusted.privateJwk.kid}),{timeout:10});
        const endpoint=config.serverMetadata().introspection_endpoint;
        if(!endpoint || new URL(endpoint).origin!==new URL(trusted.oidcIssuer).origin)throw new Error("invalid_introspection_endpoint");
        return config;
      })().catch(error=>{this.providers.delete(provider);throw error;});
      this.providers.set(provider,pending);
    }
    return pending;
  }
  private async identify(provider:string,accessToken:string){
    const trusted=Object.hasOwn(this.config.providers,provider)?this.config.providers[provider]:undefined;
    if(!trusted||!accessToken||accessToken.length>8192)throw new WorkError("external_session_invalid",401);
    let data:Awaited<ReturnType<typeof oidc.tokenIntrospection>>;
    try{data=await oidc.tokenIntrospection(await this.configuration(provider,trusted),accessToken);}
    catch{throw new WorkError("identity_provider_unavailable",503);}
    const audiences=typeof data.aud==="string"?[data.aud]:data.aud;
    if(!data.active || data.iss!==trusted.oidcIssuer || data.client_id!==trusted.clientId ||
      !Array.isArray(audiences) || audiences.length!==1 || audiences[0]!==this.service.config.publicUrl ||
      typeof data.exp!=="number" || data.exp*1000<=this.now() ||
      typeof data.scope!=="string" || !data.scope.split(" ").includes("router.connect") ||
      typeof data.sub!=="string" || !data.sub || data.sub.length>512)
      throw new WorkError("external_session_invalid",401);
    const roles=data.roles;
    if(!Array.isArray(roles)||roles.some(r=>typeof r!=="string"))throw new WorkError("identity_provider_invalid",503);
    if(!trusted.requiredRoles.every(role=>roles.includes(role)))throw new WorkError("external_role_required",403);
    return {issuer:trusted.issuer,subject:data.sub,expiresAt:data.exp*1000};
  }
  private sweep(){
    for(const [hash,session] of this.sessions)if(session.expiresAt<=this.now())this.sessions.delete(hash);
  }
  async exchange(provider:string,accessToken:string){
    const identity=await this.identify(provider,accessToken);this.sweep();
    const key=digest(JSON.stringify([identity.issuer,identity.subject]));
    let operation=this.pending.get(key);
    if(!operation){operation=this.provision(key,identity.issuer,identity.subject).finally(()=>this.pending.delete(key));this.pending.set(key,operation);}
    const owner=await operation;
    const agent=await this.service.create(owner.owner,"client");
    const sessionToken=`ars_${randomBytes(32).toString("base64url")}`,expiresAt=Math.min(this.now()+SESSION_MS,identity.expiresAt);
    this.sessions.set(digest(sessionToken),{owner:owner.owner,expiresAt,provider,accessToken,subject:identity.subject});
    return {serviceUrl:this.service.config.publicUrl,accessToken:sessionToken,expiresAt:new Date(expiresAt).toISOString(),owner:owner.owner,agent};
  }
  async authenticate(token:string):Promise<string>{
    const hash=digest(token),session=this.sessions.get(hash);
    if(!session||session.expiresAt<=this.now()){this.sessions.delete(hash);throw new WorkError("account_session_invalid",401);}
    try{
      const identity=await this.identify(session.provider,session.accessToken);
      if(this.sessions.get(hash)!==session || identity.subject!==session.subject)throw new WorkError("account_session_invalid",401);
    }catch(error){
      if(error instanceof WorkError && error.status===401){this.sessions.delete(hash);throw new WorkError("account_session_invalid",401);}
      throw error;
    }
    return session.owner;
  }
  revoke(token:string){
    if(!this.sessions.delete(digest(token)))throw new WorkError("account_session_invalid",401);
  }
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
