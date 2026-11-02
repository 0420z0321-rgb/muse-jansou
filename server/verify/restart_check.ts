/**
 * 異常系 2：DO 再生成（wrangler dev 再起動）後の復元検証。
 *   begin : 卓を作り40手だけ打って、room 情報と局面ダイジェストをファイルに残す
 *   resume: （再起動後に実行）state がダイジェストと一致することを確認し、
 *           そのまま半荘を最後まで打ち切る（合計100000）
 *
 * 実行： node verify/restart_check.ts begin  [base] [file]
 *        node verify/restart_check.ts resume [base] [file]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRoom, getState, type Room } from "./client.ts";
import { playMatch } from "./play_http.ts";

type Json = Record<string, any>;

function digest(st: Json): Json {
  return {
    revision: st.revision,
    decision_id: st.decision_id,
    phase: st.phase,
    turn: st.turn,
    dealer: st.dealer,
    honba: st.honba,
    hand_index: st.hand_index,
    scores: st.scores,
    hands: st.hands,
    discards: st.discards,
    melds: st.melds,
    riichi: st.riichi,
    wall_count: st.wall_count,
    dora_indicators: st.dora_indicators,
  };
}

async function begin(base: string, file: string): Promise<void> {
  const seed = 21;
  const { room } = await createRoom(base, { seed });
  const st = await playMatch(base, seed, {
    roomReuse: { room },
    maxSteps: 40,
    keyPrefix: "rst-a",
    skipExpected: true,
  });
  if (st.phase === "finished") {
    throw new Error("match finished within 40 steps; increase pause point");
  }
  const data = { room, seed, digest: digest(st) };
  writeFileSync(file, JSON.stringify(data, null, 1));
  console.log(
    `begin: room=${room.room_id} revision=${st.revision} phase=${st.phase} hand_index=${st.hand_index}`,
  );
}

async function resume(base: string, file: string): Promise<void> {
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    room: Room;
    seed: number;
    digest: Json;
  };
  const st = await getState(base, data.room);
  const now = digest(st);
  if (JSON.stringify(now) !== JSON.stringify(data.digest)) {
    throw new Error(
      "state after restart differs:\nbefore=" +
        JSON.stringify(data.digest) +
        "\nafter =" +
        JSON.stringify(now),
    );
  }
  console.log("state restored after restart: digest identical: OK");
  await playMatch(base, data.seed, {
    roomReuse: { room: data.room },
    keyPrefix: "rst-b",
    skipExpected: true,
  });
  console.log("2. DO regeneration restore + resume to finish: OK");
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const base = process.argv[3] ?? "http://127.0.0.1:8787";
  const file = process.argv[4] ?? "/tmp/jansou-restart.json";
  if (mode === "begin") await begin(base, file);
  else if (mode === "resume") await resume(base, file);
  else throw new Error("mode must be begin|resume");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
