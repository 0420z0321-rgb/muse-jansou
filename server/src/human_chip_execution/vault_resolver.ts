/** Internal-only owner-authenticated frozen version read; no public read-key privilege escalation. */
import {secret,workshopId,integer,HttpError,json,failure,type Receipt} from '../lab_c/contracts.js';
import {canonical,sha256,bodyJson} from '../lab_c/portable.js';
import {inspectProgram} from '../lab_c/admission.js';
import {validateProgram} from '../lab_c/vendor/chip_engine.js';
import type {StoragePort} from '../lab_c/vault.js';
import type {FrozenVersion} from './contracts.js';
export const INTERNAL_RESOLVE='/__human_execution/resolve';
function equal(a:string,b:string):boolean {let n=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)n|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return n===0;}
export async function resolveFrozenVersion(storage:StoragePort,id:string,version:number,ownerKey:unknown):Promise<FrozenVersion> {
 workshopId(id);integer(version,1,100,'version');const hash=await sha256(secret(ownerKey));
 const m=[...storage.sql.exec('SELECT workshop,owner_hash FROM hc_meta WHERE singleton=1')][0];
 if(!m || m.workshop!==id || !equal(hash,String(m.owner_hash)))throw new HttpError(403,'OWNER_REQUIRED','本人の所有者鍵が必要です');
 const row=[...storage.sql.exec('SELECT document,receipt FROM hc_versions WHERE version=?',version)][0];
 if(!row)throw new HttpError(404,'VERSION_NOT_FOUND','指定された版がありません');
 const receipt=JSON.parse(String(row.receipt)) as Receipt;
 const program:unknown=JSON.parse(String(row.document));inspectProgram(program);validateProgram(program);
 if(receipt.workshop_id!==id||receipt.version!==version||receipt.author!=='human'||receipt.status!=='stored_tested'||receipt.validation?.passed!==true || receipt.validation.suite!=='human-admission-3/v1')throw new HttpError(409,'NOT_APPROVED_HUMAN_VERSION','人作の検証済み凍結版だけ使用できます');
 if(await sha256(canonical(program))!==receipt.sha256)throw new HttpError(409,'HASH_MISMATCH','保存内容の一致確認に失敗しました');
 // Original receipt.execution stays not_connected: binding belongs to RoomDO, not the vault.
 return {program,receipt};
}
/** Call before existing HumanChipVault.fetch dispatch. Never expose this path via index.ts. */
export async function handleExecutionVaultRequest(r:Request,storage:StoragePort):Promise<Response|null> {
 if(new URL(r.url).pathname!==INTERNAL_RESOLVE)return null;
 try{
  if(r.method!=='POST')throw new HttpError(405,'METHOD','POST only');
  const b=await bodyJson(r);if(Object.keys(b).some(k=>!['workshop_id','version'].includes(k)))throw new HttpError(400,'FIELDS','Unsupported fields');
  return json(await resolveFrozenVersion(storage,String(b.workshop_id),Number(b.version),r.headers.get('X-Lab-Owner-Key')));
 }catch(e){return failure(e);}
}
export interface ExecutionVaultNamespace {idFromName(id:string):unknown;get(id:unknown):{fetch(r:Request):Promise<Response>};}
/** This is server-to-server binding access, not a public HTTP endpoint. */
export function vaultLoader(ns:ExecutionVaultNamespace):(id:string,v:number,key:string)=>Promise<FrozenVersion> {
 return async(id,v,key)=>{
  workshopId(id);integer(v,1,100,'version');secret(key);
  const r=await ns.get(ns.idFromName(id)).fetch(new Request('https://human-vault.internal'+INTERNAL_RESOLVE,{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Owner-Key':key},body:JSON.stringify({workshop_id:id,version:v})}));
  if(!r.ok)throw new HttpError(r.status,'VAULT_REFUSED','所有者鍵または指定版を確認してください');
  return await r.json() as FrozenVersion;
 };
}
