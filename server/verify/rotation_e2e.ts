/** Phase R2 rotation E2E (real engine, HTTP): join -> leave -> open seat ->
 * queue promotion -> promoted holder plays -> old credential rejected ->
 * bootstrap fallback still works -> queue waiting/leave. */
const base = process.argv[2] || "http://127.0.0.1:8799";
let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) console.log("ok -", label);
  else { failures++; console.log("FAIL -", label); }
}
type Json = Record<string, any>;
async function api(path: string, method: string, token?: string, body?: Json, extraHeaders: Json = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data: Json = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

const created = await api("/rooms", "POST", undefined, { seed: 777 },
  process.env.MASTER_TOKEN ? { "x-master-token": process.env.MASTER_TOKEN } : {});
if (created.status !== 201) { console.log("create failed", created.status, created.data); process.exit(1); }
const roomId = created.data.room_id as string;
const master = created.data.master_token as string;
const bootstrap = (created.data.player_tokens as Json[]).map((x) => String(x.token));
const R = `/rooms/${roomId}`;

async function inviteJoin(seat: number, name: string): Promise<string> {
  const inv = await api(`${R}/invites`, "POST", master, { role: "player", seat, max_uses: 1, expires_in_seconds: 3600 });
  if (inv.status !== 201) throw new Error("invite failed " + inv.status + " " + JSON.stringify(inv.data));
  const j = await api(`${R}/join`, "POST", undefined, { invite_code: inv.data.invite_code, display_name: name, icon: "🪷" });
  if (j.status !== 201) throw new Error("join failed " + j.status + " " + JSON.stringify(j.data));
  return String(j.data.token);
}

const tokenA = await inviteJoin(1, "Aさん");
const tokenB = await inviteJoin(2, "Bさん");

let st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].joined === true && st.occupancy.seats[1].open === false, "seat1 held by A");
check(st.occupancy.seats[2].joined === true && st.occupancy.seats[2].open === false, "seat2 held by B");
check(st.occupancy.seats[0].open === true && st.occupancy.seats[3].open === true, "bootstrap-only seats are open");
check(Array.isArray(st.occupancy.queue) && st.occupancy.queue.length === 0, "queue empty");

const leave = await api(`${R}/leave`, "POST", tokenA);
check(leave.status === 200 && leave.data.seat === 1, "A leaves seat1");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].open === true, "seat1 open after leave");

const aState = await api(`${R}/state`, "GET", tokenA);
check(aState.status === 401 || aState.status === 403, "A's old credential rejected");

const bootState = await api(`${R}/state`, "GET", bootstrap[1]);
check(bootState.status === 200, "bootstrap fill-in can still view seat1");

const q1 = await api(`${R}/queue`, "POST", undefined, { display_name: "Q1さん", icon: "🌸" });
check(q1.status === 201 && q1.data.status === "promoted" && q1.data.seat === 0, "Q1 promoted to lowest open seat (0)");
const q1s = await api(`${R}/queue-status`, "GET", String(q1.data.queue_token));
check(q1s.data.status === "promoted" && q1s.data.seat === 0 && typeof q1s.data.token === "string", "Q1 receives player credential");
const tokenQ1 = String(q1s.data.token);

const q2 = await api(`${R}/queue`, "POST", undefined, { display_name: "Q2さん", icon: "🌼" });
check(q2.status === 201 && q2.data.status === "promoted" && q2.data.seat === 1, "Q2 promoted into vacated seat1");
const q2s = await api(`${R}/queue-status`, "GET", String(q2.data.queue_token));
const tokenQ2 = String(q2s.data.token);
check(q2s.data.status === "promoted" && q2s.data.seat === 1, "Q2 receives seat1 credential");

const credFor: Record<number, string> = { 0: tokenQ1, 1: tokenQ2, 2: tokenB, 3: bootstrap[3] };
let step = 0;
let q2Played = false;
while (step < 60 && !q2Played) {
  step++;
  st = (await api(`${R}/state`, "GET", master)).data;
  if (st.phase === "finished") break;
  const d = (st.decisions as Json[])[0];
  if (!d) break;
  const seat = Number(d.seat);
  const actions = d.actions as Json[];
  const pick = actions.find((a) => a.type === "pass") || actions.find((a) => a.type === "discard") || actions[0];
  const body: Json = {
    seat, action: pick.type, decision_id: st.decision_id,
    expected_revision: st.revision, idempotency_key: `r2e2e-${step}`,
  };
  if (pick.tile !== undefined) body.tile = pick.tile;
  if (pick.consume !== undefined) body.consume = pick.consume;
  const r = await api(`${R}/actions`, "POST", credFor[seat], body);
  if (r.status !== 200) { check(false, `action by seat${seat} holder (${pick.type}) -> ${r.status} ${JSON.stringify(r.data)}`); break; }
  if (seat === 1 && pick.type === "discard") q2Played = true;
}
check(q2Played, "promoted holder Q2 played a real discard for seat1");

const q3 = await api(`${R}/queue`, "POST", undefined, { display_name: "Q3さん" });
check(q3.data.status === "promoted" && q3.data.seat === 3, "Q3 promoted to seat3");
const q4 = await api(`${R}/queue`, "POST", undefined, { display_name: "Q4さん" });
check(q4.data.status === "waiting" && q4.data.position === 1, "Q4 waits at position 1");
st = (await api(`${R}/state`, "GET", master)).data;
check(JSON.stringify(st.occupancy.queue) === JSON.stringify(["Q4さん"]), "state exposes queue names in order");
const q4leave = await api(`${R}/queue/leave`, "POST", String(q4.data.queue_token));
check(q4leave.status === 200, "Q4 leaves queue");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.queue.length === 0, "queue empty after Q4 leaves");

const bLeave = await api(`${R}/leave`, "POST", bootstrap[2]);
check(bLeave.status === 403, "bootstrap cannot leave");
const spec = await api(`${R}/queue`, "POST", tokenB, { display_name: "Bさん" });
check(spec.status === 409, "current player cannot join queue");

console.log(failures === 0 ? "R2 E2E: ALL OK" : `R2 E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
