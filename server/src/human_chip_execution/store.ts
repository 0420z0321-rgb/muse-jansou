import type {StoragePort} from '../lab_c/vault.js';
import {ExecutionError,type FrozenBinding,type ExecutionEvent,type Seat} from './contracts.js';
/** New tables only inside the existing RoomDO; no RoomDO class/migration replacement. */
export class ExecutionStore {
 constructor(public readonly storage:StoragePort){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS hcx_bindings (seat INTEGER PRIMARY KEY, generation INTEGER NOT NULL, document TEXT)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS hcx_attempts (attempt_id TEXT PRIMARY KEY, match_id TEXT NOT NULL, status TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS hcx_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, document TEXT NOT NULL)');
 }
 generation(seat:Seat):number {return Number([...this.storage.sql.exec('SELECT generation FROM hcx_bindings WHERE seat=?',seat)][0]?.generation??0);}
 binding(seat:Seat):FrozenBinding|null {const d=[...this.storage.sql.exec('SELECT document FROM hcx_bindings WHERE seat=?',seat)][0]?.document;return d?JSON.parse(String(d)) as FrozenBinding:null;}
 /** Caller wraps mutations + game/paipu persistence in the SAME transactionSync. */
 replace(seat:Seat,expected:number,binding:FrozenBinding|null):number {
  if(this.generation(seat)!==expected)throw new ExecutionError('BINDING_CHANGED',409);
  const generation=expected+1;
  if(binding && (binding.seat!==seat || binding.generation!==generation))throw new ExecutionError('BINDING_GENERATION');
  this.storage.sql.exec('INSERT INTO hcx_bindings(seat,generation,document) VALUES(?,?,?) ON CONFLICT(seat) DO UPDATE SET generation=excluded.generation,document=excluded.document',seat,generation,binding?JSON.stringify(binding):null);
  return generation;
 }
 hasAttempt(key:string):boolean{return [...this.storage.sql.exec('SELECT attempt_id FROM hcx_attempts WHERE attempt_id=?',key)].length>0;}
 claim(key:string,match:string):boolean {
  if(this.hasAttempt(key))return false;
  this.storage.sql.exec('INSERT INTO hcx_attempts(attempt_id,match_id,status) VALUES(?,?,?)',key,match,'claimed');return true;
 }
 finish(key:string,status:string,steps:number):void {this.storage.sql.exec('UPDATE hcx_attempts SET status=?,steps=? WHERE attempt_id=?',status,steps,key);}
 record(e:ExecutionEvent):void {this.storage.sql.exec('INSERT INTO hcx_events(match_id,document) VALUES(?,?)',e.match_id,JSON.stringify(e));}
 events(after=0,limit=100):{seq:number,event:ExecutionEvent}[] {
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new ExecutionError('PAGINATION');
  return [...this.storage.sql.exec('SELECT seq,document FROM hcx_events WHERE seq>? ORDER BY seq LIMIT ?',after,limit)].map(r=>({seq:Number(r.seq),event:JSON.parse(String(r.document)) as ExecutionEvent}));
 }
 transaction<T>(fn:()=>T):T{return this.storage.transactionSync(fn);}
}
