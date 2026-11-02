/** Prompt-proxy reservation E2E: declare proxy -> prompt plays counted ->
 * personal return clears -> re-declare -> 5th prompt play rotates seat. */
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
const created = await api("/rooms", "POST", undefined, { seed: 31337 },
  process.env.MASTER_TOKEN ? { "x-master-token": process.env.MASTER_TOKEN } : {});
if (created.status !== 201) { console.log("create failed", created.status, created.data); process.exit(1); }
const roomId = created.data.room_id as string;
const master = created.data.master_token as string;
const bootstrap = (created.data.player_tokens as Json[]).map(x => String(x.token));
const R = `/rooms/${roomId}`;
async function inviteJoin(seat: number, name: string): Promise<string> {
  const inv = await api(`${R}/invites`, "POST", master, { role: "player", seat, max_uses: 1, expires_in_seconds: 3600 });
  const j = await api(`${R}/join`, "POST", undefined, { invite_code: inv.data.invite_code, display_name: name, icon: "🪷" });
  if (j.status !== 201) throw new Error("join failed " + j.status + " " + JSON.stringify(j.data));
  return String(j.data.token);
}
const creds: Record<number, string> = {};
for (let s = 0; s < 4; s++) creds[s] = await inviteJoin(s, `P${s}`);
const qw = await api(`${R}/queue`, "POST", undefined, { display_name: "QWさん", icon: "🌸" });
check(qw.data.status === "waiting", "QW waits while all seats are held");

const bootProxy = await api(`${R}/proxy`, "POST", bootstrap[1], { active: true });
check(bootProxy.status === 403, "bootstrap cannot declare proxy");
const decl = await api(`${R}/proxy`, "POST", creds[1], { active: true });
check(decl.status === 200 && decl.data.proxy_active === true && decl.data.proxy_max_plays === 5, "P1 declares proxy (max 5 plays)");
let st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].proxy === true && st.occupancy.seats[1].proxy_plays === 0, "occupancy shows proxy active, 0 plays");

let nonce = 0;
async function actFor(s: Json, seat: number, viaPrompt: boolean): Promise<boolean> {
  const d = (s.decisions as Json[]).find(x => Number(x.seat) === seat);
  if (!d) return false;
  const actions = d.actions as Json[];
  const pick = actions.find(a => a.type === "pass") || actions.find(a => a.type === "discard") || actions[0];
  const body: Json = { seat, action: pick.type, decision_id: s.decision_id, expected_revision: s.revision, idempotency_key: `proxy-${nonce++}` };
  if (pick.tile !== undefined) body.tile = pick.tile;
  if (pick.consume !== undefined) body.consume = pick.consume;
  if (viaPrompt) body.via = "prompt";
  const r = await api(`${R}/actions`, "POST", creds[seat], body);
  if (r.status !== 200) { check(false, `action seat${seat} -> ${r.status} ${JSON.stringify(r.data)}`); return false; }
  return true;
}
/** Drive until seat1 has made `target` prompt plays in the current declaration. */
async function drivePromptPlays(target: number, label: string) {
  for (let i = 0; i < 500; i++) {
    st = (await api(`${R}/state`, "GET", master)).data;
    if (st.phase === "finished") { check(false, `${label}: match finished early`); return; }
    if (Number(st.occupancy.seats[1].proxy_plays) >= target) return;
    if (st.occupancy.seats[1].display_name !== "P1") return; // rotated
    const pend = (st.decisions as Json[]).map(d => Number(d.seat));
    for (const seat of pend) {
      await actFor(st, seat, seat === 1);
      st = (await api(`${R}/state`, "GET", master)).data;
      if (st.phase === "finished") { check(false, `${label}: match finished early`); return; }
    }
  }
  check(false, `${label}: budget exhausted`);
}
await drivePromptPlays(4, "proxy plays to 4");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].proxy === true && st.occupancy.seats[1].proxy_plays === 4 && st.occupancy.seats[1].display_name === "P1", "4 prompt plays: seat still P1, count 4");
// Personal return clears the reservation.
let returned = false;
for (let i = 0; i < 300 && !returned; i++) {
  st = (await api(`${R}/state`, "GET", master)).data;
  if (st.phase === "finished") break;
  const pend = (st.decisions as Json[]).map(d => Number(d.seat));
  for (const seat of pend) {
    if (await actFor(st, seat, false)) { if (seat === 1) returned = true; }
    st = (await api(`${R}/state`, "GET", master)).data;
    if (returned) break;
  }
}
check(returned, "P1 played in person");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].proxy === false && st.occupancy.seats[1].proxy_plays === 0, "personal play cleared the reservation");
// Re-declare and run to the cap: the 5th prompt play rotates the seat.
const decl2 = await api(`${R}/proxy`, "POST", creds[1], { active: true });
check(decl2.status === 200, "P1 re-declares proxy");
await drivePromptPlays(5, "proxy plays to cap");
st = (await api(`${R}/state`, "GET", master)).data;
check(st.occupancy.seats[1].display_name !== "P1" && st.occupancy.seats[1].proxy === false, "5th prompt play rotates P1 out");
const p1State = await api(`${R}/state`, "GET", creds[1]);
check(p1State.status === 401 || p1State.status === 403, "rotated-out P1 credential rejected");
const qws = await api(`${R}/queue-status`, "GET", String(qw.data.queue_token));
check(qws.data.status === "promoted" && qws.data.seat === 1, "QW promoted into seat1 after proxy expiry");
console.log(failures === 0 ? "PROXY E2E: ALL OK" : `PROXY E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
