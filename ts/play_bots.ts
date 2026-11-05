/**
 * play_bots.py の TypeScript 移植（HTTP を介さず直接呼び出し版）。
 * ダミーボット4席で半荘を通しで打ち、終了と点数保存（合計100000）を確認する。
 * 実行： node play_bots.ts [seed]
 */
import { connScore, countsOf } from "./engine.ts";
import { winningTilesMelds } from "./yaku.ts";
import {
  applyAction,
  newGame,
  publicState,
  type Game,
} from "./game.ts";
import { PythonRandom } from "./rng.ts";

const BOT_ACTORS = [
  { name: "ボット東", icon: "🦊", avatar_url: "" },
  { name: "ボット南", icon: "🐼", avatar_url: "" },
  { name: "ボット西", icon: "🦉", avatar_url: "" },
  { name: "ボット北", icon: "🐰", avatar_url: "" },
];

const rng = new PythonRandom(42);

type State = Record<string, any>;

function act(
  g: Game,
  st: State,
  seat: number,
  action: string,
  opts: { tile?: number; riichi?: boolean; consume?: number[] } = {},
): void {
  const body: Record<string, unknown> = {
    seat,
    action,
    decision_id: st.decision_id,
    expected_revision: st.revision,
    actor: BOT_ACTORS[seat],
  };
  if (opts.tile !== undefined) body.tile = opts.tile;
  if (opts.riichi) body.riichi = true;
  if (opts.consume !== undefined) body.consume = opts.consume;
  const r = applyAction(g, body);
  if ("error" in r) {
    throw new Error(`bot action rejected: ${JSON.stringify([body, r])}`);
  }
}

function main(): void {
  const seed = process.argv[2] ? Number(process.argv[2]) : 7;
  const g = newGame(seed);
  let steps = 0;
  while (steps < 50000) {
    steps += 1;
    const st = publicState(g) as State;
    if (st.phase === "finished") {
      const sum = (st.scores as number[]).reduce((a, b) => a + b, 0);
      console.log(
        `finished: match_status=${st.match_status} end_reason=${st.end_reason} ` +
          `winner=${st.winner} type=${st.win_type} from=${st.from_seat} ` +
          `scores=${JSON.stringify(st.scores)} ranking=${JSON.stringify(st.ranking)} ` +
          `sum=${sum} steps=${steps} revision=${st.revision} hands=${st.hand_index + 1}`,
      );
      if (st.match_status !== "finished") {
        throw new Error("phase finished but match not finished");
      }
      if (sum !== 100000) throw new Error(`score sum != 100000: ${sum}`);
      console.log("auto hanchan: OK (score sum conserved at 100000)");
      return;
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
        act(g, st, seat, "ron");
      } else if (byType.has("daiminkan") && rng.random() < 0.7) {
        act(g, st, seat, "daiminkan");
      } else if (byType.has("pon") && rng.random() < 0.5) {
        act(g, st, seat, "pon");
      } else if (byType.has("chi") && rng.random() < 0.35) {
        act(g, st, seat, "chi", {
          consume: byType.get("chi")![0].consume as number[],
        });
      } else {
        act(g, st, seat, "pass");
      }
    } else if (types.includes("tsumo") && st.phase === "discard") {
      act(g, st, seat, "tsumo");
    } else if (types.includes("ankan") && rng.random() < 0.8) {
      const a = actions.find((x) => x.type === "ankan")!;
      act(g, st, seat, "ankan", { tile: a.tile as number });
    } else if (types.includes("kakan") && rng.random() < 0.8) {
      const a = actions.find((x) => x.type === "kakan")!;
      act(g, st, seat, "kakan", { tile: a.tile as number });
    } else if (types.includes("discard")) {
      const hand = st.hands[seat] as number[];
      if (st.riichi[seat]) {
        act(g, st, seat, "discard", { tile: st.last_drawn as number });
      } else {
        const c = countsOf(hand);
        // Python: min(hand, key=lambda t: (conn_score(c, t), rng.random()))
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
        act(g, st, seat, "discard", { tile, riichi: declare });
      }
    } else {
      throw new Error(`unhandled decision: ${JSON.stringify(d)}`);
    }
  }
  throw new Error("step limit reached");
}

main();
