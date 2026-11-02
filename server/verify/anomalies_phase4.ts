/**
 * Phase 4 authorization / disclosure regression suite.
 * Run with DEV_MODE="1": node verify/anomalies_phase4.ts http://127.0.0.1:8787
 * If MASTER_TOKEN is configured, export MASTER_TOKEN in the test environment.
 * No external packages needed; Node 22+ can execute this .ts file directly.
 */
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};
type Json = Record<string, any>;
type Room = { id: string; master: string; players: string[] };
const base = process.argv[2] ?? "http://127.0.0.1:8787";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error("ASSERT FAILED: " + message);
}
async function api(path: string, method: "GET" | "POST" = "GET", body?: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  if (path === "/rooms" && process.env.MASTER_TOKEN) headers["x-master-token"] = process.env.MASTER_TOKEN;
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Json;
  try { data = (await response.json()) as Json; }
  catch { throw new Error(`${method} ${path}: invalid JSON status=${response.status}`); }
  return { status: response.status, data, replay: response.headers.get("x-idempotent-replay") === "1" };
}
async function create(seed: number, extras: Json = {}): Promise<Room> {
  const r = await api("/rooms", "POST", { seed, ...extras });
  check(r.status === 201, `create status ${r.status}: ${JSON.stringify(r.data)}`);
  check(typeof r.data.room_id === "string", "room id");
  check(typeof r.data.master_token === "string", "master token");
  check(Array.isArray(r.data.player_tokens) && r.data.player_tokens.length === 4, "four player tokens");
  return {
    id: r.data.room_id as string,
    master: r.data.master_token as string,
    players: (r.data.player_tokens as Json[]).map(x => x.token as string),
  };
}
const route = (r: Room, suffix: string) => `/rooms/${r.id}/${suffix}`;
async function state(r: Room, token: string) {
  const reply = await api(route(r, "state"), "GET", undefined, token);
  check(reply.status === 200, `state ${reply.status}: ${JSON.stringify(reply.data)}`);
  return reply.data;
}
function onlyHand(st: Json, seat: number | null): boolean {
  return Array.isArray(st.hands) && st.hands.length === 4 && st.hands.every((hand: unknown, index: number) =>
    (seat === index) ? Array.isArray(hand) : hand === null);
}
function noSecrets(st: Json): boolean {
  const serialized = JSON.stringify(st);
  return !serialized.includes('"hidden_truth"') && !serialized.includes('"raw_review"') &&
    !serialized.includes('"raw_truth"') && !serialized.includes('"wall"') &&
    !serialized.includes('"ura_dora_indicators"');
}

async function checkVisibility(): Promise<void> {
  const room = await create(7);
  const master = await state(room, room.master);
  check(master.hands.every((x: unknown) => Array.isArray(x)), "Master can inspect four hands");
  for (let seat = 0; seat < 4; seat++) {
    const p = await state(room, room.players[seat]);
    check(onlyHand(p, seat), `Player${seat} sees only own hand`);
    check(noSecrets(p), `Player${seat} response has no raw/secret fields`);
    check(Array.isArray(p.decisions) && p.decisions.every((d: Json) => d.seat === seat),
      `Player${seat} receives only own legal actions`);
    check(p.viewer.role === "player" && p.viewer.seat === seat, "viewer identity");
    if (p.drawn_tile !== undefined && p.turn !== seat) {
      check(p.drawn_tile === null, `Player${seat} cannot see another seat's drawn tile`);
    }
  }
  const anon = await api(route(room, "state"));
  check(anon.status === 401, "anonymous state forbidden");
  const wrong = await api(route(room, "state"), "GET", undefined, "invalid-token");
  check(wrong.status === 401, "invalid token rejected");
  const spectator = await api(route(room, "spectators"), "POST",
    { display_name: "South fan", support_seat: 1 }, room.master);
  check(spectator.status === 201, "spectator token issued");
  const s = await state(room, spectator.data.token);
  check(onlyHand(s, 1), "spectator sees only support seat");
  check(Array.isArray(s.decisions) && s.decisions.length === 0, "spectator has no legal actions");
  check(noSecrets(s), "spectator secrets hidden");
  if (s.drawn_tile !== undefined && s.turn !== 1) {
    check(s.drawn_tile === null, "spectator cannot see other seat's draw");
  }
  const outsider = await api(route(room, "spectators"), "POST", { display_name: "Outsider" }, room.master);
  check(outsider.status === 201, "unassigned outsider token");
  const o = await state(room, outsider.data.token);
  check(onlyHand(o, null), "outsider sees no hand");
  const switchWhilePlaying = await api(route(room, "spectators/support"), "POST",
    { support_seat: 3 }, spectator.data.token);
  check(switchWhilePlaying.status === 409, "cannot switch support seat mid-match");
  const spectatorAction = await api(route(room, "actions"), "POST",
    { seat: 1, decision_id: master.decision_id, expected_revision: master.revision, action: "pass" }, spectator.data.token);
  check(spectatorAction.status === 403, "spectator cannot act");
  const spectatorClaim = await api(route(room, "claim"), "POST",
    { seat: 1, decision_id: master.decision_id }, spectator.data.token);
  check(spectatorClaim.status === 403, "spectator cannot claim");
  const outsideCheer = await api(route(room, "cheers"), "POST", { text: "Hey!" }, outsider.data.token);
  check(outsideCheer.status === 403, "outside spectator cannot cheer without support seat");
  const events = await api(route(room, "events?after=0"), "GET", undefined, spectator.data.token);
  check(events.status === 200 && events.data.events.length > 0, "spectator can poll event deltas");
  for (const event of events.data.events as Json[]) {
    check(onlyHand(event.state, 1), "event state follows same seat-only filter");
    check(event.state.decisions?.length === 0, "event has no spectator legal actions");
    check(noSecrets(event.state), "historical event has no raw truth");
  }
  console.log("PASS visibility/roles/event filtering");
}

