/** Human workshop boundary. Never imports room/game/player code. */
export const API_BASE = "/lab/api/human";
export const LIMITS = Object.freeze({ nodes:8000, counters:512, steps:2048, programBytes:1_048_576, bodyBytes:1_500_000, depth:32, versions:100, activeCodes:5, attempts:5, defaultTTL:900, minTTL:60, maxTTL:3600, replaySeconds:86400 });
export interface TrialResult { id:string; passed:boolean; steps:number; status:string; action:string|null; reason:string; }
export interface ValidationReport { suite:"human-admission-3/v1"; scope:"three-fixtures-only"; passed:boolean; trials:TrialResult[]; }
export interface Receipt { schema:"muse-human-deposit-receipt/v1"; workshop_id:string; author:"human"; version:number; stored_at:string; sha256:string; status:"stored_tested"; execution:"not_connected"; validation:ValidationReport; }
export class HttpError extends Error { constructor(public status:number, public code:string, message:string, public detail?:unknown){super(message);} }
export function object(x:unknown):Record<string,unknown>{if(!x||typeof x!=="object"||Array.isArray(x))throw new HttpError(400,"OBJECT_REQUIRED","JSONオブジェクトが必要です");return x as Record<string,unknown>;}
export function keys(x:Record<string,unknown>,allowed:readonly string[]):void{for(const k of Object.keys(x))if(!allowed.includes(k))throw new HttpError(400,"UNKNOWN_FIELD",`未対応フィールド: ${k}`);}
export function human(x:Record<string,unknown>):void{if(x.author!=="human"||x.human_attestation!==true)throw new HttpError(400,"HUMAN_ONLY","人作チップであることの明示的な確認が必要です");}
export function integer(x:unknown,min:number,max:number,name:string):number{if(!Number.isSafeInteger(x)||(x as number)<min||(x as number)>max)throw new HttpError(400,"INVALID_INTEGER",`${name}は${min}〜${max}の整数です`);return x as number;}
export function workshopId(x:unknown):string{if(typeof x!=="string"||!/^hw_[0-9a-f]{32}$/.test(x))throw new HttpError(400,"WORKSHOP_ID","工房IDが不正です");return x;}
export function secret(x:unknown):string{if(typeof x!=="string"||! /^[0-9a-f]{64}$/.test(x))throw new HttpError(403,"CAPABILITY_REQUIRED","この操作に必要な鍵がありません");return x;}
export function ticketParts(x:unknown):{workshop:string,token:string}{if(typeof x!=="string")throw new HttpError(400,"TICKET_FORMAT","受付コードが不正です");const m=/^HDC1\.(hw_[0-9a-f]{32})\.([0-9a-f]{64})$/.exec(x);if(!m)throw new HttpError(400,"TICKET_FORMAT","受付コードが不正です");return {workshop:m[1],token:m[2]};}
export function json(x:unknown,status=200):Response{return new Response(JSON.stringify(x),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}});}
export function failure(e:unknown):Response{return e instanceof HttpError?json({error:e.code,message:e.message,...(e.detail===undefined?{}:{detail:e.detail})},e.status):json({error:"INTERNAL_ERROR",message:"受付処理を完了できませんでした。秘密を含む診断内容は返しません。"},500);}

export const allowedKeys=keys;
