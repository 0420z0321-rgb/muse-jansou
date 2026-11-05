/** Synthetic server-owned admission fixtures, never live rooms or hidden opponent hands. */
export interface AdmissionFixture {id:string; snapshot:Record<string,unknown>; actions:readonly string[];}
const discard=(tile:number,called_by:number|null=null)=>({tile,tsumogiri:false,called_by});
function base(hand:number[]):Record<string,unknown>{return {observer:0,observer_seat:0,seat:0,hands:[hand,null,null,null],discards:[[],[],[],[]],melds:[[],[],[],[]],scores:[25000,25000,25000,25000],riichi:[false,false,false,false],dora_indicators:[26],dealer:0,honba:0,kyotaku:0,turn_count:4,round_wind:0,wall_count:55,turn:0,phase:"discard",revision:1,decision_id:"admission-synthetic",last_drawn:hand.at(-1),ruleset:{aka:true}};}
export const ADMISSION_FIXTURES:readonly AdmissionFixture[]=[
 {id:"closed-discard",actions:["discard"],snapshot:base([0,1,3,5,7,9,11,13,18,20,22,24,27,31])},
 {id:"open-discard",actions:["discard"],snapshot:{...base([1,2,4,6,9,11,18,20,21,24,27]),melds:[[{type:"pon",tiles:[31,31,31],open:true,called_tile:31,from_seat:1}],[],[],[]],discards:[[],[discard(31,0)],[],[]]}},
 {id:"reaction-pass",actions:["pass"],snapshot:{...base([0,2,4,6,8,9,11,13,17,19,22,25,27]),turn:1,phase:"reaction",last_drawn:null,pending:{seat:1,tile:32},discards:[[],[discard(32)],[],[]]}}
];
