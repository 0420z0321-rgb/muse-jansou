/**
 * server.py の移植（HTTP 層を除くゲームロジック全体）。
 *
 * - 局/半荘の状態機械、合法手提示（decisions）、反応窓、鳴き、リーチ、
 *   一時フリテン、素打ち raw（hidden truth）、持ち時間制・遅延 settle。
 * - 状態は Python 版と同じ形のプレーンなオブジェクトとして保持し、
 *   公開関数の名前・意味論を揃える。
 * - 時刻は setNowMs で注入可能（Python の _now_ms 差し替え相当）。
 * - 山の生成は Python 互換 MT19937（rng.ts）で Python 版と同一牌順。
 */
import { countsOf as baseCountsOf, removeOne, tileName as baseTileName } from "./engine.ts";
import { countDora, doraFromIndicator } from "./dora.ts";
import {
  findPatterns,
  isMenzen,
  kindOf,
  isTerminalOrHonor,
  payments,
  scoreHand,
  winningTilesMelds,
  type ScoreResult,
  type ScoreContext,
  type ServerMeld,
} from "./yaku.ts";
import { PythonRandom } from "./rng.ts";

export const DORA_SLOTS = [0, 2, 4, 6, 8] as const;
export const URA_SLOTS = [1, 3, 5, 7, 9] as const;
export const RINSHAN_SLOTS = [10, 11, 12, 13] as const;

/** Boundary to the legacy 34-kind utilities: never pass physical red codes. */
function countsOf(tiles: readonly number[]): number[] {
  return baseCountsOf(tiles.map(kindOf));
}

/** Existing public name arrays remain valid for codes 34..36. */
function tileName(code: number): string {
  const kind = kindOf(code);
  const name = baseTileName(kind);
  return kind === code ? name : `赤${name}`;
}

/** Always retain physical codes when moving tiles into a meld or discarding. */
function takeTilesOfKind(tiles: number[], kind: number, count: number): number[] {
  // Prefer ordinary physical tiles before red ones when an implicit pon/kan
  // consumes matching kinds (existing public call API has no pon selection).
  const chosen = tiles.filter(t => kindOf(t) === kind).sort((a, b) => a - b).slice(0, count);
  if (chosen.length !== count) throw new Error("missing tiles of kind");
  for (const code of chosen) removeOne(tiles, code);
  return chosen;
}

/** For hands and chi-melds, preserve kind-order while exposing real codes. */
function physicalTileOrder(a: number, b: number): number {
  return kindOf(a) - kindOf(b) || a - b;
}

// ---- 時刻注入（Python の _now_ms 差し替え相当） ----
let nowProvider: () => number = () => Date.now();
export function setNowMs(fn: (() => number) | null): void {
  nowProvider = fn ?? (() => Date.now());
}
export function nowMs(): number {
  return Math.floor(nowProvider());
}

// ---- 型 ----
export interface ClockConfig {
  main_ms: number;
  discard_ms: number;
  reaction_ms: number;
  byoyomi_ms: number;
}

export const CLOCK_PRESETS: Record<string, ClockConfig> = {
  standard: {
    main_ms: 30 * 60000,
    discard_ms: 5 * 60000,
    reaction_ms: 3 * 60000,
    byoyomi_ms: 20000,
  },
  relaxed: {
    main_ms: 60 * 60000,
    discard_ms: 10 * 60000,
    reaction_ms: 5 * 60000,
    byoyomi_ms: 20000,
  },
  trial: {
    main_ms: 15 * 60000,
    discard_ms: 3 * 60000,
    reaction_ms: 2 * 60000,
    byoyomi_ms: 20000,
  },
  // Patrol-room sprint: a short 2-minute bank per match, then a hard
  // 15-second byoyomi. Deadlines are server-enforced, so the pace no
  // longer depends on how often each player checks in.
  sprint: {
    main_ms: 2 * 60000,
    discard_ms: 2 * 60000,
    reaction_ms: 2 * 60000,
    byoyomi_ms: 15000,
  },
};

export interface Ruleset {
  mode: "judged" | "raw";
  scoring_policy: "practice" | "trial";
  clock: { enabled: boolean; preset: string };
  /** Replace one ordinary five per suit with a distinct red physical tile. */
  aka: boolean;
  match_length: "east" | "south";
}

export interface ClockState {
  config: ClockConfig;
  remaining_ms: number[];
}

export interface GameMeld extends ServerMeld {
  called_tile: number | null;
  from_seat: number | null;
}

export interface Discard {
  tile: number;
  tsumogiri: boolean;
  called_by: number | null;
}

export interface GameEvent {
  type: string;
  seat?: number | null;
  [key: string]: unknown;
}

export interface Actor {
  name: string;
  icon: string;
  avatar_url: string;
}

export interface CallCand {
  type: string;
  consume?: number[];
}

export interface PendingWin {
  winner: number;
  win_type: string;
  from_seat: number | null;
  result: ScoreResult;
}

export interface LastHandResult {
  win_type: string;
  winner: number | null;
  from_seat: number | null;
  detail: unknown;
  round: string;
  honba: number;
  dealer: number;
  hand_index: number;
  tenpai?: boolean[];
  [key: string]: unknown;
}

export interface Timing {
  deadline: number;
  phase: string;
  /** Rotation grace: free milliseconds added to this deadline (not charged). */
  grace_ms?: number;
}

export interface Game {
  // Match層
  scores: number[];
  dealer: number;
  round_wind: number;
  hand_number: number;
  honba: number;
  hand_index: number;
  base_seed: number | null;
  match_status: string;
  end_reason: string | null;
  ranking: number[] | null;
  last_hand_result: LastHandResult | null;
  match_log: Record<string, unknown>[];
  revision: number;
  decision_seq: number;
  actors: (Actor | null)[];
  ruleset: Ruleset;
  events: GameEvent[];
  riichi_sticks: number;
  clock_log: Record<string, unknown>[];
  clock: ClockState | null;
  // 局の状態
  wall: number[];
  dead_wall: number[];
  dora_count: number;
  hands: number[][];
  discards: Discard[][];
  turn: number;
  phase: string;
  pending: { seat: number; tile: number } | null;
  winner: number | null;
  win_type: string | null;
  from_seat: number | null;
  turn_count: number;
  last_drawn: number | null;
  decision_id: string | null;
  decision_base_revision: number;
  eligible: number[];
  responses: Record<number, unknown>;
  riichi: boolean[];
  /** 局単位の状況役。旧保存状態には無い場合があるため ensureYakuFlags で復元する。 */
  ippatsu?: boolean[];
  double_riichi?: boolean[];
  calls_made?: boolean;
  live_draw_counts?: number[];
  last_draw_rinshan?: boolean;
  last_draw_haitei?: boolean;
  pending_houtei?: boolean;
  /** 進行追加：槓の宣言（槍槓解決まで未確定）と即時食い替え禁止牌。 */
  pending_kan?: { seat: number; tile: number; type: "ankan" | "kakan" } | null;
  kuikae_forbidden?: number[];
  win_detail: unknown;
  pending_win: PendingWin | null;
  melds: GameMeld[][];
  rinshan_used: number;
  call_cands: Record<number, CallCand[]>;
  temp_furiten: boolean[];
  riichi_furiten: boolean[];
  dec_opened_at: number | null;
  dec_deadlines: Record<number, Timing>;
  // 内部用（Python 版の g["_settling"] / g["_timeout_seat"]）
  _settling?: boolean;
  _timeout_seat?: number | null;
}

export type ActionBody = {
  seat?: unknown;
  action?: string;
  tile?: unknown;
  riichi?: unknown;
  consume?: unknown;
  decision_id?: unknown;
  expected_revision?: unknown;
  actor?: unknown;
  han?: unknown;
  fu?: unknown;
  payments?: unknown;
  [key: string]: unknown;
};

export type ActionResult = { ok: true } | { error: string };

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);

// ---- ルールセット・時計の初期化 ----

export function normRuleset(r?: Partial<Ruleset> | null): Ruleset {
  const src = (r ?? {}) as Record<string, unknown>;
  const mode = src.mode === "raw" || src.mode === "judged" ? src.mode : "judged";
  const pol =
    src.scoring_policy === "practice" || src.scoring_policy === "trial"
      ? src.scoring_policy
      : "practice";
  const clockIn = (src.clock ?? {}) as Record<string, unknown>;
  const preset =
    typeof clockIn.preset === "string" && clockIn.preset in CLOCK_PRESETS
      ? clockIn.preset
      : "standard";
  return {
    // Preserve other owner-supplied ruleset options (e.g. match_length) when
    // present, without changing the latest supplied engine's progression code.
    ...src,
    mode: mode as Ruleset["mode"],
    scoring_policy: pol as Ruleset["scoring_policy"],
    clock: { enabled: Boolean(clockIn.enabled), preset },
    aka: src.aka === true,
    match_length: src.match_length === "east" ? "east" : "south",
  };
}

