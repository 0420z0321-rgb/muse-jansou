// 再試合＋試合終わりリレーのE2E（4席とも招待参加で保持者がいる本番形）。
// A卓: 対局中に5人目が並ぶ → 終了後に rematch → 席が1つ入れ替わり新試合開始。
// B卓: 待ち列なしで rematch → 入れ替わりなしで新試合開始。対局中の rematch は409。
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

const playersOf = (room: Room): string[] => room.players;
async function inviteJoin(room: Room, seat: number, name: string): Promise<string> {
  const inv = await api(room.room_id, "/invites", "POST", room.master,
    { role: "player", seat, max_uses: 1, expires_in_sec: 3600 });
  if (inv.status !== 201) throw new Error("invite failed " + JSON.stringify(inv));
  const sh: Record<string, string> = { "content-type": "application/json",
    authorization: "Bearer " + room.players[seat] };
  const claim = await fetch(`${base}/rooms/${room.room_id}/claim`, {
    method: "POST", headers: sh,
    body: JSON.stringify({ seat, decision_id: (await getState(base, room)).decision_id }) });
  const cj = await claim.json() as Json;
  if (!cj.claim_token) throw new Error("claim failed " + JSON.stringify(cj));
  const jr = await fetch(`${base}/rooms/${room.room_id}/join`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite_code: inv.data.invite_code, display_name: name,
      claim_token: cj.claim_token }) });
  const jj = await jr.json() as Json;
  if (jr.status !== 201 || !jj.player_token) throw new Error("join failed " + JSON.stringify(jj));
  return jj.player_token as string;
}

async function playToFinish(room: Room, tokens: string[], maxSteps = 1200): Promise<Json> {
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
      expected_revision: st.revision, idempotency_key: `rm-${room.room_id.slice(0, 6)}-${step}`,
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

const names = (occ: Json) => (occ.seats as Json[]).map(s => s.display_name);

// ---------- Room A: relay with one waiter ----------
{
  const { room } = await createRoom(base, { seed: 31,
    ruleset: { match_length: "east", clock: { enabled: false } } });
  const tokens: string[] = [];
  for (let s = 0; s < 4; s++) tokens.push(await inviteJoin(room, s, "P" + s));
  const joinedRoom: Room = { room_id: room.room_id, master: room.master, players: tokens };
  const early = await api(room.room_id, "/rematch", "POST", tokens[0], {});
  check(early.status === 409, "rematch during play is 409", early);
  const q = await api(room.room_id, "/queue", "POST", undefined, { display_name: "Q5さん", icon: "🌸" });
  check(q.status === 201 && q.data.status === "waiting", "Q5 waits mid-match", q.data.status);
  const fin = await playToFinish(joinedRoom, tokens);
  check(fin.match_status === "finished", "room A match finished");
  const before = (await api(room.room_id, "/state", "GET", room.master)).data;
  const namesBefore = names(before.occupancy);
  const rm = await api(room.room_id, "/rematch", "POST", tokens[0], {});
  check(rm.status === 200 && rm.data.ok === true, "rematch accepted", rm);
  if (rm.status === 200) {
    check(Array.isArray(rm.data.rotated_seats) && rm.data.rotated_seats.length === 1,
      "exactly one seat rotated", rm.data);
    const after = (await api(room.room_id, "/state", "GET", room.master)).data;
    check(after.match_status !== "finished" && after.phase !== "finished", "new match is playing");
    check((after.scores as number[]).every(x => x === 25000), "scores reset", after.scores);
    const namesAfter = names(after.occupancy);
    const changed = namesBefore.filter((n, i) => n !== namesAfter[i]).length;
    check(changed === 1, "one holder changed (the waiter came in)", { namesBefore, namesAfter });
    check((after.occupancy.queue as Json[]).length === 0, "queue drained after relay");
    const rotatedSeat = (rm.data.rotated_seats as number[])[0];
    const stale = await api(room.room_id, "/state", "GET", tokens[rotatedSeat]);
    check(stale.status === 401, "yielded player's credential is revoked", stale.status);
  }
}

// ---------- Room B: rematch without a queue ----------
{
  const { room } = await createRoom(base, { seed: 32,
    ruleset: { match_length: "east", clock: { enabled: false } } });
  const tokens: string[] = [];
  for (let s = 0; s < 4; s++) tokens.push(await inviteJoin(room, s, "B" + s));
  const joinedRoom: Room = { room_id: room.room_id, master: room.master, players: tokens };
  const fin = await playToFinish(joinedRoom, tokens);
  check(fin.match_status === "finished", "room B match finished");
  const before = (await api(room.room_id, "/state", "GET", room.master)).data;
  const namesBefore = names(before.occupancy);
  const rm = await api(room.room_id, "/rematch", "POST", room.master, {});
  check(rm.status === 200 && (rm.data.rotated_seats as number[]).length === 0,
    "rematch without queue rotates nobody", rm.data);
  const after = (await api(room.room_id, "/state", "GET", room.master)).data;
  check(JSON.stringify(namesBefore) === JSON.stringify(names(after.occupancy)), "same holders stay");
  check(after.match_status !== "finished", "room B new match is playing");
}

console.log(failures === 0 ? "REMATCH E2E: ALL OK" : `REMATCH E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
