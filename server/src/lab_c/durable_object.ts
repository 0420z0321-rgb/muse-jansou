import {DurableObject} from "cloudflare:workers";
import {VaultService,type StoragePort} from "./vault.js";
import {handleVaultRequest} from "./vault_http.js";
import {INTERNAL_RESOLVE,handleExecutionVaultRequest} from "../human_chip_execution/vault_resolver.js";
/** New namespace only. Do not rename or migrate RoomDO. */
export class HumanChipVault extends DurableObject {
 private readonly vault:VaultService;
 private readonly executionStorage:StoragePort;
 constructor(ctx:DurableObjectState,env:unknown){super(ctx,env as never);this.executionStorage=ctx.storage as unknown as StoragePort;this.vault=new VaultService(this.executionStorage);}
 async fetch(request:Request):Promise<Response>{
  // Execution-connection internal path: reachable ONLY through the DO
  // binding (RoomDO server-to-server), never forwarded by index.ts routes.
  if(new URL(request.url).pathname===INTERNAL_RESOLVE){
   const r=await handleExecutionVaultRequest(request,this.executionStorage);
   if(r!==null)return r;
  }
  return handleVaultRequest(request,this.vault);
 }
}