function initClock(ruleset: Ruleset): ClockState | null {
  if (!ruleset.clock.enabled) return null;
  const cfg = { ...CLOCK_PRESETS[ruleset.clock.preset] };
  return { config: cfg, remaining_ms: [cfg.main_ms, cfg.main_ms, cfg.main_ms, cfg.main_ms] };
}

export function roundLabel(g: Game): string {
  return `${"東南"[g.round_wind]}${g.hand_number}局`;
}

// ---- Match / 局の開始 ----

/** 保存済みの旧Game JSONには追加フィールドが無い。未定義なら安全に初期化。 */
function ensureYakuFlags(g: Game): void {
  if (!Array.isArray(g.ippatsu) || g.ippatsu.length !== 4) g.ippatsu = [false, false, false, false];
  if (!Array.isArray(g.double_riichi) || g.double_riichi.length !== 4) g.double_riichi = [false, false, false, false];
  if (!Array.isArray(g.live_draw_counts) || g.live_draw_counts.length !== 4) {
    // 旧進行中の対局を「初ツモ」と誤認しないため既存履歴から最低回数を復元。
    g.live_draw_counts = [0, 1, 2, 3].map(s => Math.max(1, g.discards[s].length));
  }
  if (typeof g.calls_made !== "boolean") g.calls_made = g.melds.some(ms => ms.length > 0);
  if (typeof g.last_draw_rinshan !== "boolean") g.last_draw_rinshan = false;
  if (typeof g.last_draw_haitei !== "boolean") g.last_draw_haitei = false;
  if (typeof g.pending_houtei !== "boolean") g.pending_houtei = false;
  if (g.pending_kan === undefined) g.pending_kan = null;
  if (!Array.isArray(g.kuikae_forbidden)) g.kuikae_forbidden = [];
}

export function newGame(
  seed: number | null = null,
  ruleset?: Partial<Ruleset> | null,
): Game {
  const g: Game = {
    scores: [25000, 25000, 25000, 25000],
    dealer: 0,
    round_wind: 0,
    hand_number: 1,
    honba: 0,
    hand_index: 0,
    base_seed: seed,
    match_status: "playing",
    end_reason: null,
    ranking: null,
    last_hand_result: null,
    match_log: [],
    revision: 0,
    decision_seq: 0,
    actors: [null, null, null, null],
    ruleset: normRuleset(ruleset),
    events: [],
    riichi_sticks: 0,
    clock_log: [],
    clock: null,
    wall: [],
    dead_wall: [],
    dora_count: 1,
    hands: [[], [], [], []],
    discards: [[], [], [], []],
    turn: 0,
    phase: "discard",
    pending: null,
    winner: null,
    win_type: null,
    from_seat: null,
    turn_count: 0,
    last_drawn: null,
    decision_id: null,
    decision_base_revision: 0,
    eligible: [],
    responses: {},
    riichi: [false, false, false, false],
    ippatsu: [false, false, false, false],
    double_riichi: [false, false, false, false],
    calls_made: false,
    live_draw_counts: [0, 0, 0, 0],
    last_draw_rinshan: false,
    last_draw_haitei: false,
    pending_houtei: false,
    pending_kan: null,
    kuikae_forbidden: [],
    win_detail: null,
    pending_win: null,
    melds: [[], [], [], []],
    rinshan_used: 0,
    call_cands: {},
    temp_furiten: [false, false, false, false],
    riichi_furiten: [false, false, false, false],
    dec_opened_at: null,
    dec_deadlines: {},
  };
  g.clock = initClock(g.ruleset);
  startHand(g);
  return g;
}

export function startHand(g: Game): void {
  const seed =
    g.base_seed === null ? null : g.base_seed + g.hand_index;
  const rng = new PythonRandom(seed);
  const wall: number[] = [];
  for (let t = 0; t < 34; t++) for (let k = 0; k < 4; k++) {
    // Exactly one red five in each suit. No RNG change when aka is off.
    const redCode = t === 4 ? 34 : t === 13 ? 35 : t === 22 ? 36 : null;
    wall.push(g.ruleset.aka === true && k === 0 && redCode !== null ? redCode : t);
  }
  rng.shuffle(wall);
  const deadWall = wall.slice(-14); // 王牌（ドラ表示・裏ドラ・嶺上の領域）
  const liveWall = wall.slice(0, wall.length - 14);
  const hands: number[][] = [];
  for (let s = 0; s < 4; s++) {
    const h: number[] = [];
    for (let k = 0; k < 13; k++) h.push(liveWall.pop()!);
    h.sort(physicalTileOrder);
    hands.push(h);
  }
  g.wall = liveWall;
  g.dead_wall = deadWall;
  g.dora_count = 1;
  g.hands = hands;
  g.discards = [[], [], [], []];
  g.turn = g.dealer;
  g.phase = "discard";
  g.pending = null;
  g.winner = null;
  g.win_type = null;
  g.from_seat = null;
  g.turn_count = 0;
  g.last_drawn = null;
  g.decision_id = null;
  g.decision_base_revision = g.revision;
  g.eligible = [];
  g.responses = {};
  g.riichi = [false, false, false, false];
  g.ippatsu = [false, false, false, false];
  g.double_riichi = [false, false, false, false];
  g.calls_made = false;
  g.live_draw_counts = [0, 0, 0, 0];
  g.last_draw_rinshan = false;
  g.last_draw_haitei = false;
  g.pending_houtei = false;
  g.pending_kan = null;
  g.kuikae_forbidden = [];
  g.win_detail = null;
  g.pending_win = null;
  g.melds = [[], [], [], []];
  g.rinshan_used = 0;
  g.call_cands = {};
  g.temp_furiten = [false, false, false, false];
  g.riichi_furiten = [false, false, false, false];
  g.dec_opened_at = null;
  g.dec_deadlines = {};
  g.match_log.push({
    type: "hand_started",
    hand_index: g.hand_index,
    round: roundLabel(g),
    honba: g.honba,
    dealer: g.dealer,
    kyotaku: g.riichi_sticks,
  });
  drawTile(g);
}

export function newDecision(g: Game, kind: string): void {
  g.decision_seq += 1;
  g.decision_id = `${kind}_${String(g.decision_seq).padStart(6, "0")}`;
  g.decision_base_revision = g.revision;
  armClock(g);
}

export function drawTile(g: Game): void {
  ensureYakuFlags(g);
  if (g.wall.length === 0) {
    settleDraw(g);
    return;
  }
  g.temp_furiten[g.turn] = false; // 自分のツモで同巡フリテン解除
  g.hands[g.turn].push(g.wall.pop()!);
  g.last_draw_rinshan = false;
  g.last_draw_haitei = g.wall.length === 0;
  g.pending_houtei = false;
  g.kuikae_forbidden = [];
  g.live_draw_counts![g.turn] += 1;
  g.last_drawn = g.hands[g.turn][g.hands[g.turn].length - 1];
  g.hands[g.turn].sort(physicalTileOrder);
  g.turn_count += 1;
  g.phase = "discard";
  g.revision += 1;
  newDecision(g, "d");
  if (g.ruleset.mode === "raw") {
    const seat = g.turn;
    if (scoreInternal(g, seat, g.hands[seat], g.last_drawn, "tsumo").valid) {
      record(g, { type: "tsumo_opportunity", seat });
    }
  }
}

/** 九種九牌：第一自摸・まだ副露/槓なし・九種以上の么九牌。 */
export function canDeclareKyushu(g: Game, seat: number): boolean {
  ensureYakuFlags(g);
  return g.phase === "discard" && g.turn === seat && g.last_drawn !== null &&
    g.live_draw_counts![seat] === 1 && g.discards[seat].length === 0 &&
    !g.calls_made && new Set(g.hands[seat].filter(isTerminalOrHonor)).size >= 9;
}

/** 四風連打は最後の捨牌に対するロンを優先してから確定する。 */
function isSuufonRenda(g: Game): boolean {
  if (g.calls_made || !g.discards.every(ds => ds.length === 1)) return false;
  const first = kindOf(g.discards[0][0].tile);
  return first >= 27 && first <= 30 &&
    g.discards.every(ds => kindOf(ds[0].tile) === first && ds[0].called_by === null);
}

function kansBySeat(g: Game): number[] {
  return g.melds.map(ms => ms.filter(m =>
    m.type === "ankan" || m.type === "kakan" || m.type === "daiminkan").length);
}

/** 四槓散了：4槓が複数席に分かれた場合だけ中断。一席の四槓子は続行。 */
function isSuukanSansou(g: Game): boolean {
  const counts = kansBySeat(g);
  return counts.reduce((a, b) => a + b, 0) === 4 && Math.max(...counts) < 4;
}

