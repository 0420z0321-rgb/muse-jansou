import {newMachine,stepMachine,sanitizeSnapshot,type ProgramV1,type MuseSnapshot} from '../lab_c/vendor/chip_engine.js';
import {fromMuseState,type MuseStateLike} from '../lab_c/vendor/muse_adapter.js';
import type {DecisionFrame,Evaluation,LegalAction,Seat} from './contracts.js';
/** Rebuild the same observer-scoped schema used by Phase C. No spread of raw server state. */
export function observerSnapshot(raw:MuseStateLike,seat:Seat):MuseSnapshot {
 return sanitizeSnapshot(fromMuseState({hands:raw.hands,discards:raw.discards,melds:raw.melds,scores:raw.scores,riichi:raw.riichi,dora_indicators:raw.dora_indicators,dealer:raw.dealer,honba:raw.honba,kyotaku:raw.kyotaku,riichi_sticks:raw.riichi_sticks,turn:raw.turn,turn_count:raw.turn_count,round_wind:raw.round_wind,phase:raw.phase,last_drawn:raw.last_drawn},seat));
}
function actionKey(value:unknown):string|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const a=value as Record<string,unknown>;
 if(Object.keys(a).some(k=>!['action','seat','tile','consume','riichi'].includes(k)))return null;
 if(!Number.isInteger(a.seat)||Number(a.seat)<0||Number(a.seat)>3||typeof a.action!=='string')return null;
 if(a.tile!==undefined&&(!Number.isInteger(a.tile)||Number(a.tile)<0||Number(a.tile)>36))return null;
 if(a.riichi!==undefined&&typeof a.riichi!=='boolean')return null;
 if(a.consume!==undefined&&(!Array.isArray(a.consume)||a.consume.length>4||a.consume.some(t=>!Number.isInteger(t)||t<0||t>36)))return null;
 return JSON.stringify([a.action,a.seat,a.tile??null,a.riichi===true,a.consume??null]);
}
/** Never fills in a missing tile/consume and never substitutes another legal action. */
export function matchLegalAction(proposal:unknown,legal:readonly LegalAction[],seat:Seat):LegalAction|null {
 const key=actionKey(proposal);if(key===null||!proposal||(proposal as LegalAction).seat!==seat)return null;
 const found=legal.find(a=>a.seat===seat&&actionKey(a)===key);
 return found?JSON.parse(JSON.stringify(found)) as LegalAction:null;
}
export function evaluateProgram(program:ProgramV1,frame:DecisionFrame,now:()=>number=()=>Date.now()):Evaluation {
 let steps=0,status='error';
 try{
  if(frame.snapshot.observer_seat!==frame.seat)return {ok:false,code:'invalid_snapshot',steps,engine_status:status};
  const snapshot=sanitizeSnapshot(frame.snapshot);const m=newMachine(program,snapshot);
  // Keep engine defaults including maxSteps (default 500, hard cap 2048), 32 complex ops,
  // call depth and structural-search caps. No custom interpreter or expanded budget.
  while(m.status==='ready'||m.status==='running'){
   if(frame.deadline_ms!==null&&now()>=frame.deadline_ms)return {ok:false,code:'deadline_expired',steps:m.steps,engine_status:String(m.status)};
   stepMachine(m);steps=m.steps;m.trace.length=0; // Do not persist private per-step counters.
  }
  status=String(m.status);
  if(status==='step_limit')return {ok:false,code:'step_limit',steps,engine_status:status};
  if(status==='error')return {ok:false,code:'engine_error',steps,engine_status:status};
  if(status!=='action'||m.action===null)return {ok:false,code:'no_proposal',steps,engine_status:status};
  const action=matchLegalAction(m.action,frame.legal_actions,frame.seat);
  return action?{ok:true,action,steps,engine_status:status}:{ok:false,code:'illegal_proposal',steps,engine_status:status};
 }catch{return {ok:false,code:'engine_error',steps,engine_status:status};}
}
