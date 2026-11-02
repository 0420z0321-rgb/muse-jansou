/**
 * jansou_yaku.py の移植（役判定・符・点数計算、副露対応）。
 * 既存役：立直、門前清自摸和、断么九、平和、一盃口、二盃口、役牌、
 * 七対子、対々和、三暗刻、三色同順、一気通貫、混一色、清一色。
 * 拡張：通常11役＋役満12役、状況役はScoreContext経由、役満は常に1倍。
 * 既存の牌番号・公開関数・符および点数計算は維持する。
 */
import { countsOf } from "./engine.ts";

export const DRAGONS = [31, 32, 33] as const;

/** Physical tile codes 34/35/36 are the red fives; all other codes are kinds. */
export function kindOf(code: number): number {
  if (code === 34) return 4;   // red five of manzu
  if (code === 35) return 13;  // red five of pinzu
  if (code === 36) return 22;  // red five of souzu
  return code;
}

/** Accept kind-count vectors (34) and optionally a 37-slot physical-code vector. */
function foldKindCounts(counts: readonly number[]): number[] {
  if (counts.length <= 34) return counts.slice();
  const result = Array.from({ length: 34 }, (_, i) => counts[i] ?? 0);
  for (let code = 34; code < counts.length; code++) {
    if ((counts[code] ?? 0) !== 0) {
      const kind = kindOf(code);
      if (kind < 0 || kind >= 34) throw new Error("invalid tile-code count");
      result[kind] += counts[code];
    }
  }
  return result;
}

/** サーバー形式の副露（game.ts の GameMeld と同形）。 */
export interface ServerMeld {
  type: "pon" | "chi" | "daiminkan" | "ankan" | "kakan";
  tiles: number[];
  called_tile?: number | null;
  from_seat?: number | null;
  open: boolean;
}

export interface Payments {
  ron?: number;
  tsumo_all?: number;
  tsumo_dealer?: number;
  tsumo_other?: number;
  total?: number;
}

export interface ScoreResult {
  valid: boolean;
  han?: number;
  fu?: number;
  yaku?: string[];
  payments?: Payments;
  // server.py の _score が付け足す項目
  yaku_han?: number;
  dora?: number;
  ura_dora?: number;
  ura_indicator_names?: string[];
  /** 役満は重複しても最大1。13翻以上の数え役満にも1を設定する。 */
  yakuman?: 1;
}

/** 状況役は game.ts の scoreInternal で導出し、既存 scoreHand 経路に統合する。 */
export interface ScoreContext {
  ippatsu?: boolean;
  double_riichi?: boolean;
  haitei?: boolean;
  houtei?: boolean;
  rinshan?: boolean;
  tenhou?: boolean;
  chiihou?: boolean;
  /** 加槓の槍槓（1翻）。暗槓国士は役満を優先する。 */
  chankan?: boolean;
}

interface PatternMeld {
  kind: "seq" | "tri";
  start: number;
}

interface ExposedNorm {
  kind: "seq" | "tri" | "quad";
  start: number;
  open: boolean;
}

function isSimple(t: number): boolean {
  const kind = kindOf(t);
  return kind < 27 && kind % 9 >= 1 && kind % 9 <= 7;
}

function isTerminalOrHonor(t: number): boolean {
  const kind = kindOf(t);
  return kind >= 27 || kind % 9 === 0 || kind % 9 === 8;
}

function isTerminal(t: number): boolean {
  const kind = kindOf(t);
  return kind < 27 && (kind % 9 === 0 || kind % 9 === 8);
}

const ORPHANS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33] as const;
const GREENS = new Set([19, 20, 21, 23, 25, 32]); // 2/3/4/6/8索＋發

function isKokushi(counts: readonly number[]): boolean {
  return counts.reduce((a, b) => a + b, 0) === 14 &&
    ORPHANS.every(t => counts[t] >= 1) &&
    ORPHANS.filter(t => counts[t] === 2).length === 1 &&
    counts.every((n, t) => (ORPHANS as readonly number[]).includes(t) ? n <= 2 : n === 0);
}