/** 途中流局：親継続・供託維持・本場+1。既存 last_hand_result を維持した追加種別。 */
export function abortHand(g: Game, reason: string, seat: number | null = null): void {
  const detail = { reason, seat };
  g.pending = null;
  g.pending_kan = null;
  g.pending_win = null;
  g.win_type = "abortive_draw";
  g.winner = null;
  g.win_detail = detail;
  g.last_hand_result = {
    win_type: "abortive_draw", winner: null, from_seat: null, detail,
    round: roundLabel(g), honba: g.honba, dealer: g.dealer, hand_index: g.hand_index,
  };
  g.match_log.push({ type: "hand_finished", result: "abortive_draw", reason,
    seat, scores_after: [...g.scores] });
  record(g, { type: "abortive_draw", reason, seat });
  g.revision += 1;
  g.honba += 1;
  g.hand_index += 1;
  startHand(g);
}

/** 鳴いた直後の、同一牌とスジ食い替え禁止。字牌のポンは同一牌のみ。 */
function forbiddenAfterCall(tile: number, kind: string, consume?: number[]): number[] {
  const called = kindOf(tile);
  // The ban is a set of kinds; a red five never bypasses kuikae.
  const banned = new Set<number>([called]);
  if (kind === "chi" && consume && consume.length === 2) {
    const [a, b] = consume.map(kindOf).sort((x, y) => x - y);
    for (let t = 0; t < 27; t++) {
      if (t === called || Math.floor(kindOf(t) / 9) !== Math.floor(a / 9)) continue;
      if ([a, b, t].sort((x, y) => x - y).every((v, i, arr) => v === arr[0] + i)) {
        banned.add(t);
      }
    }
  }
  return [...banned];
}

/** リーチ後暗槓：ツモ牌そのもの・待ち牌集合不変・元の暗刻面子不変。 */
export function canRiichiAnkan(g: Game, seat: number, tile: number): boolean {
  const kind = kindOf(tile);
  if (!g.riichi[seat] || g.last_drawn === null || kindOf(g.last_drawn) !== kind ||
      g.hands[seat].filter(t => kindOf(t) === kind).length !== 4) return false;
  const original13 = [...g.hands[seat]];
  original13.splice(original13.indexOf(g.last_drawn), 1);
  const before = winningTilesMelds(countsOf(original13), 4 - g.melds[seat].length);
  if (!before.length) return false;
  const after = [...g.hands[seat]];
  takeTilesOfKind(after, kind, 4);
  const later = winningTilesMelds(countsOf(after), 3 - g.melds[seat].length);
  if (before.length !== later.length || before.some((t, i) => t !== later[i])) return false;
  // 立直時に刻子だったことを分解で保証。七対子・国士からの暗槓は不可。
  for (const wait of before) {
    const complete = countsOf([...original13, wait]);
    const patterns = findPatterns(complete, 4 - g.melds[seat].length);
    if (!patterns.length || !patterns.every(([, ms]) =>
      ms.some(m => m.kind === "tri" && m.start === kind))) return false;
  }
  return true;
}

/** 槍槓はフリテンを守る。暗槓では国士無双だけを許可。 */
function canRobKan(g: Game, seat: number, tile: number, kind: "ankan" | "kakan"): boolean {
  if (g.temp_furiten[seat] || g.riichi_furiten[seat]) return false;
  const shape = canRonShape(g, seat, tile);
  if (!shape) return false;
  if (kind === "kakan") return true;
  return (scoreInternal(g, seat, [...g.hands[seat], tile], tile, "ron").yaku ?? [])
    .includes("国士無双");
}

/** 槍槓受付後、または受付者なしで槓を確定する。 */
function commitKan(g: Game): void {
  const pending = g.pending_kan;
  if (!pending) throw new Error("missing pending kan");
  const { seat, tile, type } = pending;
  if (type === "ankan") {
    const consumed = takeTilesOfKind(g.hands[seat], kindOf(tile), 4);
    g.melds[seat].push({ type: "ankan", tiles: consumed.sort(physicalTileOrder),
      called_tile: null, from_seat: null, open: false });
  } else {
    const idx = g.melds[seat].findIndex(m => m.type === "pon" && kindOf(m.tiles[0]) === kindOf(tile));
    if (idx < 0) throw new Error("kakan pon disappeared");
    removeOne(g.hands[seat], tile);
    g.melds[seat][idx].type = "kakan";
    g.melds[seat][idx].tiles.push(tile);
  }
  g.pending_kan = null;
  g.pending = null;
  g.responses = {};
  g.eligible = [];
  g.call_cands = {};
  g.kuikae_forbidden = [];
  g.turn = seat;
  g.phase = "discard";
  g.dora_count += 1;
  g.revision += 1;
  if (isSuukanSansou(g)) {
    abortHand(g, "suukan_sansou");
    return;
  }
  rinshanDraw(g, seat);
}

/** 槓をまだ確定せず、他家の槍槓を優先する。 */
function declareKan(g: Game, seat: number, tile: number, type: "ankan" | "kakan"): void {
  g.pending_kan = { seat, tile, type };
  g.pending = { seat, tile };
  g.phase = "reaction";
  g.call_cands = {};
  const order = [1, 2, 3].map(k => (seat + k) % 4);
  const eligible = order.filter(s => canRobKan(g, s, tile, type));
  if (!isRaw(g) && !eligible.length) {
    commitKan(g);
    return;
  }
  for (const s of eligible) g.call_cands[s] = [{ type: "ron" }];
  g.eligible = isRaw(g) ? order : eligible;
  g.responses = {};
  g.phase = "reaction";
  g.revision += 1;
  newDecision(g, "r");
}

/** 槍槓反応：ロンなら槓は成立せず、誰もロンしなければ槓を確定する。 */
function resolveKanReaction(g: Game): void {
  const declared = g.pending_kan!;
  const ronSeats = g.eligible.filter(seat => {
    const response = g.responses[seat];
    return isRaw(g) ? response === "declare" :
      response !== null && typeof response === "object" &&
      (response as CallCand).type === "ron";
  });
  if (ronSeats.length) {
    const winner = ronSeats[0]; // 現行の頭ハネルール
    const result = scoreInternal(g, winner, [...g.hands[winner], declared.tile],
      declared.tile, "ron");
    if (!canRobKan(g, winner, declared.tile, declared.type) || !result.valid) {
      chombo(g, winner, "false_win");
    } else if (isRaw(g)) {
      enterScoring(g, winner, "ron", declared.seat, result);
    } else {
      finishHand(g, winner, "ron", declared.seat, result);
    }
    return;
  }
  commitKan(g);
}

/** 最終捨牌の反応が全部終わった後で四風連打を確定する。 */
function finishDiscardWithoutRon(g: Game, fromSeat: number): void {
  if (isSuufonRenda(g)) {
    abortHand(g, "suufon_renda");
    return;
  }
  g.pending = null;
  g.responses = {};
  g.eligible = [];
  g.call_cands = {};
  g.turn = (fromSeat + 1) % 4;
  drawTile(g);
}

export function isRaw(g: Game): boolean {
  return g.ruleset.mode === "raw";
}

export function record(g: Game, event: GameEvent): void {
  g.events.push(event);
}

export function chombo(g: Game, seat: number, kind: string): void {
  g.pending = null;
  g.pending_win = null;
  g.win_detail = { chombo_seat: seat, kind };
  g.last_hand_result = {
    win_type: "chombo",
    winner: null,
    from_seat: null,
    detail: { chombo_seat: seat, kind },
    round: roundLabel(g),
    honba: g.honba,
    dealer: g.dealer,
    hand_index: g.hand_index,
  };
  g.match_log.push({
    type: "hand_finished",
    result: "chombo",
    chombo_seat: seat,
    kind,
    scores_after: [...g.scores],
  });
  g.revision += 1;
  record(g, { type: "chombo", seat, kind });
  g.honba += 1;
  g.hand_index += 1;
  startHand(g);
}

export function enterScoring(
  g: Game,
  winner: number,
  winType: string,
  fromSeat: number | null,
  result: ScoreResult,
): void {
  g.pending = null;
  g.responses = {};
  g.eligible = [];
  g.phase = "scoring";
  g.pending_win = {
    winner,
    win_type: winType,
    from_seat: fromSeat,
    result,
  };
  g.revision += 1;
  newDecision(g, "s");
}

export function paymentsMatch(
  claim: unknown,
  truth: ScoreResult["payments"],
  winType: string,
): boolean {
  if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
    return false;
  }
  const c = claim as Record<string, unknown>;
  const t = (truth ?? {}) as Record<string, unknown>;
  let keys: string[];
  if (winType === "ron") keys = ["ron"];
  else if (t.tsumo_all !== undefined) keys = ["tsumo_all"];
  else keys = ["tsumo_dealer", "tsumo_other"];
  return keys.every((k) => c[k] === t[k]);
}

export interface RawReviewSeat {
  ron_opportunities: number;
  missed_ron: number;
  missed_ron_rate: number | null;
  tsumo_opportunities: number;
  missed_tsumo: number;
  missed_tsumo_rate: number | null;
  declare_wins: number;
  false_wins: number;
  score_errors: number;
  score_error_rate: number | null;
}

