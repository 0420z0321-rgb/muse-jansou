/** Sprint clock E2E: bank 2min / byoyomi 15s, timeout streak of 2 forces
 * rotation, a voluntary action resets the streak, and a freshly promoted
 * holder gets a one-time +60s grace on their first deadline. */
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
const created = await api("/rooms", "POST", undefined,
  { seed: 4242, ruleset: { clock: { enabled: true, preset: "sprint" } } },
  process.env.MASTER_TOKEN ? { "x-master-token": process.env.MASTER_TOKEN } : {});
if (created.status !== 201) { console.log("create failed", created.status, created.data); process.exit(1); }
const roomId = created.data.room_id as string;
const master = created.data.master_token as string;
const R = `/rooms/${roomId}`;
console.log("ROOM", roomId);
async function inviteJoin(seat: number, name: string): Promise<string> {
  const inv = await api(`${R}/invites`, "POST", master, { role: "player", seat, max_uses: 1, expires_in_seconds: 3600 });
  if (inv.status !== 201) throw new Error("invite failed " + inv.status);
  const j = await api(`${R}/join`, "POST", undefined, { invite_code: inv.data.invite_code, display_name: name, icon: "🪷" });
  if (j.status !== 201) throw new Error("join failed " + j.status + " " + JSON.stringify(j.data));
  return String(j.data.token);
}
const creds: Record<number, string> = {};
for (let s = 0; s < 4; s++) creds[s] = await inviteJoin(s, `P${s}`);
const qw = await api(`${R}/queue`, "POST", undefined, { display_name: "QWさん", icon: "🌸" });
check(qw.data.status === "waiting", "QW waits while all seats are held");
let st = (await api(`${R}/state`, "GET", master)).data;
check(st.clock && st.clock.remaining_ms.every((v: number) => v === 120000), "sprint bank is 120000ms for all seats");

let offsetMs = 0;
let knownLog: Json[] = [];
async function advanceBy(adv: number): Promise<Json> {
  const r = await api(`${R}/dev/advance-time`, "POST", master, { advance_ms: Math.max(0, Math.floor(adv)) });
  if (typeof r.data.time_offset_ms === "number") offsetMs = r.data.time_offset_ms;
  if (Array.isArray(r.data.state?.clock_log)) knownLog = r.data.state.clock_log;
  return r.data.state as Json;
}
async function advancePast(deadline: number) {
  const adv = deadline - (Date.now() + offsetMs) + 1500;
  if (adv > 0) await advanceBy(adv);
}
const seat1Timeouts = () => knownLog.filter(e => e.seat === 1 && e.timed_out === true).length;

let nonce = 0;
async function actOnce(s: Json, seat: number): Promise<boolean> {
  const d = (s.decisions as Json[]).find(x => Number(x.seat) === seat);
  if (!d) return false;
  const actions = d.actions as Json[];
  const pick = actions.find(a => a.type === "pass") || actions.find(a => a.type === "discard") || actions[0];
  const body: Json = { seat, action: pick.type, decision_id: s.decision_id, expected_revision: s.revision, idempotency_key: `sprint-${nonce++}` };
  if (pick.tile !== undefined) body.tile = pick.tile;
  if (pick.consume !== undefined) body.consume = pick.consume;
  const r = await api(`${R}/actions`, "POST", creds[seat], body);
  if (r.status !== 200) { check(false, `action seat${seat} ${pick.type} -> ${r.status} ${JSON.stringify(r.data)}`); return false; }
  return true;
}
/** Drive until predicate holds. seat1Mode "timeout": never act for seat1;
 * advance engine time when seat1 is the only pending decision. */
