import {VaultService} from "./vault.js";
import {bodyJson,decodeProgramCode} from "./portable.js";
import {HttpError,json,failure,keys,human,integer,LIMITS} from "./contracts.js";
/** INTERNAL binding protocol: no route below is directly delegated from a public request. */
export async function handleVaultRequest(request:Request,vault:VaultService):Promise<Response>{try{
 const u=new URL(request.url);if(request.method==="POST"){
  const b=await bodyJson(request);
  if(u.pathname==="/initialize"){keys(b,["workshop_id"]);return json(await vault.initialize(String(b.workshop_id)),201);}
  if(u.pathname==="/admission"){keys(b,["key","maximum","seconds"]);if(typeof b.key!=="string"||b.key.length>160)throw new HttpError(400,"RATE_KEY","内部制限キーが不正です");vault.rate(b.key,integer(b.maximum,1,1000,"maximum"),integer(b.seconds,1,86400,"seconds"));return json({ok:true});}
  if(u.pathname==="/issue"){keys(b,["owner_key","master","ttl_seconds"]);return json(await vault.issue(b.owner_key,b.master===true,b.ttl_seconds===undefined?LIMITS.defaultTTL:integer(b.ttl_seconds,60,3600,"ttl_seconds")),201);}
  if(u.pathname==="/deposit"){keys(b,["token","program","payload_code","author","human_attestation"]);human(b);if((b.program===undefined)===(b.payload_code===undefined))throw new HttpError(400,"ONE_PAYLOAD","配置JSONまたは預け用コードのどちらか一方を指定してください");const value=b.program===undefined?decodeProgramCode(b.payload_code):b.program;const result=await vault.deposit(String(b.token),value);return json(result,result.replayed?200:201);}
 }else if(request.method==="GET"){
  const k=request.headers.get("X-Lab-Read-Key");if(u.pathname==="/versions")return json(await vault.history(k,Number(u.searchParams.get("after")||0),Number(u.searchParams.get("limit")||20)));
  if(u.pathname==="/version")return json(await vault.version(k,Number(u.searchParams.get("version"))));
 }
 throw new HttpError(404,"NOT_FOUND","内部受付口がありません");
}catch(e){return failure(e);}}