export function rawReview(g: Game): {
  events: GameEvent[];
  seats: Record<string, RawReviewSeat>;
} {
  const ev = g.events;
  const cnt = (t: string, seat: number) =>
    ev.filter((e) => e.type === t && e.seat === seat).length;
  const seats: Record<string, RawReviewSeat> = {};
  for (let s = 0; s < 4; s++) {
    const ronOpp = cnt("ron_opportunity", s);
    const tsumoOpp = cnt("tsumo_opportunity", s);
    const scored = cnt("win_scored", s);
    seats[String(s)] = {
      ron_opportunities: ronOpp,
      missed_ron: cnt("missed_ron", s),
      missed_ron_rate: ronOpp ? cnt("missed_ron", s) / ronOpp : null,
      tsumo_opportunities: tsumoOpp,
      missed_tsumo: cnt("missed_tsumo", s),
      missed_tsumo_rate: tsumoOpp ? cnt("missed_tsumo", s) / tsumoOpp : null,
      declare_wins: cnt("declare_win", s),
      false_wins: ev.filter(
        (e) => e.type === "chombo" && e.seat === s && e.kind === "false_win",
      ).length,
      score_errors: cnt("score_error", s),
      score_error_rate: scored ? cnt("score_error", s) / scored : null,
    };
  }
  return { events: ev, seats };
}

export function doraIndicators(g: Game): number[] {
  const out: number[] = [];
  for (let i = 0; i < g.dora_count; i++) out.push(g.dead_wall[DORA_SLOTS[i]]);
  return out;
}

export function uraIndicators(g: Game): number[] {
  const out: number[] = [];
  for (let i = 0; i < g.dora_count; i++) out.push(g.dead_wall[URA_SLOTS[i]]);
  return out;
}

/** 役判定→ドラ加算の順で評価。自風・場風・親子は dealer から計算。 */
export function scoreInternal(
  g: Game,
  seat: number,
  hand: readonly number[],
  winTile: number,
  winType: string,
): ScoreResult {
  ensureYakuFlags(g);
  const melds = g.melds[seat];
  const dealer = g.dealer;
  const isTsumo = winType === "tsumo";
  const isRon = winType === "ron";
  const firstSelfLiveDraw = g.live_draw_counts![seat] === 1 && g.discards[seat].length === 0;
  const yakuContext: ScoreContext = {
    ippatsu: g.riichi[seat] && g.ippatsu![seat],
    double_riichi: g.riichi[seat] && g.double_riichi![seat],
    haitei: isTsumo && g.last_draw_haitei && !g.last_draw_rinshan,
    houtei: isRon && g.pending_houtei && g.pending !== null,
    rinshan: isTsumo && g.last_draw_rinshan,
    tenhou: isTsumo && seat === dealer && firstSelfLiveDraw &&
      !g.calls_made && g.discards.every(ds => ds.length === 0) && !g.last_draw_rinshan,
    // 地和：子の第1ツモまで誰の鳴き・槓も入っていないこと。
    // 親の最初の捨て牌は妨げない（天和の無捨て牌条件とは異なる）。
    chiihou: isTsumo && seat !== dealer && firstSelfLiveDraw &&
      !g.calls_made && !g.last_draw_rinshan,
    chankan: isRon && g.phase === "reaction" && g.pending_kan?.type === "kakan",
  };
  const base = scoreHand(
    hand,
    winTile,
    winType,
    (((seat - dealer) % 4) + 4) % 4,
    g.round_wind,
    g.riichi[seat],
    melds,
    yakuContext,
  );
  if (!base.valid) return base;
  if (base.yakuman === 1 && !(base.yaku ?? []).includes("数え役満")) {
    // 本役満のみ：通常役・ドラ・裏ドラを完全に除外し、複合も1倍。
    // 数え役満は下でドラを合算し、元の内訳を保持する。
    return { ...base, han: 13, fu: 0, yakuman: 1,
      yaku_han: 13, dora: 0, ura_dora: 0, ura_indicator_names: [],
      payments: payments(13, 0, winType, seat === dealer) };
  }
  const allTiles = [...hand, ...melds.flatMap((m) => m.tiles)];
  // Indicators and winning tiles are kinds for normal/ura/kan dora.
  // Red physical tiles add one additional dora each, even when the indicated
  // normal dora happens to be another five of the same suit.
  const kinds = allTiles.map(kindOf);
  const akaDora = allTiles.filter(code => code === 34 || code === 35 || code === 36).length;
  const dora = countDora(kinds, doraIndicators(g).map(kindOf)) + akaDora;
  const ura = g.riichi[seat] ? countDora(kinds, uraIndicators(g).map(kindOf)) : 0;
  const totalHan = base.han! + dora + ura;
  const out: ScoreResult = { ...base };
  out.yaku_han = base.han;
  out.dora = dora;
  out.ura_dora = ura;
  out.han = totalHan;
  if (totalHan >= 13) {
    // 数え役満は13翻以上を一律1倍の役満打点にする（翻内訳は保持）。
    out.yakuman = 1;
    if (!(out.yaku ?? []).includes("数え役満")) {
      out.yaku = [...(out.yaku ?? []), "数え役満"];
    }
  }
  out.payments = payments(totalHan, base.fu!, winType, seat === dealer);
  out.ura_indicator_names = g.riichi[seat]
    ? uraIndicators(g).map((t) => tileName(t))
    : [];
  return out;
}

export function finishHand(
  g: Game,
  winner: number,
  winType: string,
  fromSeat: number | null = null,
  result: ScoreResult | null = null,
): void {
  const dealer = g.dealer;
  const honba = g.honba;
  const sticks = g.riichi_sticks * 1000;
  g.riichi_sticks = 0;
  const res = result as ScoreResult;
  if (winType === "ron") {
    const pay = res.payments!.ron! + honba * 300;
    g.scores[fromSeat!] -= pay;
    g.scores[winner] += pay + sticks;
  } else if (winType === "tsumo") {
    const p = res.payments!;
    if (winner === dealer) {
      const each = p.tsumo_all! + honba * 100;
      for (let i = 0; i < 4; i++) if (i !== winner) g.scores[i] -= each;
      g.scores[winner] += each * 3 + sticks;
    } else {
      for (let i = 0; i < 4; i++) {
        if (i === winner) continue;
        g.scores[i] -=
          (i === dealer ? p.tsumo_dealer! : p.tsumo_other!) + honba * 100;
      }
      g.scores[winner] += p.total! + honba * 300 + sticks;
    }
  }
  g.winner = winner;
  g.win_type = winType;
  g.from_seat = fromSeat;
  g.win_detail = result;
  g.last_hand_result = {
    win_type: winType,
    winner,
    from_seat: fromSeat,
    detail: result,
    round: roundLabel(g),
    honba,
    dealer,
    hand_index: g.hand_index,
  };
  g.match_log.push({
    type: "hand_finished",
    result: winType,
    winner,
    scores_after: [...g.scores],
  });
  g.revision += 1;
  const dealerContinues = winner === dealer;
  g.honba = dealerContinues ? honba + 1 : 0;
  advanceMatch(g, dealerContinues);
}

/** 流し満貫：河に么九牌1枚以上、全て么九牌、他席から鳴かれていない。 */
function nagashiWinners(g: Game): number[] {
  const seats: number[] = [];
  for (let s = 0; s < 4; s++) {
    const river = g.discards[s];
    if (river.length > 0 && river.every(d =>
      isTerminalOrHonor(d.tile) && d.called_by === null)) seats.push(s);
  }
  return seats;
}

/** 流局のノーテン罰符より優先。複数人なら満貫ツモを席順に独立して精算する。 */
function settleNagashiMangan(g: Game, winners: number[]): void {
  const dealer = g.dealer;
  const honba = g.honba;
  const sticks = g.riichi_sticks * 1000;
  g.riichi_sticks = 0;
  const transfers: Record<string, unknown>[] = [];
  for (const winner of winners) {
    const p = payments(5, 30, "tsumo", winner === dealer);
    if (winner === dealer) {
      const each = p.tsumo_all! + honba * 100;
      for (let s = 0; s < 4; s++) if (s !== winner) g.scores[s] -= each;
      g.scores[winner] += each * 3;
    } else {
      for (let s = 0; s < 4; s++) {
        if (s === winner) continue;
        g.scores[s] -= (s === dealer ? p.tsumo_dealer! : p.tsumo_other!) + honba * 100;
      }
      g.scores[winner] += p.total! + honba * 300;
    }
    transfers.push({ seat: winner, payments: p });
  }
  // 供託は最も番号の小さい流し満貫者が獲得。
  g.scores[winners[0]] += sticks;
  const detail = { winners: [...winners], transfers };
  g.win_type = "nagashi_mangan";
  g.winner = winners.length === 1 ? winners[0] : null;
  g.win_detail = detail;
  g.last_hand_result = { win_type: "nagashi_mangan", winner: g.winner,
    from_seat: null, detail, round: roundLabel(g), honba, dealer,
    hand_index: g.hand_index };
  g.match_log.push({ type: "hand_finished", result: "nagashi_mangan",
    winners: [...winners], scores_after: [...g.scores] });
  record(g, { type: "nagashi_mangan", winners: [...winners] });
  g.revision += 1;
  const dealerContinues = winners.includes(dealer);
  g.honba = dealerContinues ? honba + 1 : 0;
  advanceMatch(g, dealerContinues);
}

