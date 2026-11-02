/**
 * fixtures_check.py の TypeScript 移植（fixture 再生検証器）。
 *
 * fixtures/*.json を読み、記録された setup / steps を JSON だけから
 * 再実行して、記録済み snapshot と一致するか照合する。
 * 実行： node fixtures_check.ts （ts/ ディレクトリから）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { countDora, doraFromIndicator } from "./dora.ts";
import { scoreHand, type ServerMeld } from "./yaku.ts";
import {
  applyAction,
  armClock,
  drawTile,
  finishHand,
  newDecision,
  newGame,
  setNowMs,
  settleExpired,
  type Game,
} from "./game.ts";
import { setPath, snapshot } from "./snapshot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

type Json = Record<string, unknown>;

function load(kind: string): Json[] {
  const data = JSON.parse(readFileSync(join(FIXTURES, `${kind}.json`), "utf-8"));
  return data.cases as Json[];
}

/** Python の == に対応する深い等価（dict はキー順不同、list は順序あり）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

function assert(cond: boolean, msg: unknown): void {
  if (!cond) throw new Error(`assert failed: ${JSON.stringify(msg)}`);
}

function checkPure(): number {
  let n = 0;
  for (const c of load("scoring")) {
    const i = c.input as Json;
    const r = scoreHand(
      i.hand as number[],
      i.win_tile as number,
      i.win_type as string,
      i.seat_wind as number,
      i.round_wind as number,
      i.riichi as boolean,
      (i.melds as Record<string, unknown>[]).map(
        (m) => ({ ...m }) as unknown as ServerMeld,
      ),
    );
    const got = {
      valid: r.valid,
      han: r.han ?? null,
      fu: r.fu ?? null,
      yaku: r.yaku ?? null,
      payments: r.payments ?? null,
    };
    assert(
      deepEqual(got, c.expected),
      [c.case_id, got, c.expected],
    );
    n += 1;
  }
  for (const c of load("dora")) {
    if (c.case_id === "indicator_mapping") {
      const got = [0, 8, 9, 17, 18, 26, 27, 30, 31, 33].map((t) => ({
        indicator: t,
        dora: doraFromIndicator(t),
      }));
      assert(deepEqual(got, c.expected), c.case_id);
    } else {
      const i = c.input as Json;
      const got = {
        dora: countDora(i.tiles as number[], i.indicators as number[]),
      };
      assert(deepEqual(got, c.expected), c.case_id);
    }
    n += 1;
  }
  console.log(`pure fixtures: ${n} cases OK`);
  return n;
}

function invoke(g: Game, name: string, args?: Json): unknown {
  const a = args ?? {};
  switch (name) {
    case "_new_decision":
      return newDecision(g, a.kind as string);
    case "_finish":
      return finishHand(
        g,
        a.winner as number,
        a.win_type as string,
        (a.from_seat as number | undefined) ?? null,
        (a.result as never) ?? null,
      );
    case "_draw":
      return drawTile(g);
    case "_settle_expired":
      return settleExpired(g);
    case "_arm_clock":
      return armClock(g);
    default:
      throw new Error(`unknown internal call: ${name}`);
  }
}

function compare(
  caseId: string,
  label: string,
  got: Record<string, unknown>,
  want: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(want)) {
    const gv = got[k] ?? null;
    assert(
      deepEqual(gv, v),
      [caseId, label, k, gv, v],
    );
  }
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function replay(cse: Json): void {
  const nowBox: { now: number | null } = {
    now: (cse.now_start as number | undefined) ?? null,
  };
  if (nowBox.now !== null) {
    setNowMs(() => nowBox.now!);
  } else {
    setNowMs(null);
  }
  try {
    const g = newGame(
      (cse.seed as number | undefined) ?? null,
      cse.ruleset as never,
    );
    assert(
      deepEqual(g.hands, cse.initial_hands),
      [cse.case_id, "initial_hands"],
    );
    assert(deepEqual(g.wall, cse.initial_wall), [cse.case_id, "initial_wall"]);
    assert(
      deepEqual(g.dead_wall, cse.initial_dead_wall),
      [cse.case_id, "initial_dead_wall"],
    );
    const ruleset = cse.ruleset as
      | { mode?: string; clock?: { enabled?: boolean } }
      | null;
    const rawReview = Boolean(
      ruleset &&
        ruleset.mode === "raw" &&
        !(ruleset.clock ?? {}).enabled,
    );
    const snap = () => snapshot(g, rawReview);
    for (const op of cse.setup as Json[]) {
      if ("set" in op) {
        setPath(g, op.set as string, deepCopy(op.value));
      } else {
        invoke(g, op.call as string, op.args as Json | undefined);
      }
    }
    if ("initial_expect" in cse) {
      compare(cse.case_id as string, "initial", snap(), cse.initial_expect as Json);
    }
    const steps = cse.steps as Json[];
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (st.now_advance_ms) {
        nowBox.now = (nowBox.now ?? 0) + (st.now_advance_ms as number);
      }
      const label = `step${i}`;
      if ("action" in st) {
        const a = { ...(st.action as Json) };
        const seat = a.seat;
        const act = a.action;
        delete a.seat;
        delete a.action;
        const body = {
          seat: seat as number,
          action: act as string,
          decision_id: g.decision_id,
          expected_revision: g.revision,
          ...a,
        };
        const r = applyAction(g, body);
        const want = { ...(st.expect as Json) };
        const res = want.apply_result;
        delete want.apply_result;
        assert(
          ("ok" in r) === (res === "ok"),
          [cse.case_id, label, r],
        );
        compare(cse.case_id as string, label, snap(), want);
      } else if ("apply_body" in st) {
        const r = applyAction(g, deepCopy(st.apply_body) as never);
        const want = { ...(st.expect as Json) };
        const res = want.apply_result;
        delete want.apply_result;
        assert(
          ("ok" in r) === (res === "ok"),
          [cse.case_id, label, r],
        );
        compare(cse.case_id as string, label, snap(), want);
      } else if ("call" in st) {
        const r = invoke(g, st.call as string, st.args as Json | undefined);
        const want = { ...(st.expect as Json) };
        if ("call_return" in want) {
          const cr = want.call_return;
          delete want.call_return;
          assert(deepEqual(r ?? null, cr), [cse.case_id, label, r]);
        }
        compare(cse.case_id as string, label, snap(), want);
      } else if ("set" in st) {
        setPath(g, st.set as string, deepCopy(st.value));
        compare(cse.case_id as string, label, snap(), st.expect as Json);
      } else {
        throw new Error(`unknown step: ${JSON.stringify([cse.case_id, st])}`);
      }
    }
  } finally {
    setNowMs(null);
  }
}

function checkTransitions(): number {
  const cases = load("transitions");
  for (const c of cases) {
    replay(c);
    console.log(`  transition ${c.case_id}: OK`);
  }
  console.log(`transition fixtures: ${cases.length} cases OK`);
  return cases.length;
}

const pure = checkPure();
const trans = checkTransitions();
console.log(`fixtures check (TS): ALL OK (${pure + trans} cases)`);
