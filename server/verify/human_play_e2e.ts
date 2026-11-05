// 検証：人の席（ruleset.allow_human_players）
// 1) フラグありの卓では human:true の招待参加が通り、状態にフラグが見える
// 2) フラグなしの卓では human:true の参加が 403 で拒否される（無印の参加は従来どおり可）
// 3) 人の席の状態では他家の手牌が見えない（自分の手牌だけ）
// 4) 対局ページ /play が配信される
// 5) 人の席がページと同じ手順（claim → action）で実際に打てる
import { createRoom, getState, type Room } from "./client.ts";

const base = process.argv[2] || "https://muse-jansou.muse-jansou.workers.dev";
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
async function inviteCode(room: Room, seat: number): Promise<string> {
  const inv = await api(room.room_id, "/invites", "POST", room.master,
    { role: "player", seat, max_uses: 1, expires_in_seconds: 3600 });
  if (inv.status !== 201) throw new Error("invite failed " + JSON.stringify(inv));
  return inv.data.invite_code as string;
}
async function join(room: Room, code: string, name: string, human: boolean) {
  const res = await fetch(`${base}/rooms/${room.room_id}/join`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite_code: code, display_name: name, ...(human ? { human: true } : {}) }) });
  let data: Json = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}
async function stateAs(roomId: string, token: string): Promise<Json> {
  const res = await fetch(`${base}/rooms/${roomId}/state`, { headers: { authorization: "Bearer " + token } });
  if (!res.ok) throw new Error("state failed " + res.status);
  return (await res.json()) as Json;
}

// claim -> action, exactly the sequence the human play page performs.
async function actAsPage(room: Room, token: string, seat: number, st: Json, step: number): Promise<boolean> {
  const dec = (st.decisions as Json[]).find(d => d.seat === seat);
  if (!dec) return false;
  const claimRes = await fetch(`${base}/rooms/${room.room_id}/claim`, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ seat, decision_id: st.decision_id }) });
  const claimJson = (await claimRes.json()) as Json;
  const claimToken = claimJson.claim_token as string | undefined;
  const actions = dec.actions as Json[];
  const types = actions.map(a => a.type as string);
  const body: Json = { seat, decision_id: st.decision_id, expected_revision: st.revision,
    idempotency_key: `hp-e2e-${room.room_id.slice(0, 6)}-${step}` };
  if (claimToken) body.claim_token = claimToken;
  if (st.phase === "reaction") {
    body.action = types.includes("ron") ? "ron" : "pass";
  } else if (types.includes("tsumo")) body.action = "tsumo";
  else {
    const discards = actions.filter(a => a.type === "discard");
    if (!discards.length) return false;
    const drawn = st.last_drawn as number | null;
    const pick = discards.find(a => a.tile === drawn) ?? discards[0];
    body.action = "discard"; body.tile = pick.tile;
  }
  const res = await fetch(`${base}/rooms/${room.room_id}/actions`, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body) });
  if (res.status !== 200) throw new Error("action failed " + res.status + " " + (await res.text()));
  return true;
}

const rulesHuman = { match_length: "east", clock: { enabled: false }, allow_human_players: true };
const { room: roomA } = await createRoom(base, { seed: 20261110, ruleset: rulesHuman });

// 1) human join on the flagged table
const codeA0 = await inviteCode(roomA, 0);
const jHuman = await join(roomA, codeA0, "人のテスト", true);
check(jHuman.status === 201 && typeof jHuman.data.token === "string" && jHuman.data.seat === 0,
  "flagged table accepts human join", jHuman);
const humanToken = jHuman.data.token as string;

// other seats join the usual (Muse) way
const botTokens: string[] = [];
for (const s of [1, 2, 3]) {
  const j = await join(roomA, await inviteCode(roomA, s), "bot" + s, false);
  if (j.status !== 201) throw new Error("bot join failed " + JSON.stringify(j));
  botTokens[s] = j.data.token as string;
}

// 2) state visibility for the human seat
let st = await stateAs(roomA.room_id, humanToken);
check(st.viewer?.role === "player" && st.viewer?.seat === 0, "human viewer is player seat 0", st.viewer);
check(st.ruleset?.allow_human_players === true, "state exposes allow_human_players=true", st.ruleset);
check(Array.isArray(st.hands?.[0]), "own hand visible");
check(st.hands?.[1] === null && st.hands?.[2] === null && st.hands?.[3] === null,
  "other hands hidden", st.hands?.map((h: unknown) => h === null));

// 3) unflagged table refuses human joins but not Muse joins
const { room: roomB } = await createRoom(base, { seed: 20261111, ruleset: { match_length: "east", clock: { enabled: false } } });
const jRefused = await join(roomB, await inviteCode(roomB, 0), "人のテスト", true);
check(jRefused.status === 403 && String(jRefused.data.error).includes("human seats"),
  "unflagged table refuses human join", jRefused);
const jMuse = await join(roomB, await inviteCode(roomB, 1), "Muse席", false);
check(jMuse.status === 201, "unflagged table still accepts Muse join", jMuse);
const stB = await stateAs(roomB.room_id, jMuse.data.token as string);
check(stB.ruleset?.allow_human_players === false, "state exposes allow_human_players=false", stB.ruleset);

// 4) the play page is served
const page = await fetch(`${base}/rooms/${roomA.room_id}/play`);
const html = await page.text();
check(page.status === 200 && html.includes("人の席"), "play page served", page.status);

// 5) play: the human acts through the page's exact sequence; bots tsumogiri.
const tokens: Record<number, string> = { 0: humanToken, 1: botTokens[1], 2: botTokens[2], 3: botTokens[3] };
let humanActs = 0, steps = 0;
while (humanActs < 4 && steps < 400) {
  steps++;
  st = await getState(base, roomA);
  const dec = (st.decisions as Json[])[0];
  if (!dec) break;
  const seat = dec.seat as number;
  const before = await stateAs(roomA.room_id, humanToken);
  if (before.hands?.[1] !== null || before.hands?.[2] !== null || before.hands?.[3] !== null) {
    check(false, "other hands stay hidden during play");
    break;
  }
  const acted = await actAsPage(roomA, tokens[seat], seat, await stateAs(roomA.room_id, tokens[seat]), steps);
  if (seat === 0 && acted) humanActs++;
}
check(humanActs >= 4, `human seat played ${humanActs} actions via claim->action`, humanActs);

console.log(failures === 0 ? "HUMAN PLAY E2E: ALL OK" : `HUMAN PLAY E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
