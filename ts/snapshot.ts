/**
 * fixtures_gen.py の _snapshot / _set_path の移植。
 * snapshot の抽出項目は Python 版と同一にすること（fixture 照合の正本）。
 */
import { publicState, roundLabel, type Game } from "./game.ts";

export const EVENT_TYPES = [
  "score_error",
  "ron_opportunity",
  "missed_ron",
  "scoring_timeout",
  "chombo",
] as const;

/** Python の _set_path："." 区切り、リスト要素は数値インデックス。 */
export function setPath(g: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = g as Record<string, unknown> | unknown[];
  for (const p of parts.slice(0, -1)) {
    cur = (Array.isArray(cur)
      ? cur[Number(p)]
      : (cur as Record<string, unknown>)[p]) as
      | Record<string, unknown>
      | unknown[];
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cur)) cur[Number(last)] = value;
  else (cur as Record<string, unknown>)[last] = value;
}

/** Python の f'{seat}' 表記（None は "None"）。 */
function pySeat(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

export function snapshot(
  g: Game,
  rawReview = false,
): Record<string, unknown> {
  const s: Record<string, unknown> = {
    scores: [...g.scores],
    dealer: g.dealer,
    hand_number: g.hand_number,
    round_wind: g.round_wind,
    round_label: roundLabel(g),
    honba: g.honba,
    riichi_sticks: g.riichi_sticks,
    phase: g.phase,
    turn: g.turn,
    match_status: g.match_status,
    end_reason: g.end_reason ?? null,
    ranking: g.ranking ?? null,
    last_drawn: g.last_drawn ?? null,
    eligible: [...(g.eligible ?? [])],
    dec_opened_at: g.dec_opened_at ?? null,
    dec_deadlines: Object.fromEntries(
      Object.entries(g.dec_deadlines ?? {}).map(([k, v]) => [
        String(k),
        { deadline: v?.deadline ?? null, phase: v?.phase ?? null },
      ]),
    ),
    discards: g.discards.map((sd) =>
      sd.map((d) => ({ tile: d.tile, tsumogiri: d.tsumogiri })),
    ),
  };
  const lhr = g.last_hand_result;
  s.last_hand_result = !lhr
    ? null
    : {
        winner: lhr.winner ?? null,
        win_type: lhr.win_type ?? null,
        round: lhr.round ?? null,
        honba: lhr.honba ?? null,
        dealer: lhr.dealer ?? null,
        hand_index: lhr.hand_index ?? null,
      };
  if (g.clock) s.clock_remaining_ms = [...g.clock.remaining_ms];
  const ev: Record<string, number> = {};
  for (const e of g.events ?? []) {
    if ((EVENT_TYPES as readonly string[]).includes(e.type)) {
      const key = `${e.type}:${pySeat(e.seat)}`;
      ev[key] = (ev[key] ?? 0) + 1;
    }
  }
  s.events = ev;
  if (rawReview) {
    const rr = publicState(g).raw_review as {
      seats: Record<string, { declare_wins?: number }>;
    } | null;
    if (rr) {
      s.raw_review_declare_wins = Object.fromEntries(
        Object.entries(rr.seats).map(([k, v]) => [
          k,
          v.declare_wins ?? null,
        ]),
      );
    }
  }
  return s;
}
