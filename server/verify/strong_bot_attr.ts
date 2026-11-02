// 強いヘルパーの帰属テスト（時計オフ・席2はHelperの強いbotだけが打つ）。
// 使い方: strong_bot_attr.ts <base> setup|drive
import { countsOf, connScore } from "../../ts/engine.ts";
import { createRoom, getState, postAction, type Room } from "./client.ts";
import { readFileSync, writeFileSync } from "node:fs";

const base = process.argv[2] || "http://127.0.0.1:8799";
const mode = process.argv[3];
type Json = Record<string, any>;

if (mode === "setup") {
  const { room } = await createRoom(base, { seed: 77,
    ruleset: { match_length: "east", clock: { enabled: false } } });
  const res = await fetch(`${base}/rooms/${room.room_id}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + room.master },
    body: JSON.stringify({ role: "player", seat: 2, max_uses: 1, expires_in_sec: 3600 }),
  });
  const inv = await res.json() as Json;
  if (!inv.invite_code) throw new Error("invite failed " + JSON.stringify(inv));
  writeFileSync("/tmp/attr_room.json", JSON.stringify({ room, invite: inv.invite_code }));
  console.log("setup done", room.room_id);
} else if (mode === "drive") {
  const saved = JSON.parse(readFileSync("/tmp/attr_room.json", "utf8")) as { room: Room };
  const room = saved.room;
  let st = await getState(base, room);
  let step = 0;
  let botTurns = 0;
  let botWaitedMs = 0;
  while (st.match_status !== "finished" && step < 60) {
    const d = (st.decisions as Json[])[0];
    if (!d) throw new Error("no decisions");
    const seat = d.seat as number;
    if (seat === 2) {
      // 席2はHelperの強いbotだけが打てる。進めば帰属が証明される。
      botTurns++;
      const t0 = Date.now();
      let advanced = false;
      while (Date.now() - t0 < 45000) {
        await new Promise(r => setTimeout(r, 1500));
        const now = await getState(base, room);
        if (now.decision_id !== st.decision_id || now.match_status === "finished") {
          advanced = true; st = now; break;
        }
      }
      botWaitedMs += Date.now() - t0;
      if (!advanced) {
        console.log("FAIL - game stalled at the bot's decision for 45s");
        process.exit(1);
      }
      console.log(`ok - bot acted on its turn (turn ${botTurns})`);
      if (botTurns >= 3) break;
      continue;
    }
    step++;
    const actions = d.actions as Json[];
    const types = actions.map(a => a.type as string);
    const body: Json = { seat, decision_id: st.decision_id,
      expected_revision: st.revision, idempotency_key: `attr-${step}`,
      actor: { name: "driver" + seat, icon: "x", avatar_url: "" } };
    if (st.phase === "reaction") body.action = types.includes("ron") ? "ron" : "pass";
    else if (types.includes("tsumo")) body.action = "tsumo";
    else if (types.includes("discard")) {
      const offered = actions.filter(a => a.type === "discard").map(a => a.tile as number);
      let tile = offered[0];
      if (st.riichi[seat]) {
        tile = offered.includes(st.last_drawn as number) ? (st.last_drawn as number) : offered[0];
      } else {
        const c = countsOf(st.hands[seat] as number[]);
        let best = connScore(c, tile);
        for (const t of offered.slice(1)) {
          const sc = connScore(c, t);
          if (sc < best) { best = sc; tile = t; }
        }
      }
      body.action = "discard"; body.tile = tile;
    } else body.action = types[0];
    const r = await postAction(base, room, body);
    if (r.status !== 200) throw new Error(`driver action failed: ${r.status} ${JSON.stringify(r.json)}`);
    st = await getState(base, room);
  }
  console.log(`STRONG BOT ATTRIBUTION: OK (bot turns handled: ${botTurns}, total wait ${Math.round(botWaitedMs / 1000)}s)`);
} else {
  throw new Error("mode must be setup|drive");
}
