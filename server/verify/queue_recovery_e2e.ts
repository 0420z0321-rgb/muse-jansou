/** Queue promotion recovery E2E:
 *  full room -> Q1 queues -> vacate promotes Q1 (provisional, unredeemed)
 *  -> vacating the unclaimed seat again must return Q1 to 'waiting' with
 *  its FIFO place intact (previously the queue row was stranded in
 *  'promoted' forever: queue-status 409-looped, queue-leave rejected it,
 *  re-queueing returned the stale row) -> Q1 is promoted again on the
 *  next opening, redeems, plays, leaves -> the claim is closed ('left')
 *  and queue-status rejects the old queue token. */
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

const created = await api("/rooms", "POST", undefined, { seed: 777 }, process.env.MASTER_TOKEN ? { "x-master-token": process.env.MASTER_TOKEN } : {});
if (created.status !== 201) { console.log("create failed", created.status, created.data); process.exit(1); }
const roomId = created.data.room_id as string;
const master = created.data.master_token as string;
const R = `/rooms/${roomId}`;

async function inviteJoin(seat: number, name: string): Promise<string> {
  const inv = await api(`${R}/invites`, "POST", master, { role: "player", seat, max_uses: 1, expires_in_seconds: 3600 });
  if (inv.status !== 201) throw new Error("invite failed " + inv.status + " " + JSON.stringify(inv.data));
  const j = await api(`${R}/join`, "POST", undefined, { invite_code: inv.data.invite_code, display_name: name, icon: "🪷" });
  if (j.status !== 201) throw new Error("join failed " + j.status + " " + JSON.stringify(j.data));
  return String(j.data.token);
}

await inviteJoin(0, "Aさん");
await inviteJoin(1, "Bさん");
await inviteJoin(2, "Cさん");
await inviteJoin(3, "Dさん");

const q1 = await api(`${R}/queue`, "POST", undefined, { display_name: "Q1さん", icon: "🌸" });
check(q1.status === 201 && q1.data.status === "waiting", "Q1 waits while room is full");
const q1Token = String(q1.data.queue_token);

const v1 = await api(`${R}/vacate`, "POST", master, { seat: 1 });
check(v1.status === 200 && v1.data.vacated === true && v1.data.promoted === true, "vacate seat1 promotes Q1 (provisional)");
let st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.queue.length === 0 && st.occupancy.seats[1].open === false, "Q1 holds seat1 provisionally, queue drained");

// Q1 never polls queue-status; the master rotates the unclaimed seat out.
const v2 = await api(`${R}/vacate`, "POST", master, { seat: 1 });
check(v2.status === 200 && v2.data.vacated === true && v2.data.promoted === false && v2.data.open === true, "vacating the unredeemed claim opens seat1");
st = (await api(`${R}/state`, "GET", master)).data;
check(Array.isArray(st.occupancy.queue) && st.occupancy.queue.length === 1 && st.occupancy.queue[0] === "Q1さん", "Q1 is back in the waiting queue after the unredeemed vacate");

const q1s = await api(`${R}/queue-status`, "GET", q1Token);
check(q1s.status === 200 && q1s.data.status === "waiting" && q1s.data.position === 1, "Q1 queue-status reports waiting at position 1 (no 409 loop)");

const q2 = await api(`${R}/queue`, "POST", undefined, { display_name: "Q2さん", icon: "🌼" });
check(q2.status === 201 && q2.data.status === "waiting" && q2.data.position === 2, "Q2 queues behind Q1 (FIFO order preserved)");

const v3 = await api(`${R}/vacate`, "POST", master, { seat: 2 });
check(v3.status === 200 && v3.data.vacated === true && v3.data.promoted === true, "vacate seat2 promotes Q1 again");
const q1s2 = await api(`${R}/queue-status`, "GET", q1Token);
check(q1s2.status === 200 && q1s2.data.status === "promoted" && q1s2.data.seat === 2 && typeof q1s2.data.token === "string", "Q1 redeems the seat2 promotion");
const playerToken = String(q1s2.data.token);
const pState = await api(`${R}/state`, "GET", playerToken);
check(pState.status === 200, "Q1 player credential works after redemption");

const lv = await api(`${R}/leave`, "POST", playerToken, {});
check(lv.status === 200 && lv.data.ok === true, "Q1 leaves seat2");
const q1s3 = await api(`${R}/queue-status`, "GET", q1Token);
check(q1s3.status === 401, "queue-status rejects the closed claim after leave");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[2].open === false && st.occupancy.queue.length === 0, "Q2 was promoted into seat2 after Q1 left, queue drained");

console.log(failures === 0 ? "ALL OK" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