async function checkInvitesAndLeases(): Promise<void> {
  const room = await create(6);
  const inviteDenied = await api(route(room, "invites"), "POST",
    { role: "player", seat: 2, expires_in_seconds: 120, max_uses: 1 }, room.players[0]);
  check(inviteDenied.status === 403, "non-master cannot invite");
  const invite = await api(route(room, "invites"), "POST",
    { role: "player", seat: 0, expires_in_seconds: 120, max_uses: 1 }, room.master);
  check(invite.status === 201 && typeof invite.data.invite_code === "string", "master invitation");
  check(invite.data.room_id === room.id && invite.data.seat === 0, "invitation scoped to room and seat");
  const join = await api(route(room, "join"), "POST",
    { invite_code: invite.data.invite_code, display_name: "Relay teammate", icon: "🀄" });
  check(join.status === 201 && join.data.seat === 0, "invited participant bound to seat 0");
  const exhausted = await api(route(room, "join"), "POST",
    { invite_code: invite.data.invite_code, display_name: "Another teammate" });
  check(exhausted.status === 409, "invite usage limit enforced");
  const foreignState = await state(room, room.players[1]);
  const acting = foreignState.decisions?.[0];
  const otherSeatClaim = await api(route(room, "claim"), "POST",
    { seat: 0, decision_id: foreignState.decision_id }, room.players[1]);
  check(otherSeatClaim.status === 403, "foreign seat claim rejected");
  const wrongSeatAction = await api(route(room, "actions"), "POST",
    { seat: 0, action: "discard", tile: 0,
      decision_id: foreignState.decision_id, expected_revision: foreignState.revision }, room.players[1]);
  check(wrongSeatAction.status === 403, "foreign seat action rejected");
  const own = await state(room, room.players[0]);
  const d = (own.decisions as Json[]).find(x => x.seat === 0);
  check(d, "initial self decision exists for East");
  const action = (d.actions as Json[]).find(x => x.type === "discard");
  check(action, "discard candidate available");
  const claim = await api(route(room, "claim"), "POST", { seat: 0, decision_id: own.decision_id }, join.data.token);
  check(claim.status === 200, "invited teammate claims East decision");
  const competitor = await api(route(room, "claim"), "POST", { seat: 0, decision_id: own.decision_id }, room.players[0]);
  check(competitor.status === 409, "another participant in same seat cannot take lease");
  const stolenToken = await api(route(room, "actions"), "POST",
    { seat: 0, action: "discard", tile: action.tile, decision_id: own.decision_id,
      expected_revision: own.revision, claim_token: claim.data.claim_token, idempotency_key: "try-stolen" }, room.players[0]);
  check(stolenToken.status === 409, "same-seat other identity cannot act using claim token");
  const request = { seat: 0, action: "discard", tile: action.tile,
    decision_id: own.decision_id, expected_revision: own.revision,
    claim_token: claim.data.claim_token, idempotency_key: "p4-once" };
  const applied = await api(route(room, "actions"), "POST", request, join.data.token);
  check(applied.status === 200 && applied.data.ok === true, "claim owner applied action");
  const replay = await api(route(room, "actions"), "POST", request, join.data.token);
  check(replay.status === 200 && replay.replay, "same request replayed");
  const collision = await api(route(room, "actions"), "POST", { ...request, tile: 999 }, join.data.token);
  check(collision.status === 409, "same key with changed action is conflict");
  const future = await state(room, room.players[1]);
  const badRevision = await api(route(room, "actions"), "POST", {
    seat: 1, action: "discard", tile: 1,
    decision_id: future.decision_id, expected_revision: future.revision + 99,
  }, room.players[1]);
  check(badRevision.status === 409, "future revision rejected");
  const invalidJson = await api(route(room, "claim"), "POST", null, room.players[1]);
  check(invalidJson.status === 400, "JSON null rejected");
  const invAfter = await api(route(room, "events?after=0"), "GET", undefined, room.players[1]);
  check(invAfter.status === 200 && invAfter.data.events.length >= 2, "game action creates event");
  console.log("PASS invitations/claim owner/idempotency/revision");
}

