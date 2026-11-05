/** Muse雀荘 Game / publicState → observer-scoped interpreter snapshot.
 * Depends only on the exported types and functions in chip_engine.ts.
 * DOES NOT accept non-observer concealed hands. It never mutates input.
 */
import { type MuseSnapshot, type MuseMeld, type MuseDiscard, validateSnapshot } from "./chip_engine.js";
export type MuseStateLike = {
  hands?: unknown; discards?: unknown; melds?: unknown; scores?: unknown; riichi?: unknown;
  dora_indicators?: unknown; dealer?: unknown; honba?: unknown; kyotaku?: unknown;
  riichi_sticks?: unknown; turn?: unknown; turn_count?: unknown; round_wind?: unknown;
  phase?: unknown; last_drawn?: unknown; win_type?: unknown; winning_tile?: unknown;
};
const obj=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==="object" && !Array.isArray(v);
export function fromMuseState(raw:MuseStateLike, observerSeat:number):MuseSnapshot {
  if(!Number.isInteger(observerSeat)||observerSeat<0||observerSeat>3)throw new Error("observerSeatは0～3");
  const hands=Array.isArray(raw.hands)?raw.hands:[];
  // Fail closed: no authorized own hand is supplied? We cannot infer it from hidden engine state.
  if(!Array.isArray(hands[observerSeat]))throw new Error("指定席の公開可能な手牌がありません");
  const ds=Array.isArray(raw.discards)?raw.discards:[];
  const ms=Array.isArray(raw.melds)?raw.melds:[];
  const riichi=Array.isArray(raw.riichi)?raw.riichi:[];
  const normalized:MuseSnapshot={
    observer_seat:observerSeat,
    hands:[0,1,2,3].map(i=>i===observerSeat?[...hands[i]]:null),
    discards:[0,1,2,3].map(i=>(Array.isArray(ds[i])?ds[i]:[]).map((x:unknown):MuseDiscard=>{
      if(typeof x==="number")return {tile:x,tsumogiri:null,called_by:null};
      if(!obj(x))throw new Error("河データ不正");
      return {tile:Number(x.tile),tsumogiri:typeof x.tsumogiri==="boolean"?x.tsumogiri:null,
        called_by:typeof x.called_by==="number"?x.called_by:null,
        ...(typeof x.turn==="number"?{turn:x.turn}:{})};
    })),
    melds:[0,1,2,3].map(i=>(Array.isArray(ms[i])?ms[i]:[]).map((x:unknown):MuseMeld=>{
      if(!obj(x)||!Array.isArray(x.tiles))throw new Error("副露データ不正");
      return {type:String(x.type) as MuseMeld["type"],tiles:[...x.tiles],open:typeof x.open==="boolean"?x.open:String(x.type)!=="ankan",
        called_tile:typeof x.called_tile==="number"?x.called_tile:null,
        from_seat:typeof x.from_seat==="number"?x.from_seat:null};
    })),
    scores:Array.isArray(raw.scores)?[...raw.scores]:[],
    riichi:[0,1,2,3].map(i=>typeof riichi[i]==="boolean"?riichi[i]:obj(riichi[i])?Boolean((riichi[i] as Record<string,unknown>).declared??(riichi[i] as Record<string,unknown>).enabled):Boolean(riichi[i])),
    dora_indicators:Array.isArray(raw.dora_indicators)?[...raw.dora_indicators]:[],
    dealer:Number(raw.dealer),honba:Number(raw.honba),
    kyotaku:Number(raw.kyotaku??raw.riichi_sticks??0),
    turn:Number(raw.turn),turn_count:Number(raw.turn_count??0),round_wind:Number(raw.round_wind??0),
    phase:typeof raw.phase==="string"?raw.phase:undefined,
    last_drawn:Number(raw.turn)===observerSeat&&typeof raw.last_drawn==="number"?raw.last_drawn:null,
    winning_tile:typeof raw.winning_tile==="number"?raw.winning_tile:null,
    win_type:typeof raw.win_type==="string"?raw.win_type:null
  };
  validateSnapshot(normalized);
  return normalized;
}
