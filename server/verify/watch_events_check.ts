// watch-events（SE/アニメ用 公開シグナル）の実機確認：
// 実際に1試合打たせながらゲスト（合言葉）で差分を取り、
// シグナルの種類・形・秘密情報が混ざらないことを確かめる。
import { countsOf, connScore } from "../../ts/engine.ts";
import { winningTilesMelds } from "../../ts/yaku.ts";
import { createRoom, getState, postAction, type Room } from "./client.ts";

const base = process.argv[2] || "http://127.0.0.1:8799";
type Json = Record<string, any>;

const { room } = await createRoom(base, {
  seed: 5,
  ruleset: { match_length: "east", clock: { enabled: false } },
});
const R = `${base}/rooms/${room.room_id}`;
const pwRes = await fetch(`${R}/watch-password`, {
  method: "POST",
  headers: { authorization: "Bearer " + room.master, "content-type": "application/json" },
  body: JSON.stringify({ password: "img" }),
});
if (!pwRes.ok) throw new Error("watch-password failed " + pwRes.status);

async function guestEvents(after: number): Promise<Json> {
  const res = await fetch(`${R}/watch-events?after=${after}`, {
    headers: { "x-watch-password": "img" },
  });
  if (!res.ok) throw new Error("watch-events failed " + res.status + " " + (await res.text()));
  return (await res.json()) as Json;
}
const tail = await (await fetch(`${R}/watch-events?tail=1`, {
  headers: { "x-watch-password": "img" },
})).json() as Json;
let cursor = Number(tail.latest_seq ?? 0);

const tally = new Map<string, number>();
const ALLOWED = new Set(["type", "seat", "tile", "call_type", "win_type", "from_seat"]);
let badKeys = 0;
let discardTilesOk = 0;
async function drain() {
  for (let page = 0; page < 10; page++) {
    const data = await guestEvents(cursor);
    for (const ev of data.events as Json[]) {
      for (const sig of ev.signals as Json[]) {
        tally.set(sig.type, (tally.get(sig.type) ?? 0) + 1);
        for (const k of Object.keys(sig)) if (!ALLOWED.has(k)) badKeys++;
        if (sig.type === "discard" && typeof sig.tile === "number" &&
            sig.tile >= 0 && sig.tile <= 33) discardTilesOk++;
      }
    }
    cursor = Number(data.latest_seq ?? cursor);
    if (!data.has_more) break;
  }
}

let step = 0;
let st = await getState(base, room as Room);
while (st.match_status !== "finished" && step < 900) {
  step++;
  const decisions = st.decisions as Json[];
  if (!decisions.length) throw new Error("no decisions at step " + step);
  const d = decisions[0];
  const seat = d.seat as number;
  const actions = d.actions as Json[];
  const types = actions.map(a => a.type as string);
  const body: Json = { seat, decision_id: st.decision_id,
    expected_revision: st.revision, idempotency_key: `we-${step}`,
    actor: { name: "bot" + seat, icon: "x", avatar_url: "" } };
  if (st.phase === "reaction") {
    if (types.includes("ron")) body.action = "ron";
    else if (types.includes("pon") && Math.random() < 0.5) body.action = "pon";
    else if (types.includes("chi") && Math.random() < 0.3) {
      body.action = "chi";
      body.consume = actions.find(a => a.type === "chi")!.consume;
    } else body.action = "pass";
  } else if (types.includes("tsumo")) body.action = "tsumo";
  else if (types.includes("ankan") && Math.random() < 0.7) {
    body.action = "ankan"; body.tile = actions.find(a => a.type === "ankan")!.tile;
  } else if (types.includes("discard")) {
    const hand = st.hands[seat] as number[];
    const offered = actions.filter(a => a.type === "discard").map(a => a.tile as number);
    let tile = offered[0];
    if (st.riichi[seat]) tile = offered.includes(st.last_drawn as number) ? (st.last_drawn as number) : offered[0];
    else {
      const c = countsOf(hand);
      let best = connScore(c, tile);
      for (const t of offered.slice(1)) {
        const sc = connScore(c, t);
        if (sc < best) { best = sc; tile = t; }
      }
      const rest = [...hand]; rest.splice(rest.indexOf(tile), 1);
      const melds = st.melds[seat] as Json[];
      if (!st.riichi[seat] && (st.scores[seat] as number) >= 1000 &&
          melds.every(m => m.type === "ankan") &&
          winningTilesMelds(countsOf(rest), 4 - melds.length).length > 0 &&
          Math.random() < 0.8) body.riichi = true;
    }
    body.action = "discard"; body.tile = tile;
  } else {
    body.action = types[0];
  }
  const r = await postAction(base, room as Room, body);
  if (r.status !== 200) throw new Error(`action failed step ${step}: ${r.status} ${JSON.stringify(r.json)}`);
  st = await getState(base, room as Room);
  if (step % 20 === 0) await drain();
}
await drain();
console.log("match_status:", st.match_status, "steps:", step, "final scores:", st.scores);
console.log("signal tally:", Object.fromEntries(tally));
console.log("discard signals with valid tile:", discardTilesOk);
console.log("non-allowlisted signal keys:", badKeys);
const need = ["tile_draw", "discard", "hand_start", "hand_end", "score_change"];
const missing = need.filter(t => !tally.get(t));
console.log(missing.length === 0 && badKeys === 0 && discardTilesOk > 10
  ? "WATCH-EVENTS CHECK: OK" : "WATCH-EVENTS CHECK: INCOMPLETE missing=" + missing.join(","));
