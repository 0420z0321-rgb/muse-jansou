import {HttpError,LIMITS,object} from "./contracts.js";
const encoder=new TextEncoder();
export function canonical(value:unknown):string{
 let count=0;
 function visit(v:unknown,depth:number):string{
  if(++count>200000||depth>LIMITS.depth)throw new HttpError(413,"JSON_COMPLEXITY","JSONの深さまたは要素数が上限を超えています");
  if(v===null)return "null";
  if(typeof v==="string"||typeof v==="boolean")return JSON.stringify(v);
  if(typeof v==="number"){if(!Number.isFinite(v))throw new HttpError(400,"FINITE_NUMBER","有限の数値だけ使用できます");return JSON.stringify(v);}
  if(Array.isArray(v))return "["+v.map(x=>visit(x,depth+1)).join(",")+"]";
  if(typeof v==="object"){
   const o=object(v);const names=Object.keys(o).sort();
   for(const k of names)if(["__proto__","constructor","prototype"].includes(k))throw new HttpError(400,"UNSAFE_PROPERTY","使用できないプロパティ名です");
   return "{"+names.map(k=>JSON.stringify(k)+":"+visit(o[k],depth+1)).join(",")+"}";
  }
  throw new HttpError(400,"JSON_VALUE","JSONで表現できない値です");
 }
 const text=visit(value,0);if(encoder.encode(text).length>LIMITS.programBytes)throw new HttpError(413,"PROGRAM_BYTES","配置JSONは1MiB以内です");return text;
}
export async function sha256(text:string):Promise<string>{const h=await crypto.subtle.digest("SHA-256",encoder.encode(text));return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,"0")).join("");}
export function randomHex(bytes=32):string{const b=new Uint8Array(bytes);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}
export function parseJson(text:string,limit:number=LIMITS.programBytes):unknown{
 if(encoder.encode(text).length>limit)throw new HttpError(413,"JSON_BYTES","JSONのサイズ上限を超えています");
 let depth=0,inString=false,escape=false;
 for(const c of text){if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;}else if(c==='"')inString=true;else if(c==='{'||c==='['){if(++depth>LIMITS.depth)throw new HttpError(413,"JSON_DEPTH","JSONが深すぎます");}else if(c==='}'||c===']')depth--;}
 try{return JSON.parse(text,(k,v)=>{if(["__proto__","constructor","prototype"].includes(k))throw new Error("unsafe");return v;});}catch{throw new HttpError(400,"INVALID_JSON","JSONを読み取れません");}
}
const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function encodeProgramCode(program:unknown):string{
 const bytes=encoder.encode(canonical(program));let out="",bits=0,buffer=0;
 for(const b of bytes){buffer=(buffer<<8)|b;bits+=8;while(bits>=6){bits-=6;out+=alphabet[(buffer>>>bits)&63];}}
 if(bits)out+=alphabet[(buffer<<(6-bits))&63];return "MHC1."+out;
}
export function decodeProgramCode(code:unknown):unknown{
 if(typeof code!=="string"||code.length>1_400_000||!/^MHC1\.[A-Za-z0-9_-]+$/.test(code))throw new HttpError(400,"PAYLOAD_CODE","預け用コードの形式が不正です");
 const s=code.slice(5);if(s.length%4===1)throw new HttpError(400,"PAYLOAD_CODE","預け用コードの長さが不正です");
 let bits=0,buffer=0;const a:number[]=[];
 for(const c of s){buffer=(buffer<<6)|alphabet.indexOf(c);bits+=6;if(bits>=8){bits-=8;a.push((buffer>>>bits)&255);}}
 if(bits&&(buffer&((1<<bits)-1)))throw new HttpError(400,"PAYLOAD_CODE","預け用コードの末尾が不正です");
 let text:string;try{text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(new Uint8Array(a));}catch{throw new HttpError(400,"PAYLOAD_UTF8","UTF-8ではありません");}
 const value=parseJson(text);if(encodeProgramCode(value)!==code)throw new HttpError(400,"PAYLOAD_CANONICAL","正規形式の預け用コードを使用してください");return value;
}
export async function bodyJson(request:Request):Promise<Record<string,unknown>>{
 if(!/^application\/json(?:;|$)/i.test(request.headers.get("Content-Type")||""))throw new HttpError(415,"CONTENT_TYPE","application/jsonが必要です");
 if(Number(request.headers.get("Content-Length")||0)>LIMITS.bodyBytes)throw new HttpError(413,"BODY_SIZE","リクエストが大きすぎます");
 const stream=request.body;if(!stream)throw new HttpError(400,"BODY_REQUIRED","本文がありません");const reader=stream.getReader();const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const v=await reader.read();if(v.done)break;length+=v.value.length;if(length>LIMITS.bodyBytes){await reader.cancel();throw new HttpError(413,"BODY_SIZE","リクエストが大きすぎます");}chunks.push(v.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let text:string;try{text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes);}catch{throw new HttpError(400,"UTF8_REQUIRED","UTF-8 JSONが必要です");}
 return object(parseJson(text,LIMITS.bodyBytes));
}
