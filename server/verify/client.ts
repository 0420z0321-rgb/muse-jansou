/** Phase 4 検証用 HTTP クライアント（Worker API の薄いラッパー）。
 *  Phase 4 の資格モデル：卓ごとに Room Master 1つ＋ Player トークン4席分。
 *  getState / getDebug / advanceTime は Master 資格（全席閲覧＝管理用）で呼び、
 *  postAction / postClaim は本文の seat に対応する Player 資格で呼ぶ。
 */

export interface Room {
  room_id: string;
  master: string;
  players: string[];
}

type Json = Record<string, any>;

export async function createRoom(
  base: string,
  opts: { seed?: number; ruleset?: unknown; time_offset_ms?: number } = {},
): Promise<{ room: Room; state: Json }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.MASTER_TOKEN) headers["x-master-token"] = process.env.MASTER_TOKEN;
  const res = await fetch(base + "/rooms", {
    method: "POST",
    headers,
    body: JSON.stringify(opts),
  });
  if (res.status !== 201) {
    throw new Error("createRoom failed: " + res.status + " " + (await res.text()));
  }
  const data = (await res.json()) as Json;
  const rawTokens = data.player_tokens as Json[];
  const players = rawTokens.map((x) => String(x.token));
  return {
    room: { room_id: data.room_id, master: data.master_token, players },
    state: data.state,
  };
}

function bearer(tok: string): Record<string, string> {
  return { authorization: "Bearer " + tok };
}

function seatAuth(room: Room, body: Json): Record<string, string> {
  const seat = Number(body.seat ?? 0);
  return bearer(room.players[seat]);
}

export async function getState(base: string, room: Room): Promise<Json> {
  const res = await fetch(`${base}/rooms/${room.room_id}/state`, {
    headers: bearer(room.master),
  });
  if (!res.ok) throw new Error("getState failed: " + res.status);
  return (await res.json()) as Json;
}

export async function getDebug(base: string, room: Room): Promise<Json> {
  const res = await fetch(`${base}/rooms/${room.room_id}/debug`, {
    headers: bearer(room.master),
  });
  if (!res.ok) throw new Error("getDebug failed: " + res.status);
  return (await res.json()) as Json;
}

export async function postAction(
  base: string,
  room: Room,
  body: Json,
): Promise<{ status: number; json: Json; replay: boolean }> {
  const res = await fetch(`${base}/rooms/${room.room_id}/actions`, {
    method: "POST",
    headers: { ...seatAuth(room, body), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Json,
    replay: res.headers.get("x-idempotent-replay") === "1",
  };
}

export async function postClaim(
  base: string,
  room: Room,
  body: Json,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}/rooms/${room.room_id}/claim`, {
    method: "POST",
    headers: { ...seatAuth(room, body), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

export async function advanceTime(
  base: string,
  room: Room,
  body: Json,
): Promise<Json> {
  const res = await fetch(`${base}/rooms/${room.room_id}/dev/advance-time`, {
    method: "POST",
    headers: { ...bearer(room.master), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("advanceTime failed: " + res.status);
  return (await res.json()) as Json;
}
