// 進行系パック（途中流局・槍槓・流し満貫・食い替え/暗槓厳密化）の自作検証。
// 実エンジンに対して rig した状態で検証する。実行: npx tsx test_flow.ts
import { applyAction, currentDecisions, newGame, settleDraw } from "./game.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log("ok:", name);
  else { failures++; console.log("FAIL:", name, extra ?? ""); }
}
function act(g: never, seat: number, action: string, extra: object = {}) {
  return applyAction(g, { seat, action, decision_id: (g as { decision_id: string }).decision_id,
    expected_revision: (g as { revision: number }).revision, ...extra } as never);
}
function actsFor(g: never, seat: number) {
  const d = currentDecisions(g as never).find(x => x.seat === seat);
  return d ? d.actions : [];
}
const J = { mode: "judged", scoring_policy: "practice", clock: { enabled: false } } as never;
type G = ReturnType<typeof newGame>;
function rig(seed = 42): G {
  const g = newGame(seed, J);
  g.wall = Array.from({ length: 70 }, (_, i) => (i * 7) % 34);
  return g;
}
const junk = (n: number, start = 0) => Array.from({ length: n }, (_, i) => (start + i * 3) % 27);

// ---- 1. 九種九牌：宣言可＋流局（親継続・本場+1・点数不変） ----
{
  const g = rig();
  g.hands[0] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33, 0];
  g.hands[1] = junk(13, 1); g.hands[2] = junk(13, 2); g.hands[3] = junk(13, 3);
  g.turn = 0; g.phase = "discard"; g.last_drawn = 0;
  g.live_draw_counts = [1, 0, 0, 0]; g.discards = [[], [], [], []]; g.calls_made = false;
  check("kyushu offered", actsFor(g as never, 0).some(a => a.type === "kyushu_kyuhai"));
  const r = act(g as never, 0, "kyushu_kyuhai");
  check("kyushu ok", "ok" in r, r);
  const lh = g.last_hand_result as { win_type: string; detail: { reason: string } };
  check("kyushu abort", lh.win_type === "abortive_draw" && lh.detail.reason === "kyushu_kyuhai", lh);
  check("kyushu honba+1 dealer stays", g.honba === 1 && g.dealer === 0 && g.scores.every(s => s === 25000));
}
// ---- 1b. 九種八種は不可 ----
{
  const g = rig();
  g.hands[0] = [0, 8, 9, 17, 18, 26, 27, 28, 1, 2, 3, 4, 5, 0];
  g.turn = 0; g.phase = "discard"; g.last_drawn = 0;
  g.live_draw_counts = [1, 0, 0, 0]; g.discards = [[], [], [], []]; g.calls_made = false;
  check("kyushu not offered at 8 kinds", !actsFor(g as never, 0).some(a => a.type === "kyushu_kyuhai"));
  const r = act(g as never, 0, "kyushu_kyuhai");
  check("kyushu rejected", "error" in r, r);
}
// ---- 2. 四風連打 ----
{
  const g = rig();
  for (let s = 0; s < 4; s++) {
    g.hands[s] = [27, ...junk(12, s + 5)];
    if (s === 0) g.hands[s].push(20);
  }
  g.turn = 0; g.phase = "discard"; g.last_drawn = 20;
  g.live_draw_counts = [1, 0, 0, 0]; g.discards = [[], [], [], []]; g.calls_made = false;
  g.wall = Array.from({ length: 60 }, () => 20);
  for (let s = 0; s < 4; s++) {
    const r = act(g as never, s, "discard", { tile: 27 });
    check(`suufon discard seat${s}`, "ok" in r, r);
  }
  const lh = g.last_hand_result as { win_type: string; detail: { reason: string } };
  check("suufon abort", lh.win_type === "abortive_draw" && lh.detail.reason === "suufon_renda", lh);
  check("suufon honba+1", g.honba === 1 && g.scores.every(x => x === 25000));
}
// ---- 3. 槍槓（加槓） ----
{
  const g = rig();
  g.melds[1] = [{ type: "pon", tiles: [31, 31, 31], called_tile: 31, from_seat: 0, open: true }];
  g.hands[1] = [31, ...junk(9, 4)];
  g.hands[0] = [31, 31, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3];
  g.hands[2] = junk(13, 7); g.hands[3] = junk(13, 8);
  g.turn = 1; g.phase = "discard"; g.last_drawn = 31;
  const r1 = act(g as never, 1, "kakan", { tile: 31 });
  check("kakan declared", "ok" in r1 && g.phase === "reaction", r1);
  check("robber offered ron", actsFor(g as never, 0).some(a => a.type === "ron"));
  const r2 = act(g as never, 0, "ron");
  check("chankan ron ok", "ok" in r2, r2);
  const lh = g.last_hand_result as { win_type: string; winner: number; from_seat: number;
    detail: { yaku?: string[] } };
  check("chankan result", lh.win_type === "ron" && lh.winner === 0 && lh.from_seat === 1, lh);
  check("chankan yaku listed", (lh.detail.yaku ?? []).includes("槍槓"), lh.detail);
  check("chankan scores moved", g.scores[0] > 25000 && g.scores[1] < 25000, g.scores);
}
// ---- 4. 暗槓への槍槓は国士のみ ----
{
  const g = rig();
  g.hands[1] = [27, 27, 27, 27, ...junk(9, 11)];
  g.hands[0] = [0, 0, 8, 9, 17, 18, 26, 28, 29, 30, 31, 32, 33]; // 国士（東待ち含む）
  g.hands[2] = [27, 27, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3];       // 通常形は東で和了形
  g.hands[3] = junk(13, 12);
  g.turn = 1; g.phase = "discard"; g.last_drawn = 27;
  const r1 = act(g as never, 1, "ankan", { tile: 27 });
  check("ankan declared", "ok" in r1, r1);
  check("kokushi offered ron vs ankan", actsFor(g as never, 0).some(a => a.type === "ron"),
    actsFor(g as never, 0));
  check("normal hand NOT offered ron vs ankan", !actsFor(g as never, 2).some(a => a.type === "ron"),
    actsFor(g as never, 2));
  const r2 = act(g as never, 0, "ron");
  check("kokushi rob ok", "ok" in r2, r2);
  const lh = g.last_hand_result as { winner: number; detail: { yaku?: string[]; yakuman?: boolean } };
  check("kokushi rob result", lh.winner === 0 && (lh.detail.yaku ?? []).includes("国士無双"), lh);
}
// ---- 5. 流し満貫（罰符より優先・子） ----
{
  const g = rig();
  g.discards[2] = [0, 27, 8, 33].map(tile => ({ tile, tsumogiri: true, called_by: null }));
  g.discards[0] = [{ tile: 13, tsumogiri: true, called_by: null }];
  g.discards[1] = [{ tile: 14, tsumogiri: true, called_by: null }];
  g.discards[3] = [{ tile: 15, tsumogiri: true, called_by: null }];
  settleDraw(g);
  const lh = g.last_hand_result as { win_type: string };
  check("nagashi result", lh.win_type === "nagashi_mangan", lh);
  check("nagashi child +8000", g.scores[2] === 33000 && g.scores[0] === 21000 &&
    g.scores[1] === 23000 && g.scores[3] === 23000, g.scores);
}
// ---- 6. 食い替え禁止 ----
{
  const g = rig();
  g.hands[0] = [13, ...junk(13, 15)];
  g.hands[1] = [11, 12, 10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 20];
  g.hands[2] = junk(13, 16); g.hands[3] = junk(13, 17);
  g.turn = 0; g.phase = "discard"; g.last_drawn = 13;
  act(g as never, 0, "discard", { tile: 13 });
  const chi = actsFor(g as never, 1).find(a => a.type === "chi");
  check("chi offered", Boolean(chi), actsFor(g as never, 1));
  const rc = act(g as never, 1, "chi", { consume: (chi as { consume: number[] }).consume });
  check("chi ok", "ok" in rc, rc);
  const discards = actsFor(g as never, 1).filter(a => a.type === "discard").map(a => a.tile);
  check("kuikae tiles not offered", !discards.includes(13) && !discards.includes(10), discards);
  const bad = act(g as never, 1, "discard", { tile: 13 });
  check("kuikae discard rejected", "error" in bad, bad);
  const good = act(g as never, 1, "discard", { tile: 0 });
  check("other discard ok", "ok" in good, good);
}
// ---- 7. リーチ後暗槓：待ち不変なら可 ----
{
  const g = rig();
  g.hands[0] = [27, 27, 27, 27, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3];
  g.hands[1] = junk(13, 21); g.hands[2] = junk(13, 22); g.hands[3] = junk(13, 23);
  g.riichi = [true, false, false, false];
  g.turn = 0; g.phase = "discard"; g.last_drawn = 27;
  check("riichi ankan offered (waits unchanged)",
    actsFor(g as never, 0).some(a => a.type === "ankan" && a.tile === 27), actsFor(g as never, 0));
  const r = act(g as never, 0, "ankan", { tile: 27 });
  check("riichi ankan ok", "ok" in r, r);
  check("ankan committed + rinshan", g.melds[0].some(m => m.type === "ankan") && g.phase === "discard");
}
// ---- 7b. リーチ後暗槓：待ちが変わるなら不可 ----
{
  const g = rig();
  g.hands[0] = [2, 3, 4, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7];
  g.hands[1] = junk(13, 24); g.hands[2] = junk(13, 25); g.hands[3] = junk(13, 26);
  g.riichi = [true, false, false, false];
  g.turn = 0; g.phase = "discard"; g.last_drawn = 4;
  check("riichi ankan NOT offered (waits change)",
    !actsFor(g as never, 0).some(a => a.type === "ankan"), actsFor(g as never, 0));
  const r = act(g as never, 0, "ankan", { tile: 4 });
  check("riichi ankan rejected", "error" in r, r);
}
// ---- 8. 三家和 → 途中流局 ----
{
  const g = rig();
  const ronHand = [33, 33, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3];
  g.hands[0] = [33, ...junk(13, 28)];
  g.hands[1] = [...ronHand]; g.hands[2] = [...ronHand]; g.hands[3] = [...ronHand];
  g.turn = 0; g.phase = "discard"; g.last_drawn = 33;
  act(g as never, 0, "discard", { tile: 33 });
  for (const s of [1, 2, 3]) {
    const r = act(g as never, s, "ron");
    check(`sanchahou ron seat${s} accepted`, "ok" in r, r);
  }
  const lh = g.last_hand_result as { win_type: string; detail: { reason: string } };
  check("sanchahou abort", lh.win_type === "abortive_draw" && lh.detail.reason === "sanchahou", lh);
  check("sanchahou scores unchanged", g.scores.every(x => x === 25000), g.scores);
}
// ---- 9. 四槓散了 ----
{
  const g = rig();
  const kan = (t: number, type: "ankan" | "daiminkan") => ({ type, tiles: [t, t, t, t], called_tile: null, from_seat: null, open: type !== "ankan" });
  g.melds[0] = [kan(0, "ankan"), kan(1, "ankan")];
  g.melds[1] = [kan(9, "daiminkan")];
  g.hands[0] = junk(5, 29);
  g.hands[1] = [20, 20, 20, 20, ...junk(6, 30)];
  g.hands[2] = junk(13, 31); g.hands[3] = junk(13, 32);
  g.turn = 1; g.phase = "discard"; g.last_drawn = 20; g.dora_count = 4;
  const r = act(g as never, 1, "ankan", { tile: 20 });
  check("4th split kan accepted", "ok" in r, r);
  const lh = g.last_hand_result as { win_type: string; detail: { reason: string } };
  check("suukan abort", lh.win_type === "abortive_draw" && lh.detail.reason === "suukan_sansou", lh);
}
// ---- 10. 東風戦ルールの保持（移植で消えていないこと） ----
{
  const g = newGame(7, { match_length: "east" } as never);
  check("match_length east kept", (g.ruleset as { match_length: string }).match_length === "east");
  const g2 = newGame(7, null);
  check("match_length default south", (g2.ruleset as { match_length: string }).match_length === "south");
}

console.log(failures === 0 ? "FLOW TESTS: ALL OK" : `FLOW TESTS: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
