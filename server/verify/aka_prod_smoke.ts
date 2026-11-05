// 本番の使い捨てaka卓スモーク：赤入り東風戦を1試合通し、赤牌の出現と完走を確認。
// 実行: MASTER_TOKEN=... npx tsx aka_prod_smoke.ts
import { countsOf, connScore } from "../../ts/engine.ts";
import { createRoom, getState, postAction, type Room } from "./client.ts";

const base = "https://muse-jansou.muse-jansou.workers.dev";
type Json = Record<string, any>;
let failures = 0;
function check(cond: boolean, label: string, extra?: unknown) {
  if (cond) console.log("ok -", label);
  else { failures++; console.log("FAIL -", label, extra ?? ""); }
}

const { room, state: created } = await createRoom(base, { seed: 777,
  ruleset: { mode: "judged", scoring_policy: "practice", match_length: "east",
    clock: { enabled: true, preset: "sprint" }, aka: true } });
check(created?.ruleset?.aka === true, "room ruleset has aka:true", created?.ruleset);

const seen = new Set<number>();
function collect(st: Json) {
  for (const h of st.hands ?? []) if (Array.isArray(h)) for (const t of h) seen.add(t);
  for (const ds of st.discards ?? []) for (const d of ds ?? []) seen.add(d.tile);
  for (const ms of st.melds ?? []) for (const m of ms ?? []) for (const t of m.tiles ?? []) seen.add(t);
  for (const t of st.wall ?? []) seen.add(t);
  for (const t of st.dead_wall ?? []) seen.add(t);
}

let st = await getState(base, room);
collect(st);
let step = 0;
while (st.match_status !== "finished" && step < 1500) {
  step++;
  const d = (st.decisions as Json[])[0];
  if (!d) throw new Error("no decisions at step " + step);
  const seat = d.seat as number;
  const actions = d.actions as Json[];
  const types = actions.map(a => a.type as string);
  const body: Json = { seat, decision_id: st.decision_id,
    expected_revision: st.revision, idempotency_key: `aka-${step}`,
    actor: { name: "aka検証" + seat, icon: "x", avatar_url: "" } };
  if (st.phase === "reaction") body.action = types.includes("ron") ? "ron" : "pass";
  else if (types.includes("tsumo")) body.action = "tsumo";
  else if (types.includes("discard")) {
    const offered = actions.filter(a => a.type === "discard").map(a => a.tile as number);
    let tile = offered[0];
    if (st.riichi[seat]) {
      tile = offered.includes(st.last_drawn as number) ? (st.last_drawn as number) : offered[0];
    } else {
      const c = countsOf((st.hands[seat] as number[]).map(t => t === 34 ? 4 : t === 35 ? 13 : t === 36 ? 22 : t));
      let best = connScore(c, tile === 34 ? 4 : tile === 35 ? 13 : tile === 36 ? 22 : tile);
      for (const t of offered.slice(1)) {
        const k = t === 34 ? 4 : t === 35 ? 13 : t === 36 ? 22 : t;
        const sc = connScore(c, k);
        if (sc < best) { best = sc; tile = t; }
      }
    }
    body.action = "discard"; body.tile = tile;
  } else body.action = types[0];
  const r = await postAction(base, room, body);
  if (r.status !== 200) throw new Error(`action failed step ${step}: ${r.status} ${JSON.stringify(r.data ?? "")}`);
  st = await getState(base, room);
  collect(st);
}
check(st.match_status === "finished", "aka match finished on production", st.scores);
const reds = [34, 35, 36].filter(c => seen.has(c));
check(reds.length === 3, "all three red tiles existed in the match", reds);
console.log("scores:", st.scores, "| reds seen:", reds);
console.log(failures === 0 ? "AKA PROD SMOKE: ALL OK" : `AKA PROD SMOKE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