function isChuuren(counts: readonly number[], meldCount: number): boolean {
  if (meldCount !== 0) return false; // 九蓮は暗槓を含む副露も不可
  const suit = [0, 1, 2].find(s => {
    const base = s * 9;
    const required = [3, 1, 1, 1, 1, 1, 1, 1, 3];
    return counts.every((n, t) => t >= base && t < base + 9 ?
      n >= required[t - base] : n === 0) &&
      counts.slice(base, base + 9).reduce((a, n) => a + n, 0) === 14;
  });
  return suit !== undefined;
}

/** ツモ/ロンの区別を含む状況役。場面側が保証するフラグのみを使用する。 */
function contextYaku(yaku: string[], winType: string, menzen: boolean,
                     riichi: boolean, context: ScoreContext): number {
  let han = 0;
  if (riichi && menzen) {
    yaku.push(context.double_riichi ? "ダブルリーチ" : "立直");
    han += context.double_riichi ? 2 : 1;
    if (context.ippatsu) { yaku.push("一発"); han += 1; }
  }
  if (winType === "tsumo" && menzen) { yaku.push("門前清自摸和"); han += 1; }
  if (winType === "tsumo" && context.haitei && !context.rinshan) {
    yaku.push("海底摸月"); han += 1;
  } else if (winType === "ron" && context.houtei) {
    yaku.push("河底撈魚"); han += 1;
  }
  if (winType === "tsumo" && context.rinshan) {
    yaku.push("嶺上開花"); han += 1;
  }
  if (winType === "ron" && context.chankan) {
    yaku.push("槍槓"); han += 1;
  }
  return han;
}

function naturalYakuman(allCounts: readonly number[], winType: string,
                        context: ScoreContext): string[] {
  const names: string[] = [];
  const hasTiles = allCounts.some(n => n > 0);
  if (hasTiles && allCounts.every((n, t) => n === 0 || t >= 27)) names.push("字一色");
  if (hasTiles && allCounts.every((n, t) => n === 0 || GREENS.has(t))) names.push("緑一色");
  if (hasTiles && allCounts.every((n, t) => n === 0 || isTerminal(t))) names.push("清老頭");
  if (winType === "tsumo") {
    if (context.tenhou) names.push("天和");
    if (context.chiihou) names.push("地和");
  }
  return names;
}

function yakumanResult(yaku: string[]): ScoreResult {
  return { valid: true, han: 13, fu: 0, yakuman: 1, yaku };
}

/**
 * 通常形の分解を返す：[[pair_tile, [meld, ...]], ...]
 * nMelds は手の内で必要な面子数（副露があるときは 4 - 副露数）。
 */
export function findPatterns(
  counts: number[],
  nMelds = 4,
): [number, PatternMeld[]][] {
  const kinds = foldKindCounts(counts);
  const raw: PatternMeld[][] = [];
  const rec = (c: number[], melds: PatternMeld[]): void => {
    for (let i = 0; i < 34; i++) {
      if (c[i] === 0) continue;
      if (c[i] >= 3) {
        const c2 = c.slice();
        c2[i] -= 3;
        rec(c2, [...melds, { kind: "tri", start: i }]);
      }
      if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
        const c2 = c.slice();
        c2[i] -= 1;
        c2[i + 1] -= 1;
        c2[i + 2] -= 1;
        rec(c2, [...melds, { kind: "seq", start: i }]);
      }
      return;
    }
    raw.push(melds.slice());
  };
  const withPair: [number, PatternMeld[]][] = [];
  for (let pair = 0; pair < 34; pair++) {
    if (kinds[pair] >= 2) {
      const c = kinds.slice();
      c[pair] -= 2;
      const before = raw.length;
      rec(c, []);
      for (let k = before; k < raw.length; k++) withPair.push([pair, raw[k]]);
    }
  }
  return withPair.filter(([, m]) => m.length === nMelds);
}

/** 門前か：副露が無いか、暗槓のみ。 */
export function isMenzen(melds: readonly ServerMeld[]): boolean {
  return melds.every((m) => m.type === "ankan");
}

