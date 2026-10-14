import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRouter } from "../src/server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const stateDir=mkdtempSync(join(tmpdir(),"embedded-channels-"));
  cleanup.push(()=>rmSync(stateDir,{recursive:true,force:true}));
  const config={serverName:"example.test",homeserver:"https://example.test",publicUrl:"https://example.test/_agent-router/v1",stateDir,asToken:"a".repeat(48),hsToken:"h".repeat(48)};
  const seed=createRouter(config), id=randomUUID();
  seed.service.store.set("agents",id,{id,owner:"@owner:example.test",name:"mail",status:"active"});
  await seed.close();
  const channelConfigFile=join(stateDir,"channels.json");
  writeFileSync(channelConfigFile,JSON.stringify({entries:[{id:"mail",kind:"agentmail",account:"mail@example.test",agentId:id,apiKeyEnv:"EMBEDDING_TEST_MAIL_KEY"}]}));
  vi.stubEnv("EMBEDDING_TEST_MAIL_KEY","fixture");
  const router=createRouter({...config,channelConfigFile});cleanup.push(()=>router.close());
  const tick=vi.spyOn(router.service.channels,"tick").mockResolvedValue();
  return {router,tick,id};
}
it("embedded Router restores configured entries and owns polling until close",async()=>{
  vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
  const {router,tick,id}=await fixture();
  const start=vi.spyOn(router.service,"start").mockResolvedValue();
  expect(router.service.channels.entries(id)).toHaveLength(1);
  await Promise.all([router.start(),router.start()]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(start).toHaveBeenCalledOnce();expect(tick).toHaveBeenCalledTimes(2);
  await router.close();await vi.advanceTimersByTimeAsync(2000);
  expect(tick).toHaveBeenCalledTimes(2);await expect(router.start()).rejects.toThrow("router_closed");
});
it("closing during startup never starts a late polling loop",async()=>{
  vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
  const {router,tick}=await fixture();let release!:()=>void;
  vi.spyOn(router.service,"start").mockImplementation(()=>new Promise<void>(r=>{release=r}));
  const start=router.start(),close=router.close();release();await Promise.all([start,close]);
  await vi.advanceTimersByTimeAsync(2000);expect(tick).not.toHaveBeenCalled();
});
