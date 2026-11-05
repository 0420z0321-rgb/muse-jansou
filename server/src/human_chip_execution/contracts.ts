/** Additive human-seat execution boundary. No browser state, credentials, or room globals. */
import type {ProgramV1, MuseSnapshot} from '../lab_c/vendor/chip_engine.js';
import type {Receipt} from '../lab_c/contracts.js';
export type Seat = 0|1|2|3;
export interface Principal { participant_id:string; seat:Seat; occupant_epoch:string; kind:'human'|'muse'; }
export interface RoomAccess { room_id:string; match_id:string; allow_human_players:boolean; occupants:(Principal|null)[]; }
export interface FrozenVersion { program:ProgramV1; receipt:Receipt; }
export interface FrozenBinding {
 schema:'muse-human-chip-binding/v1'; author:'human'; seat:Seat; participant_id:string;
 occupant_epoch:string; generation:number; workshop_id:string; version:number;
 sha256:string; bound_at:string; document:string;
}
export interface Provenance { driver:'human_chip'; author:'human'; workshop_id:string; version:number; sha256:string; generation:number; }
/** Concrete, server-approved action; optional fields are semantic, never silently invented. */
export interface LegalAction { action:string; seat:Seat; tile?:number; riichi?:boolean; consume?:number[]; }
export interface DecisionFrame {
 room_id:string; match_id:string; decision_id:string; revision:number; seat:Seat;
 participant_id:string; occupant_epoch:string; deadline_ms:number|null;
 snapshot:MuseSnapshot; legal_actions:LegalAction[];
}
export type FailureCode='engine_error'|'step_limit'|'no_proposal'|'illegal_proposal'|'invalid_snapshot'|
 'binding_corrupt'|'stale_position'|'deadline_expired'|'apply_rejected'|'internal_error';
export interface ExecutionEvent {
 type:'human_chip_bound'|'human_chip_unbound'|'human_chip_applied'|'human_chip_failed'|'human_chip_attempt';
 at:string; room_id:string; match_id:string; seat:Seat; provenance:Provenance|null;
 decision_id?:string; outcome?:FailureCode|'applied'|'claimed'; steps?:number;
 // No raw errors, counter values, hands, owner keys, reader keys or credentials.
}
export interface Evaluation { ok:boolean; code?:FailureCode; action?:LegalAction; steps:number; engine_status:string; }
export interface DriveResult { outcome:'applied'|'failed'|'skipped'; reason:string; seat?:Seat; }
export interface BindingView extends Provenance { seat:Seat; state:'bound'; bound_at:string; }
export class ExecutionError extends Error {constructor(public code:string, public status=400){super(code);}}
export function seatNumber(value:unknown):Seat {
 if(!Number.isInteger(value)||Number(value)<0||Number(value)>3)throw new ExecutionError('INVALID_SEAT');
 return value as Seat;
}
export function eligible(access:RoomAccess,principal:Principal):boolean {
 const p=access.occupants[principal.seat];
 return access.allow_human_players===true && principal.kind==='human' && p?.kind==='human' &&
 p.participant_id===principal.participant_id && p.occupant_epoch===principal.occupant_epoch && p.seat===principal.seat;
}
export function matchesOccupant(access:RoomAccess,b:FrozenBinding):boolean {
 return eligible(access,{seat:b.seat,participant_id:b.participant_id,occupant_epoch:b.occupant_epoch,kind:'human'});
}
export function provenance(b:FrozenBinding):Provenance {
 return {driver:'human_chip',author:'human',workshop_id:b.workshop_id,version:b.version,sha256:b.sha256,generation:b.generation};
}
export function clone<T>(x:T):T {return JSON.parse(JSON.stringify(x)) as T;}