function exposedNorm(melds: readonly ServerMeld[]): ExposedNorm[] {
  const out: ExposedNorm[] = [];
  for (const m of melds) {
    if (m.type === "chi") {
      out.push({ kind: "seq", start: Math.min(...m.tiles.map(kindOf)), open: true });
    } else if (m.type === "ankan" || m.type === "daiminkan" || m.type === "kakan") {
      out.push({ kind: "quad", start: kindOf(m.tiles[0]), open: Boolean(m.open) });
    } else {
      out.push({ kind: "tri", start: kindOf(m.tiles[0]), open: Boolean(m.open) });
    }
  }
  return out;
}

/**
 * 副露込みの待ち牌（形だけ・役は見ない）。
 * counts は手の内の枚数表（13 - 3*副露数 枚ぶん）。
 */
export function winningTilesMelds(counts: number[], nMelds: number): number[] {
  const kinds = foldKindCounts(counts);
  const waits: number[] = [];
  for (let t = 0; t < 34; t++) {
    if (kinds[t] >= 4) continue;
    const c = kinds.slice();
    c[t] += 1;
    if (findPatterns(c, nMelds).length > 0 ||
        (nMelds === 4 && (isKokushi(c) || c.filter(n => n === 2).length === 7))) waits.push(t);
  }
  return waits;
}

type WaitType = "tanki" | "shanpon" | "kanchan" | "penchan" | "ryanmen";

function waitType(meld: PatternMeld | null, winTile: number): WaitType {
  if (meld === null) return "tanki";
  if (meld.kind === "tri") return "shanpon";
  const pos = kindOf(winTile) - kindOf(meld.start);
  const startPos = kindOf(meld.start) % 9;
  if (pos === 1) return "kanchan";
  if (pos === 0 && startPos === 6) return "penchan";
  if (pos === 2 && startPos === 0) return "penchan";
  return "ryanmen";
}

function valuePair(pair: number, seatWind: number, roundWind: number): boolean {
  return (
    (DRAGONS as readonly number[]).includes(pair) ||
    pair === 27 + seatWind ||
    pair === 27 + roundWind
  );
}

export function basicPoints(han: number, fu: number): number {
  if (han >= 13) return 8000;
  if (han >= 11) return 6000;
  if (han >= 8) return 4000;
  if (han >= 6) return 3000;
  if (han >= 5) return 2000;
  return Math.min(fu * 2 ** (han + 2), 2000);
}

function ceil100(x: number): number {
  return Math.ceil(x / 100) * 100;
}

/** Python の jansou_yaku._payments。 */
export function payments(
  han: number,
  fu: number,
  winType: string,
  isDealer: boolean,
): Payments {
  const basic = basicPoints(han, fu);
  if (winType === "ron") {
    return { ron: ceil100(basic * (isDealer ? 6 : 4)) };
  }
  if (isDealer) {
    const each = ceil100(basic * 2);
    return { tsumo_all: each, total: each * 3 };
  }
  const dealerPay = ceil100(basic * 2);
  const otherPay = ceil100(basic);
  return {
    tsumo_dealer: dealerPay,
    tsumo_other: otherPay,
    total: dealerPay + otherPay * 2,
  };
}

