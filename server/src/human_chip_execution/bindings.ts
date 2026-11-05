import {canonical,sha256} from '../lab_c/portable.js';
import {workshopId,integer,secret} from '../lab_c/contracts.js';
import {inspectProgram} from '../lab_c/admission.js';
import {validateProgram} from '../lab_c/vendor/chip_engine.js';
import {ExecutionStore} from './store.js';
import {eligible,matchesOccupant,provenance,ExecutionError,type RoomAccess,type Principal,type FrozenVersion,type FrozenBinding,type ExecutionEvent,type BindingView} from './contracts.js';
export interface BindingHost {
 access():RoomAccess;
 /** Must be synchronous DB append on the same RoomDO transaction. Never network I/O. */
 recordPaipu(event:ExecutionEvent):void;
}
export class BindingService {
 constructor(private store:ExecutionStore,private host:BindingHost,private load:(id:string,v:number,key:string)=>Promise<FrozenVersion>,private now:()=>number=()=>Date.now()){}
 async bind(principal:Principal,id:string,version:number,ownerKey:string):Promise<BindingView>{
  const before=this.host.access();if(!eligible(before,principal))throw new ExecutionError('HUMAN_SEAT_REQUIRED',403);
  workshopId(id);integer(version,1,100,'version');secret(ownerKey);
  const generation=this.store.generation(principal.seat);
  // Only exact owner-authenticated frozen version is loaded. No latest shortcut.
  const loaded=await this.load(id,version,ownerKey);
  inspectProgram(loaded.program);validateProgram(loaded.program);
  const document=canonical(loaded.program),hash=await sha256(document),r=loaded.receipt;
  if(r.author!=='human'||r.workshop_id!==id||r.version!==version||r.status!=='stored_tested'||r.validation?.passed!==true||r.validation.suite!=='human-admission-3/v1'||r.sha256!==hash)throw new ExecutionError('FROZEN_VERSION_INVALID',409);
  const b:FrozenBinding={schema:'muse-human-chip-binding/v1',author:'human',seat:principal.seat,participant_id:principal.participant_id,occupant_epoch:principal.occupant_epoch,generation:generation+1,workshop_id:id,version,sha256:hash,bound_at:new Date(this.now()).toISOString(),document};
  this.store.transaction(()=>{
   const current=this.host.access();
   // Recheck after all awaits; leave/reseat/detach/rebind wins over an old pending bind.
   if(current.room_id!==before.room_id||current.match_id!==before.match_id||!eligible(current,principal))throw new ExecutionError('SEAT_CHANGED',409);
   this.store.replace(principal.seat,generation,b);
   const e:ExecutionEvent={type:'human_chip_bound',at:b.bound_at,room_id:current.room_id,match_id:current.match_id,seat:b.seat,provenance:provenance(b)};
   this.store.record(e);this.host.recordPaipu(e);
  });
  return {...provenance(b),seat:b.seat,state:'bound',bound_at:b.bound_at};
 }
 unbind(principal:Principal):void {
  this.store.transaction(()=>{
   const a=this.host.access();if(!eligible(a,principal))throw new ExecutionError('HUMAN_SEAT_REQUIRED',403);
   const b=this.store.binding(principal.seat);
   // Increment even when empty: invalidates an in-flight asynchronous bind.
   this.store.replace(principal.seat,this.store.generation(principal.seat),null);
   const e:ExecutionEvent={type:'human_chip_unbound',at:new Date(this.now()).toISOString(),room_id:a.room_id,match_id:a.match_id,seat:principal.seat,provenance:b&&matchesOccupant(a,b)?provenance(b):null};
   this.store.record(e);this.host.recordPaipu(e);
  });
 }
 /** Use on successful leave/seat transfer in the original leave transaction, before the new occupant. */
 clearSeat(seat:0|1|2|3):void {this.store.replace(seat,this.store.generation(seat),null);}
 forParticipant(p:Principal):BindingView|null {if(!eligible(this.host.access(),p))throw new ExecutionError('HUMAN_SEAT_REQUIRED',403);return this.view().find(b=>b.seat===p.seat)??null;}
 view():BindingView[]{const a=this.host.access();if(!a.allow_human_players)return [];const out:BindingView[]=[];
  for(const seat of [0,1,2,3] as const){const b=this.store.binding(seat);if(b&&matchesOccupant(a,b))out.push({...provenance(b),seat,state:'bound',bound_at:b.bound_at});}return out;
 }
}
