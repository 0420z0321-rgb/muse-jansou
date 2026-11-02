/** Vacate (master-initiated timeout rotation) E2E:
 *  full room -> queue waits -> master vacates a seat -> queue head promoted ->
 *  old holder credential rejected -> repeat vacate opens seat -> no-op on
 *  open seat -> non-master forbidden -> invalid seat rejected. */
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

const created = await api("/rooms", "POST", undefined, { seed: 4242 },
  process.env.MASTER_TOKEN ? { "x-master-token": process.env.MASTER_TOKEN } : {});
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

const tokenA = await inviteJoin(0, "Aさん");
const tokenB = await inviteJoin(1, "Bさん");
await inviteJoin(2, "Cさん");
await inviteJoin(3, "Dさん");

const q1 = await api(`${R}/queue`, "POST", undefined, { display_name: "Q1さん", icon: "🌸" });
check(q1.status === 201 && q1.data.status === "waiting", "Q1 waits while room is full");

const v1 = await api(`${R}/vacate`, "POST", master, { seat: 1 });
check(v1.status === 200 && v1.data.vacated === true && v1.data.promoted === true, "master vacates seat1, Q1 promoted");
let st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].open === false, "seat1 held after promotion (holder row exists)");
check(Array.isArray(st.occupancy.queue) && st.occupancy.queue.length === 0, "queue drained after promotion");

const bState = await api(`${R}/state`, "GET", tokenB);
check(bState.status === 401 || bState.status === 403, "B's old credential rejected after vacate");

const q1s = await api(`${R}/queue-status`, "GET", String(q1.data.queue_token));
check(q1s.data.status === "promoted" && q1s.data.seat === 1 && typeof q1s.data.token === "string", "Q1 credential issued for seat1");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].display_name === "Q1さん" && st.occupancy.seats[1].joined === true, "seat1 shows Q1 after credential materializes");

const v2 = await api(`${R}/vacate`, "POST", master, { seat: 1 });
check(v2.status === 200 && v2.data.vacated === true && v2.data.promoted === false && v2.data.open === true, "second vacate opens seat1 (no queue)");
const v3 = await api(`${R}/vacate`, "POST", master, { seat: 1 });
check(v3.status === 200 && v3.data.vacated === false && v3.data.open === true, "vacate on open seat is a no-op");

const vForbidden = await api(`${R}/vacate`, "POST", tokenA, { seat: 0 });
check(vForbidden.status === 403, "player token cannot vacate");
const vBad = await api(`${R}/vacate`, "POST", master, { seat: 7 });
check(vBad.status === 400, "invalid seat rejected");

console.log(failures === 0 ? "ALL OK" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
