/** Ranking E2E (real engine, HTTP): 4 joined holders play a full hanchan;
 *  the finish must be recorded exactly once and aggregated correctly.
 *  A second room with only 2 joined seats checks bootstrap exclusion. */
import { playMatch } from "./play_http.ts";
import { createRoom, getState, type Room } from "./client.ts";

const base = process.argv[2] || "http://127.0.0.1:8799";
let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) console.log("ok -", label);
  else { failures++; console.log("FAIL -", label); }
}
type Json = Record<string, any>;
async function api(path: string, method: string, token?: string, body?: Json, extra: Json = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data: Json = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function joinedRoom(seed: number, seatsToJoin: number[]): Promise<{ room: Room; names: Map<number, string> }> {
  const created = await createRoom(base, { seed });
  const room = created.room;
  const names = new Map<number, string>();
  const players = [...room.players];
  for (const seat of seatsToJoin) {
    const name = `選手${seat}さん`;
    const inv = await api(`/rooms/${room.room_id}/invites`, "POST", room.master,
      { role: "player", seat, max_uses: 1, expires_in_seconds: 3600 });
    if (inv.status !== 201) throw new Error("invite failed " + inv.status);
    const j = await api(`/rooms/${room.room_id}/join`, "POST", undefined,
      { invite_code: inv.data.invite_code, display_name: name, icon: "🪷" });
    if (j.status !== 201) throw new Error("join failed " + j.status + " " + JSON.stringify(j.data));
    players[seat] = String(j.data.token);
    names.set(seat, name);
  }
  return { room: { room_id: room.room_id, master: room.master, players }, names };
}

// --- Room 1: all four seats joined ---
{
  const { room, names } = await joinedRoom(7, [0, 1, 2, 3]);
  const final = await playMatch(base, 7, { roomReuse: { room }, skipExpected: true, keyPrefix: "rank1" });
  const scores = final.scores as number[];
  const st = await getState(base, room);
  const ranking = st.ranking as Json[];
  check(Array.isArray(ranking) && ranking.length === 4, "ranking has 4 entries");
  const byName = new Map(ranking.map((r) => [r.display_name, r]));
  let diffSum = 0;
  let winsTotal = 0;
  const order = [0, 1, 2, 3].sort((a, b) => scores[b] - scores[a] || a - b);
  const rankOf = new Map(order.map((seat, i) => [seat, i + 1]));
  for (let seat = 0; seat < 4; seat++) {
    const e = byName.get(names.get(seat)!);
    check(!!e, `entry exists for seat ${seat}`);
    if (!e) continue;
    check(e.matches === 1, `seat ${seat} matches=1`);
    check(e.total_diff === scores[seat] - 25000, `seat ${seat} total_diff`);
    check(e.best_score === scores[seat], `seat ${seat} best_score`);
    check(Math.abs(e.avg_rank - rankOf.get(seat)!) < 0.051, `seat ${seat} avg_rank`);
    diffSum += e.total_diff;
    winsTotal += e.wins;
    if (rankOf.get(seat) === 1) check(e.wins === 1, "top player has wins=1");
    else check(e.wins === 0, `seat ${seat} wins=0`);
  }
  check(diffSum === 0, "total_diff sums to 0");
  check(winsTotal === 1, "exactly one win recorded");
  const sorted = [...ranking].sort((a, b) => b.total_diff - a.total_diff || b.wins - a.wins);
  check(JSON.stringify(ranking.map((r) => r.display_name)) === JSON.stringify(sorted.map((r) => r.display_name)),
    "ranking sorted by total_diff desc");
  const recent = st.recent_results as Json[];
  check(Array.isArray(recent) && recent.length === 1, "recent_results has 1 match");
  if (recent?.length) {
    const standings = recent[0].standings as Json[];
    check(standings.length === 4 && standings.every((s, i) => s.rank === i + 1), "standings ranked 1..4");
    check(standings[0].score === Math.max(...scores), "standings top score matches");
  }
  const st2 = await getState(base, room);
  check(JSON.stringify(st2.ranking) === JSON.stringify(st.ranking), "re-read does not double count");
}

// --- Room 2: only seats 0 and 2 joined; 1 and 3 stay bootstrap ---
{
  const { room, names } = await joinedRoom(11, [0, 2]);
  await playMatch(base, 11, { roomReuse: { room }, skipExpected: true, keyPrefix: "rank2" });
  const st = await getState(base, room);
  const ranking = st.ranking as Json[];
  check(Array.isArray(ranking) && ranking.length === 2, "bootstrap seats excluded from ranking");
  check(ranking.every((r) => [...names.values()].includes(r.display_name)), "only joined players ranked");
  const recent = st.recent_results as Json[];
  check(recent?.length === 1 && (recent[0].standings as Json[]).length === 4, "recent_results still lists all 4 seats");
}

console.log(failures === 0 ? "ALL OK" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
