/**
 * ts/play_bots.ts の HTTP クライアント版。
 * ダミーボット4席で半荘を通しで打ち、終了と点数保存（合計100000）を確認する。
 * 打ち筋の判断ロジックとボット用乱数（PythonRandom(42)）は play_bots.ts と同一にし、
 * seed 7 / 11 では in-process 版と最終点数が完全一致することも確認する。
 *
 * 実行： node verify/play_http.ts [base_url] [seed]
 */
import { connScore, countsOf } from "../../ts/engine.ts";
import { winningTilesMelds } from "../../ts/yaku.ts";
import { PythonRandom } from "../../ts/rng.ts";
import {
  createRoom,
  getState,
  postAction,
  type Room,
} from "./client.ts";

const BOT_ACTORS = [
  { name: "ボット東", icon: "🦊", avatar_url: "" },
  { name: "ボット南", icon: "🐼", avatar_url: "" },
  { name: "ボット西", icon: "🦉", avatar_url: "" },
  { name: "ボット北", icon: "🐰", avatar_url: "" },
];

// Phase 2（in-process / Python 参照実装と相互検証済み）の最終点数
const EXPECTED: Record<number, number[]> = {
  7: [19500, 34200, 15000, 31300],
  11: [5500, 52000, 39500, 3000], // Phase 3 役パックで進行が変わった新記録（2回一致で決定性確認済み）
  23: [35200, 24000, 9900, 30900],
};

type State = Record<string, any>;

const rng = new PythonRandom(42);
let base = "";
let room: Room;
let stepCounter = 0;
let seedLabel = 0;
let keyPrefix = "bot";

async function act(
  st: State,
  seat: number,
  action: string,
  opts: { tile?: number; riichi?: boolean; consume?: number[] } = {},
): Promise<void> {
  stepCounter += 1;
  const body: Record<string, unknown> = {
    seat,
    action,
    decision_id: st.decision_id,
    expected_revision: st.revision,
    actor: BOT_ACTORS[seat],
    idempotency_key: `${keyPrefix}-${seedLabel}-${stepCounter}`,
  };
  if (opts.tile !== undefined) body.tile = opts.tile;
  if (opts.riichi) body.riichi = true;
  if (opts.consume !== undefined) body.consume = opts.consume;
  const r = await postAction(base, room, body);
  if (r.json.error) {
    throw new Error(`bot action rejected: ${JSON.stringify([body, r.json])}`);
  }
}

export async function playMatch(
  baseUrl: string,
  seed: number,
  opts: {
    roomReuse?: { room: Room };
    maxSteps?: number;
    keyPrefix?: string;
    skipExpected?: boolean;
  } = {},
): Promise<State> {
  base = baseUrl;
  seedLabel = seed;
  stepCounter = 0;
  keyPrefix = opts.keyPrefix ?? "bot";
  let st: State;
  if (opts.roomReuse) {
    room = opts.roomReuse.room;
    st = await getState(base, room);
  } else {
    const created = await createRoom(base, { seed });
    room = created.room;
    st = created.state;
  }
  const limit = opts.maxSteps ?? 50000;
  let steps = 0;
  while (steps < limit) {
    steps += 1;
    if (st.phase === "finished") {
      const sum = (st.scores as number[]).reduce((a, b) => a + b, 0);
      console.log(
        `finished: match_status=${st.match_status} end_reason=${st.end_reason} ` +
          `scores=${JSON.stringify(st.scores)} ranking=${JSON.stringify(st.ranking)} ` +
          `sum=${sum} steps=${steps} revision=${st.revision} hands=${st.hand_index + 1}`,
      );
      if (st.match_status !== "finished") {
        throw new Error("phase finished but match not finished");
      }
      if (sum !== 100000) throw new Error(`score sum != 100000: ${sum}`);
      const exp = opts.skipExpected ? undefined : EXPECTED[seed];
      if (exp && JSON.stringify(st.scores) !== JSON.stringify(exp)) {
        throw new Error(
          `scores differ from in-process result: got ${JSON.stringify(st.scores)}, expected ${JSON.stringify(exp)}`,
        );
      }
      if (exp) console.log("scores match in-process result: OK");
      console.log("auto hanchan (HTTP): OK (score sum conserved at 100000)");
      return st;
    }
    const decisions = st.decisions as State[];
    if (decisions.length === 0) {
      throw new Error(`no decisions at step ${steps} (phase=${st.phase})`);
    }
    const d = decisions[0];
    const seat = d.seat as number;
    const actions = d.actions as State[];
    const types = actions.map((a) => a.type as string);
    if (st.phase === "reaction") {
      const byType = new Map<string, State[]>();
      for (const a of actions) {
        const arr = byType.get(a.type as string) ?? [];
        arr.push(a);
        byType.set(a.type as string, arr);
      }
      if (byType.has("ron") && rng.random() < 0.7) {
        await act(st, seat, "ron");
      } else if (byType.has("daiminkan") && rng.random() < 0.7) {
        await act(st, seat, "daiminkan");
      } else if (byType.has("pon") && rng.random() < 0.5) {
        await act(st, seat, "pon");
      } else if (byType.has("chi") && rng.random() < 0.35) {
        await act(st, seat, "chi", {
          consume: byType.get("chi")![0].consume as number[],
        });
      } else {
        await act(st, seat, "pass");
      }
    } else if (types.includes("tsumo") && st.phase === "discard") {
      await act(st, seat, "tsumo");
    } else if (types.includes("ankan") && rng.random() < 0.8) {
      const a = actions.find((x) => x.type === "ankan")!;
      await act(st, seat, "ankan", { tile: a.tile as number });
    } else if (types.includes("kakan") && rng.random() < 0.8) {
      const a = actions.find((x) => x.type === "kakan")!;
      await act(st, seat, "kakan", { tile: a.tile as number });
    } else if (types.includes("discard")) {
      const hand = st.hands[seat] as number[];
      if (st.riichi[seat]) {
        await act(st, seat, "discard", { tile: st.last_drawn as number });
      } else {
        const c = countsOf(hand);
        let tile = hand[0];
        let bestKey: [number, number] = [connScore(c, tile), rng.random()];
        for (const t of hand.slice(1)) {
          const key: [number, number] = [connScore(c, t), rng.random()];
          if (
            key[0] < bestKey[0] ||
            (key[0] === bestKey[0] && key[1] < bestKey[1])
          ) {
            tile = t;
            bestKey = key;
          }
        }
        const rest = [...hand];
        rest.splice(rest.indexOf(tile), 1);
        const melds = st.melds[seat] as State[];
        const declare =
          !st.riichi[seat] &&
          st.scores[seat] >= 1000 &&
          melds.every((m) => m.type === "ankan") &&
          winningTilesMelds(countsOf(rest), 4 - melds.length).length > 0 &&
          rng.random() < 0.6;
        await act(st, seat, "discard", { tile, riichi: declare });
      }
    } else {
      throw new Error(`unhandled decision: ${JSON.stringify(d)}`);
    }
    st = await getState(base, room);
  }
  if (opts.maxSteps !== undefined && st.phase !== "finished") {
    console.log(
      `paused after ${steps} steps: phase=${st.phase} revision=${st.revision} hand_index=${st.hand_index}`,
    );
    return st;
  }
  throw new Error("step limit reached");
}

async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? "http://127.0.0.1:8787";
  const seed = process.argv[3] ? Number(process.argv[3]) : 7;
  await playMatch(baseUrl, seed);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