function evalPattern(
  pair: number,
  melds: PatternMeld[],
  counts: number[],
  winTile: number,
  winType: string,
  seatWind: number,
  roundWind: number,
  riichi: boolean,
  exposed: ExposedNorm[] = [],
  menzen = true,
  context: ScoreContext = {},
): ScoreResult {
  const candidates: (number | null)[] = [];
  if (pair === winTile) candidates.push(null); // 単騎
  for (let idx = 0; idx < melds.length; idx++) {
    const m = melds[idx];
    if (m.kind === "tri" && m.start === winTile) candidates.push(idx);
    else if (m.kind === "seq" && m.start <= winTile && winTile <= m.start + 2)
      candidates.push(idx);
  }
  let best: { key: [number, number, number]; res: ScoreResult } | null = null;
  const allTiles: number[] = [];
  for (let t = 0; t < 34; t++) for (let k = 0; k < counts[t]; k++) allTiles.push(t);
  const tanyao = allTiles.every((t) => isSimple(t));
  const suits = new Set(allTiles.map(kindOf).filter((t) => t < 27).map((t) => Math.floor(t / 9)));
  const honors = allTiles.some((t) => kindOf(t) >= 27);
  const honitsu = suits.size === 1 && honors;
  const chinitsu = suits.size === 1 && !honors;

  for (const winMeldIdx of candidates) {
    const winMeld = winMeldIdx === null ? null : melds[winMeldIdx];
    const wait = waitType(winMeld, winTile);
    let concealedTri = 0;
    let fuMelds = 0;
    for (let idx = 0; idx < melds.length; idx++) {
      const m = melds[idx];
      if (m.kind !== "tri") continue;
      const concealed = !(winType === "ron" && idx === winMeldIdx);
      if (concealed) concealedTri += 1;
      const base = isSimple(m.start) ? 2 : 4;
      fuMelds += base * (concealed ? 2 : 1);
    }
    for (const e of exposed) {
      if (e.kind === "seq") continue;
      const base = isSimple(e.start) ? 2 : 4;
      if (e.kind === "tri") fuMelds += base * (e.open ? 1 : 2);
      else fuMelds += base * (e.open ? 4 : 8); // quad：明槓は刻子の4倍、暗槓は8倍
      if (!e.open) concealedTri += 1;
    }
    const seqs: [number, number][] = melds
      .filter((m) => m.kind === "seq")
      .map((m) => [Math.floor(kindOf(m.start) / 9), kindOf(m.start) % 9] as [number, number]);
    for (const e of exposed)
      if (e.kind === "seq")
        seqs.push([Math.floor(kindOf(e.start) / 9), kindOf(e.start) % 9]);
    const tris: number[] = melds
      .filter((m) => m.kind === "tri")
      .map((m) => m.start);
    for (const e of exposed)
      if (e.kind === "tri" || e.kind === "quad") tris.push(e.start);

    // 通常役の判定より先に役満を確定する。重複しても役満1つ分のみ。
    const yakuman = naturalYakuman(counts, winType, context);
    const dragons = tris.filter(t => (DRAGONS as readonly number[]).includes(t)).length;
    const winds = tris.filter(t => t >= 27 && t <= 30).length;
    const quads = exposed.filter(e => e.kind === "quad").length;
    if (dragons === 3) yakuman.push("大三元");
    if (winds === 4) yakuman.push("大四喜");
    else if (winds === 3 && pair >= 27 && pair <= 30) yakuman.push("小四喜");
    if (menzen && concealedTri === 4 && (winType === "tsumo" || wait === "tanki")) {
      yakuman.push("四暗刻");
    }
    if (quads === 4) yakuman.push("四槓子");
    if (menzen && isChuuren(counts, exposed.length)) yakuman.push("九蓮宝燈");
    if (yakuman.length > 0) return yakumanResult(yakuman);

    const yaku: string[] = [];
    let han = 0;
    const pinfu = Boolean(
      menzen &&
        melds.every((m) => m.kind === "seq") &&
        exposed.every((e) => e.kind === "seq") &&
        !valuePair(pair, seatWind, roundWind) &&
        wait === "ryanmen",
    );
    if (pinfu) {
      yaku.push("平和");
      han += 1;
    }
    // 一盃口・二盃口（門前のみ）
    let dup = 0;
    if (menzen) {
      const seen = new Map<string, number>();
      for (const s of seqs) {
        const key = s.join(",");
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const v of seen.values()) dup += Math.floor(v / 2);
    }
    if (dup >= 2) {
      yaku.push("二盃口");
      han += 3;
    } else if (dup === 1) {
      yaku.push("一盃口");
      han += 1;
    }
    if (tris.length === 4) {
      yaku.push("対々和");
      han += 2;
    }
    if (concealedTri >= 3) {
      yaku.push("三暗刻");
      han += 2;
    }
    const startsByNum = new Map<number, Set<number>>();
    for (const [suit, pos] of seqs) {
      if (!startsByNum.has(pos)) startsByNum.set(pos, new Set());
      startsByNum.get(pos)!.add(suit);
    }
    if ([...startsByNum.values()].some((v) => v.size === 3)) {
      yaku.push("三色同順");
      han += menzen ? 2 : 1;
    }
    // 三色同刻は副露しても2翻。
    for (let pos = 0; pos < 9; pos++) {
      if ([0, 9, 18].every(base => tris.includes(base + pos))) {
        yaku.push("三色同刻"); han += 2; break;
      }
    }
    for (let suit = 0; suit < 3; suit++) {
      const poss = new Set(
        seqs.filter(([s]) => s === suit).map(([, pos]) => pos),
      );
      if (poss.has(0) && poss.has(3) && poss.has(6)) {
        yaku.push("一気通貫");
        han += menzen ? 2 : 1;
        break;
      }
    }
    for (const t of tris) {
      if ((DRAGONS as readonly number[]).includes(t)) {
        yaku.push("役牌");
        han += 1;
      }
      if (t === 27 + seatWind) {
        yaku.push("役牌（自風）");
        han += 1;
      }
      if (t === 27 + roundWind) {
        yaku.push("役牌（場風）");
        han += 1;
      }
    }
    if (tanyao) {
      yaku.push("断么九");
      han += 1;
    }
    if (dragons === 2 && (DRAGONS as readonly number[]).includes(pair)) {
      yaku.push("小三元"); han += 2;
    }
    if (quads === 3) { yaku.push("三槓子"); han += 2; }

    // 全帯么九・純全帯么九・混老頭は排他。
    // 帯么九系は順子が1つ以上ある通常形に限定する。
    if (allTiles.every(t => isTerminalOrHonor(t))) {
      yaku.push("混老頭"); han += 2;
    } else if (seqs.length > 0 && isTerminal(pair) &&
               melds.every(m => m.kind === "tri" ? isTerminal(m.start) :
                 kindOf(m.start) % 9 === 0 || kindOf(m.start) % 9 === 6) &&
               exposed.every(e => e.kind !== "seq" ? isTerminal(e.start) :
                 kindOf(e.start) % 9 === 0 || kindOf(e.start) % 9 === 6)) {
      yaku.push("純全帯么九"); han += menzen ? 3 : 2;
    } else if (seqs.length > 0 && isTerminalOrHonor(pair) &&
               melds.every(m => m.kind === "tri" ? isTerminalOrHonor(m.start) :
                 kindOf(m.start) % 9 === 0 || kindOf(m.start) % 9 === 6) &&
               exposed.every(e => e.kind !== "seq" ? isTerminalOrHonor(e.start) :
                 kindOf(e.start) % 9 === 0 || kindOf(e.start) % 9 === 6)) {
      yaku.push("全帯么九"); han += menzen ? 2 : 1;
    }
    if (honitsu) {
      yaku.push("混一色");
      han += menzen ? 3 : 2;
    }
    if (chinitsu) {
      yaku.push("清一色");
      han += menzen ? 6 : 5;
    }
    han += contextYaku(yaku, winType, menzen, riichi, context);
    if (han === 0) continue;
    // 符
    let fu: number;
    if (pinfu && winType === "tsumo") {
      fu = 20;
    } else {
      fu = 20 + fuMelds;
      if (winType === "ron") {
        if (menzen) fu += 10; // 門前加符
      } else if (!pinfu) {
        fu += 2; // ツモ符
      }
      if (fu <= 20) fu = 30; // 副露の平和形ロンなど、20符は30符扱い
      if (valuePair(pair, seatWind, roundWind)) {
        fu +=
          pair === 27 + seatWind && pair === 27 + roundWind ? 4 : 2;
      }
      if (wait === "tanki" || wait === "kanchan" || wait === "penchan") fu += 2;
      fu = Math.ceil(fu / 10) * 10;
    }
    const key: [number, number, number] = [basicPoints(han, fu), han, fu];
    if (
      best === null ||
      key[0] > best.key[0] ||
      (key[0] === best.key[0] &&
        (key[1] > best.key[1] ||
          (key[1] === best.key[1] && key[2] > best.key[2])))
    ) {
      best = { key, res: { valid: true, han, fu, yaku } };
    }
  }
  return best ? best.res : { valid: false };
}

