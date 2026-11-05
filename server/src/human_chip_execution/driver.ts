import {canonical,sha256} from '../lab_c/portable.js';
import {inspectProgram} from '../lab_c/admission.js';
import {validateProgram} from '../lab_c/vendor/chip_engine.js';
import {ExecutionStore} from './store.js';
import type {BindingHost} from './bindings.js';
import {matchesOccupant,provenance,type DecisionFrame,type LegalAction,type ExecutionEvent,type FrozenBinding,type DriveResult,type FailureCode,type Seat} from './contracts.js';
import {evaluateProgram,matchLegalAction} from './runner.js';
export interface PreparedAction {
 /** Writes cloned game and paipu to same RoomDO SQL transaction. Must not publish in-memory state yet. */
 persist():void;
 /** Only after transaction succeeds: update in-memory game and notify existing clients. */
 publish():void;
}
export interface ExecutionHost extends BindingHost {
 /** Server-owned decision, scoped snapshot, complete legal actions, own clock deadline. */
 frame(seat:Seat):DecisionFrame|null;
 /** Pure validation on a cloned game. Must return null for rejected actions, never mutate live game. */
 prepareAction(frame:DecisionFrame,action:LegalAction,event:ExecutionEvent):PreparedAction|null;
}
export function attemptKey(frame:DecisionFrame,b:FrozenBinding):string {
 return JSON.stringify([frame.room_id,frame.match_id,frame.seat,b.participant_id,b.occupant_epoch,b.generation,frame.decision_id]);
}
function sameFrame(a:DecisionFrame,b:DecisionFrame):boolean {
 return a.room_id===b.room_id&&a.match_id===b.match_id&&a.decision_id===b.decision_id&&a.revision===b.revision&&a.seat===b.seat&&a.participant_id===b.participant_id&&a.occupant_epoch===b.occupant_epoch;
}
function applies(frame:DecisionFrame,b:FrozenBinding):boolean {return frame.seat===b.seat&&frame.participant_id===b.participant_id&&frame.occupant_epoch===b.occupant_epoch;}
/** One attempt per decision/binding. Never loops an entire match in one request/alarm. */
export class HumanChipDriver {
 constructor(private store:ExecutionStore,private host:ExecutionHost,private now:()=>number=()=>Date.now()){}
 private event(f:DecisionFrame,b:FrozenBinding,type:ExecutionEvent['type']):ExecutionEvent {
  return {type,at:new Date(this.now()).toISOString(),room_id:f.room_id,match_id:f.match_id,seat:f.seat,decision_id:f.decision_id,provenance:provenance(b)};
 }
 async driveOne(seat:Seat):Promise<DriveResult>{
  try{return await this.driveChecked(seat);}catch{return {outcome:'failed',reason:'storage_or_host_failure',seat};}
 }
 private async driveChecked(seat:Seat):Promise<DriveResult>{
  const access=this.host.access();if(!access.allow_human_players)return {outcome:'skipped',reason:'not_human_table'};
  const b=this.store.binding(seat),frame=this.host.frame(seat);
  if(!b||!matchesOccupant(access,b)||!frame||frame.room_id!==access.room_id||frame.match_id!==access.match_id||!applies(frame,b))return {outcome:'skipped',reason:'no_bound_human_decision'};
  const key=attemptKey(frame,b);
  if(!this.store.transaction(()=>{if(!this.store.claim(key,frame.match_id))return false;const e={...this.event(frame,b,'human_chip_attempt'),outcome:'claimed' as const};this.store.record(e);this.host.recordPaipu(e);return true;}))return {outcome:'skipped',reason:'already_attempted',seat};
  const fail=(code:FailureCode,steps=0):DriveResult=>{
   this.store.transaction(()=>{const event={...this.event(frame,b,'human_chip_failed'),outcome:code,steps};this.store.finish(key,code,steps);this.store.record(event);this.host.recordPaipu(event);});
   return {outcome:'failed',reason:code,seat};
  };
  let steps=0;
  try{
   const program:unknown=JSON.parse(b.document);inspectProgram(program);validateProgram(program);
   if(await sha256(canonical(program))!==b.sha256)return fail('binding_corrupt');
   // Digest yielded: manual actions, leave, timeout, unbind or rebind may already have won.
   const latest=this.host.frame(seat),current=this.store.binding(seat);
   if(!current||current.generation!==b.generation||!matchesOccupant(this.host.access(),current)||!latest||!sameFrame(frame,latest))return fail('stale_position');
   const r=evaluateProgram(program,latest,this.now);steps=r.steps;
   if(!r.ok||!r.action)return fail(r.code??'no_proposal',steps);
   let prepared:PreparedAction|null=null;
   const result=this.store.transaction(()=>{
    const live=this.host.frame(seat),binding=this.store.binding(seat);
    if(!binding||binding.generation!==b.generation||!matchesOccupant(this.host.access(),binding)||!live||!sameFrame(frame,live))return 'stale_position' as const;
    if(live.deadline_ms!==null&&this.now()>=live.deadline_ms)return 'deadline_expired' as const;
    const legal=matchLegalAction(r.action,live.legal_actions,seat);if(!legal)return 'illegal_proposal' as const;
    const event={...this.event(live,b,'human_chip_applied'),outcome:'applied' as const,steps};
    prepared=this.host.prepareAction(live,legal,event);if(!prepared)return 'apply_rejected' as const;
    prepared.persist();this.store.finish(key,'applied',steps);this.store.record(event);
    return 'applied' as const;
   });
   if(result!=='applied')return fail(result,steps);
   // Durable commit already succeeded. Publication failure must NOT trigger replay/fallback.
   try{(prepared as PreparedAction|null)?.publish();}catch{return {outcome:'applied',reason:'durable_commit_reload_required',seat};}
   return {outcome:'applied',reason:'applied',seat};
  }catch{return fail('internal_error',steps);}
 }
 /** Call after settleExpired and after each existing committed action. One scheduled step, not a spin loop. */
 nextSeat():Seat|null {
  const a=this.host.access();if(!a.allow_human_players)return null;
  for(const s of [0,1,2,3] as const){const b=this.store.binding(s),f=this.host.frame(s);
   if(b&&matchesOccupant(a,b)&&f&&f.room_id===a.room_id&&f.match_id===a.match_id&&applies(f,b)&&(f.deadline_ms===null||this.now()<f.deadline_ms)&&!this.store.hasAttempt(attemptKey(f,b)))return s;
  }return null;
 }
}
/** DO has one alarm: merge with the EXISTING deadline, never delete/postpone the old clock. */
export function mergeAlarm(existingDeadline:number|null,chipWakeup:number|null):number|null {
 const xs=[existingDeadline,chipWakeup].filter((v):v is number=>v!==null&&Number.isFinite(v));return xs.length?Math.min(...xs):null;
}
