/** Members directory E2E: profile bio extension + GET /rooms/:id/members.
 *  Joins players and a spectator on a fresh room, exercises bio validation
 *  and persistence, and checks the directory payload for token principals
 *  and for the watch-password audience. */
import { createRoom } from "./client.ts";

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

const created = await createRoom(base, { seed: 42 });
const room = created.room;
const rid = room.room_id;

// Watch password for the public audience.
{
  const r = await api(`/rooms/${rid}/watch-password`, "POST", room.master, { password: "test-watch-pw" });
  check(r.status === 200 && r.data.ok === true, "master sets watch password");
}

// Join two players and one spectator.
async function join(role: string, seat: number | null, name: string): Promise<string> {
  const inv = await api(`/rooms/${rid}/invites`, "POST", room.master,
    { role, seat, max_uses: 1, expires_in_seconds: 3600 });
  if (inv.status !== 201) throw new Error("invite failed " + inv.status);
  const j = await api(`/rooms/${rid}/join`, "POST", undefined,
    { invite_code: inv.data.invite_code, display_name: name, icon: "🪷" });
  if (j.status !== 201) throw new Error("join failed " + j.status + " " + JSON.stringify(j.data));
  return String(j.data.token);
}
const p0 = await join("player", 0, "名鑑テスト0");
const p1 = await join("player", 1, "名鑑テスト1");
const s0 = await join("spectator", null, "名鑑観戦者");

// Anonymous directory read is refused.
{
  const r = await api(`/rooms/${rid}/members`, "GET");
  check(r.status === 401, "members without auth -> 401");
}

// Directory via watch password: all three present, players seated.
{
  const r = await api(`/rooms/${rid}/members`, "GET", undefined, undefined,
    { "x-watch-password": "test-watch-pw" });
  check(r.status === 200, "members via watch password -> 200");
  const ms = r.data.members as Json[];
  check(Array.isArray(ms) && ms.length === 3, "members lists 3 participants");
  const byName = new Map(ms.map((m) => [m.display_name, m]));
  const m0 = byName.get("名鑑テスト0");
  check(!!m0 && m0.role === "player", "player 0 present as player");
  check(!!m0 && m0.status && m0.status.kind === "seated" && m0.status.seat === 0, "player 0 seated at seat 0");
  check(!!m0 && m0.ranking === null, "player 0 ranking null before any match");
  check(!!m0 && m0.bio === null, "player 0 bio null initially");
  const ms0 = byName.get("名鑑観戦者");
  check(!!ms0 && ms0.role === "spectator" && ms0.ranking === null, "spectator present without ranking");
}

// Bio set / validation / persistence.
{
  const bio = "よろしくお願いします。\n攻めの麻雀が好きです。";
  const r = await api(`/rooms/${rid}/profile`, "POST", p0, { bio });
  check(r.status === 200 && r.data.bio === bio, "bio set with newline");
  const bad1 = await api(`/rooms/${rid}/profile`, "POST", p0, { bio: "あ".repeat(201) });
  check(bad1.status === 400, "bio 201 chars -> 400");
  const ok200 = await api(`/rooms/${rid}/profile`, "POST", p0, { bio: "あ".repeat(200) });
  check(ok200.status === 200, "bio 200 chars -> 200");
  const bad2 = await api(`/rooms/${rid}/profile`, "POST", p0, { bio: "badbio" });
  check(bad2.status === 400, "bio with control char -> 400");
  const bad3 = await api(`/rooms/${rid}/profile`, "POST", p0, { bio: 42 });
  check(bad3.status === 400, "bio non-string -> 400");
  // Restore the readable bio, then a name-only update must preserve it.
  await api(`/rooms/${rid}/profile`, "POST", p0, { bio });
  const rn = await api(`/rooms/${rid}/profile`, "POST", p0, { display_name: "名鑑テスト0改" });
  check(rn.status === 200 && rn.data.bio === bio, "name-only update preserves bio");
  const r2 = await api(`/rooms/${rid}/members`, "GET", p1);
  const m0 = (r2.data.members as Json[]).find((m) => m.display_name === "名鑑テスト0改");
  check(!!m0 && m0.bio === bio, "bio visible in members directory");
  const cleared = await api(`/rooms/${rid}/profile`, "POST", p0, { bio: null });
  check(cleared.status === 200 && cleared.data.bio === null, "bio cleared with null");
  const empty = await api(`/rooms/${rid}/profile`, "POST", p0, {});
  check(empty.status === 400, "empty profile update -> 400");
}

// A fresh room has an empty directory.
{
  const c2 = await createRoom(base, { seed: 43 });
  const r = await api(`/rooms/${c2.room.room_id}/members`, "GET", c2.room.master);
  check(r.status === 200 && Array.isArray(r.data.members) && r.data.members.length === 0,
    "fresh room members empty");
}

console.log(failures === 0 ? "members_e2e: ALL OK" : `members_e2e: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
