/** 牌譜（paipu）書き出しの検証。
 *  1. 対局前：終了した半荘がないので GET /paipu は 404 (no_finished_match)。
 *  2. ボット4席で半荘を完走させる（play_http の playMatch を再利用）。
 *  3. 終了後：GET /paipu が NDJSON を返し、ヘッダー／イベント列／
 *     フッター（最終結果）が局面と一致することを確認する。
 *
 *  使い方: node verify/paipu_e2e.ts http://127.0.0.1:8787 7
 */
import { createRoom, type Room } from "./client.ts";
import { playMatch } from "./play_http.ts";

type Json = Record<string, any>;

async function fetchPaipu(base: string, room: Room): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/rooms/${room.room_id}/paipu`, {
    headers: { authorization: "Bearer " + room.master },
  });
  return { status: res.status, text: await res.text() };
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + message);
}

async function main(): Promise<void> {
  const base = process.argv[2] ?? "http://127.0.0.1:8787";
  const seed = process.argv[3] ? Number(process.argv[3]) : 7;

  const { room } = await createRoom(base, { seed });

  const before = await fetchPaipu(base, room);
  assert(before.status === 404, `pre-match paipu should be 404, got ${before.status}`);
  assert(
    (JSON.parse(before.text) as Json).error === "no_finished_match",
    "pre-match paipu error should be no_finished_match: " + before.text,
  );
  console.log("pre-match: 404 no_finished_match OK");

  const finalState = (await playMatch(base, seed, { roomReuse: { room }, skipExpected: true, keyPrefix: "paipu" })) as Json;
  assert(finalState.phase === "finished", "match should be finished");

  const after = await fetchPaipu(base, room);
  assert(after.status === 200, `post-match paipu should be 200, got ${after.status}: ${after.text.slice(0, 200)}`);
  const lines = after.text.split("\n").filter((l) => l.trim().length > 0);
  assert(lines.length >= 3, "paipu should have header, events and footer");
  const header = JSON.parse(lines[0]) as Json;
  const footer = JSON.parse(lines[lines.length - 1]) as Json;
  const events = lines.slice(1, -1).map((l) => JSON.parse(l) as Json);

  assert(header.type === "paipu_header", "first line is the header");
  assert(header.schema_version === 1, "schema_version is 1");
  assert(header.event_count === events.length, "header event_count matches event lines");
  assert(header.complete === true, "stream starts with init (complete)");
  assert(events[0].kind === "init", "first event is init");
  for (let i = 1; i < events.length; i++) {
    assert(events[i].seq > events[i - 1].seq, "seq strictly increases");
    assert(events[i].revision >= events[i - 1].revision, "revision never decreases");
  }
  assert(footer.type === "paipu_footer", "last line is the footer");
  assert(footer.match_key === header.match_key, "footer match_key matches header");
  const results = footer.results as Json[];
  assert(Array.isArray(results) && results.length === 4, "footer has 4 results");
  const total = results.reduce((sum, r) => sum + Number(r.score), 0);
  assert(total === 100000, `footer scores sum to 100000, got ${total}`);
  if (Array.isArray(finalState.scores)) {
    for (const r of results) {
      assert(
        Number(finalState.scores[Number(r.seat)]) === Number(r.score),
        `footer score for seat ${r.seat} matches final state`,
      );
    }
  }
  console.log(
    `post-match: paipu OK (events=${events.length}, match_key=${header.match_key}, ` +
      `results=${results.map((r) => `${r.display_name}:${r.score}`).join(", ")})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
