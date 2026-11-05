/** Muse mahjong chip interpreter v0.3-candidate.1 — based on v0.1, additive extension.
 * Pure TypeScript, no DOM, no I/O.
 * Contract: ProgramV1 JSON is shared by server and editor. No hidden game state access.
 * Physical tile IDs: 0-33 normal, 34/35/36 red fives.
 */
export const SCHEMA = "muse-mahjong-chips/v1" as const;
export const RUNTIME_VERSION = "0.3.0-candidate.1" as const;
export type CounterKind = "fact" | "estimate";
export type ChipType = "START" | "JUMP" | "CALL" | "RETURN" | "END" |
  "MJ_対象指定" | "MJ_状態入力" | "MJ_牌属性入力" | "MJ_枚数入力" | "MJ_履歴入力" |
  "MJ_候補列挙" | "MJ_候補移動" | "MJ_仮状態評価" | "MJ_シャンテン入力" |
  "MJ_面子分解列挙" | "MJ_面子分解移動" | "MJ_面子情報入力" |
  "MJ_カウンタ操作" | "MJ_カウンタ判断" | "MJ_点数算出" | "MJ_行動" | "MJ_門前・鳴き状態判断";
/** Legacy v0.1 registry: keep all 16 families + 5 controls and their indices intact. */
export const CHIP_TYPES: readonly ChipType[] = [
  "MJ_対象指定", "MJ_状態入力", "MJ_牌属性入力", "MJ_枚数入力", "MJ_履歴入力",
  "MJ_候補列挙", "MJ_候補移動", "MJ_仮状態評価", "MJ_シャンテン入力",
  "MJ_面子分解列挙", "MJ_面子分解移動", "MJ_面子情報入力", "MJ_カウンタ操作",
  "MJ_カウンタ判断", "MJ_点数算出", "MJ_行動",
  "START", "JUMP", "CALL", "RETURN", "END"
] as const;
/** Additive registry. New editors should use AVAILABLE_CHIP_TYPES, not replace legacy IDs. */
export const EXTENSION_CHIP_TYPES: readonly ChipType[] = ["MJ_門前・鳴き状態判断"] as const;
export const AVAILABLE_CHIP_TYPES: readonly ChipType[] = [...CHIP_TYPES, ...EXTENSION_CHIP_TYPES];
export type RelativeSeat = "self" | "kamicha" | "toimen" | "shimocha";
export type OpenMeldComparison = "eq" | "ne" | "gt" | "ge" | "lt" | "le";
/** In count mode, op and threshold are required. Threshold is an integer from 0 to 4. */
export type MenzenNakiParams = { target: RelativeSeat } & (
  { condition: "has_open" | "menzen"; op?: OpenMeldComparison; threshold?: number } |
  { condition: "count"; op: OpenMeldComparison; threshold: number }
);
export type MenzenNakiResult = {
  target: RelativeSeat; observerSeat: number; targetSeat: number;
  openMeldCount: number; concealedKanCount: number; menzen: boolean;
  byType: Record<MuseMeld["type"], number>; openFlagConflicts: number[];
  condition: MenzenNakiParams["condition"]; operator: OpenMeldComparison | null;
  threshold: number | null; matched: boolean;
};
export type Operand = { source: "counter"; name: string } |
  { source: "constant"; value: number } | { source: "input" };
export type ChipNode = {
  id: string; type: ChipType; x: number; y: number;
  params: Record<string, unknown>; routes: { next?: string; yes?: string; no?: string; target?: string };
};
export type CounterDef = { name: string; kind: CounterKind; initial: number };
export type ProgramV1 = { schema: typeof SCHEMA; id: string; name: string; entry: string;
  counters: CounterDef[]; nodes: ChipNode[];
  /** Editor-only layout metadata; ignored by the interpreter. */
  layout?: { columns:number; rows:number };
  limits?: { maxSteps?: number; maxCallDepth?: number } };
export type MuseDiscard = { tile: number; tsumogiri: boolean | null; called_by: number | null; turn?: number | null };
export type MuseMeld = { type: "chi" | "pon" | "daiminkan" | "ankan" | "kakan";
  tiles: number[]; open: boolean; called_tile?: number | null; from_seat?: number | null };
/** Sanitized, observer-scoped snapshot: hands for non-observer seats must be null. */
export type MuseSnapshot = { observer_seat: number; hands: (number[] | null)[];
  discards: MuseDiscard[][]; melds: MuseMeld[][]; scores: number[]; riichi: boolean[];
  dora_indicators: number[]; dealer: number; honba: number; kyotaku: number;
  turn: number; turn_count: number; round_wind: number;
  phase?: string; winning_tile?: number | null; win_type?: string | null; last_drawn?: number | null;
};
export type Candidate = { type: "discard"; tile: number };
export type PatternMeld = { kind: "sequence" | "triplet" | "quad"; start: number; suit: number; open: boolean; fromMeld: boolean };
export type Pattern = { pair: number; melds: PatternMeld[]; winningMeldIndex: number | null; wait: string | null };
export type CounterValue = { kind: CounterKind; value: number };
export type TraceEntry = { step: number; nodeId: string; type: ChipType; description: string;
  route: "next" | "yes" | "no" | "target" | "return" | "stop";
  nextNode: string | null; changes: { name: string; before: number; after: number; kind: CounterKind }[];
  counters: Record<string, number>; info?: Record<string, unknown> };
export type MachineStatus = "ready" | "running" | "completed" | "action" | "error" | "step_limit";
export type Machine = { program: ProgramV1; snapshot: MuseSnapshot; status: MachineStatus;
  pc: string | null; steps: number; counters: Record<string, CounterValue>; trace: TraceEntry[];
  lastInput: number; selectedSeat: number; selectedTile: number | null;
  candidates: Candidate[]; candidateIndex: number; virtualHand: number[] | null;
  patterns: Pattern[]; patternIndex: number; callStack: string[];
  action: { action: string; tile?: number; riichi?: boolean; seat: number } | null;
  complexOps: number;
  error: string | null; message: string };

