import {HttpError,LIMITS,workshopId,secret,type Receipt} from "./contracts.js";
import {canonical,sha256,randomHex} from "./portable.js";
import {verifyProgram} from "./admission.js";
export interface SqlPort {exec<T extends Record<string,unknown> = Record<string,unknown>>(query:string,...bindings:unknown[]):Iterable<T>;}
export interface StoragePort {sql:SqlPort;transactionSync<T>(closure:()=>T):T;}
type Row=Record<string,unknown>;
export class VaultService {
 constructor(private storage:StoragePort,private now:()=>number=()=>Date.now()){
  this.sql.exec("CREATE TABLE IF NOT EXISTS hc_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), workshop TEXT NOT NULL, owner_hash TEXT NOT NULL, read_hash TEXT NOT NULL, created_at TEXT NOT NULL)");
  this.sql.exec("CREATE TABLE IF NOT EXISTS hc_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, version INTEGER, payload_hash TEXT)");
  this.sql.exec("CREATE TABLE IF NOT EXISTS hc_versions (version INTEGER PRIMARY KEY, document TEXT NOT NULL, receipt TEXT NOT NULL)");
  this.sql.exec("CREATE TABLE IF NOT EXISTS hc_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
 }
 private get sql(){return this.storage.sql;}
 private one(q:string,...b:unknown[]):Row|undefined{return [...this.sql.exec(q,...b)][0];}
 private meta():Row{const r=this.one("SELECT * FROM hc_meta WHERE singleton=1");if(!r)throw new HttpError(404,"WORKSHOP_NOT_FOUND","工房がありません");return r;}
 rate(key:string,maximum:number,seconds:number):void{
  const now=this.now();this.storage.transactionSync(()=>{
   this.sql.exec("DELETE FROM hc_rate WHERE expires_at<=?",now);
   const r=this.one("SELECT n FROM hc_rate WHERE k=?",key);
   if(r&&Number(r.n)>=maximum)throw new HttpError(429,"RATE_LIMIT","操作回数が上限に達しました。時間をおいてください");
   if(r)this.sql.exec("UPDATE hc_rate SET n=n+1 WHERE k=?",key);
   else this.sql.exec("INSERT INTO hc_rate(k,n,expires_at) VALUES(?,1,?)",key,now+seconds*1000);
  });
 }
 async initialize(id:string):Promise<Record<string,unknown>>{
  workshopId(id);const owner=randomHex(),read=randomHex();const oh=await sha256(owner),rh=await sha256(read);const at=new Date(this.now()).toISOString();
  this.storage.transactionSync(()=>{if(this.one("SELECT singleton FROM hc_meta WHERE singleton=1"))throw new HttpError(409,"ALREADY_EXISTS","工房は作成済みです");this.sql.exec("INSERT INTO hc_meta VALUES(1,?,?,?,?)",id,oh,rh,at);});
  return {workshop_id:id,owner_key:owner,read_key:read,created_at:at,author:"human",execution:"not_connected"};
 }
 private async authorize(key:unknown,kind:"owner"|"read"):Promise<void>{const hash=await sha256(secret(key));const m=this.meta();if(hash!==m[kind==="owner"?"owner_hash":"read_hash"])throw new HttpError(403,"WRONG_KEY","この工房で使える鍵ではありません");}
 async issue(owner:unknown,master:boolean,ttl:number=LIMITS.defaultTTL):Promise<Record<string,unknown>>{
  if(!master)await this.authorize(owner,"owner");const m=this.meta();
  if(!Number.isInteger(ttl)||ttl<LIMITS.minTTL||ttl>LIMITS.maxTTL)throw new HttpError(400,"TTL","受付コードの期限は60〜3600秒です");
  this.rate("issue",20,3600);const token=randomHex(),hash=await sha256(token),now=this.now(),expiry=now+ttl*1000;
  this.storage.transactionSync(()=>{
   this.sql.exec("DELETE FROM hc_codes WHERE (used_at IS NULL AND expires_at<=?) OR (used_at IS NOT NULL AND used_at<?)",now,now-LIMITS.replaySeconds*1000);
   const n=Number(this.one("SELECT COUNT(*) AS n FROM hc_codes WHERE used_at IS NULL AND expires_at>?",now)?.n||0);
   if(n>=LIMITS.activeCodes)throw new HttpError(429,"ACTIVE_CODE_LIMIT","未使用コードは同時に5個までです");
   this.sql.exec("INSERT INTO hc_codes(code_hash,expires_at,failures) VALUES(?,?,0)",hash,expiry);
  });
  return {workshop_id:m.workshop,code:`HDC1.${m.workshop}.${token}`,expires_at:new Date(expiry).toISOString(),one_time:true};
 }
 private code(hash:string,payloadHash:string):{row:Row;replay?:Receipt}{
  const r=this.one("SELECT * FROM hc_codes WHERE code_hash=?",hash);if(!r)throw new HttpError(403,"UNKNOWN_CODE","受付コードを確認してください");
  if(r.used_at!==null){
   if(this.now()-Number(r.used_at)>LIMITS.replaySeconds*1000)throw new HttpError(410,"REPLAY_EXPIRED","再送確認期限が過ぎています。閲覧鍵で履歴を確認してください");
   if(r.payload_hash!==payloadHash)throw new HttpError(409,"CODE_ALREADY_USED","この受付コードは別の配置に使用済みです");
   const v=this.one("SELECT receipt FROM hc_versions WHERE version=?",r.version);if(!v)throw new Error("receipt missing");return {row:r,replay:JSON.parse(String(v.receipt)) as Receipt};
  }
  if(Number(r.expires_at)<=this.now())throw new HttpError(410,"CODE_EXPIRED","受付コードの期限が切れています");
  if(Number(r.failures)>=LIMITS.attempts)throw new HttpError(429,"CODE_ATTEMPTS","検証失敗が5回に達しました。新しい受付コードを発行してください");return {row:r};
 }
 async deposit(token:string,program:unknown):Promise<{receipt:Receipt;replayed:boolean}>{
  secret(token);const m=this.meta();const document=canonical(program),payloadHash=await sha256(document),codeHash=await sha256(token);
  const before=this.code(codeHash,payloadHash);if(before.replay)return {receipt:before.replay,replayed:true};
  this.rate("validate",60,3600);
  let validation;
  try{validation=verifyProgram(program);if(!validation.passed)throw new HttpError(422,"PROGRAM_REJECTED","3種類の局面で行動を返して停止できる配置が必要です",validation);}
  catch(error){this.sql.exec("UPDATE hc_codes SET failures=failures+1 WHERE code_hash=? AND used_at IS NULL",codeHash);throw error;}
  return this.storage.transactionSync(()=>{
   const current=this.code(codeHash,payloadHash);if(current.replay)return {receipt:current.replay,replayed:true};
   const next=Number(this.one("SELECT COALESCE(MAX(version),0)+1 AS n FROM hc_versions")?.n||1);
   if(next>LIMITS.versions)throw new HttpError(409,"VERSION_LIMIT","この工房の保存上限100版に達しました");
   const at=this.now();const receipt:Receipt={schema:"muse-human-deposit-receipt/v1",workshop_id:String(m.workshop),author:"human",version:next,stored_at:new Date(at).toISOString(),sha256:payloadHash,status:"stored_tested",execution:"not_connected",validation};
   this.sql.exec("INSERT INTO hc_versions(version,document,receipt) VALUES(?,?,?)",next,document,JSON.stringify(receipt));
   this.sql.exec("UPDATE hc_codes SET used_at=?,version=?,payload_hash=? WHERE code_hash=?",at,next,payloadHash,codeHash);
   return {receipt,replayed:false};
  });
 }
 async history(readKey:unknown,after=0,limit=20):Promise<Record<string,unknown>>{
  await this.authorize(readKey,"read");if(!Number.isInteger(after)||after<0||after>LIMITS.versions||!Number.isInteger(limit)||limit<1||limit>50)throw new HttpError(400,"PAGINATION","履歴のページ指定が不正です");
  const rows=[...this.sql.exec("SELECT receipt FROM hc_versions WHERE version>? ORDER BY version LIMIT ?",after,limit+1)];const more=rows.length>limit;const versions=rows.slice(0,limit).map(r=>JSON.parse(String(r.receipt)) as Receipt);
  return {workshop_id:this.meta().workshop,author:"human",execution:"not_connected",versions,next_after:more?versions.at(-1)!.version:null};
 }
 async version(readKey:unknown,v:number):Promise<Record<string,unknown>>{
  await this.authorize(readKey,"read");if(!Number.isInteger(v)||v<1||v>LIMITS.versions)throw new HttpError(400,"VERSION","版番号が不正です");const r=this.one("SELECT document,receipt FROM hc_versions WHERE version=?",v);if(!r)throw new HttpError(404,"VERSION_NOT_FOUND","指定された版がありません");return {program:JSON.parse(String(r.document)),receipt:JSON.parse(String(r.receipt))};
 }
}