export function settleDraw(g: Game): void {
  const nagashi = nagashiWinners(g);
  if (nagashi.length > 0) {
    settleNagashiMangan(g, nagashi);
    return;
  }
  const tenpai = [0, 1, 2, 3].map((s) => waits(g, s).length > 0);
  const n = tenpai.filter(Boolean).length;
  if (n === 1) {
    for (let s = 0; s < 4; s++) g.scores[s] += tenpai[s] ? 3000 : -1000;
  } else if (n === 2) {
    for (let s = 0; s < 4; s++) g.scores[s] += tenpai[s] ? 1500 : -1500;
  } else if (n === 3) {
    for (let s = 0; s < 4; s++) g.scores[s] += tenpai[s] ? 1000 : -3000;
  }
  const dealerContinues = tenpai[g.dealer];
  g.win_type = "draw";
  g.winner = null;
  g.last_hand_result = {
    win_type: "draw",
    winner: null,
    from_seat: null,
    detail: null,
    round: roundLabel(g),
    honba: g.honba,
    dealer: g.dealer,
    hand_index: g.hand_index,
    tenpai,
  };
  g.match_log.push({
    type: "hand_finished",
    result: "draw",
    tenpai,
    scores_after: [...g.scores],
  });
  g.revision += 1;
  g.honba += 1;
  advanceMatch(g, dealerContinues);
}

export function advanceMatch(g: Game, dealerContinues: boolean): void {
  if (g.scores.some((s) => s < 0)) {
    finishMatch(g, "tobi");
    return;
  }
  if (!dealerContinues) {
    if (g.ruleset.match_length === "east" && g.round_wind === 0 && g.hand_number === 4) {
      finishMatch(g, "east4_complete");
      return;
    }
    if (g.round_wind === 1 && g.hand_number === 4) {
      finishMatch(g, "south4_complete");
      return;
    }
    g.dealer = (g.dealer + 1) % 4;
    g.hand_number += 1;
    if (g.hand_number === 5) {
      g.hand_number = 1;
      g.round_wind += 1;
    }
  }
  g.hand_index += 1;
  startHand(g);
}

export function finishMatch(g: Game, reason: string): void {
  if (g.riichi_sticks > 0) {
    let top = 0;
    for (let s = 1; s < 4; s++) {
      // Python: max(range(4), key=(score, -seat)) → 同点は小さい席
      if (g.scores[s] > g.scores[top]) top = s;
    }
    g.scores[top] += g.riichi_sticks * 1000;
    g.riichi_sticks = 0;
  }
  g.match_status = "finished";
  g.end_reason = reason;
  g.phase = "finished";
  g.ranking = [0, 1, 2, 3].sort(
    (a, b) => g.scores[b] - g.scores[a] || a - b,
  );
  g.match_log.push({
    type: "match_finished",
    reason,
    scores: [...g.scores],
    ranking: g.ranking,
  });
  g.revision += 1;
}

/** 副露込みの待ち牌（形だけ）。 */
export function waits(g: Game, seat: number): number[] {
  const counts = countsOf(g.hands[seat]);
  return winningTilesMelds(counts, 4 - g.melds[seat].length);
}

/** 待ち・捨て牌フリテン・役あり（同巡／リーチ後フリテンは見ない）。 */
export function canRonShape(g: Game, seat: number, tile: number): boolean {
  const w = waits(g, seat);
  if (!w.includes(kindOf(tile))) return false;
  const discardTiles = g.discards[seat].map((d) => kindOf(d.tile));
  if (w.some((x) => discardTiles.includes(x))) return false; // 捨て牌フリテン
  const hand = [...g.hands[seat], tile];
  return scoreInternal(g, seat, hand, tile, "ron").valid;
}

/** フリテン全種を満たすロン可否。 */
export function canRon(g: Game, seat: number, tile: number): boolean {
  if (g.temp_furiten[seat] || g.riichi_furiten[seat]) return false;
  return canRonShape(g, seat, tile);
}

/**
 * 各席のロン・鳴き候補。{seat: [action, ...]}（pass は含まない）。
 * リーチ中の席はロンだけ。チーは下家（from_seat の次席）だけ。
 */
export function reactionCandidates(
  g: Game,
  fromSeat: number,
  tile: number,
): Record<number, CallCand[]> {
  const cands: Record<number, CallCand[]> = {};
  for (let s = 0; s < 4; s++) {
    if (s === fromSeat) continue;
    const acts: CallCand[] = [];
    if (canRon(g, s, tile)) acts.push({ type: "ron" });
    if (!g.riichi[s]) {
      const called = kindOf(tile);
      const hand = g.hands[s];
      const n = hand.filter(t => kindOf(t) === called).length;
      if (n >= 3) acts.push({ type: "daiminkan" });
      if (n >= 2) {
        const remainder = [...hand];
        takeTilesOfKind(remainder, called, 2);
        if (remainder.some(t => kindOf(t) !== called)) acts.push({ type: "pon" });
      }
      if (s === (fromSeat + 1) % 4 && called < 27) {
        const suit = Math.floor(called / 9);
        for (const [a, b] of [
          [called - 2, called - 1],
          [called - 1, called + 1],
          [called + 1, called + 2],
        ] as [number, number][]) {
          if (a < 0 || b >= 27 || Math.floor(kindOf(a) / 9) !== suit ||
              Math.floor(kindOf(b) / 9) !== suit) continue;
          // Both a normal five and a red five can be consumed; expose the
          // exact physical-code alternatives in the existing chi consume field.
          const as = hand.filter(t => kindOf(t) === a);
          const bs = hand.filter(t => kindOf(t) === b);
          const used = new Set<string>();
          for (const physicalA of as) for (const physicalB of bs) {
            const signature = `${physicalA},${physicalB}`;
            if (used.has(signature)) continue;
            used.add(signature);
            const remainder = [...hand];
            removeOne(remainder, physicalA);
            removeOne(remainder, physicalB);
            const prohibited = forbiddenAfterCall(tile, "chi", [physicalA, physicalB]);
            if (remainder.some(code => !prohibited.includes(kindOf(code)))) {
              acts.push({ type: "chi", consume: [physicalA, physicalB] });
            }
          }
        }
      }
    }
    if (acts.length > 0) cands[s] = acts;
  }
  return cands;
}

/** 嶺上ツモ：王牌の嶺上スロットから引き、通常山を1枚封印する。 */
export function rinshanDraw(g: Game, seat: number): void {
  ensureYakuFlags(g);
  g.calls_made = true;
  g.ippatsu!.fill(false); // 暗槓・明槓・加槓は全席の一発を消す。
  g.last_draw_rinshan = true;
  g.last_draw_haitei = false;
  g.pending_houtei = false;
  g.kuikae_forbidden = [];
  g.temp_furiten[seat] = false;
  const tile = g.dead_wall[RINSHAN_SLOTS[g.rinshan_used]];
  g.rinshan_used += 1;
  if (g.wall.length > 0) g.wall.shift();
  g.hands[seat].push(tile);
  g.hands[seat].sort(physicalTileOrder);
  g.last_drawn = tile;
  g.turn_count += 1;
  g.revision += 1;
  newDecision(g, "d");
}

/** 鳴き成立：副露を作り、鳴いた席へ打牌権を移す。 */
export function applyCall(
  g: Game,
  caller: number,
  act: { type: string; consume?: number[] },
): void {
  ensureYakuFlags(g);
  g.calls_made = true;
  g.ippatsu!.fill(false); // 他家の鳴きは一発を取り消す。
  g.pending_houtei = false;
  g.last_draw_haitei = false;
  g.last_draw_rinshan = false;
  const fromSeat = g.pending!.seat;
  const tile = g.pending!.tile;
  const kind = act.type;
  const hand = g.hands[caller];
  let meld: GameMeld;
  if (kind === "pon") {
    const consumed = takeTilesOfKind(hand, kindOf(tile), 2);
    meld = {
      type: "pon",
      tiles: [...consumed, tile].sort(physicalTileOrder),
      called_tile: tile,
      from_seat: fromSeat,
      open: true,
    };
  } else if (kind === "daiminkan") {
    const consumed = takeTilesOfKind(hand, kindOf(tile), 3);
    meld = {
      type: "daiminkan",
      tiles: [...consumed, tile].sort(physicalTileOrder),
      called_tile: tile,
      from_seat: fromSeat,
      open: true,
    };
  } else {
    // chi
    for (const t of act.consume!) removeOne(hand, t);
    meld = {
      type: "chi",
      tiles: [...act.consume!, tile].sort(physicalTileOrder),
      called_tile: tile,
      from_seat: fromSeat,
      open: true,
    };
  }
  g.melds[caller].push(meld);
  g.kuikae_forbidden = kind === "pon" || kind === "chi"
    ? forbiddenAfterCall(tile, kind, act.consume) : [];
  g.discards[fromSeat][g.discards[fromSeat].length - 1].called_by = caller;
  g.pending = null;
  g.responses = {};
  g.eligible = [];
  g.call_cands = {};
  g.turn = caller;
  g.phase = "discard";
  g.revision += 1;
  if (kind === "daiminkan") {
    g.dora_count += 1;
    if (isSuukanSansou(g)) {
      abortHand(g, "suukan_sansou");
      return;
    }
    rinshanDraw(g, caller);
  } else {
    g.last_drawn = null;
    newDecision(g, "d");
  }
}