const ALL = new Set<string>(AVAILABLE_CHIP_TYPES);
const HARD_MAX_STEPS=2048;
const HARD_MAX_COMPLEX=32;
const VALID_KIND = new Set(["fact", "estimate"]);
const fail = (s: string): never => { throw new Error(s); };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const whole = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const asString = (v: unknown, label: string): string => typeof v === "string" ? v : fail(`${label}: 文字列が必要`);
const asNumber = (v: unknown, label: string): number => typeof v === "number" && Number.isFinite(v) ? v : fail(`${label}: 有限の数値が必要`);
const asInt = (v: unknown, label: string): number => whole(v) ? v as number : fail(`${label}: 整数が必要`);
const validTile = (t: unknown): t is number => whole(t) && (t as number) >= 0 && (t as number) <= 36;
export function kindOf(code: number): number {
  if (!validTile(code)) return fail(`不正な牌ID: ${code}`);
  return code === 34 ? 4 : code === 35 ? 13 : code === 36 ? 22 : code;
}
export function suitOf(code: number): number { const k = kindOf(code); return k < 27 ? Math.floor(k / 9) : 3; }
export function numberOf(code: number): number { const k = kindOf(code); return k < 27 ? k % 9 + 1 : k - 26; }
export function tileLabel(t: number): string {
  const k = kindOf(t); const label = k < 27 ? `${(k % 9) + 1}${"mps"[Math.floor(k / 9)]}` : ["東","南","西","北","白","發","中"][k - 27];
  return t >= 34 ? `赤${label}` : label;
}
export const terminalOrHonor = (t: number): boolean => { const k = kindOf(t); return k >= 27 || k % 9 === 0 || k % 9 === 8; };
export function validateProgram(p: unknown): asserts p is ProgramV1 {
  if (!isObject(p) || p.schema !== SCHEMA || !Array.isArray(p.nodes) || !Array.isArray(p.counters)) throw new Error("配置JSONのschema/nodes/countersが不正");
  if (typeof p.id !== "string" || typeof p.name !== "string" || typeof p.entry !== "string") throw new Error("配置JSONのid/name/entryが不正");
  if (p.nodes.length > 8000 || p.counters.length > 512) throw new Error("安全上限: ノード8000・カウンタ512（CPU容量のゲーム的制限ではありません）");
  const names = new Set<string>();
  for (const c of p.counters) {
    if (!isObject(c) || typeof c.name !== "string" || !/^[A-Za-z0-9_\-]{1,40}$/.test(c.name) || ["__proto__","constructor","prototype"].includes(c.name) || !VALID_KIND.has(String(c.kind)) || typeof c.initial !== "number" || !Number.isFinite(c.initial)) throw new Error("カウンタ宣言が不正");
    if (names.has(c.name)) throw new Error(`カウンタ名の重複: ${c.name}`);
    names.add(c.name);
  }
  const ids = new Set<string>();
  for (const n of p.nodes) {
    if (!isObject(n) || typeof n.id !== "string" || !/^[A-Za-z0-9_\-]{1,60}$/.test(n.id) || ["__proto__","constructor","prototype"].includes(n.id) || !ALL.has(String(n.type)) || !whole(n.x) || !whole(n.y) || Number(n.x) < 0 || Number(n.y) < 0 || Number(n.x) >= 512 || Number(n.y) >= 512 || !isObject(n.params) || !isObject(n.routes)) throw new Error(`不正なノード: ${String(n?.id)}`);
    if (n.type === "MJ_門前・鳴き状態判断") readMenzenNakiParams(n.params);
    if (ids.has(n.id)) throw new Error(`ノードID重複: ${n.id}`);
    ids.add(n.id);
  }
  if (!ids.has(p.entry)) throw new Error(`開始ノードが見つからない: ${p.entry}`);
  if (p.nodes.find(n => (n as ChipNode).id === p.entry)?.type !== "START") throw new Error("開始ノードはSTARTにする");
  for (const n of p.nodes) for (const [port, to] of Object.entries((n as ChipNode).routes)) {
    if (!["next","yes","no","target"].includes(port) || typeof to !== "string" || !ids.has(to)) throw new Error(`${n.id} の ${port} が存在しないノードを指す`);
  }
  if (p.layout !== undefined && (!isObject(p.layout)||!whole(p.layout.columns)||!whole(p.layout.rows)||Number(p.layout.columns)<1||Number(p.layout.rows)<1||Number(p.layout.columns)>512||Number(p.layout.rows)>512)) throw new Error("layoutの列/行は1～512の整数");
  if (p.limits !== undefined && (!isObject(p.limits) || (p.limits.maxSteps !== undefined && (!whole(p.limits.maxSteps) || Number(p.limits.maxSteps) < 1 || Number(p.limits.maxSteps) > 100000)) || (p.limits.maxCallDepth !== undefined && (!whole(p.limits.maxCallDepth) || Number(p.limits.maxCallDepth) < 1 || Number(p.limits.maxCallDepth) > 1024)))) throw new Error("limits不正");
}
export function validateSnapshot(s: unknown): asserts s is MuseSnapshot {
  if (!isObject(s) || !whole(s.observer_seat) || Number(s.observer_seat) < 0 || Number(s.observer_seat) > 3) throw new Error("observer_seatが不正");
  for (const field of ["hands","discards","melds","scores","riichi"]) if (!Array.isArray(s[field]) || s[field].length !== 4) throw new Error(`局面.${field} は4席の配列`);
  if (!Array.isArray(s.dora_indicators)) throw new Error("dora_indicatorsが不正");
  const hands=s.hands as unknown[], discards=s.discards as unknown[], melds=s.melds as unknown[], scores=s.scores as unknown[], riichi=s.riichi as unknown[];
  if (!Array.isArray(hands[s.observer_seat as number])) throw new Error("observer席の手牌がありません");
  for (let i=0;i<4;i++) {
    const hand=hands[i]; if (i!==s.observer_seat && hand !== null) throw new Error("他家の非公開手牌はnullにしてください");
    if (hand!==null && (!Array.isArray(hand) || !hand.every(validTile))) throw new Error("手牌IDが不正");
    if (!whole(scores[i]) || typeof riichi[i] !== "boolean") throw new Error("点数またはリーチ情報が不正");
    if (!Array.isArray(discards[i]) || !Array.isArray(melds[i])) throw new Error("河/副露の形式が不正");
    for (const d of discards[i] as unknown[]) {
      if (!isObject(d) || !validTile(d.tile) || (d.tsumogiri !== null && typeof d.tsumogiri !== "boolean") || (d.called_by !== null && (!whole(d.called_by) || Number(d.called_by)<0 || Number(d.called_by)>3))) throw new Error("河牌が不正");
    }
    for (const m of melds[i] as unknown[]) {
      if (!isObject(m) || !["chi","pon","daiminkan","ankan","kakan"].includes(String(m.type)) || !Array.isArray(m.tiles) || !m.tiles.every(validTile) || typeof m.open !== "boolean") throw new Error("副露データが不正");
    }
  }
  if (!s.dora_indicators.every(validTile)) throw new Error("ドラ表示牌IDが不正");
  for (const field of ["dealer","honba","kyotaku","turn","turn_count","round_wind"]) if (!whole(s[field]) || Number(s[field]) < 0) throw new Error(`局面.${field} が不正`);
  if (Number(s.dealer)>3 || Number(s.turn)>3 || Number(s.round_wind)>3) throw new Error("席/場風番号が不正");
  if (s.winning_tile !== undefined && s.winning_tile !== null && !validTile(s.winning_tile)) throw new Error("winning_tile不正");
  if(s.last_drawn !== undefined && s.last_drawn !== null && !validTile(s.last_drawn)) throw new Error("last_drawn不正");
  if(s.turn !== s.observer_seat && s.last_drawn != null) throw new Error("他家の非公開ツモ牌は渡せません");
}
export function sanitizeSnapshot(raw: MuseSnapshot): MuseSnapshot {
  validateSnapshot(raw);
  // Rebuild only explicitly allowlisted fields. Never retain raw.wall, dead_wall,
  // hidden event payloads, opponents' drawn tiles, private auth fields, etc.
  const safe:MuseSnapshot = {
    observer_seat:raw.observer_seat,
    hands:raw.hands.map((h,i)=>i===raw.observer_seat?[...(h as number[])]:null),
    discards:raw.discards.map(ds=>ds.map(d=>({tile:d.tile,tsumogiri:d.tsumogiri,called_by:d.called_by,...(d.turn===undefined?{}:{turn:d.turn})}))),
    melds:raw.melds.map(ms=>ms.map(m=>({type:m.type,tiles:[...m.tiles],open:m.open,
      ...(m.called_tile===undefined?{}:{called_tile:m.called_tile}),...(m.from_seat===undefined?{}:{from_seat:m.from_seat})}))),
    scores:[...raw.scores],riichi:[...raw.riichi],dora_indicators:[...raw.dora_indicators],
    dealer:raw.dealer,honba:raw.honba,kyotaku:raw.kyotaku,turn:raw.turn,
    turn_count:raw.turn_count,round_wind:raw.round_wind,
    ...(raw.phase===undefined?{}:{phase:raw.phase}),
    ...(raw.winning_tile===undefined?{}:{winning_tile:raw.winning_tile}),
    ...(raw.win_type===undefined?{}:{win_type:raw.win_type}),
    ...(raw.turn!==raw.observer_seat||raw.last_drawn===undefined?{}:{last_drawn:raw.last_drawn})
  };
  return safe;
}