function evalChiitoitsu(
  counts: number[],
  winType: string,
  riichi: boolean,
  context: ScoreContext = {},
): ScoreResult {
  if (counts.filter((x) => x === 2).length !== 7) return { valid: false };
  const allTiles: number[] = [];
  for (let t = 0; t < 34; t++) for (let k = 0; k < counts[t]; k++) allTiles.push(t);
  const yakuman = naturalYakuman(counts, winType, context);
  if (yakuman.length > 0) return yakumanResult(yakuman);
  const yaku: string[] = ["七対子"];
  if (allTiles.every(t => isTerminalOrHonor(t))) {
    yaku.push("混老頭");
  }
  let han = 2 + (yaku.includes("混老頭") ? 2 : 0);
  if (allTiles.every((t) => isSimple(t))) {
    yaku.push("断么九");
    han += 1;
  }
  const suits = new Set(allTiles.map(kindOf).filter((t) => t < 27).map((t) => Math.floor(t / 9)));
  const honors = allTiles.some((t) => kindOf(t) >= 27);
  if (suits.size === 1 && honors) {
    yaku.push("混一色");
    han += 3;
  } else if (suits.size === 1) {
    yaku.push("清一色");
    han += 6;
  }
  han += contextYaku(yaku, winType, true, riichi, context);
  return { valid: true, han, fu: 25, yaku };
}