/**
 * 打牌直後：ロン可能者がいれば reaction、いなければ即次家ツモ。
 * 素打ち（raw）ではロン可否を漏らさないため、常に対象全席へ開く。
 */
export function advanceAfterDiscard(g: Game): void {
  const tile = g.pending!.tile;
  const fromSeat = g.pending!.seat;
  const order = [1, 2, 3].map((k) => (fromSeat + k) % 4); // 頭ハネ優先順
  g.call_cands = reactionCandidates(g, fromSeat, tile);
  if (isRaw(g)) {
    for (const s of order) {
      if (canRon(g, s, tile)) {
        record(g, {
          type: "ron_opportunity",
          seat: s,
          tile,
          from_seat: fromSeat,
        });
      }
    }
    g.eligible = order;
    g.phase = "reaction";
    g.responses = {};
    newDecision(g, "r");
    return;
  }
  g.eligible = order.filter((s) => s in g.call_cands);
  if (g.eligible.length === 0) {
    finishDiscardWithoutRon(g, fromSeat);
    return;
  }
  g.phase = "reaction";
  g.responses = {};
  newDecision(g, "r");
}

export function resolveReaction(g: Game): void {
  if (g.pending_kan) {
    resolveKanReaction(g);
    return;
  }
  const fromSeat = g.pending!.seat;
  if (isRaw(g)) {
    const tile = g.pending!.tile;
    const declarations = g.eligible.filter(s => g.responses[s] === "declare");
    if (declarations.length === 3 && declarations.every(s => canRon(g, s, tile))) {
      abortHand(g, "sanchahou");
      return;
    }
    for (const s of g.eligible) {
      // 頭ハネ優先順に宣言を確認
      if (g.responses[s] === "declare") {
        const result = scoreInternal(
          g,
          s,
          [...g.hands[s], tile],
          tile,
          "ron",
        );
        if (!result.valid) chombo(g, s, "false_win");
        else enterScoring(g, s, "ron", fromSeat, result);
        return;
      }
    }
    // 鳴き（宣言がなければ、ポン／大明槓→チーの順で席順に解決）
    for (const kinds of [
      ["pon", "daiminkan"],
      ["chi"],
    ] as string[][]) {
      for (const s of g.eligible) {
        const r = g.responses[s];
        if (
          r !== null &&
          typeof r === "object" &&
          kinds.includes((r as CallCand).type)
        ) {
          applyCall(g, s, r as CallCand);
          return;
        }
      }
    }
    finishDiscardWithoutRon(g, fromSeat);
    return;
  }
  const rons = g.eligible.filter((s) => {
    const r = g.responses[s];
    return (
      r !== null &&
      typeof r === "object" &&
      (r as CallCand).type === "ron"
    );
  });
  if (rons.length === 3) {
    abortHand(g, "sanchahou");
    return;
  }
  if (rons.length > 0) {
    const winner = rons[0];
    const tile = g.pending!.tile;
    const result = scoreInternal(
      g,
      winner,
      [...g.hands[winner], tile],
      tile,
      "ron",
    );
    finishHand(g, winner, "ron", fromSeat, result);
    return;
  }
  for (const kinds of [
    ["pon", "daiminkan"],
    ["chi"],
  ] as string[][]) {
    for (const s of g.eligible) {
      const r = g.responses[s];
      if (
        r !== null &&
        typeof r === "object" &&
        kinds.includes((r as CallCand).type)
      ) {
        applyCall(g, s, r as CallCand);
        return;
      }
    }
  }
  finishDiscardWithoutRon(g, fromSeat);
}

// ---- 合法手提示 ----

export interface DecisionAction {
  id: string;
  type: string;
  tile?: number;
  consume?: number[];
}

export interface Decision {
  decision_id: string | null;
  seat: number;
  actions: DecisionAction[];
}

export function currentDecisions(g: Game): Decision[] {
  const raw = isRaw(g);
  if (g.phase === "discard") {
    const seat = g.turn;
    const acts: DecisionAction[] = [...new Set(g.hands[seat])]
      .sort((a, b) => a - b)
      .map((t) => ({ id: `discard:${t}`, type: "discard", tile: t }));
    if (raw) {
      // 素打ち：ツモ可否は漏らさず、宣言ボタンは常に提示する
      acts.push({ id: "declare_tsumo", type: "declare_tsumo" });
    } else if (
      g.last_drawn !== null &&
      scoreInternal(g, seat, g.hands[seat], g.last_drawn, "tsumo").valid
    ) {
      acts.push({ id: "tsumo", type: "tsumo" });
    }
    // 暗槓・加槓：リーチ中は待ち・面子が変わらない暗槓のみ。
    if (g.dora_count < 5) {
      const counts = countsOf(g.hands[seat]);
      for (let t = 0; t < 34; t++) {
        if (counts[t] === 4) {
          const code = g.hands[seat].find(physical => kindOf(physical) === t)!;
          if (!g.riichi[seat] || canRiichiAnkan(g, seat, code)) {
            acts.push({ id: `ankan:${code}`, type: "ankan", tile: code });
          }
        }
      }
      if (!g.riichi[seat]) for (const m of g.melds[seat]) {
        if (m.type === "pon" && counts[kindOf(m.tiles[0])] >= 1) {
          const code = g.hands[seat].find(physical => kindOf(physical) === kindOf(m.tiles[0]))!;
          acts.push({ id: `kakan:${code}`, type: "kakan", tile: code });
        }
      }
    }
    if (canDeclareKyushu(g, seat)) {
      acts.push({ id: "kyushu_kyuhai", type: "kyushu_kyuhai" });
    }
    const legalDiscards = acts.filter(a => a.type !== "discard" ||
      !g.kuikae_forbidden?.includes(kindOf(a.tile!)));
    return [{ decision_id: g.decision_id, seat, actions: legalDiscards }];
  }
  if (g.phase === "reaction") {
    const callActs = (s: number, skipRon: boolean): DecisionAction[] => {
      const out: DecisionAction[] = [];
      for (const c of g.call_cands[s] ?? []) {
        if (c.type === "ron") {
          if (!skipRon) out.push({ id: "ron", type: "ron" });
        } else if (c.type === "chi") {
          const [a, b] = c.consume!;
          out.push({ id: `chi:${a},${b}`, type: "chi", consume: [a, b] });
        } else {
          out.push({ id: c.type, type: c.type });
        }
      }
      return out;
    };
    if (raw) {
      return g.eligible
        .filter((s) => !(s in g.responses))
        .map((s) => ({
          decision_id: g.decision_id,
          seat: s,
          actions: [
            { id: "declare_ron", type: "declare_ron" },
            { id: "pass", type: "pass" },
            ...callActs(s, true),
          ] as DecisionAction[],
        }));
    }
    return g.eligible
      .filter((s) => !(s in g.responses))
      .map((s) => ({
        decision_id: g.decision_id,
        seat: s,
        actions: [
          ...callActs(s, false),
          { id: "pass", type: "pass" },
        ] as DecisionAction[],
      }));
  }
  if (g.phase === "scoring") {
    return [
      {
        decision_id: g.decision_id,
        seat: g.pending_win!.winner,
        actions: [{ id: "declare_score", type: "declare_score" }],
      },
    ];
  }
  return [];
}

// ---- public_state ----