/** Only the new extension has these strict parameters; old chip parameter formats are unchanged. */
export function readMenzenNakiParams(value: unknown): MenzenNakiParams {
  if (!isObject(value)) return fail("門前・鳴き状態判断: paramsはオブジェクトです");
  const allowed = new Set(["target", "condition", "op", "threshold"]);
  for (const key of Object.keys(value)) if (!allowed.has(key))
    return fail(`門前・鳴き状態判断: 未対応パラメータ ${key}（読み取り専用・出力先指定なし）`);
  if (typeof value.target !== "string" || !["self", "kamicha", "toimen", "shimocha"].includes(value.target))
    return fail("門前・鳴き状態判断: targetはself/kamicha/toimen/shimochaです");
  if (typeof value.condition !== "string" || !["has_open", "menzen", "count"].includes(value.condition))
    return fail("門前・鳴き状態判断: conditionはhas_open/menzen/countです");
  if ((value.condition === "count" || value.op !== undefined) &&
      (typeof value.op !== "string" || !["eq", "ne", "gt", "ge", "lt", "le"].includes(value.op)))
    return fail("門前・鳴き状態判断: opはeq/ne/gt/ge/lt/leです");
  if ((value.condition === "count" || value.threshold !== undefined) &&
      (!whole(value.threshold) || Number(value.threshold) < 0 || Number(value.threshold) > 4))
    return fail("門前・鳴き状態判断: thresholdは0〜4の整数です");
  return value as MenzenNakiParams;
}
/** Relative to the observing player, never dealer or the mutable selectedSeat.
 * Seat contract: turn order 0 -> 1 -> 2 -> 3 -> 0; kamicha = previous seat.
 */
export function resolveRelativeSeat(observerSeat: number, target: RelativeSeat): number {
  if (!whole(observerSeat) || observerSeat < 0 || observerSeat > 3)
    return fail("門前・鳴き状態判断: 観測席は0〜3です");
  let offset: number;
  switch (target) {
    case "self": offset = 0; break;
    case "kamicha": offset = 3; break;
    case "toimen": offset = 2; break;
    case "shimocha": offset = 1; break;
    default: return fail("門前・鳴き状態判断: 未対応の相対席");
  }
  return (observerSeat + offset) % 4;
}
/** Pure observation, shared by interpreter and UI preview. Does not even read hands.
 * Owner rule: chi/pon/daiminkan/kakan each count as one OPEN group; ankan never does.
 * `melds` must be the CURRENT group list: kakan replaces its pon record, not an event history.
 * Type is authoritative for this chip; contradictory `open` flags are reported, not rewritten.
 */
export function evaluateMenzenNaki(
  snapshot: Pick<MuseSnapshot, "observer_seat" | "melds">,
  rawParams: unknown
): MenzenNakiResult {
  const params = readMenzenNakiParams(rawParams);
  const targetSeat = resolveRelativeSeat(snapshot.observer_seat, params.target);
  if (!Array.isArray(snapshot.melds) || snapshot.melds.length !== 4)
    return fail("門前・鳴き状態判断: meldsは4席分必要です。不明を門前として扱いません");
  const melds = snapshot.melds[targetSeat];
  if (!Array.isArray(melds) || melds.length > 4)
    return fail("門前・鳴き状態判断: 対象の現在面子は0〜4組の配列です");
  const byType = { chi: 0, pon: 0, daiminkan: 0, ankan: 0, kakan: 0 };
  const openFlagConflicts: number[] = [];
  let openMeldCount = 0;
  for (let i = 0; i < melds.length; i++) {
    const meld = melds[i];
    if (!isObject(meld) || typeof meld.open !== "boolean")
      return fail("門前・鳴き状態判断: 面子の種類・openフラグが不正です");
    switch (meld.type) {
      case "chi": case "pon": case "daiminkan": case "kakan":
        byType[meld.type]++; openMeldCount++;
        if (!meld.open) openFlagConflicts.push(i);
        break;
      case "ankan":
        byType.ankan++;
        if (meld.open) openFlagConflicts.push(i);
        break;
      default: return fail(`門前・鳴き状態判断: 未対応の面子種類 ${String(meld.type)}`);
    }
  }
  let matched: boolean;
  if (params.condition === "has_open") matched = openMeldCount >= 1;
  else if (params.condition === "menzen") matched = openMeldCount === 0;
  else if (params.condition === "count") {
    switch (params.op) {
      case "eq": matched = openMeldCount === params.threshold; break;
      case "ne": matched = openMeldCount !== params.threshold; break;
      case "gt": matched = openMeldCount > params.threshold; break;
      case "ge": matched = openMeldCount >= params.threshold; break;
      case "lt": matched = openMeldCount < params.threshold; break;
      case "le": matched = openMeldCount <= params.threshold; break;
      default: return fail("門前・鳴き状態判断: 未対応の比較演算子");
    }
  } else return fail("門前・鳴き状態判断: 未対応の条件");
  return { target: params.target, observerSeat: snapshot.observer_seat, targetSeat,
    openMeldCount, concealedKanCount: byType.ankan, menzen: openMeldCount === 0,
    byType, openFlagConflicts, condition: params.condition,
    operator: params.condition === "count" ? params.op : null,
    threshold: params.condition === "count" ? params.threshold : null, matched };
}