async function drive(seat1Mode: "timeout" | "act", until: () => boolean, label: string, budget = 400) {
  for (let i = 0; i < budget; i++) {
    if (until()) return true;
    st = (await api(`${R}/state`, "GET", master)).data;
    if (st.phase === "finished") { check(false, `${label}: match finished early`); return false; }
    if (until()) return true;
    const pend = (st.decisions as Json[]).map(d => Number(d.seat));
    if (pend.length === 0) { check(false, `${label}: no pending decisions`); return false; }
    if (seat1Mode === "timeout" && pend.length === 1 && pend[0] === 1) {
      const dl = st.clock?.deadlines?.["1"];
      if (typeof dl !== "number") { check(false, `${label}: no deadline for seat1`); return false; }
      await advancePast(dl);
      continue;
    }
    for (const seat of pend) {
      if (seat === 1 && seat1Mode === "timeout") continue;
      await actOnce(st, seat);
      st = (await api(`${R}/state`, "GET", master)).data;
      if (st.phase === "finished") { check(false, `${label}: match finished early`); return false; }
    }
  }
  check(false, `${label}: step budget exhausted`);
  return false;
}
// A1: one timeout; P1 keeps the seat.
await drive("timeout", () => seat1Timeouts() >= 1, "A1 first timeout");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].open === false && st.occupancy.seats[1].display_name === "P1", "after 1 timeout seat1 still held by P1");
// A2: P1 acts once (streak reset).
let acted = false;
for (let i = 0; i < 400 && !acted; i++) {
  st = (await api(`${R}/state`, "GET", master)).data;
  if (st.phase === "finished") break;
  const pend = (st.decisions as Json[]).map(d => Number(d.seat));
  for (const seat of pend) {
    if (await actOnce(st, seat)) { if (seat === 1) acted = true; }
    st = (await api(`${R}/state`, "GET", master)).data;
    if (acted) break;
  }
}
check(acted, "P1 acted voluntarily (streak reset)");
const t0 = seat1Timeouts();
await drive("timeout", () => seat1Timeouts() >= t0 + 1, "A2 timeout after reset");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].open === false && st.occupancy.seats[1].display_name === "P1", "one timeout after reset does NOT rotate (streak was reset)");
await drive("timeout", () => seat1Timeouts() >= t0 + 2, "A2 second consecutive timeout");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].open === false && st.occupancy.seats[1].display_name !== "P1", "second consecutive timeout vacates P1 from seat1");
const p1State = await api(`${R}/state`, "GET", creds[1]);
check(p1State.status === 401 || p1State.status === 403, "rotated-out P1 credential rejected");
const qws = await api(`${R}/queue-status`, "GET", String(qw.data.queue_token));
check(qws.data.status === "promoted" && qws.data.seat === 1 && typeof qws.data.token === "string", "QW receives seat1 credential");
if (typeof qws.data.token === "string") creds[1] = String(qws.data.token);
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].display_name === "QWさん", "after credential issue, seat1 shows QW as holder");
// B: grace on QW's first deadline only. Raw publicState comes from advance-time(0).
let graceSeen = false; let plainSeen = false;
for (let i = 0; i < 400 && !(graceSeen && plainSeen); i++) {
  const raw = await advanceBy(0);
  if (raw.phase === "finished") { check(false, "B: match finished early"); break; }
  const dl = raw.clock?.deadlines?.["1"]; const ph = raw.clock?.phases?.["1"]; const opened = raw.clock?.opened_at;
  st = (await api(`${R}/state`, "GET", master)).data;
  const pend1 = (st.decisions as Json[]).some(d => Number(d.seat) === 1);
  if (typeof dl === "number" && pend1 && typeof opened === "number") {
    const base = ph === "main" ? Math.min(120000, Number(raw.clock.remaining_ms[1])) : 15000;
    const delta = dl - opened;
    if (!graceSeen) {
      check(delta >= base + 55000 && delta <= base + 65000, `QW first deadline carries +60s grace (delta=${delta}, base=${base})`);
      graceSeen = true;
    } else if (!plainSeen) {
      check(Math.abs(delta - base) <= 5000, `QW second deadline has no grace (delta=${delta}, base=${base})`);
      plainSeen = true;
    }
  }
  const pend = (st.decisions as Json[]).map(d => Number(d.seat));
  for (const seat of pend) await actOnce(st, seat);
}
check(graceSeen, "grace deadline observed");
check(plainSeen, "post-grace plain deadline observed");
console.log(failures === 0 ? "SPRINT E2E: ALL OK" : `SPRINT E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