export function publicState(g: Game): Record<string, unknown> {
  return {
    phase: g.phase,
    turn: g.turn,
    hands: g.hands,
    discards: g.discards,
    scores: g.scores,
    wall_count: g.wall.length,
    dealer: g.dealer,
    honba: g.honba,
    kyotaku: g.riichi_sticks,
    round: {
      wind: g.round_wind === 0 ? "east" : "south",
      number: g.hand_number,
      label: roundLabel(g),
    },
    hand_index: g.hand_index,
    match_status: g.match_status,
    end_reason: g.end_reason,
    ranking: g.ranking,
    last_hand_result: g.last_hand_result,
    match_log: g.match_log,
    clock: g.clock
      ? {
          remaining_ms: g.clock.remaining_ms,
          opened_at: g.dec_opened_at,
          deadlines: Object.fromEntries(
            Object.entries(g.dec_deadlines).map(([s, t]) => [s, t.deadline]),
          ),
          phases: Object.fromEntries(
            Object.entries(g.dec_deadlines).map(([s, t]) => [s, t.phase]),
          ),
        }
      : null,
    clock_log: g.clock_log,
    pending: g.pending,
    winner: g.winner,
    win_type: g.win_type,
    from_seat: g.from_seat,
    turn_count: g.turn_count,
    revision: g.revision,
    decision_id: g.decision_id,
    eligible: g.eligible,
    actors: g.actors,
    responses: Object.fromEntries(
      Object.entries(g.responses).map(([k, v]) => [String(k), v]),
    ),
    decisions: currentDecisions(g),
    can_tsumo:
      g.phase === "discard" &&
      !isRaw(g) &&
      g.last_drawn !== null &&
      scoreInternal(g, g.turn, g.hands[g.turn], g.last_drawn, "tsumo").valid,
    melds: g.melds,
    temp_furiten: g.temp_furiten,
    riichi_furiten: g.riichi_furiten,
    melds_detail: g.melds.map((ms) =>
      ms.map((m) => ({
        type: m.type,
        names: m.tiles.map((t) => tileName(t)),
        open: m.open,
        from_seat: m.from_seat,
      })),
    ),
    ruleset: g.ruleset,
    scoring:
      g.phase === "scoring"
        ? {
            seat: g.pending_win!.winner,
            win_type: g.pending_win!.win_type,
            ura_indicator_names:
              g.pending_win!.result.ura_indicator_names ?? [],
          }
        : null,
    raw_review: isRaw(g) ? rawReview(g) : null,
    riichi: g.riichi,
    riichi_sticks: g.riichi_sticks,
    dora_indicators: doraIndicators(g),
    dora_indicator_names: doraIndicators(g).map((t) => tileName(t)),
    dora_names: doraIndicators(g).map((t) => tileName(doraFromIndicator(kindOf(t)))),
    last_drawn: g.last_drawn,
    win_detail: g.win_detail,
    hand_names: g.hands.map((h) => h.map((t) => tileName(t))),
    discard_names: g.discards.map((ds) => ds.map((d) => tileName(d.tile))),
    discard_detail: g.discards.map((ds) =>
      ds.map((d) => ({
        name: tileName(d.tile),
        tsumogiri: d.tsumogiri,
        called_by: d.called_by,
      })),
    ),
    pending_name: g.pending ? tileName(g.pending.tile) : null,
  };
}

// ---- 持ち時間制（遅延 settle 方式） ----

/** 新しい decision に opened_at と席別 deadline を付ける。 */
export function armClock(g: Game): void {
  g.dec_opened_at = null;
  g.dec_deadlines = {};
  const clock = g.clock;
  if (!clock || !["discard", "reaction", "scoring"].includes(g.phase)) return;
  const cfg = clock.config;
  const now = nowMs();
  let seats: number[];
  let limit: number;
  if (g.phase === "discard") {
    seats = [g.turn];
    limit = cfg.discard_ms;
  } else if (g.phase === "reaction") {
    seats = [...g.eligible];
    limit = cfg.reaction_ms;
  } else {
    seats = [g.pending_win!.winner];
    limit = cfg.discard_ms;
  }
  g.dec_opened_at = now;
  for (const s of seats) {
    const rem = clock.remaining_ms[s];
    if (rem > 0) {
      g.dec_deadlines[s] = {
        deadline: now + Math.min(limit, rem),
        phase: "main",
      };
    } else {
      g.dec_deadlines[s] = {
        deadline: now + cfg.byoyomi_ms,
        phase: "byoyomi",
      };
    }
  }
}

export function chargeClockAt(
  g: Game,
  seat: number,
  opened: number | null,
  timing: Timing | null,
  now: number,
): void {
  const clock = g.clock;
  if (!clock || opened === null || timing === null) return;
  const effective = Math.min(now, timing.deadline);
  const elapsed = Math.max(0, effective - opened);
  const before = clock.remaining_ms[seat];
  let charged = 0;
  if (timing.phase === "main") {
    // Grace time (rotation hand-over) is a gift: it extends the deadline
    // but is never charged against the bank.
    charged = Math.min(Math.max(0, elapsed - (timing.grace_ms ?? 0)), before);
    clock.remaining_ms[seat] = before - charged;
  }
  const timedOut = now >= timing.deadline;
  g.clock_log.push({
    seat,
    phase: timing.phase,
    elapsed_ms: elapsed,
    charged_ms: charged,
    remaining_ms: clock.remaining_ms[seat],
    timed_out: timedOut,
    settle_lag_ms: timedOut ? Math.max(0, now - timing.deadline) : 0,
  });
}

function applyTimeout(g: Game, seat: number): void {
  const timing = g.dec_deadlines[seat] ?? null;
  chargeClockAt(g, seat, g.dec_opened_at, timing, nowMs());
  const phase = g.phase;
  const base = {
    seat,
    decision_id: g.decision_id,
    expected_revision: g.revision,
  };
  if (phase === "discard") {
    let tile = g.last_drawn;
    if (tile === null || g.kuikae_forbidden?.includes(kindOf(tile))) {
      // 鳴き直後も食い替え禁止牌を自動選択しない。
      const legal = [...g.hands[seat]].filter(t => !g.kuikae_forbidden?.includes(kindOf(t)));
      if (!legal.length) throw new Error("no legal timeout discard after call");
      tile = Math.min(...legal);
    }
    applyActionInternal(g, { ...base, action: "discard", tile });
  } else if (phase === "reaction") {
    g._timeout_seat = seat;
    try {
      applyActionInternal(g, { ...base, action: "pass" });
    } finally {
      g._timeout_seat = null;
    }
  } else if (phase === "scoring") {
    const pw = g.pending_win!;
    if (g.ruleset.scoring_policy === "practice") {
      record(g, {
        type: "scoring_timeout",
        seat,
        result: "server_corrected",
      });
      g.pending_win = null;
      finishHand(g, pw.winner, pw.win_type, pw.from_seat, pw.result);
    } else {
      record(g, { type: "scoring_timeout", seat, result: "chombo" });
      chombo(g, seat, "scoring_timeout");
    }
  }
}

/**
 * 期限を過ぎた未応答の席を、アクセス時にまとめて確定する。
 * 新しい decision は現在時刻から始める（過去へ遡って連鎖させない）。
 */
export function settleExpired(g: Game): boolean {
  if (!g.clock || g.phase === "finished" || g._settling) return false;
  const now = nowMs();
  const did = g.decision_id;
  let changed = false;
  g._settling = true;
  try {
    const seats = Object.keys(g.dec_deadlines)
      .map(Number)
      .sort((a, b) => a - b);
    for (const seat of seats) {
      if (g.decision_id !== did || g.phase === "finished") break;
      const timing = g.dec_deadlines[seat] ?? null;
      if (timing === null || now < timing.deadline) continue;
      if (g.phase === "reaction" && seat in g.responses) continue;
      applyTimeout(g, seat);
      changed = true;
    }
  } finally {
    g._settling = false;
  }
  return changed;
}

// ---- 操作の適用 ----

/**
 * 入口：先に時間切れを settle し、合法手が確定したら時計を消費する。
 * 消費は操作前の decision の timing で確定させる。
 */
export function applyAction(g: Game, body: ActionBody): ActionResult {
  settleExpired(g);
  const seat = body.seat;
  const opened = g.dec_opened_at;
  let timing: Timing | null = null;
  if (g.clock && isInt(seat) && 0 <= seat && seat <= 3) {
    timing = g.dec_deadlines[seat] ?? null;
  }
  const result = applyActionInternal(g, body);
  if (timing !== null && "ok" in result) {
    chargeClockAt(g, seat as number, opened, timing, nowMs());
  }
  return result;
}