async function checkCheers(): Promise<void> {
  const room = await create(4);
  const spectator = await api(route(room, "spectators"), "POST",
    { display_name: "East supporter", support_seat: 0 }, room.master);
  check(spectator.status === 201, "spectator created");
  const p = spectator.data.token as string;
  const invalid = await api(route(room, "cheers"), "POST", { text: "a".repeat(501) }, p);
  check(invalid.status === 400, "cheer length limit");
  const post = await api(route(room, "cheers"), "POST",
    { text: "Please guard carefully", client_nonce: "cheer-001" }, p);
  check(post.status === 201, "cheer submitted");
  const repeat = await api(route(room, "cheers"), "POST",
    { text: "Please guard carefully", client_nonce: "cheer-001" }, p);
  check(repeat.status === 200 && repeat.data.reused === true, "cheer retry deduplicated");
  const fastRepeat = await api(route(room, "cheers"), "POST", { text: "Another note" }, p);
  check(fastRepeat.status === 429, "cheer frequency limit");
  const east = await api(route(room, "cheers?after=0"), "GET", undefined, room.players[0]);
  check(east.status === 200 && east.data.comments.length === 1, "only target seat gets comment");
  const south = await api(route(room, "cheers?after=0"), "GET", undefined, room.players[1]);
  check(south.status === 200 && south.data.comments.length === 0, "other seats see no comment");
  const spectatorRead = await api(route(room, "cheers?after=0"), "GET", undefined, p);
  check(spectatorRead.status === 200 && spectatorRead.data.comments.length === 1,
    "spectator reads cheers of the seat they support");
  const otherFan = await api(route(room, "spectators"), "POST",
    { display_name: "South supporter", support_seat: 1 }, room.master);
  const otherRead = await api(route(room, "cheers?after=0"), "GET", undefined, otherFan.data.token as string);
  check(otherRead.status === 200 && otherRead.data.comments.length === 0,
    "spectator cannot read other seats' cheers");
  const raw = await create(5, { ruleset: { mode: "raw" }, spectator_policy: { defer_during_raw_decision: true } });
  const initial = await state(raw, raw.master);
  const decision = initial.decisions?.[0];
  check(decision && typeof decision.seat === "number", "raw decision exists");
  const fan = await api(route(raw, "spectators"), "POST",
    { display_name: "Raw fan", support_seat: decision.seat }, raw.master);
  check(fan.status === 201, "raw spectator created");
  const rawCheer = await api(route(raw, "cheers"), "POST", { text: "Think independently" }, fan.data.token);
  check(rawCheer.status === 201, "raw cheer stored");
  const rawInbox = await api(route(raw, "cheers?after=0"), "GET", undefined, raw.players[decision.seat]);
  check(rawInbox.status === 200 && rawInbox.data.deferred === true && rawInbox.data.comments.length === 0,
    "raw mode defers cheer while seat decides");
  console.log("PASS cheers/rate limit/raw defer");
}

async function checkAllVisiblePlayerOption(): Promise<void> {
  const room = await create(10, { player_visibility: "all" });
  const p = await state(room, room.players[1]);
  check(p.hands.every((h: unknown) => Array.isArray(h)), "all player hands available with option");
  check((p.decisions as Json[]).every(d => d.seat === 1), "even in all mode other decisions hidden");
  const s = await api(route(room, "spectators"), "POST", { display_name: "North fan", support_seat: 3 }, room.master);
  check(s.status === 201, "spectator created");
  const watcher = await state(room, s.data.token);
  check(onlyHand(watcher, 3), "spectators remain seat-scoped even with all player visibility");
  console.log("PASS player_visibility=all with spectator isolation");
}

async function main(): Promise<void> {
  await checkVisibility();
  await checkInvitesAndLeases();
  await checkCheers();
  await checkAllVisiblePlayerOption();
  console.log("Phase 4 anomalies: ALL TESTS PASS");
}
main().catch(error => { console.error(error); process.exit(1); });