export function newMachine(program: ProgramV1, snapshot: MuseSnapshot): Machine {
  validateProgram(program); const safe=sanitizeSnapshot(snapshot);
  const counters=Object.create(null) as Record<string,CounterValue>;
  for(const c of program.counters)counters[c.name]={kind:c.kind,value:c.initial};
  return {program:JSON.parse(JSON.stringify(program)),snapshot:safe,status:"ready",pc:program.entry,steps:0,counters,trace:[],lastInput:0,
    selectedSeat:safe.observer_seat,selectedTile:null,candidates:[],candidateIndex:-1,virtualHand:null,
    patterns:[],patternIndex:-1,callStack:[],action:null,error:null,message:"開始待ち",complexOps:0};
}
function counter(machine:Machine,name:unknown):CounterValue {
  const key=asString(name,"カウンタ名");const result=machine.counters[key];if(!result)throw new Error(`宣言されていないカウンタ: ${key}`);return result;
}
function setCounter(m:Machine,name:unknown,value:number): void {if(!Number.isFinite(value))throw new Error("カウンタ演算結果が有限数ではありません");counter(m,name).value=value;m.lastInput=value;}
function resolveOperand(m:Machine,unknownOp:unknown):number {
  if (!isObject(unknownOp))throw new Error("オペランドが不正");
  if(unknownOp.source==="constant")return asNumber(unknownOp.value,"定数");
  if(unknownOp.source==="counter")return counter(m,unknownOp.name).value;
  if(unknownOp.source==="input")return m.lastInput;
  return fail("オペランド種類が未対応");
}
/** Visible tile multiset, observing only own concealed hand. Called discards are represented in melds, not twice. */
export function getVisibleTiles(s:MuseSnapshot):number[] {
  const out=[...(s.hands[s.observer_seat] as number[])];
  for (const river of s.discards) for(const d of river) if(d.called_by===null)out.push(d.tile);
  for (const ms of s.melds)for(const meld of ms)out.push(...meld.tiles);
  out.push(...s.dora_indicators);
  const count=Array(34).fill(0) as number[];
  for(const tile of out){const k=kindOf(tile);count[k]++;if(count[k]>4)throw new Error(`公開牌の枚数が物理上限を超えました: ${tileLabel(tile)} (${count[k]})。河と副露の二重計上、または牌データを確認してください`);}
  return out;
}
const suitName=(s:number)=>["man","pin","sou","honor"][s]||"?";
function matchTile(tile:number,p:Record<string,unknown>):boolean {
  const group=String(p.group??"suit");
  if(group==="suit")return suitName(suitOf(tile))===String(p.suit??"sou");
  if(group==="tile"){
    const expect=asInt(p.tile,"指定牌");
    return (p.physicalRed===true||p.physicalRed==="true")?tile===expect:kindOf(tile)===kindOf(expect);
  }
  if(group==="attribute"){
    const a=String(p.attribute??"yaochu");const k=kindOf(tile);
    switch(a){case "yaochu":return terminalOrHonor(tile);case "terminal":return k<27 && (k%9===0||k%9===8);
      case "honor":return k>=27; case "middle":return k<27 && k%9>0&&k%9<8;
      case "red":return tile>=34;case "dragon":return k>=31&&k<=33;case "wind":return k>=27&&k<=30;
      case "green":return [19,20,21,23,25,32].includes(k);
      default:return fail(`未知の牌属性: ${a}`);}
  }
  return fail(`未知の枚数group: ${group}`);
}
function allTileCodesOfGroup(p:Record<string,unknown>):number {
  if(p.physicalRed === true || p.physicalRed === "true") throw new Error("赤/通常5の実牌別の全数はルール設定が必要です。未見では34種の牌IDで数えてください");
  let n=0;
  for(let t=0;t<34;t++) if(matchTile(t,p))n+=4;
  // 'red' is a separate property of some physical tile, not a fifth tile per kind.
  if(p.group==="attribute"&&p.attribute==="red")throw new Error("赤牌の総数はルール設定が必要。未見赤牌の簡易集計は未対応");
  return n;
}
function countTiles(m:Machine,p:Record<string,unknown>):number {
  const scope=String(p.scope??"visible");let tiles:number[]=[];
  if(scope==="hand"){
    if(m.selectedSeat!==m.snapshot.observer_seat)throw new Error("他家の伏せ手牌は参照禁止");
    tiles=m.virtualHand??(m.snapshot.hands[m.snapshot.observer_seat] as number[]);
  }else if(scope==="river"){
    const seat=p.seat==="selected"?m.selectedSeat:asInt(p.seat??m.selectedSeat,"河の席");
    if(seat<0||seat>3)throw new Error("席の範囲は0〜3");
    const method=String(p.discardMethod??"all");
    tiles=m.snapshot.discards[seat].filter(d=>method==="all" || (method==="tsumogiri"&&d.tsumogiri===true) || (method==="tedashi"&&d.tsumogiri===false)).map(d=>d.tile);
    // River includes called tile as historical discard: correct for river-count questions.
  }else if(scope==="meld"){
    const seat=p.seat==="selected"?m.selectedSeat:asInt(p.seat??m.selectedSeat,"副露の席");
    if(seat<0||seat>3)throw new Error("席の範囲は0〜3");
    tiles=m.snapshot.melds[seat].flatMap(mm=>mm.tiles);
  }else if(scope==="visible" || scope==="unseen"){
    if(m.virtualHand!==null)throw new Error("仮状態での未見/全体公開牌評価は未対応。手牌範囲で試してください");
    tiles=getVisibleTiles(m.snapshot);
  }else return fail(`未対応の枚数範囲: ${scope}`);
  const count=tiles.filter(t=>matchTile(t,p)).length;
  if(scope==="unseen")return allTileCodesOfGroup(p)-count;
  return count;
}
function stateValue(m:Machine,p:Record<string,unknown>):number {
  const s=m.snapshot;const seat=p.seat==="selected"?m.selectedSeat:asInt(p.seat??m.selectedSeat,"席");
  if(seat<0||seat>3)throw new Error("席の範囲は0〜3");
  const key=String(p.field??"turn_count");
  switch(key){
    case "turn_count":return s.turn_count;
    case "turn":return s.turn;
    case "dealer":return s.dealer;
    case "is_dealer":return seat===s.dealer?1:0;
    case "score":return s.scores[seat];
    case "score_gap":return s.scores[seat]-s.scores[asInt(p.targetSeat??s.observer_seat,"比較席")];
    case "rank":return 1+s.scores.filter((points,i)=>points>s.scores[seat] || (points===s.scores[seat] && i<seat)).length;
    case "riichi":return s.riichi[seat]?1:0;
    case "honba":return s.honba;
    case "kyotaku":return s.kyotaku;
    case "round_wind":return s.round_wind;
    case "meld_count":return s.melds[seat].length;
    case "menzen":return s.melds[seat].every(x=>x.type==="ankan")?1:0;
    case "tsumo":return s.win_type==="tsumo"?1:0;
    case "ron":return s.win_type==="ron"?1:0;
    default:return fail(`未知の状態入力: ${key}`);
  }
}
function attributeValue(tile:number,field:string):number {
  const k=kindOf(tile);
  switch(field){case "id":return tile;case "kind":return k;case "suit":return suitOf(tile);
    case "number":return numberOf(tile);case "red":return tile>=34?1:0;
    case "yaochu":return terminalOrHonor(tile)?1:0;case "honor":return k>=27?1:0;
    case "wind":return k>=27&&k<=30?1:0;case "dragon":return k>=31&&k<=33?1:0;
    default:return fail(`未知の牌属性: ${field}`);}
}
function historyValue(m:Machine,p:Record<string,unknown>):number {
  const seat=p.seat==="selected"?m.selectedSeat:asInt(p.seat??m.selectedSeat,"履歴の席");
  if(seat<0||seat>3)throw new Error("席の範囲は0〜3");
  const index=asInt(p.offset??0,"何件前");const d=m.snapshot.discards[seat][m.snapshot.discards[seat].length-1-index];
  if(!d)throw new Error("指定履歴がありません");
  switch(String(p.field??"tile")){
    case "tile":return d.tile; case "kind":return kindOf(d.tile);
    case "suit":return suitOf(d.tile);case "tsumogiri":if(d.tsumogiri===null)throw new Error("手出し/ツモ切り不明");return d.tsumogiri?1:0;
    case "called":return d.called_by===null?0:1;case "turn":if(d.turn===undefined||d.turn===null)throw new Error("履歴に巡番号がありません");return d.turn;
    default:return fail("未知の履歴属性");
  }
}
function handCounts(hand:number[]):number[]{const c=Array(34).fill(0) as number[];for(const t of hand)c[kindOf(t)]++;return c;}
const ORPHANS=[0,8,9,17,18,26,27,28,29,30,31,32,33];
export function shantenOf(hand:number[],openMelds=0,shape="min"):number {
  const counts=handCounts(hand);if(openMelds<0||openMelds>4||!whole(openMelds))throw new Error("副露面子数が不正");
  let best=8;let seen=0;
  // DFS of small fixed 34-kind vector; memoize structural subproblems by state for speed.
  const memo=new Map<string,number>();
  function dfs(index:number,mentsu:number,taatsu:number,pair:number):void {
    if(mentsu+openMelds>4)return;
    while(index<34&&counts[index]===0)index++;
    if(index===34){const melds=mentsu+openMelds;const usableT=Math.min(taatsu,4-melds);const sh=8-2*melds-usableT-pair;if(sh<best)best=sh;return;}
    const key=`${index}|${mentsu}|${taatsu}|${pair}|${counts.slice(index).join("")}`;
    if(memo.has(key))return;
    memo.set(key,1);if(++seen>300000)throw new Error("シャンテン探索の安全上限を超過");
    if(counts[index]>=3){counts[index]-=3;dfs(index,mentsu+1,taatsu,pair);counts[index]+=3;}
    if(index<27&&index%9<=6&&counts[index+1]>0&&counts[index+2]>0){counts[index]--;counts[index+1]--;counts[index+2]--;dfs(index,mentsu+1,taatsu,pair);counts[index]++;counts[index+1]++;counts[index+2]++;}
    if(counts[index]>=2){counts[index]-=2;if(!pair)dfs(index,mentsu,taatsu,1);dfs(index,mentsu,taatsu+1,pair);counts[index]+=2;}
    if(index<27&&index%9<=7&&counts[index+1]>0){counts[index]--;counts[index+1]--;dfs(index,mentsu,taatsu+1,pair);counts[index]++;counts[index+1]++;}
    if(index<27&&index%9<=6&&counts[index+2]>0){counts[index]--;counts[index+2]--;dfs(index,mentsu,taatsu+1,pair);counts[index]++;counts[index+2]++;}
    counts[index]--;dfs(index,mentsu,taatsu,pair);counts[index]++;
  }
  if(shape==="normal"||shape==="min")dfs(0,0,0,0);
  if(openMelds>0 && (shape==="chiitoi" || shape==="kokushi")) throw new Error("七対子・国士は副露した状態では計算できません");
  if(openMelds===0 && (shape==="chiitoi"||shape==="min")){
    const pairs=counts.filter(n=>n>=2).length;const uniques=counts.filter(n=>n>0).length;
    best=Math.min(best,6-pairs+Math.max(0,7-uniques));
  }
  if(openMelds===0 && (shape==="kokushi"||shape==="min")){
    const uniq=ORPHANS.filter(t=>counts[t]>0).length;const pair=ORPHANS.some(t=>counts[t]>1)?1:0;
    best=Math.min(best,13-uniq-pair);
  }
  if(!["normal","chiitoi","kokushi","min"].includes(shape))throw new Error("未知のシャンテン形");
  return best;
}
function waitType(m:PatternMeld|null, win:number):string|null{
  if(m===null)return "tanki";
  const k=kindOf(win);
  if(m.kind!=="sequence")return "shanpon";
  const diff=k-m.start;if(diff<0||diff>2)return null;
  if(diff===1)return "kanchan";
  if(diff===0 && m.start%9===6)return "penchan";
  if(diff===2 && m.start%9===0)return "penchan";
  return "ryanmen";
}
/** Decompose already-complete standard hand; never decide which yaku it contains. */
export function decompose(hand:number[], exposed:readonly MuseMeld[]=[], winningTile:number|null=null):Pattern[]{
  const need=4-exposed.length;
  if(need<0||hand.length!==need*3+2)return [];
  const total=handCounts(hand);if(total.some(n=>n>4))throw new Error("同種牌5枚以上");
  const fixed:PatternMeld[]=exposed.map(m=>{
    const kinds=m.tiles.map(kindOf).sort((a,b)=>a-b);const first=kinds[0];
    if(m.type==="chi" && (kinds.length!==3 || first>=27 || first%9>6 || kinds[1]!==first+1||kinds[2]!==first+2))throw new Error("副露の順子データが不正");
    if(m.type!=="chi" && kinds.some(k=>k!==first))throw new Error("副露の刻子・槓子データが不正");
    const kind=m.type==="chi"?"sequence":m.type==="pon"?"triplet":"quad";
    return {kind,start:first,suit:suitOf(first),open:m.open,fromMeld:true};
  });
  const result:Pattern[]=[]; const seen=new Set<string>();let examined=0;
  function record(pair:number,melds:PatternMeld[]){
    const full=[...fixed,...melds];
    const add=(idx:number|null,wt:string|null)=>{
      const sig=`${pair}|${full.map(x=>`${x.kind[0]}${x.start}${x.open?1:0}`).join(",")}|${idx}|${wt}`;
      if(seen.has(sig))return;seen.add(sig);
      result.push({pair,melds:full.map(x=>({...x})),winningMeldIndex:idx,wait:wt});
      if(result.length>128)throw new Error("面子分解の安全上限128を超過");
    };
    if(winningTile===null){add(null,null);return;}
    const w=kindOf(winningTile);
    if(pair===w)add(-1,"tanki");
    for(let i=fixed.length;i<full.length;i++){
      const me=full[i];if(me.start===w||(me.kind==="sequence"&&w>=me.start&&w<=me.start+2))add(i,waitType(me,w));
    }
  }
  function rec(c:number[],pair:number,ms:PatternMeld[]){
    if(++examined>100000)throw new Error("面子分解探索が上限を超過");
    const i=c.findIndex(n=>n>0);
    if(i<0){if(ms.length===need)record(pair,ms);return;}
    if(ms.length>=need)return;
    if(c[i]>=3){c[i]-=3;rec(c,pair,[...ms,{kind:"triplet",start:i,suit:suitOf(i),open:false,fromMeld:false}]);c[i]+=3;}
    if(i<27 && i%9<=6 && c[i+1]>0 && c[i+2]>0){c[i]--;c[i+1]--;c[i+2]--;rec(c,pair,[...ms,{kind:"sequence",start:i,suit:suitOf(i),open:false,fromMeld:false}]);c[i]++;c[i+1]++;c[i+2]++;}
  }
  for(let p=0;p<34;p++)if(total[p]>=2){const c=total.slice();c[p]-=2;rec(c,p,[]);}
  return result;
}
function patternValue(m:Machine,p:Record<string,unknown>):number{
  const current=m.patterns[m.patternIndex];if(!current)throw new Error("面子分解候補未選択");
  const field=String(p.field??"meld_count");
  if(field==="pair_kind")return current.pair;
  if(field==="pair_suit")return suitOf(current.pair);
  if(field==="meld_count")return current.melds.length;
  if(field==="sequence_count")return current.melds.filter(mm=>mm.kind==="sequence").length;
  if(field==="triplet_count")return current.melds.filter(mm=>mm.kind==="triplet").length;
  if(field==="quad_count")return current.melds.filter(mm=>mm.kind==="quad").length;
  if(field==="wait_type")return ({tanki:1,shanpon:2,kanchan:3,penchan:4,ryanmen:5})[current.wait??""]??0;
  if(field==="winning_meld_index")return current.winningMeldIndex??-2;
  const index=asInt(p.index??0,"面子番号");if(index<0||index>=current.melds.length)throw new Error("面子番号が範囲外");
  const mm=current.melds[index];
  if(field==="meld_kind")return ({sequence:1,triplet:2,quad:3})[mm.kind];
  if(field==="meld_start")return mm.start;
  if(field==="meld_suit")return mm.suit;
  if(field==="meld_open")return mm.open?1:0;
  return fail("未知の面子情報");
}
function scorePoints(han:number,fu:number,isDealer:boolean,mode:string):number{
  if(!whole(han)||han<0||han>200||!whole(fu)||fu<0||fu>120)throw new Error("符翻の値が不正");
  if(han===0)throw new Error("和了役がありません。点数算出は既に成立した役と翻を入力してください");
  let base:number;
  if(han>=13)base=8000;else if(han>=11)base=6000;else if(han>=8)base=4000;else if(han>=6)base=3000;
  else if(han>=5)base=2000;else base=Math.min(2000,fu*2**(han+2));
  const ceil100=(n:number)=>Math.ceil(n/100)*100;
  if(mode==="ron")return ceil100(base*(isDealer?6:4));
  if(mode==="tsumo")return isDealer?ceil100(base*2)*3:ceil100(base*2)+2*ceil100(base);
  return fail("和了方式はron/tsumoのみ");
}
function compute(m:Machine,n:ChipNode): {description:string;port:"next"|"yes"|"no"|"target"|"return"|"stop";info?:Record<string,unknown>} {
  const p=n.params;const next=() =>({description:n.type,port:"next" as const});
  switch(n.type){
    case "START":return {description:"開始",port:"next"};
    case "END":m.status="completed";m.message=String(p.label??"処理完了");return {description:`終了: ${m.message}`,port:"stop"};
    case "JUMP":return {description:"ジャンプ",port:"target"};
    case "CALL":{const dest=n.routes.next;if(!dest)throw new Error("CALLの復帰先nextが必要");if(m.callStack.length>Math.min(1024,m.program.limits?.maxCallDepth??32)-1)throw new Error("呼出スタック上限");m.callStack.push(dest);return {description:`呼出 / 復帰先 ${dest}`,port:"target"};}
    case "RETURN":{if(m.callStack.length===0)throw new Error("呼出元がないRETURN");return {description:"復帰",port:"return"};}
    case "MJ_対象指定":{
      const target=String(p.target??"self");
      if(target==="self")m.selectedSeat=m.snapshot.observer_seat;
      else if(target==="seat")m.selectedSeat=asInt(p.seat,"対象席");
      else if(target==="candidate"){const c=m.candidates[m.candidateIndex];if(!c)throw new Error("候補未選択");m.selectedTile=c.tile;}
      else if(target==="tile")m.selectedTile=asInt(p.tile,"対象牌");
      else if(target==="decomposition"){if(m.patternIndex<0)throw new Error("面子分解候補未選択");}
      else fail("対象指定が不正");
      if(m.selectedSeat<0||m.selectedSeat>3)throw new Error("対象席が範囲外");return {description:`対象指定: ${target}`,port:"next"};
    }
    case "MJ_状態入力":{const value=stateValue(m,p);setCounter(m,p.output,value);return {description:`${p.field} = ${value}`,port:"next"};}
    case "MJ_牌属性入力":{const tile=p.tile==="selected"?m.selectedTile:asInt(p.tile??0,"対象牌");if(tile===null)throw new Error("対象牌未選択");const value=attributeValue(tile,String(p.field??"suit"));setCounter(m,p.output,value);return {description:`${tileLabel(tile)} の ${p.field} = ${value}`,port:"next"};}
    case "MJ_枚数入力":{const value=countTiles(m,p);setCounter(m,p.output,value);return {description:`${p.scope??"visible"} / ${p.group??"suit"} / ${p.suit??p.attribute??p.tile??""} = ${value}${p.scope==="unseen"?" (未見≠山残数)":""}`,port:"next",info:{unseen_is_not_wall: p.scope==="unseen"}};}
    case "MJ_履歴入力":{const value=historyValue(m,p);setCounter(m,p.output,value);return {description:`河履歴 ${p.field} = ${value}`,port:"next"};}
    case "MJ_候補列挙":{if(p.mode!==undefined&&p.mode!=="discard")throw new Error("試作では打牌候補列挙のみ対応。鳴き候補は未実装");
      const hand=m.snapshot.hands[m.snapshot.observer_seat] as number[];
      // This enumerates physically distinct tiles, NOT all legal actions under riichi/kuikae.
      m.candidates=[...new Set(hand)].sort((a,b)=>kindOf(a)-kindOf(b)||a-b).map(tile=>({type:"discard" as const,tile}));m.candidateIndex=-1;
      return {description:`打牌候補 ${m.candidates.length} 件`,port:"next"};}
    case "MJ_候補移動":{const operation=String(p.mode??"first");
      if(operation==="first")m.candidateIndex=m.candidates.length?0:-1;
      else if(operation==="next")m.candidateIndex++;
      else if(operation!=="end")throw new Error("候補移動modeが不正");
      const ended=m.candidates.length===0||m.candidateIndex<0||m.candidateIndex>=m.candidates.length;
      if(p.output!==undefined)setCounter(m,p.output,ended?1:0);
      return {description:`打牌候補 ${ended?"終了":tileLabel(m.candidates[m.candidateIndex].tile)}`,port:"next"};}
    case "MJ_仮状態評価":{
      if(p.mode==="clear"){m.virtualHand=null;return {description:"仮状態解除",port:"next"};}
      if(p.mode!==undefined&&p.mode!=="discard")throw new Error("仮状態は打牌後のみ対応。鳴き後は未実装");
      const c=m.candidates[m.candidateIndex];if(!c)throw new Error("打牌候補未選択");
      const hand=[...(m.snapshot.hands[m.snapshot.observer_seat] as number[])];const idx=hand.indexOf(c.tile);if(idx<0)throw new Error("候補牌が手牌にありません");hand.splice(idx,1);m.virtualHand=hand;
      return {description:`仮の打牌: ${tileLabel(c.tile)}（実局面は不変更）`,port:"next"};}
    case "MJ_シャンテン入力":{
      if(++m.complexOps>HARD_MAX_COMPLEX)throw new Error("構造計算の安全上限（32回）を超過");
      const hand=m.virtualHand??m.snapshot.hands[m.snapshot.observer_seat] as number[];
      const open=m.snapshot.melds[m.snapshot.observer_seat].length;
      const result=shantenOf(hand,open,String(p.shape??"min"));setCounter(m,p.output,result);
      return {description:`${p.shape??"min"} シャンテン=${result}`,port:"next"};}
    case "MJ_面子分解列挙":{
      if(++m.complexOps>HARD_MAX_COMPLEX)throw new Error("構造計算の安全上限（32回）を超過");
      const hand=m.virtualHand??m.snapshot.hands[m.snapshot.observer_seat] as number[];
      const win=m.snapshot.winning_tile??null;
      m.patterns=decompose(hand,m.snapshot.melds[m.snapshot.observer_seat],win);m.patternIndex=-1;
      if(p.output!==undefined)setCounter(m,p.output,m.patterns.length);
      return {description:`面子分解 ${m.patterns.length} 候補`,port:"next"};}
    case "MJ_面子分解移動":{
      const mode=String(p.mode??"first");if(mode==="first")m.patternIndex=m.patterns.length?0:-1;
      else if(mode==="next")m.patternIndex++;
      else if(mode!=="end")throw new Error("面子分解移動mode不正");
      const ended=m.patternIndex<0||m.patternIndex>=m.patterns.length;
      if(p.output!==undefined)setCounter(m,p.output,ended?1:0);
      return {description:`面子分解 ${ended?"終了":`${m.patternIndex+1}/${m.patterns.length}`}`,port:"next"};}
    case "MJ_面子情報入力":{const value=patternValue(m,p);setCounter(m,p.output,value);return {description:`${p.field} = ${value}`,port:"next"};}
    case "MJ_カウンタ操作":{
      const left=resolveOperand(m,p.left);const right=p.op==="assign"||p.op==="not"?0:resolveOperand(m,p.right);
      const op=String(p.op??"assign");let value:number;
      switch(op){case "assign":value=left;break;case "add":value=left+right;break;case "sub":value=left-right;break;
        case "mul":value=left*right;break;case "div":if(right===0)throw new Error("ゼロ除算");value=left/right;break;
        case "mod":if(right===0)throw new Error("ゼロ剰余");value=left%right;break;case "min":value=Math.min(left,right);break;
        case "max":value=Math.max(left,right);break;case "and":value=(left|0)&(right|0);break;
        case "or":value=(left|0)|(right|0);break;case "xor":value=(left|0)^(right|0);break;
        case "not":value=~(left|0);break;case "shl":value=(left|0)<<(right&31);break;
        case "shr":value=(left|0)>>(right&31);break;
        default:return fail(`未対応の演算子: ${op}`);}
      setCounter(m,p.output,value);return {description:`${p.output} ← ${left} ${op}${op==="assign"||op==="not"?"":" "+right} → ${value}`,port:"next"};}
    case "MJ_カウンタ判断":{
      const left=resolveOperand(m,p.left),right=resolveOperand(m,p.right);const op=String(p.op??"eq");let ok:boolean;
      switch(op){case "eq":ok=left===right;break;case "ne":ok=left!==right;break;case "gt":ok=left>right;break;
        case "ge":ok=left>=right;break;case "lt":ok=left<right;break;case "le":ok=left<=right;break;
        case "bit_all":ok=((left|0)&(right|0))===(right|0);break;
        case "bit_any":ok=(((left|0)&(right|0))!==0);break;
        default:return fail(`未対応の比較子: ${op}`);}
      return {description:`判断: ${left} ${op} ${right} → ${ok?"YES":"NO"}`,port:ok?"yes":"no"};}
    case "MJ_門前・鳴き状態判断": {
      const facts = evaluateMenzenNaki(m.snapshot, p);
      const label = {self:"自家",kamicha:"上家",toimen:"対面",shimocha:"下家"}[facts.target];
      const sign = {eq:"=",ne:"≠",gt:">",ge:"≥",lt:"<",le:"≤"};
      const condition = facts.condition === "has_open" ? "鳴きあり" :
        facts.condition === "menzen" ? "門前維持" : `公開面子数 ${sign[facts.operator!]} ${facts.threshold}`;
      const warning = facts.openFlagConflicts.length ? " / openフラグ不一致あり・面子typeを採用" : "";
      return {
        description: `${label}（席${facts.targetSeat}）: 公開面子${facts.openMeldCount}組・暗槓${facts.concealedKanCount}組は除外 / ${condition} → ${facts.matched?"YES":"NO"}${warning}`,
        port: facts.matched ? "yes" : "no",
        info: { read_only: true, target: facts.target, observer_seat: facts.observerSeat,
          target_seat: facts.targetSeat, open_meld_count: facts.openMeldCount,
          excluded_ankan_count: facts.concealedKanCount, menzen: facts.menzen,
          meld_type_counts: facts.byType, open_flag_conflicts: facts.openFlagConflicts,
          condition: facts.condition, operator: facts.operator, threshold: facts.threshold,
          matched: facts.matched }
      };
    }
    case "MJ_点数算出":{
      const han=resolveOperand(m,p.han),fu=resolveOperand(m,p.fu);const mode=String(p.mode??"ron");const score=scorePoints(han,fu,m.snapshot.dealer===m.snapshot.observer_seat,mode);
      setCounter(m,p.output,score);return {description:`${han}翻 ${fu}符 / ${mode} → ${score}点 (本場・供託別。役成立検査なし)`,port:"next"};}
    case "MJ_行動":{
      const act=String(p.action??"pass");if(!["discard","riichi","tsumo","ron","chi","pon","ankan","kakan","daiminkan","pass","kyushu_kyuhai"].includes(act))throw new Error("未対応の行動");
      const proposal:NonNullable<Machine["action"]>={action:act,seat:m.snapshot.observer_seat};
      if(["discard","riichi","ankan","kakan","daiminkan"].includes(act)){
        let tile:number;
        if(p.tileSource==="candidate"){
          const c=m.candidates[m.candidateIndex];if(!c)throw new Error("行動候補がありません");tile=c.tile;
        }else tile=asInt(p.tile,"行動牌");
        if(!validTile(tile))throw new Error("行動牌IDが不正");proposal.tile=tile;
      }
      if(act==="riichi"){proposal.action="discard";proposal.riichi=true;}
      // Engine proposal only: no game state mutation, legality check, or action submission.
      m.action=proposal;m.status="action";m.message="行動提案を作成（未送信・合法性未検証）";
      return {description:`行動提案: ${act} (対局へ未送信)`,port:"stop"};}
    default:return fail(`未実装チップ: ${n.type}`);
  }
}
export function stepMachine(m:Machine): TraceEntry|null {
  if(m.status==="completed"||m.status==="action"||m.status==="error"||m.status==="step_limit")return null;
  const maxSteps=Math.min(HARD_MAX_STEPS,m.program.limits?.maxSteps??500);
  if(m.steps>=maxSteps){m.status="step_limit";m.error=`安全停止: ${maxSteps}ステップ上限`;m.message=m.error;return null;}
  const node=m.program.nodes.find(n=>n.id===m.pc);
  if(!node){m.status="error";m.error=`ノード ${m.pc} 不在`;m.message=m.error;return null;}
  const before=Object.fromEntries(Object.entries(m.counters).map(([k,v])=>[k,v.value]));
  m.status="running";let result:ReturnType<typeof compute>;
  try{result=compute(m,node);
    if(result.port==="return")m.pc=m.callStack.pop()!;
    else if(result.port==="stop")m.pc=null;
    else{
      const to=node.routes[result.port];if(!to)throw new Error(`${node.type} (${node.id}) の ${result.port} 接続先がありません`);
      m.pc=to;
    }
  }catch(e){m.status="error";m.error=e instanceof Error?e.message:String(e);m.message=`${node.id}: ${m.error}`;
    result={description:`診断停止: ${m.error}`,port:"stop"};m.pc=null;}
  m.steps++;
  const changes=Object.entries(m.counters).filter(([k,v])=>before[k]!==v.value).map(([name,v])=>({name,before:before[name],after:v.value,kind:v.kind}));
  const entry:TraceEntry={step:m.steps,nodeId:node.id,type:node.type,description:result.description,route:result.port,nextNode:m.pc,
    changes,counters:Object.fromEntries(Object.entries(m.counters).map(([k,v])=>[k,v.value])),info:result.info};
  m.trace.push(entry);return entry;
}
export function runProgram(program:ProgramV1,snapshot:MuseSnapshot):Machine {
  const m=newMachine(program,snapshot);
  while(m.status==="ready"||m.status==="running")stepMachine(m);
  return m;
}
