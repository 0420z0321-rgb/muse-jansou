import {API_BASE,HttpError,json,failure,keys,human,workshopId,ticketParts,integer,LIMITS} from "./contracts.js";
import {bodyJson,randomHex,sha256} from "./portable.js";
export interface VaultNamespace {idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>};}
export interface LabCOptions {namespace:VaultNamespace;verifyMaster:(request:Request)=>Promise<boolean>|boolean;verifyWatch:(request:Request)=>Promise<boolean>|boolean;allowedOrigins?:readonly string[];}
function internal(options:LabCOptions,name:string,path:string,body?:unknown,readKey?:string):Promise<Response>{const headers=new Headers({"Content-Type":"application/json"});if(readKey)headers.set("X-Lab-Read-Key",readKey);return options.namespace.get(options.namespace.idFromName(name)).fetch(new Request("https://human-vault.internal"+path,{method:body===undefined?"GET":"POST",headers,...(body===undefined?{}:{body:JSON.stringify(body)})}));}
async function requireOK(response:Response):Promise<void>{if(!response.ok){const detail=await response.json() as {message?:string;error?:string};throw new HttpError(response.status,detail.error||"RATE_LIMIT",detail.message||"受付を続行できません");}}
export async function handleHumanLabRequest(request:Request,options:LabCOptions):Promise<Response|null>{
 const u=new URL(request.url);if(u.pathname!==API_BASE&&!u.pathname.startsWith(API_BASE+"/"))return null;
 const origin=request.headers.get("Origin");let allow:string|undefined;
 const add=(res:Response):Response=>{const h=new Headers(res.headers);h.set("Cache-Control","no-store");h.set("X-Content-Type-Options","nosniff");h.set("Referrer-Policy","no-referrer");if(allow){h.set("Access-Control-Allow-Origin",allow);h.set("Vary","Origin");}return new Response(res.body,{status:res.status,headers:h});};
 try{
  if(origin){if(origin==="null"||(origin!==u.origin&&!options.allowedOrigins?.includes(origin)))throw new HttpError(403,"ORIGIN","この出自からの受付は許可されていません");allow=origin;}
  for(const k of u.searchParams.keys())if(/(?:key|token|secret|password|code)/i.test(k))throw new HttpError(400,"SECRET_IN_URL","鍵やコードをURLに入れないでください");
  if(request.method==="OPTIONS")return add(new Response(null,{status:204,headers:{"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, X-Lab-Client, X-Watch-Password, X-Lab-Owner-Key, X-Lab-Read-Key, Authorization","Access-Control-Max-Age":"600"}}));
  if(!["GET","POST"].includes(request.method))throw new HttpError(405,"METHOD","GETまたはPOSTを使用してください");
  if(request.method==="POST"&&request.headers.get("X-Lab-Client")!=="human-workshop-v1")throw new HttpError(403,"CLIENT_HEADER","人の工房の受付から送信してください");
  const ipHash=await sha256(request.headers.get("CF-Connecting-IP")||"no-cf-ip-available");
  await requireOK(await internal(options,"lab-c:admission","/admission",{key:"request:"+ipHash,maximum:180,seconds:60}));
  const path=u.pathname.slice(API_BASE.length);
  if(request.method==="POST"&&path==="/workshops"){
   const b=await bodyJson(request);keys(b,["author","human_attestation"]);human(b);
   const master=await options.verifyMaster(request);if(!master&&!await options.verifyWatch(request))throw new HttpError(401,"WATCH_REQUIRED","既存の合言葉または主催資格で認証してください");
   await requireOK(await internal(options,"lab-c:admission","/admission",{key:(master?"master-create:":"self-create:")+ipHash,maximum:master?100:10,seconds:86400}));
   const id="hw_"+randomHex(16);return add(await internal(options,id,"/initialize",{workshop_id:id}));
  }
  const issue=/^\/(hw_[0-9a-f]{32})\/codes$/.exec(path);
  if(request.method==="POST"&&issue){
   const b=await bodyJson(request);keys(b,["author","human_attestation","ttl_seconds"]);human(b);
   const master=await options.verifyMaster(request);if(!master&&!await options.verifyWatch(request))throw new HttpError(401,"WATCH_REQUIRED","既存の合言葉で認証してください");
   const ttl=b.ttl_seconds===undefined?LIMITS.defaultTTL:integer(b.ttl_seconds,60,3600,"ttl_seconds");
   return add(await internal(options,workshopId(issue[1]),"/issue",{owner_key:request.headers.get("X-Lab-Owner-Key"),master,ttl_seconds:ttl}));
  }
  if(request.method==="POST"&&path==="/deposits"){
   const b=await bodyJson(request);keys(b,["code","program","payload_code","author","human_attestation"]);human(b);const ticket=ticketParts(b.code);
   return add(await internal(options,ticket.workshop,"/deposit",{token:ticket.token,author:"human",human_attestation:true,...(b.program===undefined?{}:{program:b.program}),...(b.payload_code===undefined?{}:{payload_code:b.payload_code})}));
  }
  const read=/^\/(hw_[0-9a-f]{32})\/versions(?:\/(\d+))?$/.exec(path);
  if(request.method==="GET"&&read){
   const allowed=read[2]?[]:["after","limit"];for(const k of u.searchParams.keys())if(!allowed.includes(k))throw new HttpError(400,"QUERY","未対応の検索条件です");
   const key=request.headers.get("X-Lab-Read-Key")||"";
   const target=read[2]?"/version?version="+integer(Number(read[2]),1,100,"version"):"/versions?after="+integer(Number(u.searchParams.get("after")||0),0,100,"after")+"&limit="+integer(Number(u.searchParams.get("limit")||20),1,50,"limit");
   return add(await internal(options,read[1],target,undefined,key));
  }
  throw new HttpError(404,"NOT_FOUND","人の工房の受付口がありません");
 }catch(e){return add(failure(e));}
}
