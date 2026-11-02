/**
 * Phase 3a 異常系検証：
 *   1. 同じ idempotency_key の二重 POST で局面が二重に進まない（逐次＋並行）
 *   3. 時計つき卓の期限切れが GET /state の遅延 settle と DO Alarm で処理される
 *   4. 同時 claim で有効な lease が1つだけになり、claim_token が行動を gate する
 *   （2. DO 再生成後の復元は restart_test.sh で検証）
 *
 * 実行： node verify/anomalies.ts [base_url]
 */
import {
  advanceTime,
  createRoom,
  getDebug,
  getState,
  postAction,
  postClaim,
  type Room,
} from "./client.ts";

type Json = Record<string, any>;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

function discardBody(st: Json, key: string, extra: Json = {}): Json {
  const d = st.decisions[0];
  const a = d.actions.find((x: Json) => x.type === "discard");
  assert(a, "discard action exists");
  return {
    seat: d.seat,
    action: "discard",
    tile: a.tile,
    decision_id: st.decision_id,
    expected_revision: st.revision,
    idempotency_key: key,
    ...extra,
  };
}

function digest(st: Json): Json {
  return {
    revision: st.revision,
    decision_id: st.decision_id,
    phase: st.phase,
    turn: st.turn,
    scores: st.scores,
    hands: st.hands,
    discards: st.discards,
    wall_count: st.wall_count,
  };
}

const eq = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

async function testAuth(base: string): Promise<void> {
  const { room } = await createRoom(base, { seed: 1 });
  const noAuth = await fetch(`${base}/rooms/${room.room_id}/state`);
  assert(noAuth.status === 401, `no-auth state -> 401 (got ${noAuth.status})`);
  const wrong = await fetch(`${base}/rooms/${room.room_id}/state`, {
    headers: { authorization: "Bearer deadbeef" },
  });
  assert(wrong.status === 401, `wrong token -> 401 (got ${wrong.status})`);
  console.log("auth (401 without/with wrong token): OK");
}

async function testDoublePost(base: string): Promise<void> {
  // 逐次二重 POST
  const { room } = await createRoom(base, { seed: 5 });
  const st0 = await getState(base, room);
  const body = discardBody(st0, "dup-seq-1");
  const r1 = await postAction(base, room, body);
  assert(r1.json.ok === true && !r1.replay, "first POST ok, not replay");
  const st1 = await getState(base, room);
  const r2 = await postAction(base, room, body);
  assert(r2.json.ok === true && r2.replay, "second POST is idempotent replay");
  const st2 = await getState(base, room);
  assert(
    eq(digest(st2), digest(st1)),
    "state after duplicate POST equals state after single POST",
  );

  // 並行二重 POST（別卓・同 seed・同操作を1回だけ適用した卓と比較）
  const a = await createRoom(base, { seed: 5 });
  const b = await createRoom(base, { seed: 5 });
  const sa = await getState(base, a.room);
  const sb = await getState(base, b.room);
  assert(eq(digest(sa), digest(sb)), "same-seed rooms start identical");
  const bodyA = discardBody(sa, "dup-par-a");
  const bodyB = discardBody(sb, "dup-par-b");
  const single = await postAction(base, a.room, bodyA);
  assert(single.json.ok === true, "control POST ok");
  const [p1, p2] = await Promise.all([
    postAction(base, b.room, bodyB),
    postAction(base, b.room, bodyB),
  ]);
  assert(p1.json.ok === true && p2.json.ok === true, "both parallel POSTs ok");
  assert(
    (p1.replay ? 1 : 0) + (p2.replay ? 1 : 0) === 1,
    "exactly one of the parallel POSTs is a replay",
  );
  const fa = await getState(base, a.room);
  const fb = await getState(base, b.room);
  assert(
    eq(digest(fa), digest(fb)),
    "parallel duplicate result equals single application",
  );
  console.log("1. idempotency double-POST (sequential + parallel): OK");
}

async function testClockLazySettle(base: string): Promise<void> {
  const { room } = await createRoom(base, {
    seed: 3,
    ruleset: { clock: { enabled: true, preset: "standard" } },
  });
  const st0 = await getState(base, room);
  assert(st0.clock, "clock present");
  const deadlines = Object.values(st0.clock.deadlines) as number[];
  assert(deadlines.length > 0, "deadlines armed");
  const seat = st0.turn as number;
  const advance = Math.max(...deadlines) - Date.now() + 5000;
  const adv = await advanceTime(base, room, { advance_ms: advance });
  const stA = adv.state as Json;
  const timedOut = (stA.clock_log as Json[]).some((e) => e.timed_out === true);
  assert(timedOut, "clock_log has a timed_out entry after advance");
  const detail = stA.discard_detail[seat] as Json[];
  assert(detail.length >= 1, "timed-out seat has a discard");
  assert(
    detail[detail.length - 1].tsumogiri === true,
    "timeout discard is tsumogiri",
  );
  const st1 = await getState(base, room);
  assert(st1.revision === stA.revision, "GET /state consistent after settle");
  console.log("3a. clock expiry via lazy settle: OK");
}

