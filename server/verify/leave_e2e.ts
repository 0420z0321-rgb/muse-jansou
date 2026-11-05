// 検証：対局ページの「退室する」ボタンが使う POST /leave の実挙動
// 1) 人の席に参加 → 席が埋まっている
// 2) /leave（ページと同じ Bearer 資格）→ 200、席が空く
// 3) 退室した資格では state が読めない（資格は無効化される）
// 4) 二度目の /leave は失敗する
import { createRoom, type Room } from "./client.ts";

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

const { room }: { room: Room } = await createRoom(base, {
  ruleset: { allow_human_players: true, match_length: "east" },
} as any);
console.log("room:", room.room_id);

const inv = await api(room.room_id, "/invites", "POST", room.master,
  { role: "player", seat: 1, max_uses: 1, expires_in_seconds: 3600 });
check(inv.status === 201, "invite issued", inv);
const joined = await api(room.room_id, "/join", "POST", undefined,
  { invite_code: inv.data.invite_code, display_name: "退室テスト", human: true });
check(joined.status === 201 && typeof joined.data.token === "string", "human join ok", joined);
const token = joined.data.token as string;
const seat = joined.data.seat as number;

const st1 = await api(room.room_id, "/state", "GET", token);
const occ1 = (st1.data.occupancy?.seats ?? []) as Json[];
check(occ1.some(s => s.seat === seat && !s.open), "seat occupied before leave", occ1);

const left = await api(room.room_id, "/leave", "POST", token, {});
check(left.status === 200 && left.data.ok === true && left.data.open === true, "leave ok, seat open", left);

const st2 = await api(room.room_id, "/state", "GET", room.master);
const occ2 = (st2.data.occupancy?.seats ?? []) as Json[];
check(occ2.some(s => s.seat === seat && s.open), "seat open in occupancy after leave", occ2);

const stOld = await api(room.room_id, "/state", "GET", token);
check(stOld.status === 401, "old credential rejected after leave", stOld.status);

const left2 = await api(room.room_id, "/leave", "POST", token, {});
check(left2.status !== 200, "second leave rejected", left2.status);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