/** Python の str() のうち actor 処理で必要な範囲。 */
function pyStr(v: unknown, def: string): string {
  if (v === undefined) return def;
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

export function applyActionInternal(g: Game, body: ActionBody): ActionResult {
  ensureYakuFlags(g);
  const seat = body.seat;
  if (!isInt(seat) || !(0 <= seat && seat < 4)) {
    return { error: "invalid seat" };
  }
  if (g.phase === "finished") return { error: "game already finished" };
  if (body.decision_id !== g.decision_id) return { error: "stale decision" };
  const er = body.expected_revision;
  if (!isInt(er) || er < g.decision_base_revision) {
    return { error: "STALE_POSITION" };
  }
  const action = body.action;

  // 打った人の名乗り（任意）：操作が成功したときだけ席の表示を切り替える
  let newActor: Actor | null = null;
  if (
    body.actor !== null &&
    typeof body.actor === "object" &&
    !Array.isArray(body.actor)
  ) {
    const a = body.actor as Record<string, unknown>;
    const name = pyStr(a.name, "").slice(0, 32);
    if (name) {
      newActor = {
        name,
        icon: pyStr(a.icon, "").slice(0, 8),
        avatar_url: pyStr(a.avatar_url, "").slice(0, 300),
      };
    }
  }
  const ok = (): ActionResult => {
    if (newActor !== null) g.actors[seat] = newActor;
    return { ok: true };
  };

  if (action === "kyushu_kyuhai") {
    if (!canDeclareKyushu(g, seat)) return { error: "kyushu kyuhai not available" };
    abortHand(g, "kyushu_kyuhai", seat);
    return ok();
  }
  if (action === "ankan" || action === "kakan") {
    if (g.phase !== "discard" || seat !== g.turn) {
      return { error: "not your turn" };
    }
    if (g.dora_count >= 5) return { error: "too many kans" };
    const tile = body.tile;
    if (!isInt(tile) || tile < 0 || tile >= 37) return { error: "bad tile" };
    if (action === "ankan") {
      if (g.hands[seat].filter(t => kindOf(t) === kindOf(tile)).length !== 4 ||
          !g.hands[seat].includes(tile)) {
        return { error: "no four of a kind" };
      }
      if (g.riichi[seat] && !canRiichiAnkan(g, seat, tile)) {
        return { error: "riichi: ankan changes waits or melds" };
      }
    } else {
      if (g.riichi[seat]) return { error: "riichi: kakan not allowed" };
      if (!g.melds[seat].some(m => m.type === "pon" && kindOf(m.tiles[0]) === kindOf(tile)) ||
          !g.hands[seat].includes(tile)) {
        return { error: "no pon to upgrade" };
      }
    }
    declareKan(g, seat, tile, action);
    return ok();
  }
  if (action === "discard") {
    if (g.phase !== "discard" || seat !== g.turn) {
      return { error: "not your discard turn" };
    }
    const tile = body.tile;
    if (!isInt(tile) || !g.hands[seat].includes(tile)) {
      return { error: "tile not in hand" };
    }
    if (g.kuikae_forbidden?.includes(kindOf(tile))) {
      return { error: "kuikae forbidden" };
    }
    if (
      isRaw(g) &&
      g.last_drawn !== null &&
      scoreInternal(g, seat, g.hands[seat], g.last_drawn, "tsumo").valid
    ) {
      record(g, { type: "missed_tsumo", seat, discarded: tile });
    }
    if (g.riichi[seat] && tile !== g.last_drawn) {
      return { error: "riichi: tsumogiri only" };
    }
    const declareRiichi = body.riichi === true;
    if (declareRiichi) {
      if (g.riichi[seat]) return { error: "already riichi" };
      if (!isMenzen(g.melds[seat])) return { error: "not menzen" };
      if (g.scores[seat] < 1000) {
        return { error: "not enough points for riichi" };
      }
      const rest = [...g.hands[seat]];
      removeOne(rest, tile);
      if (
        winningTilesMelds(countsOf(rest), 4 - g.melds[seat].length).length ===
        0
      ) {
        return { error: "not tenpai" };
      }
    }
    const firstDiscard = g.discards[seat].length === 0;
    const lastLiveDiscard = g.last_draw_haitei && !g.last_draw_rinshan;
    removeOne(g.hands[seat], tile);
    g.kuikae_forbidden = [];
    g.discards[seat].push({
      tile,
      tsumogiri: tile === g.last_drawn,
      called_by: null,
    });
    if (declareRiichi) {
      g.riichi[seat] = true;
      g.double_riichi![seat] = firstDiscard && !g.calls_made;
      g.ippatsu![seat] = true;
      g.scores[seat] -= 1000;
      g.riichi_sticks += 1;
    } else if (g.riichi[seat]) {
      // 立直後の次のツモで和了せずに打牌したら一発終了。
      g.ippatsu![seat] = false;
    }
    g.pending_houtei = lastLiveDiscard;
    g.last_draw_rinshan = false;
    g.last_draw_haitei = false;
    g.pending = { seat, tile };
    g.revision += 1;
    advanceAfterDiscard(g);
    return ok();
  }
  if (action === "tsumo") {
    if (isRaw(g)) return { error: "use declare_tsumo in raw mode" };
    if (g.phase !== "discard" || seat !== g.turn) {
      return { error: "not your turn" };
    }
    if (g.last_drawn === null) return { error: "no drawn tile" };
    const result = scoreInternal(
      g,
      seat,
      g.hands[seat],
      g.last_drawn,
      "tsumo",
    );
    if (!result.valid) return { error: "no yaku" };
    finishHand(g, seat, "tsumo", null, result);
    return ok();
  }
  if (action === "declare_tsumo") {
    if (!isRaw(g)) return { error: "judged mode" };
    if (g.phase !== "discard" || seat !== g.turn) {
      return { error: "not your turn" };
    }
    if (g.last_drawn === null) return { error: "no drawn tile" };
    record(g, { type: "declare_win", seat, win_type: "tsumo" });
    const result = scoreInternal(
      g,
      seat,
      g.hands[seat],
      g.last_drawn,
      "tsumo",
    );
    if (!result.valid) chombo(g, seat, "false_win");
    else enterScoring(g, seat, "tsumo", null, result);
    return ok();
  }
  if (action === "declare_ron") {
    if (!isRaw(g)) return { error: "judged mode" };
    if (g.phase !== "reaction") return { error: "no reaction window" };
    if (!g.eligible.includes(seat)) {
      return { error: "not eligible for this reaction" };
    }
    if (seat in g.responses) return { error: "already responded" };
    record(g, { type: "declare_win", seat, win_type: "ron" });
    g.responses[seat] = "declare";
    g.revision += 1;
    if (Object.keys(g.responses).length === g.eligible.length) {
      resolveReaction(g);
    }
    return ok();
  }
  if (action === "declare_score") {
    if (!isRaw(g) || g.phase !== "scoring") {
      return { error: "no scoring phase" };
    }
    const pw = g.pending_win!;
    if (seat !== pw.winner) return { error: "not the winner" };
    const truth = pw.result;
    const claimPay = body.payments;
    const correct =
      body.han === truth.han &&
      body.fu === truth.fu &&
      paymentsMatch(claimPay, truth.payments, pw.win_type);
    record(g, { type: "win_scored", seat, score_error: !correct });
    if (!correct) {
      record(g, {
        type: "score_error",
        seat,
        claimed: { han: body.han ?? null, fu: body.fu ?? null, payments: claimPay ?? null },
        correct: { han: truth.han, fu: truth.fu, payments: truth.payments },
      });
      if (g.ruleset.scoring_policy === "trial") {
        chombo(g, seat, "score_error");
        return ok();
      }
    }
    finishHand(g, pw.winner, pw.win_type, pw.from_seat, truth);
    g.pending_win = null;
    return ok();
  }
  if (
    action === "ron" ||
    action === "pass" ||
    action === "pon" ||
    action === "daiminkan" ||
    action === "chi"
  ) {
    if (isRaw(g) && action === "ron") {
      return { error: "use declare_ron in raw mode" };
    }
    if (g.phase !== "reaction") return { error: "no reaction window" };
    if (!g.eligible.includes(seat)) {
      return { error: "not eligible for this reaction" };
    }
    if (seat in g.responses) return { error: "already responded" };
    if (g.pending_kan && action !== "ron" && action !== "pass") {
      return { error: "kan robbery permits ron/pass only" };
    }
    if (action === "ron" && !(g.pending_kan
          ? canRobKan(g, seat, g.pending!.tile, g.pending_kan.type)
          : canRon(g, seat, g.pending!.tile))) {
      return { error: "cannot ron" };
    }
    if (action !== "ron" && (g.pending_kan
          ? canRobKan(g, seat, g.pending!.tile, g.pending_kan.type)
          : canRonShape(g, seat, g.pending!.tile))) {
      // ロンを見逃した（鳴き含む）：同巡フリテン。
      // リーチ中の見逃しはその局ずっとフリテン。
      if (g.riichi[seat]) g.riichi_furiten[seat] = true;
      else g.temp_furiten[seat] = true;
      if (isRaw(g) && action === "pass") {
        record(g, {
          type: "missed_ron",
          seat,
          tile: g.pending!.tile,
          from_seat: g.pending!.seat,
          reason: g._timeout_seat === seat ? "timeout" : "pass",
        });
      }
    }
    if (action === "pon" || action === "daiminkan" || action === "chi") {
      let okCall = false;
      for (const c of g.call_cands[seat] ?? []) {
        if (c.type !== action) continue;
        if (action === "chi") {
          const consume = Array.isArray(body.consume)
            ? (body.consume as number[])
            : [];
          if (
            consume.length !== (c.consume ?? []).length ||
            consume.some((v, i) => v !== c.consume![i])
          ) {
            continue;
          }
        }
        okCall = true;
      }
      if (!okCall) return { error: "call not available" };
      const resp: CallCand = { type: action };
      if (action === "chi") resp.consume = [...(body.consume as number[])];
      g.responses[seat] = resp;
    } else if (action === "ron") {
      g.responses[seat] = { type: "ron" };
    } else {
      // pass（見逃しの記録は上のフリテン判定で済ませた）
      g.responses[seat] = isRaw(g) ? "pass" : { type: "pass" };
    }
    g.revision += 1;
    if (Object.keys(g.responses).length === g.eligible.length) {
      resolveReaction(g);
    }
    return ok();
  }
  return { error: `unknown action: ${action}` };
}
