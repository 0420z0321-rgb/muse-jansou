// PR #3（牌譜一覧 GET /paipu?list=1）のステージ確認。
import { countsOf, connScore } from "../../ts/engine.ts";
import { createRoom, getState, postAction, type Room } from "./client.ts";

const base = process.argv[2] || "http://127.0.0.1:8799";
type Json = Record<string, any>;
let failures = 0;
function check(cond: boolean, label: string, extra?: unknown) {
  if (cond) console.log("ok -", label);
  else { failures++; console.log("FAIL -", label, extra ?? ""); }
}

const { room } = await createRoom(base, { seed: 41,
  ruleset: { match_length: "east", clock: { enabled: false } } });

async function paipuList(): Promise<{ status: number; data: Json }> {
  const res = await fetch(`${base}/rooms/${room.room_id}/paipu?list=1`,
    { headers: { authorization: "Bearer " + room.master } });
  return { status: res.status, data: await res.json() as Json };
}

const before = await paipuList();
check(before.status === 200 && Array.isArray(before.data.matches) && before.data.matches.length === 0,
  "list is empty before any match", before.status);

// play the match out (legal discards only)
let st = await getState(base, room);
let step = 0;
while (st.match_status !== "finished" && step < 1200) {
  step++;
  const d = (st.decisions as Json[])[0];
  if (!d) throw new Error("no decisions at step " + step);
  const seat = d.seat as number;
  const actions = d.actions as Json[];
  const types = actions.map(a => a.type as string);
  const body: Json = { seat, decision_id: st.decision_id,
    expected_revision: st.revision, idempotency_key: `pl-${step}`,
    actor: { name: "bot" + seat, icon: "x", avatar_url: "" } };
  if (st.phase === "reaction") body.action = types.includes("ron") ? "ron" : "pass";
  else if (types.includes("tsumo")) body.action = "tsumo";
  else if (types.includes("discard")) {
    const offered = actions.filter(a => a.type === "discard").map(a => a.tile as number);
    let tile = offered[0];
    if (st.riichi[seat]) {
      tile = offered.includes(st.last_drawn as number) ? (st.last_drawn as number) : offered[0];
    } else {
      const c = countsOf(st.hands[seat] as number[]);
      let best = connScore(c, tile);
      for (const t of offered.slice(1)) {
        const sc = connScore(c, t);
        if (sc < best) { best = sc; tile = t; }
      }
    }
    body.action = "discard"; body.tile = tile;
  } else body.action = types[0];
  const r = await postAction(base, room, body);
  if (r.status !== 200) throw new Error(`action failed step ${step}: ${r.status}`);
  st = await getState(base, room);
}
check(st.match_status === "finished", "match finished");

const after = await paipuList();
check(after.status === 200 && after.data.matches.length === 1, "list has the finished match", after.data);
const entry = after.data.matches[0] as Json;
check(entry.paipu_available === true, "paipu_available is true");
check(typeof entry.event_count === "number" && entry.event_count > 0, "event_count > 0", entry.event_count);
check(Array.isArray(entry.results) && entry.results.length === 4, "4 results listed");
check(typeof entry.match_key === "string" && entry.match_key.length > 0, "match_key present");

const res = await fetch(`${base}/rooms/${room.room_id}/paipu?match=${encodeURIComponent(entry.match_key)}`,
  { headers: { authorization: "Bearer " + room.master } });
const text = await res.text();
const lines = text.split("\n").filter(l => l.trim());
check(res.status === 200 && lines.length === entry.event_count + 2,
  "paipu by key returns header + events + footer", { status: res.status, lines: lines.length, events: entry.event_count });
const header = JSON.parse(lines[0]) as Json;
check(header.match_key === entry.match_key, "paipu header match_key agrees");

console.log(failures === 0 ? "PAIPU LIST CHECK: ALL OK" : `PAIPU LIST CHECK: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