/**
 * hand は和了牌を含む手の内の牌（リスト）。副露があるときは
 * 14 - 3*副露数 枚。melds はサーバー形式の副露の列。
 * seatWind/roundWind は 0=東..3=北。
 */
export function scoreHand(
  hand: readonly number[],
  winTile: number,
  winType: string,
  seatWind: number,
  roundWind: number,
  riichi: boolean,
  melds: readonly ServerMeld[] = [],
  context: ScoreContext = {},
): ScoreResult {
  // Shape and decomposition use kinds, while game.ts retains physical codes.
  const winKind = kindOf(winTile);
  const counts = countsOf(hand.map(kindOf));
  const needed = 4 - melds.length;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== 3 * needed + 2 || counts[winKind] === 0) {
    return { valid: false };
  }
  const menzen = isMenzen(melds);
  const exposed = exposedNorm(melds);
  const allCounts = countsOf([
    ...hand,
    ...melds.flatMap((m) => m.tiles),
  ].map(kindOf));
  const results: ScoreResult[] = [];
  if (melds.length === 0 && isKokushi(counts)) {
    // 国士無双：13種の么九牌＋そのうち1種の対子（13面待ちでも単独役満）。
    const yaku = ["国士無双", ...naturalYakuman(counts, winType, context)];
    const result = yakumanResult(yaku);
    result.payments = payments(13, 0, winType, seatWind === 0);
    return result;
  }
  if (melds.length === 0) {
    const chii = evalChiitoitsu(counts, winType, riichi, context);
    if (chii.valid) results.push(chii);
  }
  for (const [pair, pmelds] of findPatterns(counts, needed)) {
    const r = evalPattern(
      pair,
      pmelds,
      allCounts,
      winKind,
      winType,
      seatWind,
      roundWind,
      riichi,
      exposed,
      menzen,
      context,
    );
    if (r.valid) results.push(r);
  }
  if (results.length === 0) return { valid: false };
  const isDealer = seatWind === 0;
  let best = results[0];
  for (const r of results.slice(1)) {
    const kr: [number, number, number, number] = [
      r.yakuman === 1 ? 1 : 0,
      basicPoints(r.han!, r.fu!),
      r.han!,
      r.fu!,
    ];
    const kb: [number, number, number, number] = [
      best.yakuman === 1 ? 1 : 0,
      basicPoints(best.han!, best.fu!),
      best.han!,
      best.fu!,
    ];
    if (
      kr[0] > kb[0] ||
      (kr[0] === kb[0] && (kr[1] > kb[1] ||
        (kr[1] === kb[1] && (kr[2] > kb[2] ||
        (kr[2] === kb[2] && kr[3] > kb[3])))))
    ) {
      best = r;
    }
  }
  const out: ScoreResult = { ...best };
  if (out.yakuman !== 1 && out.han! >= 13) {
    // 点数は既存 basicPoints(13翻以上)=8000。役満倍率も明示する。
    out.yakuman = 1;
    out.yaku = [...(out.yaku ?? []), "数え役満"];
  }
  out.payments = payments(best.han!, best.fu!, winType, isDealer);
  return out;
}

// Python 版では _is_terminal_or_honor は他関数から参照されるため残置
export { isTerminalOrHonor };
