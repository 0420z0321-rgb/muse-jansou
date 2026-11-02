// 赤ドラの自作検証：山構成・決定性（aka無効時は旧エンジンと完全一致）・
// 赤のドラ数え・待ちの等価性。実行: npx tsx test_aka.ts
import { applyAction, currentDecisions, newGame } from "./game.ts";
import { countsOf, connScore } from "./engine.ts";
// @ts-ignore old engine snapshot for determinism comparison
import { newGame as oldNewGame, applyAction as oldApply, currentDecisions as oldDecisions } from "/tmp/oldeng/game.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log("ok:", name);
  else { failures++; console.log("FAIL:", name, extra ?? ""); }
}
const J = { mode: "judged", scoring_policy: "practice", clock: { enabled: false } } as never;
type G = ReturnType<typeof newGame>;

// ---- 1. 山構成 ----
function composition(aka: boolean) {
  const g = newGame(123, { ...(J as object), aka } as never);
  const all = [...g.hands.flat(), ...g.wall, ...g.dead_wall];
  const byKind = new Array(37).fill(0);
  for (const t of all) byKind[t]++;
  return { total: all.length, byKind };
}
{
  const on = composition(true);
  check("aka on: 136 tiles", on.total === 136, on.total);
  check("aka on: one red per suit", on.byKind[34] === 1 && on.byKind[35] === 1 && on.byKind[36] === 1,
    [on.byKind[34], on.byKind[35], on.byKind[36]]);
  check("aka on: plain fives are 3 each", on.byKind[4] === 3 && on.byKind[13] === 3 && on.byKind[22] === 3);
  check("aka on: other kinds are 4", [0, 8, 27, 33].every(k => on.byKind[k] === 4));
  const off = composition(false);
  check("aka off: no reds", off.byKind[34] === 0 && off.byKind[35] === 0 && off.byKind[36] === 0);
  check("aka off: fives are 4 each", off.byKind[4] === 4 && off.byKind[13] === 4 && off.byKind[22] === 4);
}

// ---- 2. 決定性：aka無効なら旧エンジンと配牌も試合結果も一致 ----
function playOut(newGameFn: typeof newGame, applyFn: typeof applyAction,
                 decFn: typeof currentDecisions, seed: number) {
  const g = newGameFn(seed, J);
  const firstHands = JSON.stringify(g.hands);
  let guard = 0;
  while ((g as G).match_status !== "finished" && guard++ < 1500) {
    const d = decFn(g as never)[0] as { seat: number; actions: { type: string; tile?: number }[] };
    if (!d) break;
    const seat = d.seat;
    const types = d.actions.map(a => a.type);
    let action: { seat: number; action: string; decision_id: string; expected_revision: number; tile?: number } =
      { seat, action: types[0], decision_id: (g as G).decision_id, expected_revision: (g as G).revision };
    if ((g as G).phase === "reaction") action.action = types.includes("ron") ? "ron" : "pass";
    else if (types.includes("tsumo")) action.action = "tsumo";
    else if (types.includes("discard")) {
      const offered = d.actions.filter(a => a.type === "discard").map(a => a.tile as number);
      let tile = offered[0];
      if ((g as G).riichi[seat]) {
        tile = offered.includes((g as G).last_drawn as number) ? (g as G).last_drawn as number : offered[0];
      } else {
        const c = countsOf((g as G).hands[seat]);
        let best = connScore(c, tile);
        for (const t of offered.slice(1)) {
          const sc = connScore(c, t);
          if (sc < best) { best = sc; tile = t; }
        }
      }
      action.action = "discard"; action.tile = tile;
    }
    const r = applyFn(g as never, action as never) as { error?: string };
    if (r && r.error) throw new Error("playOut action failed: " + r.error);
  }
  return { firstHands, scores: (g as G).scores, finished: (g as G).match_status === "finished" };
}
for (const seed of [7, 11, 23]) {
  const a = playOut(newGame, applyAction, currentDecisions, seed);
  const b = playOut(oldNewGame as never, oldApply as never, oldDecisions as never, seed);
  check(`seed ${seed}: initial hands identical`, a.firstHands === b.firstHands);
  check(`seed ${seed}: match finished with identical scores`,
    a.finished && b.finished && JSON.stringify(a.scores) === JSON.stringify(b.scores),
    { a: a.scores, b: b.scores });
}

// ---- 3. 赤はドラとして +1 される（通常5と同形の和了で比較） ----
function rigWin(red: boolean) {
  const g = newGame(42, J);
  g.wall = Array.from({ length: 70 }, (_, i) => (i * 7) % 34);
  const five = red ? 34 : 4;
  g.hands[0] = [2, 3, five, 9, 10, 11, 19, 20, 21, 27, 27, 27, 33, 33];
  g.hands[1] = Array.from({ length: 13 }, (_, i) => (i * 3 + 1) % 27);
  g.hands[2] = Array.from({ length: 13 }, (_, i) => (i * 3 + 2) % 27);
  g.hands[3] = Array.from({ length: 13 }, (_, i) => (i * 5 + 3) % 27);
  g.turn = 0; g.phase = "discard"; g.last_drawn = five;
  g.dealer = 1; // 親を外して天和条件を消す（東は場風として役牌になる）
  g.live_draw_counts = [2, 1, 1, 1]; // 第1ツモではなくして地和も消す
  g.discards = [[], [], [], []]; g.calls_made = false;
  const r = applyAction(g as never, { seat: 0, action: "tsumo",
    decision_id: g.decision_id, expected_revision: g.revision } as never) as { error?: string };
  if (r && r.error) throw new Error("tsumo failed: " + r.error);
  return g;
}
{
  const plain = rigWin(false);
  const red = rigWin(true);
  const gainP = plain.scores[0] - 25000;
  const gainR = red.scores[0] - 25000;
  check("red five hand wins", gainP > 0 && gainR > 0, { gainP, gainR });
  check("red five pays strictly more (+1 dora)", gainR > gainP, { gainP, gainR });
  const dp = (plain.last_hand_result as { detail?: { dora?: number; ura?: number } })?.detail;
  const dr = (red.last_hand_result as { detail?: { dora?: number; ura?: number } })?.detail;
  if (dp && dr && typeof dp.dora === "number" && typeof dr.dora === "number") {
    check("detail dora differs by exactly 1", dr.dora - dp.dora === 1, { dp, dr });
  } else {
    console.log("note: dora detail fields not present; score delta used instead", { dp, dr });
  }
}

console.log(failures === 0 ? "AKA TESTS: ALL OK" : `AKA TESTS: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
