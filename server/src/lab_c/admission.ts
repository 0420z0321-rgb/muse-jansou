import * as Engine from "./vendor/chip_engine.js";
import {HttpError,LIMITS,object,integer,type ValidationReport,type TrialResult} from "./contracts.js";
import {canonical} from "./portable.js";
import {ADMISSION_FIXTURES} from "./fixtures.js";
export function inspectProgram(value:unknown):Record<string,unknown>{
 const p=object(value);canonical(p);
 if(p.schema!=="muse-mahjong-chips/v1")throw new HttpError(422,"SCHEMA","muse-mahjong-chips/v1だけ受け付けます");
 if(!Array.isArray(p.nodes)||p.nodes.length<1||p.nodes.length>LIMITS.nodes)throw new HttpError(422,"NODE_LIMIT","ノードは1〜8000です");
 if(!Array.isArray(p.counters)||p.counters.length>LIMITS.counters)throw new HttpError(422,"COUNTER_LIMIT","カウンタは512個までです");
 if(p.limits!==undefined){const l=object(p.limits);if(l.maxSteps!==undefined)integer(l.maxSteps,1,LIMITS.steps,"maxSteps");if(l.maxCallDepth!==undefined)integer(l.maxCallDepth,1,64,"maxCallDepth");}
 return p;
}
/** The original engine is used unchanged. Clearing diagnostic traces bounds admission memory. */
export function verifyProgram(value:unknown):ValidationReport{
 const p=inspectProgram(value);const trials:TrialResult[]=[];
 for(const fixture of ADMISSION_FIXTURES){
  let steps=0,status="error",action:string|null=null,reason="",passed=false;
  try{
   const machine=Engine.newMachine(JSON.parse(JSON.stringify(p)) as Parameters<typeof Engine.newMachine>[0],JSON.parse(JSON.stringify(fixture.snapshot)) as Parameters<typeof Engine.newMachine>[1]);
   while(["ready","running"].includes(String(machine.status))&&steps<LIMITS.steps){Engine.stepMachine(machine);steps++;if(Array.isArray(machine.trace))machine.trace.length=0;}
   status=String(machine.status);const a=machine.action as unknown as Record<string,unknown>|undefined;
   action=a&&typeof a.action==="string"?a.action:null;
   if(status!=="action"||!a)reason="行動を返して正常停止する必要があります（ENDだけ・診断停止・歩数上限は不可）";
   else if(a.seat!==0)reason="観測者と異なる席の行動は受理しません";
   else if(!action||!fixture.actions.includes(action))reason="この試験局面で許可されていない行動種別です";
   else if(action==="discard"&&(!Number.isInteger(a.tile)||!((fixture.snapshot.hands as (number[]|null)[])[0]||[]).includes(a.tile as number)))reason="打牌が自分の手牌に存在しません";
   else if(a.riichi===true)reason="今回の試験局面でリーチは許可されません";
   else{passed=true;reason="試験局面の行動条件を満たしました";}
  }catch{reason="エンジンによる配置・実行検証に失敗しました";}
  trials.push({id:fixture.id,passed,steps,status,action,reason});
 }
 return {suite:"human-admission-3/v1",scope:"three-fixtures-only",passed:trials.every(x=>x.passed),trials};
}