async function testClockAlarm(base: string): Promise<void> {
  const { room } = await createRoom(base, {
    seed: 4,
    ruleset: { clock: { enabled: true, preset: "standard" } },
  });
  const st0 = await getState(base, room);
  const deadlines = Object.values(st0.clock.deadlines) as number[];
  const remaining = Math.min(...deadlines) - Date.now();
  assert(remaining > 10000, "enough time remains before deadline");
  // deadline が実時間で約2.5秒後になるようエンジン時刻を進める
  await advanceTime(base, room, { advance_ms: remaining - 2500 });
  const dbg0 = await getDebug(base, room);
  assert(dbg0.alarm_count === 0, "no alarm yet");
  const revBefore = dbg0.revision as number;
  // リクエストを一切せずに Alarm が settle するのを待つ（debug は settle しない）
  let dbg = dbg0;
  const until = Date.now() + 20000;
  while (Date.now() < until && (dbg.alarm_count as number) === 0) {
    await new Promise((r) => setTimeout(r, 400));
    dbg = await getDebug(base, room);
  }
  assert((dbg.alarm_count as number) >= 1, "alarm fired without requests");
  assert(
    (dbg.revision as number) > revBefore,
    "alarm settled the expired decision (revision advanced in storage)",
  );
  const st1 = await getState(base, room);
  const seat = st0.turn as number;
  assert(
    (st1.discard_detail[seat] as Json[]).length >= 1,
    "state shows the timeout discard after alarm",
  );
  console.log("3b. clock expiry via DO Alarm: OK");
}

async function testConcurrentClaim(base: string): Promise<void> {
  const { room } = await createRoom(base, { seed: 6 });
  const st0 = await getState(base, room);
  const seat = st0.decisions[0].seat as number;
  const results = await Promise.all(
    Array.from({ length: 10 }, () => postClaim(base, room, { seat })),
  );
  for (const r of results) assert(r.status === 200, "claim status 200");
  const tokens = new Set(results.map((r) => r.json.claim_token as string));
  assert(tokens.size === 1, `exactly one lease token (got ${tokens.size})`);
  const fresh = results.filter((r) => r.json.reused === false).length;
  assert(fresh === 1, `exactly one fresh lease (got ${fresh})`);
  const token = [...tokens][0];
  const dbg = await getDebug(base, room);
  assert(dbg.lease?.claim_token === token, "stored lease matches");
  assert(dbg.lease?.decision_id === st0.decision_id, "lease bound to decision");
  const st1 = await getState(base, room);
  assert(st1.revision === st0.revision, "claims do not change revision");

  // claim_token なし／誤りは gate される
  const body = discardBody(st1, "claim-gate-1");
  const noToken = await postAction(base, room, body);
  assert(
    noToken.json.error === "decision claimed",
    "action without claim_token rejected while leased",
  );
  const wrongToken = await postAction(base, room, {
    ...body,
    idempotency_key: "claim-gate-2",
    claim_token: "wrong-token",
  });
  assert(
    wrongToken.json.error === "decision claimed",
    "action with wrong claim_token rejected",
  );
  const okRes = await postAction(base, room, {
    ...body,
    idempotency_key: "claim-gate-3",
    claim_token: token,
  });
  assert(okRes.json.ok === true, "action with lease token ok");

  // 行動成功で lease は消費され、次の decision では新しい lease が発行される
  const st2 = await getState(base, room);
  const claim2 = await postClaim(base, room, {
    seat: st2.decisions[0].seat,
  });
  assert(claim2.json.reused === false, "new lease after consumption");
  assert(claim2.json.claim_token !== token, "new lease has a new token");
  console.log("4. concurrent claim -> single lease + token gate: OK");
}

async function main(): Promise<void> {
  const base = process.argv[2] ?? "http://127.0.0.1:8787";
  await testAuth(base);
  await testDoublePost(base);
  await testClockLazySettle(base);
  await testClockAlarm(base);
  await testConcurrentClaim(base);
  console.log("anomalies: ALL OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
