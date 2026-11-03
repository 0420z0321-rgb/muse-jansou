// 回帰テスト：再試合（rematch）で始まった2戦目もランキング・牌譜に記録されること。
// 不具合の経緯（2026-11-03）：handleRematch が ranking_generation を繰り上げずに
// 新しい game を直接書き込んでいたため、2戦目の試合キーが初戦と衝突し、
// recordFinishedMatchTx が「記録済み」として結果を静かに捨てていた。
import { countsOf, connScore } from "../../ts/engine.ts";
import { createRoom, getState, postAction, type Room } from "./client.ts";

const base = process.argv[2] || "http://127.0.0.1:8799";
type Json = Record<string, any>;
let failures = 0;
function check(cond: boolean, label: string, extra?: unknown) {
  if (cond) console.log("ok -", label);
  else { failures++; console.log("FAIL -", label, extra ?? ""); }
}
async function api(roomId: string, path: string, method: string, token?: string, body?: Json) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(`${base}/rooms/${roomId}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined });
  let data: Json = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function inviteJoin(room: Room, seat: number, name: string): Promise<string> {
  const inv = await api(room.room_id, "/invites", "POST", room.master,
    { role: "player", seat, max_uses: 1, expires_in_sec: 3600 });
  if (inv.status !== 201) throw new Error("invite failed " + JSON.stringify(inv));
  const jr = await fetch(`${base}/rooms/${room.room_id}/join`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite_code: inv.data.invite_code, display_name: name }) });
  const jj = await jr.json() as Json;
  const ptoken = (jj.token ?? jj.player_token) as string;
  if (jr.status !== 201 || !ptoken) throw new Error("join failed " + JSON.stringify(jj));
  return ptoken;
}

async function playToFinish(room: Room, tokens: string[], tag: string, maxSteps = 2400): Promise<Json> {
  let st = await getState(base, room);
  let step = 0;
  while (st.match_status !== "finished" && step < maxSteps) {
    step++;
    const src: Room = { room_id: room.room_id, master: room.master, players: tokens };
    const d = (st.decisions as Json[])[0];
    if (!d) throw new Error("no decisions at step " + step);
    const seat = d.seat as number;
    const actions = d.actions as Json[];
    const types = actions.map(a => a.type as string);
    const body: Json = { seat, decision_id: st.decision_id,
      expected_revision: st.revision, idempotency_key: `rr-${tag}-${room.room_id.slice(0, 6)}-${step}`,
      actor: { name: "bot" + seat, icon: "x", avatar_url: "" } };
    if (st.phase === "reaction") {
      body.action = types.includes("ron") ? "ron" : "pass";
    } else if (types.includes("tsumo")) body.action = "tsumo";
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
    const r = await postAction(base, src, body);
    if (r.status !== 200) throw new Error(`action failed step ${step}: ${r.status} ${JSON.stringify(r.json)}`);
    st = await getState(base, room);
  }
  if (st.match_status !== "finished") throw new Error("match did not finish");
  return st;
}

const { room } = await createRoom(base, { seed: 41,
  ruleset: { match_length: "east", clock: { enabled: false } } });
const tokens: string[] = [];
for (let s = 0; s < 4; s++) tokens.push(await inviteJoin(room, s, "R" + s));
const joinedRoom: Room = { room_id: room.room_id, master: room.master, players: tokens };

// --- match 1 ---
await playToFinish(joinedRoom, tokens, "m1");
let list = (await api(room.room_id, "/paipu?list=1", "GET", room.master)).data;
check(Array.isArray(list.matches) && list.matches.length === 1,
  "after match 1: exactly one recorded match", list.matches?.length);
check(list.matches?.[0]?.match_key === "g0:initial",
  "match 1 key is g0:initial", list.matches?.[0]?.match_key);

// --- rematch ---
const rm = await api(room.room_id, "/rematch", "POST", room.master, {});
check(rm.status === 200 && rm.data.ok === true, "rematch accepted", rm);

// --- match 2 ---
await playToFinish(joinedRoom, tokens, "m2");
list = (await api(room.room_id, "/paipu?list=1", "GET", room.master)).data;
check(Array.isArray(list.matches) && list.matches.length === 2,
  "after match 2: two recorded matches", list.matches?.map((m: Json) => m.match_key));
const keys = (list.matches as Json[]).map(m => m.match_key).sort();
check(keys[0] === "g0:initial" && keys[1] === "g1:initial",
  "match keys are g0:initial and g1:initial", keys);
const st = (await api(room.room_id, "/state", "GET", room.master)).data;
check(Array.isArray(st.recent_results) && st.recent_results.length === 2,
  "recent_results holds both matches", st.recent_results?.length);
const ranked = (st.ranking as Json[]).filter(r => (r.matches as number) >= 2);
check(ranked.length === 4, "all four holders have 2 matches in ranking",
  (st.ranking as Json[]).map(r => r.matches));

console.log(failures === 0 ? "REMATCH RANKING E2E: ALL OK" : `REMATCH RANKING E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
