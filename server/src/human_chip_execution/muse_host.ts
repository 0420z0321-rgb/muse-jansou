/** Adapter to existing Game/RoomDO. Rules, auth, clocks and live publication remain host-owned. */
import type {MuseStateLike} from '../lab_c/vendor/muse_adapter.js';
import {observerSnapshot} from './runner.js';
import {clone,type RoomAccess,type DecisionFrame,type LegalAction,type ExecutionEvent,type Seat} from './contracts.js';
import type {ExecutionHost,PreparedAction} from './driver.js';
export interface GameFields extends MuseStateLike {
 revision:number;decision_id:string|null;phase:string;match_status?:string;
 dec_deadlines?:Record<number,{deadline:number}>;
}
export interface MuseHostPorts<G extends GameFields> {
 access():RoomAccess;
 game():G;
 /** Only the current trusted server decision's exact legal actions, no client input. */
 legalActions(game:G,seat:Seat):LegalAction[];
 /** Derive PUBLIC dora indicators; never copy dead_wall/wall into a chip snapshot. */
 doraIndicators(game:G):number[];
 /** On a CLONE: invoke existing applyAction + clocks/rule validation. No live mutation. */
 applyOnClone(game:G,action:LegalAction,decision:{decision_id:string;expected_revision:number}):{ok:true}|{error:string};
 /** Both methods below write through the SAME storage transaction used by ExecutionStore. */
 persistGameAndPaipu(game:G,event:ExecutionEvent):void;
 recordPaipu(event:ExecutionEvent):void;
 publishGame(game:G):void;
 /** Honor existing participant/lease/manual-control policy; never steal an existing claim. */
 canDrive(seat:Seat):boolean;
}
export function createMuseExecutionHost<G extends GameFields>(p:MuseHostPorts<G>):ExecutionHost {
 return {
  access:p.access,recordPaipu:p.recordPaipu,
  frame(seat){
   const a=p.access(),person=a.occupants[seat],g=p.game();
   if(!a.allow_human_players||person?.kind!=='human'||!p.canDrive(seat)||g.match_status==='finished'||g.phase==='finished'||!g.decision_id)return null;
   const legal=p.legalActions(g,seat);if(!legal.length)return null;
   return {room_id:a.room_id,match_id:a.match_id,seat,participant_id:person.participant_id,occupant_epoch:person.occupant_epoch,decision_id:g.decision_id,revision:g.revision,
    deadline_ms:g.dec_deadlines?.[seat]?.deadline??null,snapshot:observerSnapshot({...g,dora_indicators:p.doraIndicators(g)},seat),legal_actions:clone(legal)};
  },
  prepareAction(f,action,event):PreparedAction|null{
   const g=p.game();const a=p.access(),person=a.occupants[f.seat];
   if(!a.allow_human_players||!p.canDrive(f.seat)||a.room_id!==f.room_id||a.match_id!==f.match_id||g.revision!==f.revision||g.decision_id!==f.decision_id||person?.kind!=='human'||person.participant_id!==f.participant_id||person.occupant_epoch!==f.occupant_epoch)return null;
   const next=clone(g);const result=p.applyOnClone(next,clone(action),{decision_id:f.decision_id,expected_revision:f.revision});
   if(!('ok' in result)||result.ok!==true)return null;
   return {persist:()=>p.persistGameAndPaipu(next,event),publish:()=>p.publishGame(next)};
  }
 };
}
