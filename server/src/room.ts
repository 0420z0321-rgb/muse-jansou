/**
 * Muse雀荘 Phase 3b — 1 room = 1 SQLite-backed Durable Object.
 *
 * - No engine changes: use ../../ts/game.ts as provided by the owner.
 * - Keep the legacy /state, /actions, /claim response shapes.
 * - One active lease per (decision_id, seat); no revision change on claim.
 * - Replay only successful actions, after validating a canonical request hash.
 * - Apply timeouts and human actions in separate, synchronous SQL transactions.
 * - Work on cloned Game instances; publish to memory only after commit.
 * - Only schedule an Alarm when its desired deadline changes.
 * - No /debug or /dev/advance-time unless DEV_MODE === "1".
 *
 * Phase 4 adds per-seat identity, scoped visibility, invitations, spectators, cheers.
 * Game engine semantics and the Phase-3b transaction / timeout safeguards remain unchanged.
 */
import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  currentDecisions,
  newGame,
  publicState,
  setNowMs,
  settleExpired,
  type ActionBody,
  type Game,
  type Ruleset,
} from "../../ts/game.ts";

const LEASE_TTL_MS = 180_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_DECISION_ID_LENGTH = 256;
const MAX_LOG_MESSAGE_LENGTH = 300;

type JsonObject = Record<string, unknown>;

type InitBody = {
  room_id: string;
  seed?: number | null;
  ruleset?: Partial<Ruleset> | null;
  master_token_hash: string;
  player_token_hashes: Array<{ seat: number; token_hash: string }>;
  player_visibility: PlayerVisibility;
  watch_open_hands?: boolean;
  spectator_policy: { defer_during_raw_decision?: boolean };
  time_offset_ms?: number;
};

type ActionRequest = ActionBody & {
  idempotency_key?: string;
  claim_token?: string;
};

type Lease = {
  decision_id: string;
  seat: number;
  claim_token: string;
  participant_id: string;
  expires_at: number;
};

type StoredIdempotency = {
  request_hash: string | null;
  result: string;
  status_code: number;
};

type PersistOptions = {
  logKind: string;
  logPayload: unknown;
  action?: {
    idemKey: string | null;
    requestHash: string | null;
    response: unknown;
    statusCode: number;
    consumedSeat: number;
    decisionId: string;
  };
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function isSeat(v: unknown): v is number {
  return isInt(v) && v >= 0 && v < 4;
}

function safeError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, MAX_LOG_MESSAGE_LENGTH);
}

/** Canonical JSON, sorted object keys. All action-relevant fields are included. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const object = value as JsonObject;
  return "{" + Object.keys(object).sort().map((k) =>
    JSON.stringify(k) + ":" + canonicalJson(object[k])
  ).join(",") + "}";
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashActionRequest(body: JsonObject, participantId: string): Promise<string> {
  // Owner identity prevents one Player from replaying another Player's result.
  // Claim credentials and the retry key are transport metadata, not action intent.
  const payload: JsonObject = { _participant_id: participantId };
  for (const [key, value] of Object.entries(body)) {
    if (key !== "idempotency_key" && key !== "claim_token") {
      payload[key] = value;
    }
  }
  return sha256Hex(canonicalJson(payload));
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJsonObject(request: Request): Promise<JsonObject | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return json({ error: "request too large" }, 413);
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "invalid request body" }, 400);
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return json({ error: "request too large" }, 413);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : json({ error: "json object required" }, 400);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
}

function validateAction(body: JsonObject): string | null {
  if (!isSeat(body.seat)) return "invalid seat";
  if (typeof body.decision_id !== "string" ||
      body.decision_id.length === 0 ||
      body.decision_id.length > MAX_DECISION_ID_LENGTH) {
    return "invalid decision_id";
  }
  if (typeof body.action !== "string" || body.action.length === 0 || body.action.length > 64) {
    return "invalid action";
  }
  if (body.claim_token !== undefined &&
      (typeof body.claim_token !== "string" || body.claim_token.length > 256)) {
    return "invalid claim_token";
  }
  if (body.idempotency_key !== undefined &&
      (typeof body.idempotency_key !== "string" ||
       body.idempotency_key.length === 0 ||
       body.idempotency_key.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
    return "invalid idempotency_key";
  }
  // An invalid revision is reported as STALE_POSITION (409) by precheck.
  return null;
}

function statusForEngineError(error: string): number {
  if (error === "STALE_POSITION" || error === "stale decision" ||
      error === "decision claimed" || error === "game already finished") {
    return 409;
  }
  if (error === "no pending decision for seat") return 403;
  return 400;
}


// ---- Phase 4 identity and disclosure contracts ----
type PrincipalRole = "master" | "player" | "spectator";
type PlayerVisibility = "seat_only" | "all";

type Principal = {
  participant_id: string;
  role: PrincipalRole;
  seat: number | null;
  display_name: string;
  token_hash: string;
};

type RoomPolicy = {
  player_visibility: PlayerVisibility;
  raw_mode: boolean;
  defer_during_raw_decision: boolean;
  watch_open_hands: boolean;
};

type Invite = {
  code_hash: string;
  room_id: string;
  role: "player" | "spectator";
  seat: number | null;
  expires_at: number;
  max_uses: number;
  used_count: number;
};

type Viewer = Pick<Principal, "role" | "seat"> & { participant_id?: string };
const MAX_EVENTS_PAGE = 50;
const RETAIN_EVENTS = 500;
/** Consecutive server timeouts (clocked rooms) that force a seat rotation. */
const TIMEOUT_ROTATE_AFTER = 2;
/** Free deadline extension granted once to a freshly seated holder. */
const ROTATION_GRACE_MS = 60_000;
/** Proxy plays a declared prompt fill-in may make before the seat rotates. */
const PROXY_MAX_PLAYS = 5;
// Paipu archives survive the events trim; only the newest few finished
// matches are kept per room (same horizon as recentMatchResults).
const PAIPU_RETAINED_MATCHES = 5;
/** Small, completed-only hand snapshots; never an active Game snapshot. */
const FINISHED_HAND_RETAINED = 128;
const MAX_NAME_LENGTH = 80;
const MAX_CHEER_LENGTH = 500;
const CHEER_INTERVAL_MS = 30_000;
const DEFAULT_CHEER_FLAG_THRESHOLD = 5;
const MAX_CHEER_FLAG_THRESHOLD = 100;
const MAX_INVITE_LIFETIME_SEC = 30 * 24 * 3600;
const QUEUE_TOKEN_RE = /^[0-9a-f]{48}$/;
const MAX_QUEUE_SIZE = 1000;

type QueueRow = {
  id: number;
  queue_hash: string;
  display_name: string;
  icon: string | null;
  status: string;
  seat: number | null;
  participant_id: string | null;
  grant_nonce: string | null;
  player_token_hash: string | null;
};


function copySafeFields(source: JsonObject, names: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(source, name)) out[name] = source[name];
  }
  return out;
}
function cleanDiscard(record: unknown): unknown {
  if (typeof record === "number" && isInt(record)) return record;
  if (typeof record === "string" && record.length <= 24) return record;
  if (!isObject(record)) return null;
  return copySafeFields(record, [
    "tile", "name", "called", "called_by", "tsumogiri", "riichi", "riichi_discard",
    "seq", "turn", "from_seat", "type", "is_red",
  ]);
}
function cleanMeld(record: unknown): unknown {
  if (!isObject(record)) return null;
  return copySafeFields(record, [
    "type", "tiles", "called_tile", "from_seat", "open", "meld_id", "orientation",
    "added_tile", "red", "is_red",
  ]);
}
function cleanAction(action: unknown): unknown {
  if (!isObject(action)) return null;
  // Never forward engine-internal validation, raw truth, or score candidates.
  return copySafeFields(action, [
    "id", "action_id", "type", "tile", "tile_id", "tiles", "consume", "meld", "meld_index",
    "called_tile", "from_seat", "kind", "red", "riichi_discard",
  ]);
}
function cleanDecision(record: unknown): unknown {
  if (!isObject(record)) return null;
  const result = copySafeFields(record, [
    "seat", "kind", "type", "decision_id", "opened_at", "deadline", "deadline_ms",
  ]);
  if (Array.isArray(record.actions)) result.actions = record.actions.map(cleanAction);
  if (Array.isArray(record.legal_actions)) result.legal_actions = record.legal_actions.map(cleanAction);
  return result;
}
function cleanPending(record: unknown): unknown {
  if (!isObject(record)) return null;
  return copySafeFields(record, ["seat", "tile", "name", "discarder", "tile_name", "called_by"]);
}
function cleanDora(record: unknown, finished: boolean): unknown {
  if (Array.isArray(record)) return record;
  if (!isObject(record)) return null;
  return copySafeFields(record, finished ? [
    "indicators", "indicator_names", "count", "indicator_count", "normal", "red",
    "ura", "ura_indicators", "ura_indicator_names",
  ] : ["indicators", "indicator_names", "count", "indicator_count"]);
}
function cleanResult(record: unknown, finished: boolean): unknown {
  if (!finished || !isObject(record)) return undefined;
  const r = copySafeFields(record, [
    "winner", "winners", "win_type", "from_seat", "type", "han", "fu", "yaku", "payments",
    "normal_dora", "ura_dora", "red_dora", "dora", "scores_after", "tenpai", "reason",
  ]);
  if (r.dora !== undefined) r.dora = cleanDora(r.dora, true);
  return r;
}
function cleanClock(record: unknown, viewer: Viewer): unknown {
  if (!isObject(record)) return undefined;
  const out = copySafeFields(record, [
    "remaining_ms", "remaining", "expired", "enabled", "preset", "byoyomi_ms",
    "time_left_ms", "seat_remaining_ms", "status",
  ]);
  if (Array.isArray(record.seats)) {
    out.seats = record.seats.map(v => isObject(v) ?
      copySafeFields(v, ["remaining_ms", "remaining", "expired", "byoyomi_ms", "status"]) : v);
  }
  // Reaction eligibility and thinking deadlines must not leak to other seats.
  if (isObject(record.deadlines)) {
    const deadline: JsonObject = {};
    if (viewer.role === "master") Object.assign(deadline, record.deadlines);
    else if (viewer.role === "player" && viewer.seat !== null) {
      const key = String(viewer.seat);
      if (Object.prototype.hasOwnProperty.call(record.deadlines, key)) deadline[key] = record.deadlines[key];
    }
    out.deadlines = deadline;
  }
  return out;
}

/**
 * Build a new allowlisted response; NEVER spread/copy the engine's publicState as-is.
 * Input may be a live publicState or a historical in-DO event snapshot.
 * Spectators see exactly their bound seat, regardless of player_visibility.
 * Exception: the password-only watch viewer sees every hand while the room's
 * watch_open_hands policy is on (host opt-in for open spectating).
 */
function viewState(raw: unknown, viewer: Viewer, policy: RoomPolicy): JsonObject {
  if (!isObject(raw)) return {};
  const finished = raw.phase === "finished" || raw.match_status === "finished" ||
    (isObject(raw.match) && raw.match.status === "finished");
  const visibleSeat = (seat: number): boolean => viewer.role === "master" ||
    (viewer.role === "player" && (policy.player_visibility === "all" || viewer.seat === seat)) ||
    (viewer.role === "spectator" && viewer.seat === seat) ||
    (viewer.role === "spectator" && viewer.participant_id === "watch" && policy.watch_open_hands);
  const out = copySafeFields(raw, [
    "revision", "decision_id", "decision_base_revision", "phase", "turn", "dealer",
    "round_wind", "round_number", "round_label", "round", "hand_number", "hand_index",
    "honba", "kyotaku", "scores", "wall_count", "turn_count", "winner", "win_type",
    "from_seat", "match_status", "end_reason", "rankings", "status", "pending_name",
    "dora_indicators", "dora_count", "riichi", "riichi_flags", "riichi_sticks",
    "rinshan_used", "hand_id", "match_id",
  ]);
  if (raw.last_discard !== undefined) out.last_discard = cleanDiscard(raw.last_discard);
  if (raw.pending_tile !== undefined) out.pending_tile = cleanDiscard(raw.pending_tile);
  if (raw.pending !== undefined) out.pending = cleanPending(raw.pending);
  if (raw.dora !== undefined) out.dora = cleanDora(raw.dora, finished);
  if (raw.clock !== undefined) out.clock = cleanClock(raw.clock, viewer);
  if (isObject(raw.round)) out.round = copySafeFields(raw.round, ["wind", "number", "label", "honba"]);
  if (Array.isArray(raw.riichi)) {
    out.riichi = raw.riichi.map(v => isObject(v) ?
      copySafeFields(v, ["declared", "enabled", "double", "ippatsu", "turn"]) :
      (typeof v === "boolean" || typeof v === "number" ? v : null));
  }
  const result = cleanResult(raw.result, finished);
  if (result !== undefined) out.result = result;
  for (const name of ["discards", "discard_detail"] as const) {
    if (Array.isArray(raw[name])) {
      out[name] = raw[name].map(v => Array.isArray(v) ? v.map(cleanDiscard) : null);
    }
  }
  if (Array.isArray(raw.melds)) {
    out.melds = raw.melds.map(v => Array.isArray(v) ? v.map(cleanMeld) : null);
  }
  if (Array.isArray(raw.hands)) {
    out.hands = raw.hands.map((hand, seat) => visibleSeat(seat) ? hand : null);
    out.hand_counts = raw.hands.map(hand => Array.isArray(hand) ? hand.length : null);
  }
  if (Array.isArray(raw.hand_names)) {
    out.hand_names = raw.hand_names.map((hand, seat) => visibleSeat(seat) ? hand : null);
  }
  if (Array.isArray(raw.drawn_tiles)) {
    out.drawn_tiles = raw.drawn_tiles.map((tile, seat) => visibleSeat(seat) ? tile : null);
  }
  if (raw.drawn_tile !== undefined) {
    const drawSeat = isSeat(raw.turn) ? raw.turn : -1;
    out.drawn_tile = visibleSeat(drawSeat) ?
      (isObject(raw.drawn_tile) ? copySafeFields(raw.drawn_tile, ["tile", "seat", "name", "is_red"]) : raw.drawn_tile) : null;
  }
  if (raw.last_drawn !== undefined) {
    const drawSeat = isSeat(raw.turn) ? raw.turn : -1;
    out.last_drawn = visibleSeat(drawSeat) ? raw.last_drawn : null;
  }
  if (Array.isArray(raw.decisions)) {
    out.decisions = viewer.role === "spectator" ? [] : raw.decisions
      .filter(v => isObject(v) && isSeat(v.seat) &&
        (viewer.role === "master" || (viewer.role === "player" && viewer.seat === v.seat)))
      .map(cleanDecision);
  }
  // Support both flat and nested engine state formats without open-ended spreads.
  if (isObject(raw.match)) out.match = copySafeFields(raw.match, [
    "status", "scores", "round", "round_wind", "hand_number", "dealer", "honba", "kyotaku",
    "hand_index", "end_reason", "rankings", "starting_dealer",
  ]);
  if (isObject(raw.hand)) out.hand = viewState(raw.hand, viewer, policy);
  out.viewer = { role: viewer.role, seat: viewer.seat, player_visibility: policy.player_visibility, watch_open_hands: policy.watch_open_hands };
  return out;
}

function validateName(v: unknown, field: string): string | null {
  if (typeof v !== "string" || v.trim().length < 1 ||
      Array.from(v.trim()).length > MAX_NAME_LENGTH || /[\u0000-\u001f]/.test(v)) return `invalid ${field}`;
  return null;
}
function validateAvatarUrl(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== "string" || v.length > 500) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch { return false; }
}
function parseCursor(url: URL): number | null {
  return parseCursorParam(url, "after");
}
function parseCursorParam(url: URL, name: string): number | null {
  const param = url.searchParams.get(name) ?? "0";
  if (!/^(0|[1-9]\d{0,14})$/.test(param)) return null;
  const after = Number(param);
  return Number.isSafeInteger(after) ? after : null;
}

/** Terminal state is explicit. A hand change or score change alone is NOT proof
 *  that the last hand's final tiles exist in the new engine snapshot. */
function terminalHandSnapshot(snapshot: unknown): JsonObject | null {
  if (!isObject(snapshot)) return null;
  if (isObject(snapshot.hand) && snapshot.hand.phase === "finished" &&
      Array.isArray(snapshot.hand.hands) && snapshot.hand.hands.length === 4) return snapshot.hand;
  if (snapshot.phase === "finished") return snapshot;
  return null;
}
function fourScores(value: unknown): number[] | null {
  return Array.isArray(value) && value.length === 4 && value.every(isInt)
    ? value as number[] : null;
}
/** Stable identity is optional; do not infer it from a moving score or turn. */
function handIdentifier(snapshot: JsonObject): string | null {
  const hand = isObject(snapshot.hand) ? snapshot.hand : null;
  const handId = snapshot.hand_id ?? hand?.hand_id;
  if ((typeof handId === "string" && handId.length > 0 && handId.length <= 128) ||
      (isInt(handId) && handId >= 0)) return `id:${String(handId)}`;
  const index = snapshot.hand_index ?? hand?.hand_index;
  if (isInt(index) && index >= 0) return `index:${index}`;
  // Do not assume a changing round label, kyotaku or honba is a hand identity.
  return null;
}

// ---- Watch event stream v2: public facts ONLY, no private draw tile. ----
// The old `draw` signal is *hand draw/ryuukyoku*. A player's tile draw is
// `tile_draw` to keep pre-existing watch-SE event names compatible.
type WatchCallType = "chi" | "pon" | "kan";
type WatchWinType = "tsumo" | "ron";
type WatchTile = string | number | { suit: "m" | "p" | "s" | "z"; rank: number; red?: boolean };
type WatchSignal =
  | { type: "tile_draw"; seat: number }
  | { type: "discard"; seat: number; tile: WatchTile | null }
  | { type: "call"; seat: number; call_type: WatchCallType | null }
  | { type: "riichi"; seat: number }
  | { type: "win"; seat: number; win_type: WatchWinType | null; from_seat?: number }
  | { type: "draw" }
  | { type: "hand_start" }
  | { type: "hand_end" }
  | { type: "score_change"; seat: number };
const MAX_WATCH_SIGNALS = 32;

/** The old event archive uses a master-view snapshot. NEVER ship it to guests.
 * Project to a spectator that does NOT get open-hands access, even when the
 * host has enabled watch_open_hands on the main watch page. */
function soundView(snapshot: unknown, policy: RoomPolicy): JsonObject {
  return viewState(snapshot,
    { role: "spectator", seat: null, participant_id: "watch-event-only" },
    { ...policy, player_visibility: "seat_only", watch_open_hands: false });
}

function soundHand(state: JsonObject): JsonObject {
  const hand = state.hand;
  return isObject(hand) && (Array.isArray(hand.discards) ||
    Array.isArray(hand.melds) || typeof hand.phase === "string") ? hand : state;
}

function soundHandKey(state: JsonObject): string | null {
  const hand = soundHand(state);
  const id = hand.hand_id ?? state.hand_id;
  const matchId = state.match_id;
  const prefix = (typeof matchId === "string" && matchId.length <= 128) ? matchId + "/" : "";
  if ((typeof id === "string" && id.length > 0 && id.length <= 128) ||
      (isInt(id) && id >= 0)) return prefix + "id:" + String(id);
  const index = hand.hand_index ?? state.hand_index;
  if (isInt(index) && index >= 0) return prefix + "index:" + index;
  const round = isObject(state.round) ? state.round : null;
  const wind = hand.round_wind ?? state.round_wind ?? round?.wind;
  const number = hand.round_number ?? state.round_number ?? round?.number;
  const honba = hand.honba ?? state.honba;
  const dealer = hand.dealer ?? state.dealer;
  if ((typeof wind === "string" || isInt(wind)) && isInt(number) &&
      isInt(honba) && isSeat(dealer)) {
    return prefix + "round:" + String(wind) + ":" + number + ":" + honba + ":" + dealer;
  }
  return null;
}

function soundRows(state: JsonObject, key: "discards" | "melds"): unknown[][] | null {
  const nested = soundHand(state)[key];
  const source = Array.isArray(nested) ? nested : state[key];
  return Array.isArray(source) && source.length === 4 &&
    source.every(Array.isArray) ? source as unknown[][] : null;
}

function soundRiichi(state: JsonObject, seat: number): boolean {
  const hand = soundHand(state);
  for (const value of [hand.riichi_flags, hand.riichi, state.riichi_flags, state.riichi]) {
    if (!Array.isArray(value)) continue;
    const marker: unknown = value[seat];
    if (marker === true || (typeof marker === "number" && marker > 0)) return true;
    if (isObject(marker) && marker.declared === true) return true;
  }
  return false;
}

function soundScores(state: JsonObject): number[] | null {
  const root = fourScores(state.scores);
  if (root !== null) return root;
  if (isObject(state.match)) return fourScores(state.match.scores);
  return null;
}

function soundResult(state: JsonObject): JsonObject | null {
  const hand = soundHand(state);
  return isObject(hand.result) ? hand.result :
    isObject(state.result) ? state.result : null;
}

function soundFinished(state: JsonObject): boolean {
  return state.phase === "finished" || soundHand(state).phase === "finished";
}

/** Public discard tile only. Object values are rebuilt field by field; NO
 * nested engine object or private red/hand metadata is copied. */
function soundTile(value: unknown): WatchTile | null {
  if (isInt(value) && value >= 0 && value <= 135) return value;
  if (typeof value === "string") {
    // Supported compact notations, Unicode tile glyphs and Japanese honors.
    // Never forward arbitrary string data from a future engine shape.
    if (/^(?:[0-9]{1,2}[mpsz]|[mpsz][0-9]{1,2}|[1-9](?:man|pin|sou)|[一二三四五六七八九][萬万筒索]|[1-9][萬万筒索]|[東南西北白發発中]|[ESWNPCF]|[🀀-🀫]|(?:aka|red)[0-9][mps])$/iu.test(value)) return value;
    return null;
  }
  if (isObject(value) &&
      (value.suit === "m" || value.suit === "p" || value.suit === "s" || value.suit === "z") &&
      isInt(value.rank) && value.rank >= 0 && value.rank <= (value.suit === "z" ? 7 : 9)) {
    const tile: WatchTile = { suit: value.suit, rank: value.rank };
    if (value.red === true || value.is_red === true) tile.red = true;
    return tile;
  }
  return null;
}

function soundDiscardTile(record: unknown): WatchTile | null {
  if (isObject(record)) return soundTile(record.tile) ?? soundTile(record.name);
  return soundTile(record);
}

function soundCallType(value: unknown): WatchCallType | null {
  if (typeof value !== "string") return null;
  const type = value.toLowerCase();
  if (["chi", "chii", "chow"].includes(type)) return "chi";
  if (["pon", "pung"].includes(type)) return "pon";
  if (["kan", "ankan", "kakan", "daiminkan", "minkan", "shouminkan", "kong"].includes(type)) return "kan";
  return null;
}

function soundWinType(value: unknown): WatchWinType | null {
  if (typeof value !== "string") return null;
  const type = value.toLowerCase();
  if (["tsumo", "tsumo_agari", "zimo", "自摸", "ツモ"].includes(type)) return "tsumo";
  if (["ron", "ron_agari", "栄和", "ロン"].includes(type)) return "ron";
  return null;
}

function soundWinnerSeats(result: JsonObject, state: JsonObject): number[] {
  const winners: number[] = [];
  if (Array.isArray(result.winners)) {
    for (const seat of result.winners) if (isSeat(seat) && !winners.includes(seat)) winners.push(seat);
  }
  if (winners.length === 0) {
    const seat = isSeat(result.winner) ? result.winner : state.winner;
    if (isSeat(seat)) winners.push(seat);
  }
  return winners;
}

function soundIsDraw(result: JsonObject, state: JsonObject): boolean {
  if (Array.isArray(result.tenpai)) return true;
  const reason = result.reason ?? result.type ?? state.end_reason;
  if (typeof reason !== "string") return false;
  return ["draw", "ryuukyoku", "ryukyoku", "exhaustive", "abortive", "流局"].some(
    marker => reason.toLowerCase().includes(marker));
}

function soundWallCount(state: JsonObject): number | null {
  const value = soundHand(state).wall_count ?? state.wall_count;
  return isInt(value) && value >= 0 ? value : null;
}

function soundRinshanUsed(state: JsonObject): number | null {
  const value = soundHand(state).rinshan_used ?? state.rinshan_used;
  return isInt(value) && value >= 0 ? value : null;
}

/**
 * Classify two *public spectator projections* at the successful commit.
 * Does not peek at drawn_tile/drawn_tiles/hand contents. `tile_draw` uses
 * public wall_count/rinshan_used movement and public turn only; bundled
 * automatic game transitions with no such public witness cannot be invented.
 * A scalar tile on `discard` comes ONLY from a published discard record.
 */
function makeWatchSignals(previous: JsonObject | null, current: JsonObject,
                          cause: string, actionHint?: unknown): WatchSignal[] {
  const output: WatchSignal[] = [];
  const seen = new Set<string>();
  const push = (signal: WatchSignal, key?: string): void => {
    if (output.length >= MAX_WATCH_SIGNALS) return;
    if (key !== undefined) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    output.push(signal);
  };
  const unique = (signal: WatchSignal): void =>
    push(signal, signal.type + ":" + ("seat" in signal ? signal.seat : ""));

  if (previous === null) {
    if (cause === "init") unique({ type: "hand_start" });
    return output;
  }

  const prevKey = soundHandKey(previous);
  const nextKey = soundHandKey(current);
  const oldDiscards = soundRows(previous, "discards");
  const newDiscards = soundRows(current, "discards");
  const oldTotal = oldDiscards?.reduce((n, list) => n + list.length, 0) ?? null;
  const newTotal = newDiscards?.reduce((n, list) => n + list.length, 0) ?? null;
  const handChanged = (prevKey !== null && nextKey !== null && prevKey !== nextKey) ||
    (prevKey === null && nextKey === null && oldTotal !== null && newTotal === 0 && oldTotal > 0);

  if (!handChanged) {
    // A legitimate discard is visible in the public river. Retain its exact
    // order and tile; if the tile is an unknown format, use explicit null.
    if (oldDiscards && newDiscards) {
      for (let seat = 0; seat < 4; seat++) {
        const before = oldDiscards[seat], after = newDiscards[seat];
        if (after.length > before.length) {
          for (let index = before.length; index < after.length; index++) {
            const record = after[index];
            push({ type: "discard", seat, tile: soundDiscardTile(record) });
            if (isObject(record) && (record.riichi === true || record.riichi_discard === true)) {
              unique({ type: "riichi", seat });
            }
          }
        }
      }
    }

    const oldMelds = soundRows(previous, "melds");
    const newMelds = soundRows(current, "melds");
    if (oldMelds && newMelds) {
      for (let seat = 0; seat < 4; seat++) {
        const oldList = oldMelds[seat], newList = newMelds[seat];
        for (let j = 0; j < newList.length; j++) {
          if (j < oldList.length && JSON.stringify(oldList[j]) === JSON.stringify(newList[j])) continue;
          const meld = newList[j];
          const callType = isObject(meld) ? soundCallType(meld.type) : null;
          // A changed existing pon -> added kan is a public kan as well.
          push({ type: "call", seat, call_type: callType });
        }
      }
    }
    for (let seat = 0; seat < 4; seat++) {
      if (!soundRiichi(previous, seat) && soundRiichi(current, seat)) unique({ type: "riichi", seat });
    }

    // Drawing a tile is public; its ID and value are NOT. A decrease in the
    // public wall count is evidence of one draw by the current turn seat.
    // Kan replacement draws can use rinshan_used even if wall_count is static.
    const oldWall = soundWallCount(previous);
    const newWall = soundWallCount(current);
    const oldRinshan = soundRinshanUsed(previous);
    const newRinshan = soundRinshanUsed(current);
    const wallDraw = oldWall !== null && newWall !== null && oldWall > newWall;
    const rinshanDraw = oldRinshan !== null && newRinshan !== null && newRinshan > oldRinshan;
    const drawingSeat = soundHand(current).turn ?? current.turn;
    // Some engines expose hand sizes but not a wall count at every decision.
    // A visible one-tile increase in the current seat is also proof of a draw;
    // a mere turn change is NOT proof and must not trigger an event.
    const oldCounts = soundHand(previous).hand_counts ?? previous.hand_counts;
    const newCounts = soundHand(current).hand_counts ?? current.hand_counts;
    const countDraw = isSeat(drawingSeat) && Array.isArray(oldCounts) &&
      Array.isArray(newCounts) && oldCounts.length === 4 && newCounts.length === 4 &&
      isInt(oldCounts[drawingSeat]) && isInt(newCounts[drawingSeat]) &&
      newCounts[drawingSeat] === oldCounts[drawingSeat] + 1;
    if ((wallDraw || rinshanDraw || countDraw) && isSeat(drawingSeat) && !soundFinished(current)) {
      unique({ type: "tile_draw", seat: drawingSeat });
    }
  }

  // Only a completed result already present in the spectator projection is
  // enough to announce a win. An accepted ron action alone is not proof (and
  // could otherwise reveal an unresolved reaction decision).
  const oldResult = soundResult(previous);
  const result = soundResult(current);
  const resultAppeared = result !== null && (oldResult === null ||
    JSON.stringify(oldResult) !== JSON.stringify(result));
  const newlyFinished = !soundFinished(previous) && soundFinished(current);
  if (!handChanged && soundFinished(current) && (resultAppeared || newlyFinished)) {
    // Older engines can publish terminal winner/win_type directly on the
    // public state, without an explicit `result` object.
    const finalInfo: JsonObject = result ?? {};
    const winners = soundWinnerSeats(finalInfo, current);
    const hint = cause === "action" && isObject(actionHint) ? actionHint.action : null;
    const winType = soundWinType(finalInfo.win_type ?? finalInfo.type ?? current.win_type) ?? soundWinType(hint);
    if (winners.length && (result !== null || winType !== null)) {
      const from = isSeat(finalInfo.from_seat) ? finalInfo.from_seat :
        (isSeat(current.from_seat) ? current.from_seat : null);
      for (const seat of winners) {
        if (winType === "ron" && from !== null && from !== seat) {
          unique({ type: "win", seat, win_type: winType, from_seat: from });
        } else {
          unique({ type: "win", seat, win_type: winType });
        }
      }
    } else if (soundIsDraw(finalInfo, current)) {
      unique({ type: "draw" }); // Ryuukyoku, not drawing one tile.
    }
  }

  if (newlyFinished || handChanged) unique({ type: "hand_end" });
  if (handChanged) unique({ type: "hand_start" });

  // Action hint fallback (whitelisted only) when a public layout lacks a
  // normal meld/discard record. Only accepted, committed actions reach here.
  // Never copy request.tile: it may be a private hand selection rather than a
  // published river tile. A fallback discard can explicitly carry tile:null.
  if (!handChanged && cause === "action" && isObject(actionHint) && isSeat(actionHint.seat) &&
      typeof actionHint.action === "string") {
    const seat = actionHint.seat;
    const action = actionHint.action.toLowerCase();
    if (["discard", "dahai"].includes(action) && !output.some(s => s.type === "discard" && s.seat === seat)) {
      const oldLast = soundHand(previous).last_discard ?? previous.last_discard;
      const newLast = soundHand(current).last_discard ?? current.last_discard;
      const tile = JSON.stringify(oldLast) === JSON.stringify(newLast)
        ? null : soundDiscardTile(newLast);
      unique({ type: "discard", seat, tile });
    } else if (soundCallType(action) !== null && !output.some(s => s.type === "call" && s.seat === seat)) {
      unique({ type: "call", seat, call_type: soundCallType(action) });
    } else if (["riichi", "reach"].includes(action)) {
      unique({ type: "riichi", seat });
    } else if (["draw_tile", "tsumo_draw"].includes(action)) {
      // A draw action is safe to report only as a seat, never a drawn tile.
      unique({ type: "tile_draw", seat });
    }
  }

  const oldScores = soundScores(previous);
  const newScores = soundScores(current);
  if (oldScores && newScores) {
    for (let seat = 0; seat < 4; seat++) {
      if (oldScores[seat] !== newScores[seat]) unique({ type: "score_change", seat });
    }
  }
  return output;
}

/** All public HTTP payloads are rebuilt from a strict output allowlist,
 * even for pre-upgrade rows or a malformed persisted JSON blob. */
function readWatchSignals(value: unknown): WatchSignal[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const result: WatchSignal[] = [];
  for (const entry of parsed.slice(0, MAX_WATCH_SIGNALS)) {
    if (!isObject(entry) || typeof entry.type !== "string") continue;
    const seat = entry.seat;
    switch (entry.type) {
      case "tile_draw":
        if (isSeat(seat)) result.push({ type: "tile_draw", seat });
        break;
      case "discard":
        if (isSeat(seat)) result.push({ type: "discard", seat,
          tile: soundTile(entry.tile) });
        break;
      case "call":
        if (isSeat(seat)) result.push({ type: "call", seat,
          call_type: soundCallType(entry.call_type) });
        break;
      case "riichi":
        if (isSeat(seat)) result.push({ type: "riichi", seat });
        break;
      case "win":
        if (isSeat(seat)) {
          const winType = soundWinType(entry.win_type);
          const from = entry.from_seat;
          result.push(winType === "ron" && isSeat(from) && from !== seat
            ? { type: "win", seat, win_type: winType, from_seat: from }
            : { type: "win", seat, win_type: winType });
        }
        break;
      case "draw": result.push({ type: "draw" }); break;
      case "hand_start": result.push({ type: "hand_start" }); break;
      case "hand_end": result.push({ type: "hand_end" }); break;
      case "score_change":
        if (isSeat(seat)) result.push({ type: "score_change", seat });
        break;
      // No unknown types or unknown keys are forwarded.
    }
  }
  return result;
}

export class RoomDO extends DurableObject {
  private game: Game | null = null;
  private roomId: string | null = null;
  private policy: RoomPolicy = {
    player_visibility: "seat_only", raw_mode: false, defer_during_raw_decision: true,
    watch_open_hands: false,
  };
  private timeOffsetMs = 0;
  private alarmCount = 0;
  private lastAlarmAt: number | null = null;
  private savedRevision = -1;
  private alarmSyncFailed = false;
  private alarmSetCount = 0; // process-local diagnostic, no DB writes
  private lastAlarmCheckAt = 0;
  private alarmStalledKey: string | null = null;
  private readonly devMode: boolean;

  constructor(ctx: DurableObjectState, env: { DEV_MODE?: string }) {
    super(ctx, env as never);
    this.devMode = env.DEV_MODE === "1";

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        sql.exec(
          "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT)",
        );
        sql.exec(
          "CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT NOT NULL, status_code INTEGER NOT NULL DEFAULT 200, created_at INTEGER NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE IF NOT EXISTS leases (decision_id TEXT NOT NULL, seat INTEGER NOT NULL, claim_token TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (decision_id, seat))",
        );

        sql.exec(
          "CREATE TABLE IF NOT EXISTS credentials (token_hash TEXT PRIMARY KEY, participant_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, seat INTEGER, display_name TEXT NOT NULL, icon TEXT, avatar_url TEXT, created_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)",
        );
        sql.exec(
          "CREATE TABLE IF NOT EXISTS invites (code_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, role TEXT NOT NULL, seat INTEGER, expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE IF NOT EXISTS cheers (id INTEGER PRIMARY KEY AUTOINCREMENT, spectator_id TEXT NOT NULL, target_seat INTEGER NOT NULL, body TEXT NOT NULL, nonce TEXT, created_at INTEGER NOT NULL)",
        );
        sql.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS cheers_nonce_idx ON cheers (spectator_id, nonce)",
        );
        sql.exec("CREATE INDEX IF NOT EXISTS cheers_seat_seq_idx ON cheers (target_seat, id)");
        // One moderation vote per credential identity and cheer. Old data stays intact.
        sql.exec(
          "CREATE TABLE IF NOT EXISTS cheer_flags (cheer_id INTEGER NOT NULL, participant_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (cheer_id, participant_id))",
        );
        const cheerCols = new Set(sql.exec("PRAGMA table_info(cheers)")
          .toArray().map((r: Record<string, unknown>) => String(r.name)));
        if (!cheerCols.has("hidden")) {
          sql.exec("ALTER TABLE cheers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
        }
        if (!cheerCols.has("hidden_at")) {
          sql.exec("ALTER TABLE cheers ADD COLUMN hidden_at INTEGER");
        }
        sql.exec(
          "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, kind TEXT NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL)",
        );
        // NULL on old rows is intentional: do not reconstruct historical
        // reactions from full-information archives or replay old SE on rollout.
        const eventCols = new Set(sql.exec("PRAGMA table_info(events)")
          .toArray().map((row: Record<string, unknown>) => String(row.name)));
        if (!eventCols.has("watch_signals")) {
          sql.exec("ALTER TABLE events ADD COLUMN watch_signals TEXT");
        }
        // Paipu archive: the same archival snapshots as events, keyed by
        // match and exempt from the RETAIN_EVENTS trim so a finished match
        // can be exported whole (see PAIPU.md). Pruned per finished match.
        sql.exec(
          "CREATE TABLE IF NOT EXISTS paipu_events (match_key TEXT NOT NULL, seq INTEGER NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (match_key, seq))",
        );
        // Completed hands only. Do not copy an unfinished master-view snapshot
        // into this table; it is intentionally readable by every room role.
        sql.exec(
          "CREATE TABLE IF NOT EXISTS finished_hands (id INTEGER PRIMARY KEY AUTOINCREMENT, match_key TEXT NOT NULL, hand_key TEXT NOT NULL, revision INTEGER NOT NULL, ended_at INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(match_key, hand_key))",
        );

        // Phase R2: independent ownership from Phase-4 credential membership.
        // Promotion reserves a seat. GET queue-status deterministically derives
        // the Player token from the private queue secret plus a persisted salt;
        // only its hash enters SQLite, and the POST queue response cannot issue it.
        sql.exec(
          "CREATE TABLE IF NOT EXISTS rotation_seat_holders (seat INTEGER PRIMARY KEY CHECK(seat BETWEEN 0 AND 3), participant_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, assigned_at INTEGER NOT NULL, source TEXT NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE IF NOT EXISTS rotation_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, queue_hash TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, icon TEXT, status TEXT NOT NULL CHECK(status IN ('waiting','promoted','left')), seat INTEGER, participant_id TEXT, grant_nonce TEXT, player_token_hash TEXT, created_at INTEGER NOT NULL, promoted_at INTEGER, left_at INTEGER)",
        );
        sql.exec("CREATE INDEX IF NOT EXISTS rotation_queue_fifo ON rotation_queue (status, id)");


        // Ranking v1: immutable 1-match/1-seat result ledger. A match row is
        // the durable recorded flag; four seat rows and the flag commit together
        // with the terminal game snapshot (no new migration namespace).
        sql.exec(
          "CREATE TABLE IF NOT EXISTS ranking_matches (match_key TEXT PRIMARY KEY, finished_at INTEGER NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE IF NOT EXISTS ranking_results (match_key TEXT NOT NULL, finished_at INTEGER NOT NULL, seat INTEGER NOT NULL CHECK(seat BETWEEN 0 AND 3), participant_id TEXT NOT NULL, display_name TEXT NOT NULL, icon TEXT, score INTEGER NOT NULL, rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 4), PRIMARY KEY (match_key, seat), FOREIGN KEY (match_key) REFERENCES ranking_matches(match_key))",
        );
        sql.exec(
          "CREATE INDEX IF NOT EXISTS ranking_results_participant_idx ON ranking_results (participant_id, finished_at)",
        );
        // Upgrade existing Phase-3a SQLite databases without changing the DO namespace.
        const cols = new Set(sql.exec("PRAGMA table_info(idempotency)")
          .toArray().map((r: Record<string, unknown>) => String(r.name)));
        let upgraded = false;
        if (!cols.has("request_hash")) {
          sql.exec("ALTER TABLE idempotency ADD COLUMN request_hash TEXT");
          upgraded = true;
        }
        if (!cols.has("status_code")) {
          sql.exec("ALTER TABLE idempotency ADD COLUMN status_code INTEGER NOT NULL DEFAULT 200");
          upgraded = true;
        }
        if (upgraded) {
          // Old rows lack the original request body: replay would be ambiguous.
          sql.exec("DELETE FROM idempotency WHERE request_hash IS NULL");
        }

        // Phase-3b leases had no owner field. Invalidate them rather than
        // allowing an anonymous legacy claimant to block the new identities.
        const leaseCols = new Set(sql.exec("PRAGMA table_info(leases)")
          .toArray().map((r: Record<string, unknown>) => String(r.name)));
        if (!leaseCols.has("participant_id")) {
          sql.exec("ALTER TABLE leases ADD COLUMN participant_id TEXT NOT NULL DEFAULT ''");
          sql.exec("DELETE FROM leases");
        }

        // One-time rollout: recognize the earliest enabled, non-bootstrap Player
        // as each existing seat's holder. Later /leave does NOT auto-rebuild
        // holders from legacy extra credentials. Bootstrap is always a fallback,
        // never evidence of an occupied human seat.
        if (this.metaGet("rotation_r2_initialized") !== "1") {
          const holders = sql.exec(
            "SELECT token_hash, participant_id, seat FROM credentials " +
            "WHERE enabled = 1 AND role = 'player' AND participant_id NOT LIKE 'bootstrap:%' " +
            "ORDER BY created_at, participant_id",
          ).toArray();
          for (const row of holders) {
            const seat = row.seat === null ? null : Number(row.seat);
            if (isSeat(seat)) {
              sql.exec(
                "INSERT OR IGNORE INTO rotation_seat_holders (seat, participant_id, token_hash, assigned_at, source) VALUES (?, ?, ?, ?, 'legacy')",
                seat, String(row.participant_id), String(row.token_hash), Date.now(),
              );
            }
          }
          this.metaSet("rotation_r2_initialized", "1");
        }


        const legacyLease = this.metaGet("lease");
        if (legacyLease !== null) this.metaDelete("lease");

        // Existing Phase-3b room tokens become MASTER tokens. The owner may
        // then issue the four Player bootstraps via POST /seat-tokens.
        const legacyToken = this.metaGet("token_hash");
        if (legacyToken !== null) {
          sql.exec(
            "INSERT OR IGNORE INTO credentials (token_hash, participant_id, role, seat, display_name, created_at) VALUES (?, 'master', 'master', NULL, 'Master (migrated)', ?)",
            legacyToken, Date.now(),
          );
          this.metaDelete("token_hash");
        }
      });

      this.roomId = this.metaGet("room_id");
      const settings = this.metaGet("room_policy");
      if (settings !== null) {
        const parsed: unknown = JSON.parse(settings);
        if (isObject(parsed)) {
          this.policy = {
            player_visibility: parsed.player_visibility === "all" ? "all" : "seat_only",
            raw_mode: parsed.raw_mode === true,
            defer_during_raw_decision: parsed.defer_during_raw_decision !== false,
            watch_open_hands: parsed.watch_open_hands === true,
          };
        }
      }
      const snapshot = this.metaGet("game");
      if (snapshot !== null) {
        this.game = JSON.parse(snapshot) as Game;
        this.savedRevision = this.game.revision;
      }
      // The development clock offset must never affect production gameplay.
      this.timeOffsetMs = this.devMode ? Number(this.metaGet("time_offset_ms") ?? "0") : 0;
      if (!Number.isSafeInteger(this.timeOffsetMs)) this.timeOffsetMs = 0;
      this.alarmCount = Number(this.metaGet("alarm_count") ?? "0");
      const last = this.metaGet("last_alarm_at");
      this.lastAlarmAt = last === null ? null : Number(last);
      this.alarmStalledKey = this.metaGet("alarm_stalled_key");
    });
  }

  // ---- Storage helpers (all SQL operations are synchronous) ----

  private metaGet(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM meta WHERE key = ?", key)
      .toArray()[0];
    return row === undefined ? null : String(row.value);
  }

  private metaSet(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value,
    );
  }

  private metaDelete(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }

  /** Called inside the existing write transactions. No occupancy work on GET. */
  private matchBegunForOccupancy(game: Game | null): boolean {
    return game !== null && game.phase !== "finished" &&
      game.discards.some(d => d.length > 0);
  }

  private bumpOccupancyRevisionTx(): void {
    const raw = Number(this.metaGet("occupancy_revision") ?? "0");
    const current = isInt(raw) && raw >= 0 ? raw : 0;
    if (!Number.isSafeInteger(current + 1)) throw new Error("occupancy revision overflow");
    this.metaSet("occupancy_revision", String(current + 1));
  }

  private opsLog(kind: string, payload: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO ops (ts, kind, payload) VALUES (?, ?, ?)",
      Date.now(), kind, JSON.stringify(payload),
    );
  }

  private countRows(table: "idempotency" | "ops" | "leases"): number {
    const row = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS c FROM ${table}`).toArray()[0];
    return row === undefined ? 0 : Number(row.c);
  }

  private allCurrentLeases(): Lease[] {
    const g = this.game;
    if (g === null || typeof g.decision_id !== "string") return [];
    return this.ctx.storage.sql.exec(
      "SELECT decision_id, seat, claim_token, participant_id, expires_at FROM leases WHERE decision_id = ? AND expires_at > ? ORDER BY seat",
      g.decision_id, this.engineNow(),
    ).toArray().map((r: Record<string, unknown>) => ({
      decision_id: String(r.decision_id),
      seat: Number(r.seat),
      claim_token: String(r.claim_token),
      participant_id: String(r.participant_id),
      expires_at: Number(r.expires_at),
    }));
  }

  private currentLease(decisionId: string, seat: number): Lease | null {
    const row = this.ctx.storage.sql.exec(
      "SELECT decision_id, seat, claim_token, participant_id, expires_at FROM leases WHERE decision_id = ? AND seat = ?",
      decisionId, seat,
    ).toArray()[0];
    if (row === undefined) return null;
    const lease: Lease = {
      decision_id: String(row.decision_id),
      seat: Number(row.seat),
      claim_token: String(row.claim_token),
      participant_id: String(row.participant_id),
      expires_at: Number(row.expires_at),
    };
    if (this.engineNow() >= lease.expires_at) {
      this.ctx.storage.sql.exec(
        "DELETE FROM leases WHERE decision_id = ? AND seat = ?",
        decisionId, seat,
      );
      return null;
    }
    return lease;
  }

  private findIdempotency(key: string): StoredIdempotency | null {
    const row = this.ctx.storage.sql.exec(
      "SELECT request_hash, result, status_code FROM idempotency WHERE key = ?", key,
    ).toArray()[0];
    if (row === undefined) return null;
    return {
      request_hash: row.request_hash === null ? null : String(row.request_hash),
      result: String(row.result),
      status_code: Number(row.status_code),
    };
  }

  private logCompletionMetrics(snapshotBytes: number): void {
    this.opsLog("match_storage_metrics", {
      snapshot_bytes: snapshotBytes,
      database_size_bytes: this.ctx.storage.sql.databaseSize,
      idempotency_keys: this.countRows("idempotency"),
      ops: this.countRows("ops") + 1,
    });
  }

  // ---- Ranking v1: append-only, transactional match results ----

  /** An existing room plays one match; future match resets may supply match_id. */
  private rankingMatchKey(game: Game): string {
    const raw = game as unknown as JsonObject;
    const identifier = raw.match_id;
    // Future resets must use commitGame(), which increases this durable epoch.
    // The epoch makes two consecutive halves distinct even on older engines
    // that do not provide a match_id (or unexpectedly reuse that id).
    const generationText = this.metaGet("ranking_generation") ?? "0";
    const generation = Number(generationText);
    if (!isInt(generation) || generation < 0) throw new Error("invalid ranking generation");
    if ((typeof identifier === "string" && identifier.length > 0 && identifier.length <= 128) ||
        (isInt(identifier) && identifier >= 0)) return `g${generation}:match:${String(identifier)}`;
    return `g${generation}:initial`;
  }

  /** Must only be called *inside* the same transactionSync as the game finish. */
  private recordFinishedMatchTx(game: Game): void {
    if (game.phase !== "finished") return;
    const matchKey = this.rankingMatchKey(game);
    if (this.metaGet("ranking_recorded_match_key") === matchKey) return;
    const old = this.ctx.storage.sql.exec(
      "SELECT 1 AS recorded FROM ranking_matches WHERE match_key = ?", matchKey,
    ).toArray()[0];
    if (old !== undefined) {
      // A future engine could have more than one match in this DO. Keep the
      // most-recent marker in sync without appending duplicate results.
      this.metaSet("ranking_recorded_match_key", matchKey);
      return;
    }

    const raw = game as unknown as JsonObject;
    const scores = raw.scores;
    if (!Array.isArray(scores) || scores.length !== 4 ||
        !scores.every(score => isInt(score))) {
      throw new Error("cannot record completed match: invalid final scores");
    }
    const finishedAt = Date.now();
    // The specification leaves tied scores unspecified. Use seat number as a
    // deterministic secondary key; all four finish ranks remain 1..4.
    const order = [0, 1, 2, 3].sort((a, b) =>
      (scores[b] as number) - (scores[a] as number) || a - b);
    const ranks = [0, 0, 0, 0];
    order.forEach((seat, index) => { ranks[seat] = index + 1; });

    this.ctx.storage.sql.exec(
      "INSERT INTO ranking_matches (match_key, finished_at) VALUES (?, ?)",
      matchKey, finishedAt,
    );
    for (let seat = 0; seat < 4; seat++) {
      // Read the holder NOW, not a historical action actor and not an inactive
      // legacy Player credential. A promoted-but-unredeemed queue holder has
      // a participant_id even before the credential is delivered.
      const holder = this.currentHolder(seat);
      const participantId = holder?.participant_id ?? `bootstrap:${seat}`;
      let name = `Seat ${seat}`;
      let icon: string | null = null;
      if (holder !== null) {
        const credential = this.ctx.storage.sql.exec(
          "SELECT display_name, icon FROM credentials WHERE participant_id = ? AND token_hash = ? AND enabled = 1",
          holder.participant_id, holder.token_hash,
        ).toArray()[0];
        const queued = credential === undefined ? this.ctx.storage.sql.exec(
          "SELECT display_name, icon FROM rotation_queue WHERE participant_id = ? AND status = 'promoted' ORDER BY id DESC LIMIT 1",
          holder.participant_id,
        ).toArray()[0] : undefined;
        const identity = credential ?? queued;
        if (identity !== undefined) {
          name = String(identity.display_name);
          icon = identity.icon === null || identity.icon === undefined ? null : String(identity.icon);
        }
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO ranking_results (match_key, finished_at, seat, participant_id, display_name, icon, score, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        matchKey, finishedAt, seat, participantId, name, icon, scores[seat], ranks[seat],
      );
    }
    this.metaSet("ranking_recorded_match_key", matchKey);
    this.opsLog("match_ranking_recorded", { match_key: matchKey, finished_at: finishedAt });
    // Paipu retention: keep archives for the newest finished matches only.
    // Ranking rows are the durable record and stay; only the bulky event
    // snapshots are pruned. The just-finished match is always kept.
    const keepKeys = this.ctx.storage.sql.exec(
      "SELECT match_key FROM ranking_matches ORDER BY finished_at DESC LIMIT ?",
      PAIPU_RETAINED_MATCHES,
    ).toArray().map(row => String(row.match_key));
    if (!keepKeys.includes(matchKey)) keepKeys.push(matchKey);
    const placeholders = keepKeys.map(() => "?").join(", ");
    this.ctx.storage.sql.exec(
      `DELETE FROM paipu_events WHERE match_key NOT IN (${placeholders})`, ...keepKeys,
    );
  }

  /** Public leaderboard; bootstrap rows remain in the ledger but not in totals. */
  private rankingSummary(): JsonObject[] {
    const rows = this.ctx.storage.sql.exec(
      `SELECT r.participant_id, COUNT(*) AS matches,
         SUM(CASE WHEN r.rank = 1 THEN 1 ELSE 0 END) AS wins,
         ROUND(AVG(CAST(r.rank AS REAL)), 1) AS avg_rank,
         CAST(ROUND(AVG(CAST(r.score AS REAL)), 0) AS INTEGER) AS avg_score,
         SUM(r.score - 25000) AS total_diff,
         MAX(r.score) AS best_score,
         (SELECT newer.display_name FROM ranking_results newer
           WHERE newer.participant_id = r.participant_id
           ORDER BY newer.finished_at DESC, newer.match_key DESC LIMIT 1) AS display_name,
         (SELECT newer.icon FROM ranking_results newer
           WHERE newer.participant_id = r.participant_id
           ORDER BY newer.finished_at DESC, newer.match_key DESC LIMIT 1) AS icon
       FROM ranking_results r
       WHERE r.participant_id NOT LIKE 'bootstrap:%'
       GROUP BY r.participant_id
       ORDER BY total_diff DESC, wins DESC, r.participant_id ASC LIMIT 20`,
    ).toArray();
    return rows.map(row => ({
      participant_id: String(row.participant_id),
      display_name: String(row.display_name),
      icon: row.icon === null ? null : String(row.icon),
      matches: Number(row.matches), wins: Number(row.wins),
      avg_rank: Number(row.avg_rank), avg_score: Number(row.avg_score),
      total_diff: Number(row.total_diff), best_score: Number(row.best_score),
    }));
  }

  /** Five most recent complete matches, including bootstrap seats (public). */
  private recentMatchResults(): JsonObject[] {
    const matches = this.ctx.storage.sql.exec(
      "SELECT match_key, finished_at FROM ranking_matches ORDER BY finished_at DESC, match_key DESC LIMIT 5",
    ).toArray();
    return matches.map(match => {
      const standings = this.ctx.storage.sql.exec(
        "SELECT display_name, icon, score, rank FROM ranking_results WHERE match_key = ? ORDER BY rank, seat",
        String(match.match_key),
      ).toArray().map(row => ({
        display_name: String(row.display_name),
        icon: row.icon === null ? null : String(row.icon),
        score: Number(row.score), rank: Number(row.rank),
      }));
      return { finished_at: Number(match.finished_at), standings };
    });
  }

  /** Commit a proposed Game atomically, then change the memory cache. */
  private commitGame(next: Game, options: PersistOptions): void {
    const previous = this.game;
    // Rotation grace: a seat whose holder just changed carries a one-time
    // flag; the first deadline armed for that seat is extended by a free
    // minute (deadline only — the bank is not charged for it). Fill-in
    // (bootstrap) play never sets the flag, so it never receives grace.
    if (next.clock !== null && next.dec_deadlines) {
      const deadlines = next.dec_deadlines as Record<string, { deadline: number; grace_ms?: number }>;
      for (let seat = 0; seat < 4; seat++) {
        const entry = deadlines[String(seat)];
        if (!entry || entry.grace_ms) continue;
        if (this.metaGet(`rotation_grace:${seat}`) !== "1") continue;
        entry.deadline += ROTATION_GRACE_MS;
        entry.grace_ms = ROTATION_GRACE_MS;
        this.metaSet(`rotation_grace:${seat}`, "0");
      }
    }
    const snapshot = JSON.stringify(next);
    const snapshotBytes = new TextEncoder().encode(snapshot).byteLength;
    this.ctx.storage.transactionSync(() => {
      this.metaSet("game", snapshot);
      if (this.matchBegunForOccupancy(previous) !== this.matchBegunForOccupancy(next)) {
        this.bumpOccupancyRevisionTx();
      }
      if (previous?.phase === "finished" && next.phase !== "finished") {
        const currentGeneration = Number(this.metaGet("ranking_generation") ?? "0");
        if (!isInt(currentGeneration) || currentGeneration < 0 ||
            !Number.isSafeInteger(currentGeneration + 1)) throw new Error("invalid ranking generation");
        this.metaSet("ranking_generation", String(currentGeneration + 1));
      }
      if (options.action) {
        const a = options.action;
        // Only the acting seat's lease is consumed here.
        this.ctx.storage.sql.exec(
          "DELETE FROM leases WHERE decision_id = ? AND seat = ?",
          a.decisionId, a.consumedSeat,
        );
        if (a.idemKey !== null && a.requestHash !== null) {
          this.ctx.storage.sql.exec(
            "INSERT INTO idempotency (key, request_hash, result, status_code, created_at) VALUES (?, ?, ?, ?, ?)",
            a.idemKey, a.requestHash, JSON.stringify(a.response), a.statusCode, Date.now(),
          );
        }
      }
      // If the phase/decision advanced, other leases are no longer valid.
      if (typeof next.decision_id === "string") {
        this.ctx.storage.sql.exec(
          "DELETE FROM leases WHERE decision_id <> ?", next.decision_id,
        );
      } else {
        this.ctx.storage.sql.exec("DELETE FROM leases");
      }
      this.opsLog(options.logKind, options.logPayload);
      this.appendEvent(next, options.logKind);
      if (previous?.phase !== "finished" && next.phase === "finished") {
        this.recordFinishedMatchTx(next);
        this.logCompletionMetrics(snapshotBytes);
      }
    });
    this.game = next;
    this.savedRevision = next.revision;
  }

  /**
   * Timeout settlement is a *separate* atomic commit. A later rejected action
   * cannot roll it back. The engine's semantics remain unchanged.
   */
  private settleNow(kind: "lazy_settle" | "alarm_settle"): boolean {
    if (this.game === null) return false;
    this.injectTime();
    const logBefore = this.game.clock_log?.length ?? 0;
    const next = structuredClone(this.game);
    const changed = settleExpired(next);
    if (!changed) return false;
    this.commitGame(next, {
      logKind: kind,
      logPayload: { revision: next.revision, decision_id: next.decision_id },
    });
    this.processTimeoutsTx(logBefore, next);
    return true;
  }

  /**
   * Timeout rotation (clocked rooms): a holder who lets the server play
   * TIMEOUT_ROTATE_AFTER decisions in a row loses the seat to the queue.
   * Timeouts on open seats (fill-in territory) never count, and a single
   * voluntary action by the holder resets the streak (see handleActions).
   */
  private processTimeoutsTx(logBefore: number, next: Game): void {
    const fresh = (next.clock_log ?? []).slice(logBefore)
      .filter(entry => isObject(entry) && entry.timed_out === true && isInt(entry.seat));
    if (fresh.length === 0) return;
    const seats = [...new Set(fresh.map(entry => Number((entry as { seat: unknown }).seat)))];
    this.ctx.storage.transactionSync(() => {
      for (const seat of seats) {
        const holder = this.currentHolder(seat);
        if (holder === null) continue;
        const streak = Number(this.metaGet(`timeout_streak:${seat}`) ?? "0") + 1;
        if (streak >= TIMEOUT_ROTATE_AFTER) {
          this.opsLog("seat_timeout_rotation", { participant_id: holder.participant_id, seat, streak });
          this.vacateSeatTx(seat);
        } else {
          this.metaSet(`timeout_streak:${seat}`, String(streak));
        }
      }
    });
  }

  // ---- Clock / Alarm ----

  private engineNow(): number {
    return Date.now() + this.timeOffsetMs;
  }

  private injectTime(offsetMs = this.timeOffsetMs): void {
    // The imported engine currently provides a module-global clock setter.
    // Never yield/await between injectTime() and any engine call.
    setNowMs(() => Date.now() + offsetMs);
  }

  private nextEngineDeadline(): number | null {
    const g = this.game;
    if (g === null || g.clock === null || g.phase === "finished") return null;
    const deadlines = Object.values(g.dec_deadlines as Record<string, unknown>)
      .map(item => isObject(item) ? item.deadline : null)
      .filter((deadline): deadline is number => isInt(deadline) && deadline > 0);
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  /**
   * Alarm is changed only when the desired real timestamp is different.
   * blockConcurrencyWhile is reserved for this occasional async scheduling,
   * not for the read/action hot path. Failures are logged, not silently ignored.
   */
  private async syncAlarmSafely(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      let alarmOperation: "get" | "set" | "delete" = "get";
      try {
        const deadline = this.nextEngineDeadline();
        const existing = await this.ctx.storage.getAlarm();
        this.lastAlarmCheckAt = Date.now();
        if (deadline === null) {
          if (existing !== null) {
            alarmOperation = "delete";
            await this.ctx.storage.deleteAlarm();
          }
          this.alarmSyncFailed = false;
          return;
        }
        const desired = deadline - this.timeOffsetMs;
        if (desired <= Date.now()) {
          // settleNow() has already been attempted. Re-arming this due deadline
          // would loop forever if the engine cannot make progress.
          if (existing !== null) {
            alarmOperation = "delete";
            await this.ctx.storage.deleteAlarm();
          }
          const key = `${this.game?.decision_id ?? "none"}:${deadline}`;
          if (this.alarmStalledKey !== key) {
            this.ctx.storage.transactionSync(() => {
              this.metaSet("alarm_stalled_key", key);
              this.opsLog("alarm_stalled", { decision_id: this.game?.decision_id, deadline });
            });
            this.alarmStalledKey = key;
          }
          this.alarmSyncFailed = false;
          return;
        }
        if (existing !== desired) {
          alarmOperation = "set";
          await this.ctx.storage.setAlarm(desired);
          this.alarmSetCount += 1;
        }
        this.alarmSyncFailed = false;
      } catch (e) {
        this.alarmSyncFailed = true;
        const message = safeError(e);
        console.error("RoomDO alarm synchronization failed:", message);
        try {
          this.opsLog(
            alarmOperation === "delete" ? "alarm_delete_failed" : "alarm_schedule_error",
            { operation: alarmOperation, message },
          );
        } catch (logError) {
          console.error("RoomDO could not log alarm failure:", safeError(logError));
        }
      }
    });
  }

  private async syncIfNeeded(changed: boolean): Promise<void> {
    // Cheap once-per-minute reconciliation also heals a missing Alarm after a
    // DO restart, without rewriting it on every GET /state poll.
    if (changed || this.alarmSyncFailed || Date.now() - this.lastAlarmCheckAt >= 60_000) {
      await this.syncAlarmSafely();
    }
  }

  async alarm(): Promise<void> {
    this.injectTime();
    const nextCount = this.alarmCount + 1;
    const now = Date.now();
    const old = this.game;
    const next = old === null ? null : structuredClone(old);
    const changed = next !== null && settleExpired(next);

    // Alarm statistics and the optional state transition commit together.
    const snapshot = changed && next !== null ? JSON.stringify(next) : null;
    this.ctx.storage.transactionSync(() => {
      this.metaSet("alarm_count", String(nextCount));
      this.metaSet("last_alarm_at", String(now));
      if (snapshot !== null && next !== null) {
        this.metaSet("game", snapshot);
        if (this.matchBegunForOccupancy(old) !== this.matchBegunForOccupancy(next)) {
          this.bumpOccupancyRevisionTx();
        }
        if (typeof next.decision_id === "string") {
          this.ctx.storage.sql.exec("DELETE FROM leases WHERE decision_id <> ?", next.decision_id);
        } else {
          this.ctx.storage.sql.exec("DELETE FROM leases");
        }
        this.opsLog("alarm_settle", { revision: next.revision, decision_id: next.decision_id });
        this.appendEvent(next, "alarm_settle");
        if (old?.phase !== "finished" && next.phase === "finished") {
          this.recordFinishedMatchTx(next);
          this.logCompletionMetrics(new TextEncoder().encode(snapshot).byteLength);
        }
      }
    });
    this.alarmCount = nextCount;
    this.lastAlarmAt = now;
    if (changed && next !== null) {
      this.game = next;
      this.savedRevision = next.revision;
    }
    await this.syncAlarmSafely();
  }


  /** Watch watermarks advance in the SAME committed event transaction as the
   *  Game snapshot. Claim leases do not create a new decision or watermark. */
  private updateDecisionWatermarksTx(next: Game, timeOffsetMs: number): void {
    const active = next.phase === "finished" ? [] : currentDecisions(next);
    for (let seat = 0; seat < 4; seat++) {
      const pending = active.some(d => d.seat === seat);
      const deadlineRow = next.clock === null ? null :
        (next.dec_deadlines as Record<string, unknown>)[String(seat)];
      const deadline = pending && isObject(deadlineRow) && isInt(deadlineRow.deadline)
        ? deadlineRow.deadline : null;
      const signature = pending ? JSON.stringify([next.decision_id, deadline]) : "null";
      if (this.metaGet(`watch_decision_sig:${seat}`) !== signature) {
        this.metaSet(`watch_decision_sig:${seat}`, signature);
        this.metaSet(`watch_decision_changed_at:${seat}`, String(Date.now() + timeOffsetMs));
      }
    }
  }

  /** Persist the first *verified* score baseline for a new hand. Migration in
   *  the middle of an existing hand deliberately leaves the baseline unknown. */
  private trackHandScoreBaselineTx(snapshot: JsonObject, matchKey: string, kind: string): void {
    const hand = handIdentifier(snapshot);
    const scores = fourScores(snapshot.scores);
    if (hand === null || scores === null) return;
    const key = `${matchKey}/${hand}`;
    const raw = this.metaGet("finished_hand_score_track");
    let old: JsonObject | null = null;
    if (raw !== null) {
      try { const parsed: unknown = JSON.parse(raw); if (isObject(parsed)) old = parsed; }
      catch { /* corrupt cache is not proof of a baseline */ }
    }
    if (old?.key === key) return;
    // Only init or a witnessed change from a previous hand proves this is a
    // hand-start score, rather than the middle of an upgraded live game.
    const trusted = kind === "init" || (old !== null && typeof old.key === "string");
    this.metaSet("finished_hand_score_track", JSON.stringify({ key, scores, trusted }));
  }

  /** Construct an allowlisted terminal projection; null means NOT PROVEN to
   *  be a completed hand with all four end-of-hand concealed tile arrays. */
  private finishedHandProjection(snapshot: unknown, matchKey: string, revision: number,
                                 endedAt: number, useTrackedBaseline: boolean): JsonObject | null {
    if (!isObject(snapshot)) return null;
    const finished = terminalHandSnapshot(snapshot);
    if (finished === null) return null;
    // A terminal nested hand must supply ITS OWN hands. Falling back to the
    // root's new hand would accidentally reveal ongoing concealed tiles.
    const hands = finished.hands;
    // A nested finished hand may belong to the PREVIOUS hand while the root
    // already describes the next active hand. Never borrow its live scores.
    const resultScores = isObject(finished.result) ? fourScores(finished.result.scores_after) : null;
    const scores = fourScores(finished.scores) ?? resultScores ??
      (finished === snapshot || snapshot.phase === "finished" ? fourScores(snapshot.scores) : null);
    if (!Array.isArray(hands) || hands.length !== 4 || !hands.every(Array.isArray) ||
        scores === null) return null;
    const handKey = handIdentifier(finished) ?? handIdentifier(snapshot) ?? `revision:${revision}`;
    let before: number[] | null = null;
    if (useTrackedBaseline) {
      const trackedText = this.metaGet("finished_hand_score_track");
      if (trackedText !== null) {
        try {
          const tracked: unknown = JSON.parse(trackedText);
          if (isObject(tracked) && tracked.key === `${matchKey}/${handKey}` &&
              tracked.trusted === true) before = fourScores(tracked.scores);
        } catch { /* leave unknown rather than invent score changes */ }
      }
    }
    const result = isObject(finished.result) ? cleanResult(finished.result, true) : null;
    const round = finished.round ?? snapshot.round ?? null;
    const handIndex = finished.hand_index ?? snapshot.hand_index;
    const handId = finished.hand_id ?? snapshot.hand_id;
    return {
      schema_version: 1,
      match_key: matchKey,
      hand_key: handKey,
      hand_id: typeof handId === "string" || isInt(handId) ? handId : null,
      hand_index: isInt(handIndex) ? handIndex : null,
      round,
      round_wind: finished.round_wind ?? snapshot.round_wind ?? null,
      round_number: finished.round_number ?? snapshot.round_number ?? null,
      round_label: finished.round_label ?? snapshot.round_label ?? null,
      honba: finished.honba ?? snapshot.honba ?? null,
      revision,
      ended_at: endedAt,
      final_hands: hands,
      final_hand_names: Array.isArray(finished.hand_names) && finished.hand_names.length === 4
        ? finished.hand_names : null,
      final_melds: Array.isArray(finished.melds) && finished.melds.length === 4
        ? finished.melds : null,
      final_drawn_tiles: Array.isArray(finished.drawn_tiles) && finished.drawn_tiles.length === 4
        ? finished.drawn_tiles : null,
      result: result ?? null,
      scores_before: before,
      score_changes: before === null ? null : scores.map((v, i) => v - before![i]),
      final_scores: scores,
    };
  }

  /** Archive only terminal snapshots, atomically with the existing event. */
  private archiveFinishedHandTx(snapshot: JsonObject, next: Game, kind: string, endedAt: number): void {
    const matchKey = this.rankingMatchKey(next);
    // Project before changing the hand-start marker: nested finished hand N
    // can arrive together with the start of active hand N+1.
    const hand = this.finishedHandProjection(snapshot, matchKey, next.revision, endedAt, true);
    this.trackHandScoreBaselineTx(snapshot, matchKey, kind);
    if (hand === null) return;
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO finished_hands (match_key, hand_key, revision, ended_at, payload) VALUES (?, ?, ?, ?, ?)",
      matchKey, String(hand.hand_key), next.revision, endedAt, JSON.stringify(hand),
    );
    // Keep only a bounded archive; paipu's own retention is not changed.
    this.ctx.storage.sql.exec(
      "DELETE FROM finished_hands WHERE id NOT IN (SELECT id FROM finished_hands ORDER BY id DESC LIMIT ?)",
      FINISHED_HAND_RETAINED,
    );
  }

  /** Player-only, tiny per-seat polling surface. Watermarks and counts contain
   *  no tile, action, lease token, commenter identity or comment body. */
  private async handleWatchDigest(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "player" || who.seat === null) return json({ error: "forbidden" }, 403);
    if (!this.canOperateSeat(who, who.seat)) return json({ error: "not current seat holder" }, 403);
    const url = new URL(request.url);
    const after = parseCursor(url);
    const cheersAfter = parseCursorParam(url, "cheers_after");
    if (after === null) return json({ error: "invalid after cursor" }, 400);
    if (cheersAfter === null) return json({ error: "invalid cheers_after cursor" }, 400);
    // Avoid cloning the entire Game on every cheap poll. The existing Alarm
    // handles future deadlines; only a due clock needs lazy settlement now.
    const nextDeadline = this.nextEngineDeadline();
    const due = nextDeadline !== null && nextDeadline <= this.engineNow();
    const settled = due ? this.settleNow("lazy_settle") : false;
    await this.syncIfNeeded(settled);
    // Engine decisions are queried only for this authenticated, held seat.
    this.injectTime();
    const game = this.game!;
    const seat = who.seat;
    const active = game.phase !== "finished" && currentDecisions(game).some(d => d.seat === seat);
    const row = game.clock === null ? null :
      (game.dec_deadlines as Record<string, unknown>)[String(seat)];
    const deadline = active && isObject(row) && isInt(row.deadline) ? row.deadline : null;
    const bounds = this.ctx.storage.sql.exec(
      "SELECT MIN(seq) AS earliest, MAX(seq) AS latest FROM events",
    ).toArray()[0];
    const earliest = bounds?.earliest === null || bounds === undefined ? 0 : Number(bounds.earliest);
    const latest = bounds?.latest === null || bounds === undefined ? 0 : Number(bounds.latest);
    const deferred = this.policy.raw_mode && this.policy.defer_during_raw_decision && active;
    let ownCheerCount = 0;
    let cheerLatest: number | null = null;
    if (!deferred) {
      const cheerBound = this.ctx.storage.sql.exec(
        "SELECT MAX(id) AS n FROM cheers WHERE target_seat = ?", seat,
      ).toArray()[0];
      cheerLatest = cheerBound?.n === null || cheerBound === undefined ? 0 : Number(cheerBound.n);
      // Most polls have no new cheer. Avoid scanning/comment-counting them.
      if (cheerLatest > cheersAfter) {
        const cheers = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS n FROM cheers c JOIN credentials p ON p.participant_id = c.spectator_id WHERE c.target_seat = ? AND c.id > ? AND c.hidden = 0",
          seat, cheersAfter,
        ).toArray()[0];
        ownCheerCount = Number(cheers?.n ?? 0);
      }
    }
    const changedRaw = this.metaGet(`watch_decision_changed_at:${seat}`);
    const changed = changedRaw === null ? null : Number(changedRaw);
    return json({
      revision: game.revision,
      latest_seq: latest,
      earliest_events_seq: earliest,
      latest_events_seq: latest,
      events_cursor_expired: earliest > 1 && after < earliest - 1,
      own_decision: active ? { id: game.decision_id, deadline } : null,
      decision_changed_at: changed !== null && isInt(changed) ? changed : null,
      own_cheer_new_count: ownCheerCount,
      cheers_latest_seq_for_seat: cheerLatest,
      cheers_deferred: deferred,
      occupancy_revision: Number(this.metaGet("occupancy_revision") ?? "0"),
      server_time: this.engineNow(),
    });
  }

  /** Expose only an archived terminal hand, never this.game's active hands. */
  private async handleHandsLatest(who: Principal): Promise<Response> {
    if (who.role !== "player" && who.role !== "spectator" && who.role !== "master") {
      return json({ error: "forbidden" }, 403);
    }
    const saved = this.ctx.storage.sql.exec(
      "SELECT payload, ended_at FROM finished_hands ORDER BY id DESC LIMIT 1",
    ).toArray()[0];
    let latest: JsonObject | null = null;
    let latestAt = -1;
    if (saved !== undefined) {
      try {
        const parsed: unknown = JSON.parse(String(saved.payload));
        if (isObject(parsed) && Array.isArray(parsed.final_hands) && parsed.final_hands.length === 4) {
          latest = parsed;
          latestAt = Number(saved.ended_at);
        }
      } catch { /* corrupt historical row is not disclosed */ }
    }
    // Pre-upgrade finished matches have paipu snapshots but no finished_hands
    // rows. Only the registered FINISHED match's terminal archive is eligible.
    const archived = this.ctx.storage.sql.exec(
      `SELECT p.match_key, p.revision, p.created_at, p.snapshot
       FROM paipu_events p JOIN ranking_matches m ON m.match_key = p.match_key
       ORDER BY p.created_at DESC, p.seq DESC LIMIT 1`,
    ).toArray()[0];
    if (archived !== undefined && Number(archived.created_at) > latestAt) {
      let record: JsonObject | null = null;
      try {
        const snapshot: unknown = JSON.parse(String(archived.snapshot));
        record = this.finishedHandProjection(snapshot, String(archived.match_key),
          Number(archived.revision), Number(archived.created_at), false);
      } catch { /* fail closed on legacy snapshots */ }
      if (record !== null) latest = record;
    }
    return latest === null ? json({ error: "no_finished_hand" }, 404) : json(latest);
  }

  /** Only public, allowlisted fields enter the event-history projection. */
  private appendEvent(next: Game, kind: string, policy: RoomPolicy = this.policy,
                      timeOffsetMs = this.timeOffsetMs, actionHint?: unknown): void {
    this.injectTime(timeOffsetMs);
    const raw: unknown = publicState(next);
    const archival = viewState(raw, { role: "master", seat: null }, policy);
    const snapshotJson = JSON.stringify(archival);
    // Use a second, restricted spectator projection ONLY for classification.
    // The previous full-information archive never crosses the HTTP boundary.
    const previous = this.ctx.storage.sql.exec(
      "SELECT snapshot FROM events ORDER BY seq DESC LIMIT 1",
    ).toArray()[0];
    let publicSignals: WatchSignal[] = [];
    try {
      const before = previous === undefined ? null :
        soundView(JSON.parse(String(previous.snapshot)) as unknown, policy);
      publicSignals = makeWatchSignals(before, soundView(archival, policy), kind, actionHint);
    } catch {
      // A cosmetic sound feature must NEVER cause a valid game commit to fail.
      // An unexpected engine format simply produces a silent event.
    }
    const createdAt = Date.now();
    this.updateDecisionWatermarksTx(next, timeOffsetMs);
    this.archiveFinishedHandTx(archival, next, kind, createdAt);
    this.ctx.storage.sql.exec(
      "INSERT INTO events (revision, kind, snapshot, created_at, watch_signals) VALUES (?, ?, ?, ?, ?)",
      next.revision, kind, snapshotJson, createdAt, JSON.stringify(publicSignals),
    );
    const last = this.ctx.storage.sql.exec("SELECT MAX(seq) AS n FROM events").toArray()[0];
    if (last) {
      // Mirror into the paipu archive under the current match key. The
      // archive is not trimmed with events; it is pruned per finished
      // match in recordFinishedMatchTx.
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO paipu_events (match_key, seq, revision, kind, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        this.rankingMatchKey(next), Number(last.n), next.revision, kind, snapshotJson, createdAt,
      );
    }
    if (last && Number(last.n) % 50 === 0) {
      this.ctx.storage.sql.exec("DELETE FROM events WHERE seq <= ?", Number(last.n) - RETAIN_EVENTS);
    }
  }

  private async authenticate(request: Request): Promise<Principal | null> {
    const raw = request.headers.get("authorization") ?? request.headers.get("x-room-token") ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    if (!token || token.length > 256) return null;
    const hash = await sha256Hex(token);
    const row = this.ctx.storage.sql.exec(
      "SELECT token_hash, participant_id, role, seat, display_name FROM credentials WHERE token_hash = ? AND enabled = 1", hash,
    ).toArray()[0];
    if (!row) return null;
    if (row.role !== "master" && row.role !== "player" && row.role !== "spectator") return null;
    const seat = row.seat === null ? null : Number(row.seat);
    return {
      token_hash: String(row.token_hash),
      participant_id: String(row.participant_id),
      role: row.role as PrincipalRole,
      seat: isSeat(seat) ? seat : null,
      display_name: String(row.display_name),
    };
  }

  private async watchPrincipal(request: Request): Promise<Principal | null> {
    const pw = request.headers.get("x-watch-password") ?? "";
    if (!pw || pw.length > 64) return null;
    const stored = this.metaGet("watch_hash");
    if (!stored) return null;
    const hash = await sha256Hex(pw);
    if (hash !== stored) return null;
    return {
      token_hash: "",
      participant_id: "watch",
      role: "spectator",
      seat: null,
      display_name: "Watch",
    };
  }

  private async handleWatchOpen(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "master") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    if (typeof parsed.open !== "boolean") return json({ error: "invalid open" }, 400);
    this.policy.watch_open_hands = parsed.open;
    this.metaSet("room_policy", JSON.stringify(this.policy));
    return json({ ok: true, watch_open_hands: this.policy.watch_open_hands });
  }

  /**
   * Guest cheer identity for the password-only watch view (and Muse API
   * guests): the watch password plus a per-browser client id, a chosen
   * support seat and an optional display name become a lightweight
   * spectator principal (participant_id "watch:<client>"). A matching
   * credentials row is upserted so cheers can be attributed and counted
   * in occupancy. The client id acts as the guest's personal key.
   */
  private async watchCheerPrincipal(request: Request): Promise<Principal | null> {
    const base = await this.watchPrincipal(request);
    if (!base) return null;
    const client = request.headers.get("x-watch-client") ?? "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(client)) return null;
    const supportRaw = request.headers.get("x-watch-support") ?? "";
    if (!/^[0-3]$/.test(supportRaw)) return null;
    const seat = Number(supportRaw);
    let name = "ゲスト";
    const rawName = request.headers.get("x-watch-name");
    if (rawName) {
      try {
        const decoded = decodeURIComponent(rawName).trim().slice(0, 20);
        if (decoded && !/[\u0000-\u001f\u007f]/.test(decoded)) name = decoded;
      } catch { /* keep the default name */ }
    }
    const pid = "watch:" + client;
    const tokenHash = await sha256Hex("watch-cheer:" + client);
    this.ctx.storage.transactionSync(() => {
      const old = this.ctx.storage.sql.exec(
        "SELECT seat, display_name, enabled FROM credentials WHERE participant_id = ?", pid,
      ).toArray()[0];
      if (!old || old.seat === null || Number(old.seat) !== seat ||
          String(old.display_name) !== name || Number(old.enabled) !== 1) {
        this.bumpOccupancyRevisionTx();
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO credentials (token_hash, participant_id, role, seat, display_name, created_at)
         VALUES (?, ?, 'spectator', ?, ?, ?)
         ON CONFLICT(participant_id) DO UPDATE SET seat = excluded.seat, display_name = excluded.display_name`,
        tokenHash, pid, seat, name, Date.now(),
      );
    });
    return { token_hash: tokenHash, participant_id: pid, role: "spectator", seat, display_name: name };
  }

  // ---- Phase R2 / rotation helpers; all updates are inside transactionSync. ----

  private currentHolder(seat: number): { participant_id: string; token_hash: string } | null {
    const row = this.ctx.storage.sql.exec(
      "SELECT participant_id, token_hash FROM rotation_seat_holders WHERE seat = ?", seat,
    ).toArray()[0];
    return row ? { participant_id: String(row.participant_id), token_hash: String(row.token_hash) } : null;
  }

  /** Only this seat's current credential, its bootstrap fallback, or Master. */
  private canOperateSeat(who: Principal, seat: number): boolean {
    if (!isSeat(seat)) return false;
    if (who.role === "master") return true; // explicit R2 administration exception
    if (who.role !== "player" || who.seat !== seat) return false;
    if (who.participant_id === `bootstrap:${seat}`) return true;
    const holder = this.currentHolder(seat);
    return holder !== null && holder.participant_id === who.participant_id &&
      holder.token_hash === who.token_hash;
  }

  /** Return a promoted-but-unredeemed queue row to 'waiting', FIFO place
   *  intact (its id is unchanged, so it stays ahead of later arrivals). */
  private revertQueuePromotionTx(id: number, seat: number | null, via: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE rotation_queue SET status = 'waiting', seat = NULL, participant_id = NULL, grant_nonce = NULL, promoted_at = NULL WHERE id = ?",
      id,
    );
    this.opsLog("queue_promotion_reverted", { queue_id: id, seat, via });
  }

  /**
   * Settle the rotation_queue row behind a seat claim that is ending
   * (leave / vacate / timeout rotation). An unredeemed promotion — the
   * provisional holder never polled queue-status, so no Player credential
   * was ever issued — returns to 'waiting'; a redeemed claim is closed as
   * 'left'. Callers invoke this AFTER promoteWaitingTx() so a reverted
   * row is not instantly re-promoted into the seat just vacated. (PR #2)
   */
  private settleQueueClaimTx(seat: number, participantId: string): void {
    const row = this.ctx.storage.sql.exec(
      "SELECT id, player_token_hash FROM rotation_queue WHERE status = 'promoted' AND seat = ? AND participant_id = ?",
      seat, participantId,
    ).toArray()[0];
    if (!row) return;
    const id = Number(row.id);
    if (row.player_token_hash === null) {
      this.revertQueuePromotionTx(id, seat, "settle");
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE rotation_queue SET status = 'left', left_at = ? WHERE id = ?", Date.now(), id,
      );
      this.opsLog("queue_claim_closed", { queue_id: id, seat });
    }
  }

  /** FIFO promotion, low-numbered open seat first. Never returns a token. */
  private promoteWaitingTx(): number {
    let promoted = 0;
    for (let seat = 0; seat < 4; seat++) {
      if (this.currentHolder(seat) !== null) continue;
      const row = this.ctx.storage.sql.exec(
        "SELECT id, queue_hash, display_name, icon FROM rotation_queue WHERE status = 'waiting' ORDER BY id LIMIT 1",
      ).toArray()[0];
      if (!row) break;
      const id = Number(row.id);
      const participant = crypto.randomUUID();
      const hash = String(row.queue_hash);
      const now = Date.now();
      // Reserve the seat without issuing a credential or storing any raw token.
      // The provisional holder hash is the queue's hash, which does NOT
      // authorize a Player request because credentials has no matching row.
      const salt = randomToken();
      this.ctx.storage.sql.exec(
        "INSERT INTO rotation_seat_holders (seat, participant_id, token_hash, assigned_at, source) VALUES (?, ?, ?, ?, 'queue')",
        seat, participant, hash, now,
      );
      // A freshly seated holder starts with a clean timeout streak and a
      // one-time grace extension on their first deadline (see commitGame).
      // Fill-in (bootstrap) play never sets this flag.
      this.metaSet(`timeout_streak:${seat}`, "0");
      this.metaSet(`rotation_grace:${seat}`, "1");
      this.metaSet(`proxy_active:${seat}`, "0");
      this.metaSet(`proxy_count:${seat}`, "0");
      this.ctx.storage.sql.exec(
        "UPDATE rotation_queue SET status = 'promoted', seat = ?, participant_id = ?, grant_nonce = ?, promoted_at = ? WHERE id = ? AND status = 'waiting'",
        seat, participant, salt, now, id,
      );
      this.opsLog("queue_promoted", { queue_id: id, seat, participant_id: participant });
      this.bumpOccupancyRevisionTx();
      promoted++;
    }
    return promoted;
  }

  private async queueSecret(request: Request): Promise<{ token: string; hash: string } | null> {
    const raw = request.headers.get("authorization") ?? request.headers.get("x-queue-token") ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    if (!QUEUE_TOKEN_RE.test(token)) return null;
    return { token, hash: await sha256Hex(token) };
  }

  private queueEntry(hash: string): QueueRow | null {
    const row = this.ctx.storage.sql.exec(
      "SELECT id, queue_hash, display_name, icon, status, seat, participant_id, grant_nonce, player_token_hash FROM rotation_queue WHERE queue_hash = ?",
      hash,
    ).toArray()[0];
    return row ? {
      id: Number(row.id), queue_hash: String(row.queue_hash),
      display_name: String(row.display_name),
      icon: row.icon === null ? null : String(row.icon),
      status: String(row.status), seat: row.seat === null ? null : Number(row.seat),
      participant_id: row.participant_id === null ? null : String(row.participant_id),
      grant_nonce: row.grant_nonce === null ? null : String(row.grant_nonce),
      player_token_hash: row.player_token_hash === null ? null : String(row.player_token_hash),
    } : null;
  }

  private queuePosition(id: number): number {
    const row = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM rotation_queue WHERE status = 'waiting' AND id <= ?", id,
    ).toArray()[0];
    return row ? Number(row.n) : 0;
  }

  private async handleQueue(request: Request): Promise<Response> {
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const bad = validateName(parsed.display_name, "display_name");
    if (bad) return json({ error: bad }, 400);
    if (parsed.icon !== undefined &&
        (typeof parsed.icon !== "string" || Array.from(parsed.icon).length > 12)) {
      return json({ error: "invalid icon" }, 400);
    }
    const name = String(parsed.display_name).trim();
    // An optional client-created 192-bit secret permits safe retry after a
    // disconnected POST. Callers must generate it cryptographically at random.
    if (parsed.queue_token !== undefined &&
        (typeof parsed.queue_token !== "string" || !QUEUE_TOKEN_RE.test(parsed.queue_token))) {
      return json({ error: "invalid queue_token" }, 400);
    }
    const token = typeof parsed.queue_token === "string" ? parsed.queue_token : randomToken();
    const hash = await sha256Hex(token);
    // If an authenticated Player already exists, do not let that identity join
    // the waiting queue. Anonymous clients are deduplicated by exact name.
    const principal = await this.authenticate(request);
    if (principal?.role === "player") return json({ error: "already player" }, 409);
    let status = 201;
    let data: JsonObject = {};
    this.ctx.storage.transactionSync(() => {
      const previous = this.queueEntry(hash);
      if (previous) {
        if (previous.display_name !== name || previous.status === "left") {
          status = 409; data = { error: "queue token conflict" }; return;
        }
        status = 200;
        data = { queue_token: token, status: previous.status, position:
          previous.status === "waiting" ? this.queuePosition(previous.id) : 0,
          seat: previous.seat, display_name: previous.display_name, reused: true };
        return;
      }
      const matchingCredential = this.ctx.storage.sql.exec(
        "SELECT 1 AS n FROM credentials WHERE token_hash = ? LIMIT 1", hash,
      ).toArray()[0];
      if (matchingCredential) {
        status = 409; data = { error: "queue token already assigned" }; return;
      }
      const sameName = this.ctx.storage.sql.exec(
        "SELECT 1 AS n FROM rotation_queue WHERE status = 'waiting' AND display_name = ? LIMIT 1", name,
      ).toArray()[0];
      const existingHolder = this.ctx.storage.sql.exec(
        "SELECT 1 AS n FROM rotation_seat_holders h JOIN credentials c " +
        "ON c.token_hash = h.token_hash WHERE c.display_name = ? LIMIT 1", name,
      ).toArray()[0];
      if (sameName || existingHolder) {
        status = 409; data = { error: "already in queue or holding seat" }; return;
      }
      const count = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM rotation_queue WHERE status = 'waiting'",
      ).toArray()[0];
      if (Number(count?.n ?? 0) >= MAX_QUEUE_SIZE) {
        status = 429; data = { error: "queue full" }; return;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO rotation_queue (queue_hash, display_name, icon, status, created_at) VALUES (?, ?, ?, 'waiting', ?)",
        hash, name, parsed.icon ?? null, Date.now(),
      );
      const id = Number(this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS id").toArray()[0].id);
      this.opsLog("queue_joined", { queue_id: id });
      this.bumpOccupancyRevisionTx();
      this.promoteWaitingTx();
      const row = this.queueEntry(hash)!;
      data = { queue_token: token, status: row.status, position:
        row.status === "waiting" ? this.queuePosition(id) : 0,
        seat: row.seat, display_name: name, reused: false };
    });
    return json(data, status);
  }

  private async handleQueueStatus(request: Request): Promise<Response> {
    const secret = await this.queueSecret(request);
    if (!secret) return json({ error: "queue authorization required" }, 401);
    const row = this.queueEntry(secret.hash);
    if (!row || row.status === "left") return json({ error: "queue token invalid" }, 401);
    if (row.status === "waiting") {
      return json({ status: "waiting", position: this.queuePosition(row.id),
        display_name: row.display_name });
    }
    if (row.status !== "promoted" || !isSeat(row.seat) || !row.participant_id || !row.grant_nonce) {
      return json({ error: "queue state invalid" }, 500);
    }
    // Only the bearer queue secret lets a claimant rederive this distinct
    // Player token. It is NOT returned from POST /queue or stored as plaintext.
    // Repeated GETs recover exactly the same Player token (lost responses safe).
    const playerToken = await sha256Hex(
      `muse-jansou-r2-player:${secret.token}:${row.grant_nonce}:${this.roomId ?? ""}`,
    );
    const playerHash = await sha256Hex(playerToken);
    let status = 200;
    let failure: JsonObject | null = null;
    let reverted = false;
    this.ctx.storage.transactionSync(() => {
      const fresh = this.queueEntry(secret.hash);
      const holder = this.currentHolder(row.seat!);
      if (!fresh || fresh.status !== "promoted" || !holder ||
          holder.participant_id !== row.participant_id ||
          (holder.token_hash !== secret.hash && holder.token_hash !== playerHash)) {
        // Legacy orphan: the claim ended before redemption and the row
        // was stranded in 'promoted' (see settleQueueClaimTx). If no
        // Player credential was ever issued for it, return it to
        // 'waiting' instead of 409-looping the owner forever. (PR #2)
        if (fresh && fresh.status === "promoted" && fresh.player_token_hash === null) {
          this.revertQueuePromotionTx(fresh.id, row.seat, "queue-status");
          reverted = true;
          return;
        }
        status = 409; failure = { error: "queue promotion no longer active" }; return;
      }
      if (holder.token_hash === secret.hash) {
        this.ctx.storage.sql.exec(
          "INSERT INTO credentials (token_hash, participant_id, role, seat, display_name, icon, created_at) VALUES (?, ?, 'player', ?, ?, ?, ?)",
          playerHash, row.participant_id, row.seat, row.display_name, row.icon, Date.now(),
        );
        this.ctx.storage.sql.exec(
          "UPDATE rotation_seat_holders SET token_hash = ? WHERE seat = ? AND participant_id = ?",
          playerHash, row.seat, row.participant_id,
        );
        this.ctx.storage.sql.exec(
          "UPDATE rotation_queue SET player_token_hash = ? WHERE id = ?", playerHash, row.id,
        );
        this.opsLog("queue_credential_issued", { queue_id: row.id, seat: row.seat });
        this.bumpOccupancyRevisionTx();
      }
    });
    if (reverted) {
      return json({ status: "waiting", position: this.queuePosition(row.id),
        display_name: row.display_name });
    }
    if (failure !== null) return json(failure, status);
    return json({ status: "promoted", role: "player", seat: row.seat,
      display_name: row.display_name, icon: row.icon ?? "", participant_id: row.participant_id,
      token: playerToken });
  }

  private async handleQueueLeave(request: Request): Promise<Response> {
    const secret = await this.queueSecret(request);
    if (!secret) return json({ error: "queue authorization required" }, 401);
    let status = 200;
    let data: JsonObject = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const row = this.queueEntry(secret.hash);
      if (!row || row.status === "left") {
        status = 401; data = { error: "queue token invalid" }; return;
      }
      if (row.status !== "waiting") {
        status = 409; data = { error: "already promoted; use leave" }; return;
      }
      this.ctx.storage.sql.exec(
        "UPDATE rotation_queue SET status = 'left', left_at = ? WHERE id = ?", Date.now(), row.id,
      );
      this.opsLog("queue_left", { queue_id: row.id });
      this.bumpOccupancyRevisionTx();
      data = { ok: true, left: true };
    });
    return json(data, status);
  }

  private async handleLeave(who: Principal): Promise<Response> {
    if (who.role !== "player" || who.seat === null ||
        who.participant_id.startsWith("bootstrap:")) {
      return json({ error: "only current non-bootstrap player may leave" }, 403);
    }
    let status = 200;
    let data: JsonObject = {};
    this.ctx.storage.transactionSync(() => {
      if (!this.canOperateSeat(who, who.seat!)) {
        status = 403; data = { error: "not current seat holder" }; return;
      }
      const seat = who.seat!;
      this.ctx.storage.sql.exec("UPDATE credentials SET enabled = 0 WHERE token_hash = ?", who.token_hash);
      this.ctx.storage.sql.exec("DELETE FROM leases WHERE seat = ?", seat);
      this.ctx.storage.sql.exec(
        "DELETE FROM rotation_seat_holders WHERE seat = ? AND token_hash = ?", seat, who.token_hash,
      );
      this.metaSet(`proxy_active:${seat}`, "0");
      this.metaSet(`proxy_count:${seat}`, "0");
      this.opsLog("player_left", { participant_id: who.participant_id, seat });
      this.bumpOccupancyRevisionTx();
      const promoted = this.promoteWaitingTx();
      this.settleQueueClaimTx(seat, who.participant_id);
      data = { ok: true, seat, open: this.currentHolder(seat) === null, promoted: promoted > 0 };
    });
    return json(data, status);
  }

  /** Master-initiated seat vacating (timeout rotation): same effects as
   *  /leave, but triggered by the room master for a stalled holder. */
  /**
   * Prompt-proxy reservation: a current holder declares that their own
   * prompt fill-in will play the seat (actions marked via:"prompt").
   * The reservation ends when the holder plays in person again; if the
   * fill-in reaches PROXY_MAX_PLAYS plays first, the seat rotates.
   */
  private async handleProxy(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "player" || who.seat === null ||
        who.participant_id.startsWith("bootstrap:")) {
      return json({ error: "only current non-bootstrap player may declare proxy" }, 403);
    }
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    if (typeof parsed.active !== "boolean") return json({ error: "active boolean required" }, 400);
    const seat = who.seat;
    let status = 200;
    let data: JsonObject = {};
    this.ctx.storage.transactionSync(() => {
      if (!this.canOperateSeat(who, seat)) {
        status = 403; data = { error: "not current seat holder" }; return;
      }
      this.metaSet(`proxy_active:${seat}`, parsed.active ? "1" : "0");
      this.metaSet(`proxy_count:${seat}`, "0");
      this.opsLog(parsed.active ? "proxy_declared" : "proxy_cleared", { participant_id: who.participant_id, seat });
      this.bumpOccupancyRevisionTx();
      data = { ok: true, seat, proxy_active: parsed.active, proxy_plays: 0, proxy_max_plays: PROXY_MAX_PLAYS };
    });
    return json(data, status);
  }


  /** Self-service profile update: a joined player or spectator may change
   * their own display_name / icon / avatar_url. The avatar_url is shown on
   * the watch page and later carries tiles on the presentation layer.
   * Bootstrap and master principals have no editable profile row. */
  private async handleProfile(request: Request, who: Principal): Promise<Response> {
    if ((who.role !== "player" && who.role !== "spectator") ||
        who.participant_id.startsWith("bootstrap:")) {
      return json({ error: "only joined participants may update their profile" }, 403);
    }
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const hasName = parsed.display_name !== undefined;
    const hasIcon = parsed.icon !== undefined;
    const hasAvatar = parsed.avatar_url !== undefined;
    if (!hasName && !hasIcon && !hasAvatar) return json({ error: "nothing to update" }, 400);
    if (hasName) {
      const nameError = validateName(parsed.display_name, "display_name");
      if (nameError) return json({ error: nameError }, 400);
    }
    if (hasIcon && parsed.icon !== null &&
        (typeof parsed.icon !== "string" || Array.from(parsed.icon).length > 12)) {
      return json({ error: "invalid icon" }, 400);
    }
    if (hasAvatar && !validateAvatarUrl(parsed.avatar_url)) {
      return json({ error: "invalid avatar_url" }, 400);
    }
    let status = 200;
    let data: JsonObject = {};
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec(
        "SELECT display_name, icon, avatar_url FROM credentials WHERE participant_id = ? AND enabled = 1",
        who.participant_id,
      ).toArray()[0];
      if (!row) { status = 404; data = { error: "profile not found" }; return; }
      const name = hasName ? String(parsed.display_name).trim() : String(row.display_name);
      const icon = hasIcon
        ? (parsed.icon === null ? null : String(parsed.icon))
        : (row.icon === null || row.icon === undefined ? null : String(row.icon));
      const avatar = hasAvatar
        ? (parsed.avatar_url === null ? null : String(parsed.avatar_url))
        : (row.avatar_url === null || row.avatar_url === undefined ? null : String(row.avatar_url));
      this.ctx.storage.sql.exec(
        "UPDATE credentials SET display_name = ?, icon = ?, avatar_url = ? WHERE participant_id = ?",
        name, icon, avatar, who.participant_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE rotation_queue SET display_name = ?, icon = ? WHERE participant_id = ? AND status = 'promoted'",
        name, icon, who.participant_id,
      );
      this.opsLog("profile_updated", { participant_id: who.participant_id });
      this.bumpOccupancyRevisionTx();
      data = { ok: true, display_name: name, icon, avatar_url: avatar };
    });
    return json(data, status);
  }

  private async handleVacate(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "master") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const seat = parsed.seat;
    if (typeof seat !== "number" || !Number.isInteger(seat) || seat < 0 || seat > 3) {
      return json({ error: "invalid seat" }, 400);
    }
    let data: JsonObject = {};
    this.ctx.storage.transactionSync(() => {
      const result = this.vacateSeatTx(seat);
      data = result.vacated
        ? { ok: true, seat, open: this.currentHolder(seat) === null, vacated: true, promoted: result.promoted > 0 }
        : { ok: true, seat, open: true, vacated: false };
    });
    return json(data, 200);
  }

  /**
   * Revoke the seat's holder and promote the queue head, if any.
   * Must be called inside a storage transaction. Shared by the master
   * vacate endpoint and the timeout-rotation path.
   */
  private vacateSeatTx(seat: number): { vacated: boolean; promoted: number } {
    const holder = this.currentHolder(seat);
    if (holder === null) return { vacated: false, promoted: 0 };
    this.ctx.storage.sql.exec("UPDATE credentials SET enabled = 0 WHERE token_hash = ?", holder.token_hash);
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE seat = ?", seat);
    this.ctx.storage.sql.exec("DELETE FROM rotation_seat_holders WHERE seat = ?", seat);
    this.metaSet(`timeout_streak:${seat}`, "0");
    this.metaSet(`proxy_active:${seat}`, "0");
    this.metaSet(`proxy_count:${seat}`, "0");
    this.opsLog("seat_vacated", { participant_id: holder.participant_id, seat });
    this.bumpOccupancyRevisionTx();
    const promoted = this.promoteWaitingTx();
    this.settleQueueClaimTx(seat, holder.participant_id);
    return { vacated: true, promoted };
  }

  /**
   * POST /rematch — start the next match in this room (a room otherwise
   * hosts exactly one match). Master or a current seat holder may call it,
   * only while the current match is finished. When the waiting queue is
   * non-empty, seats first rotate (match-end relay): bot seats yield first,
   * then the longest-held seats, one per waiting person; each vacated seat
   * is refilled from the queue by the usual FIFO promotion. Yielded players
   * lose their credential (as with leave) and may queue again at the tail.
   * Unredeemed promotions never block the start: the seat is covered by the
   * usual fill-in play until the holder redeems and takes over.
   */
  private async handleRematch(request: Request, who: Principal): Promise<Response> {
    if (this.game === null) return json({ error: "room not initialized" }, 404);
    if (who.role !== "master" && who.role !== "player") {
      return json({ error: "forbidden" }, 403);
    }
    if (who.role === "player") {
      // The current holder may call it; a registered player of a seat with
      // no holder (e.g. a bootstrap seat never claimed through rotation)
      // speaks for that seat as well.
      const holder = who.seat === null ? null : this.currentHolder(who.seat);
      const isHolder = holder !== null && holder.participant_id === who.participant_id;
      if (!isHolder && holder !== null) {
        return json({ error: "not a current seat holder" }, 403);
      }
      if (who.seat === null) return json({ error: "not a current seat holder" }, 403);
    }
    if (this.game.phase !== "finished") {
      return json({ error: "match in progress" }, 409);
    }
    const ruleset = this.game.ruleset;
    const seed = Math.floor(Math.random() * 1_000_000_000);
    const rotated: number[] = [];
    let promotedCount = 0;
    const nextBox: { game: Game | null } = { game: null };
    this.ctx.storage.transactionSync(() => {
      const waitingRow = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM rotation_queue WHERE status = 'waiting'",
      ).toArray()[0];
      const waiting = waitingRow ? Number(waitingRow.n) : 0;
      if (waiting > 0) {
        const holders = this.ctx.storage.sql.exec(
          "SELECT seat, source, assigned_at FROM rotation_seat_holders ORDER BY seat",
        ).toArray().map(r => ({ seat: Number(r.seat), source: String(r.source),
          assigned_at: Number(r.assigned_at) }));
        holders.sort((a, b) =>
          (a.source === "bot" ? 0 : 1) - (b.source === "bot" ? 0 : 1) ||
          a.assigned_at - b.assigned_at);
        for (const h of holders.slice(0, Math.min(waiting, holders.length))) {
          const r = this.vacateSeatTx(h.seat);
          if (r.vacated) { rotated.push(h.seat); promotedCount += r.promoted; }
        }
        if (rotated.length === 0) promotedCount += this.promoteWaitingTx();
      }
      nextBox.game = newGame(seed, ruleset);
      this.ctx.storage.sql.exec("DELETE FROM leases");
      this.metaSet("game", JSON.stringify(nextBox.game));
      this.appendEvent(nextBox.game, "rematch");
      this.bumpOccupancyRevisionTx();
      this.opsLog("rematch_started", { rotated_seats: rotated, promoted: promotedCount });
    });
    if (nextBox.game === null) return json({ error: "rematch failed" }, 500);
    this.game = nextBox.game;
    this.savedRevision = nextBox.game.revision;
    await this.syncAlarmSafely();
    return json({ ok: true, rotated_seats: rotated, promoted: promotedCount,
      phase: nextBox.game.phase });
  }

  private async handleWatchPassword(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "master") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const pw = parsed.password;
    if (typeof pw !== "string" || pw.length < 1 || pw.length > 64) {
      return json({ error: "invalid password" }, 400);
    }
    this.metaSet("watch_hash", await sha256Hex(pw));
    return json({ ok: true });
  }

  /**
   * Public enrollment totals (NOT online/presence counts).
   * Only enabled, non-bootstrap Players count as joined; the bootstrap
   * credentials created at room initialization are empty-seat placeholders.
   * No token hashes, IDs, role-specific decisions, or concealed tiles leave
   * this projection. The same result is returned to all viewer roles.
   */
  private occupancySummary(): JsonObject {
    type PublicPlayer = { display_name: string; icon: string | null; avatar_url: string | null };
    type SeatSummary = {
      seat: number;
      joined: boolean;
      in_match: boolean;
      display_name: string | null;
      icon: string | null;
      participant_count: number;
      participants: PublicPlayer[];
      avatar_url: string | null;
      open: boolean;
      proxy: boolean;
      proxy_plays: number;
    };
    type SpectatorGroup = { count: number; names: string[] };

    const seats: SeatSummary[] = Array.from({ length: 4 }, (_, seat) => ({
      seat, joined: false, in_match: false, display_name: null, icon: null,
      participant_count: 0, participants: [], avatar_url: null, open: this.currentHolder(seat) === null,
      proxy: this.metaGet(`proxy_active:${seat}`) === "1",
      proxy_plays: Number(this.metaGet(`proxy_count:${seat}`) ?? "0"),
    }));
    const bySeat: Array<SpectatorGroup & { seat: number }> =
      Array.from({ length: 4 }, (_, seat) => ({ seat, count: 0, names: [] }));
    const withoutSupport: SpectatorGroup = { count: 0, names: [] };
    let spectatorTotal = 0;

    const rows = this.ctx.storage.sql.exec(
      "SELECT participant_id, role, seat, display_name, icon, avatar_url FROM credentials " +
      "WHERE enabled = 1 AND role IN ('player', 'spectator') " +
      "ORDER BY created_at, participant_id",
    ).toArray();
    for (const row of rows) {
      const role = String(row.role);
      const seat = row.seat === null ? null : Number(row.seat);
      const name = String(row.display_name);
      const icon = row.icon === null || row.icon === undefined ? null : String(row.icon);
      const avatarUrl = row.avatar_url === null || row.avatar_url === undefined ? null : String(row.avatar_url);
      if (role === "player") {
        // A bootstrap credential is NEVER evidence that a Muse joined.
        if (String(row.participant_id).startsWith("bootstrap:") || !isSeat(seat)) continue;
        const item = seats[seat];
        item.participants.push({ display_name: name, icon, avatar_url: avatarUrl });
        item.participant_count += 1;
        if (!item.joined) {
          item.joined = true;
          item.display_name = name;
          item.icon = icon;
          item.avatar_url = avatarUrl;
        }
      } else if (role === "spectator") {
        spectatorTotal += 1;
        const group = isSeat(seat) ? bySeat[seat] : withoutSupport;
        group.count += 1;
        group.names.push(name);
      }
    }
    // A match that has actually begun (at least one discard, not finished)
    // occupies every seat: unjoined seats are being played by their
    // bootstrap holder (host or a fill-in), so they are not "empty".
    const g = this.game;
    const matchBegun = g !== null && g.phase !== "finished" &&
      g.discards.some((d) => d.length > 0);
    if (matchBegun) {
      for (const item of seats) if (!item.joined) item.in_match = true;
    }
    return {
      seats,
      queue: this.ctx.storage.sql.exec(
        "SELECT display_name FROM rotation_queue WHERE status = 'waiting' ORDER BY id",
      ).toArray().map(row => String(row.display_name)),
      spectators: {
        total: spectatorTotal,
        by_seat: bySeat,
        without_support: withoutSupport,
      },
    };
  }

  private expose(g: Game, who: Viewer): JsonObject {
    this.injectTime();
    // Keep the existing per-viewer allowlist; add only a separately constructed
    // public summary. This does not copy from the private Game object.
    const result = viewState(publicState(g), who, this.policy);
    result.occupancy = this.occupancySummary();
    result.ranking = this.rankingSummary();
    result.recent_results = this.recentMatchResults();
    return result;
  }

  /**
   * GET /rooms/:id/watch-events?tail=1 OR ?after=N.
   * Authentication is performed by fetch() (enabled token or watch password).
   * Every returned field is independently constructed from a fixed allowlist.
   * Only publicly discarded tiles plus categorical animation signals.
   * Never a private drawn tile, concealed hand, full snapshot or decision.
   */
  private async handleWatchEvents(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tail = url.searchParams.get("tail");
    if (tail !== null && (tail !== "1" || url.searchParams.has("after"))) {
      return json({ error: "invalid tail cursor" }, 400);
    }
    const after = tail === null ? parseCursor(url) : 0;
    if (after === null) return json({ error: "invalid after cursor" }, 400);
    const settled = this.settleNow("lazy_settle");
    await this.syncIfNeeded(settled);
    const bounds = this.ctx.storage.sql.exec(
      "SELECT MIN(seq) AS first_seq, MAX(seq) AS last_seq FROM events",
    ).toArray()[0];
    const earliest = bounds?.first_seq == null ? 0 : Number(bounds.first_seq);
    const serverLatest = bounds?.last_seq == null ? 0 : Number(bounds.last_seq);
    if (tail === "1") {
      return json({ events: [], latest_seq: serverLatest,
        server_latest_seq: serverLatest, has_more: false });
    }
    if (earliest > 1 && after < earliest - 1) {
      return json({ error: "EVENT_CURSOR_EXPIRED", snapshot_required: true,
        latest_seq: serverLatest }, 409);
    }
    const rows = this.ctx.storage.sql.exec(
      "SELECT seq, revision, watch_signals FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
      after, MAX_EVENTS_PAGE,
    ).toArray();
    const events = rows.map(row => ({
      seq: Number(row.seq), revision: Number(row.revision),
      signals: readWatchSignals(row.watch_signals),
    }));
    const cursor = events.length ? events[events.length - 1].seq : after;
    return json({ events, latest_seq: cursor,
      server_latest_seq: serverLatest, has_more: cursor < serverLatest });
  }

  private async handleEvents(request: Request, who: Principal): Promise<Response> {
    const after = parseCursor(new URL(request.url));
    if (after === null) return json({ error: "invalid after cursor" }, 400);
    const settled = this.settleNow("lazy_settle");
    await this.syncIfNeeded(settled);
    const first = this.ctx.storage.sql.exec("SELECT MIN(seq) AS n FROM events").toArray()[0];
    const latest = this.ctx.storage.sql.exec("SELECT MAX(seq) AS n FROM events").toArray()[0];
    const earliest = first?.n === null || first === undefined ? 0 : Number(first.n);
    const serverLatest = latest?.n === null || latest === undefined ? 0 : Number(latest.n);
    if (earliest > 1 && after < earliest - 1) {
      return json({ error: "EVENT_CURSOR_EXPIRED", snapshot_required: true, latest_seq: serverLatest }, 409);
    }
    const records = this.ctx.storage.sql.exec(
      "SELECT seq, revision, kind, snapshot FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, MAX_EVENTS_PAGE,
    ).toArray();
    const events = records.map(row => ({
      seq: Number(row.seq),
      revision: Number(row.revision),
      type: "state",
      cause: String(row.kind),
      state: viewState(JSON.parse(String(row.snapshot)) as unknown, who, this.policy),
    }));
    const cursor = events.length ? events[events.length - 1].seq : after;
    return json({ events, latest_seq: cursor, server_latest_seq: serverLatest, has_more: cursor < serverLatest });
  }

  /**
   * Public endpoint: GET /rooms/{roomId}/paipu[?match=<match_key>].
   * Exports one finished match as an NDJSON paipu file (see PAIPU.md):
   * a header line, one line per archived event (master-view snapshots,
   * untrimmed), and a footer line with the recorded results.
   *
   * The stored snapshots are full-information, so export is limited to
   * matches already recorded as finished in ranking_matches; a match in
   * progress is never exportable. Any enabled credential may download.
   *
   * With ?list=1 the endpoint instead returns a JSON index of recorded
   * finished matches (newest first, at most 50), so a reader can discover
   * match keys and pick one: { matches: [{ match_key, finished_at,
   * event_count, paipu_available, results }] }. event_count is 0 once the
   * archive has been pruned by the retention policy (paipu_available:
   * false). Ported from PR #3 (neon-joshu).
   */
  private async handlePaipu(request: Request, who: Principal): Promise<Response> {
    const params = new URL(request.url).searchParams;
    if (params.has("list")) {
      const matches = this.ctx.storage.sql.exec(
        "SELECT m.match_key AS match_key, m.finished_at AS finished_at, " +
        "(SELECT COUNT(*) FROM paipu_events p WHERE p.match_key = m.match_key) AS event_count " +
        "FROM ranking_matches m ORDER BY m.finished_at DESC, m.match_key DESC LIMIT 50",
      ).toArray().map(row => {
        const eventCount = Number(row.event_count);
        const results = this.ctx.storage.sql.exec(
          "SELECT display_name, score, rank FROM ranking_results WHERE match_key = ? ORDER BY rank, seat",
          String(row.match_key),
        ).toArray().map(r => ({
          display_name: String(r.display_name),
          score: Number(r.score),
          rank: Number(r.rank),
        }));
        return {
          match_key: String(row.match_key),
          finished_at: Number(row.finished_at),
          event_count: eventCount,
          paipu_available: eventCount > 0,
          results,
        };
      });
      return json({ matches });
    }
    const requested = params.get("match");
    let matchKey: string | null = null;
    if (requested !== null && requested.length > 0) {
      if (requested.length > 200) return json({ error: "invalid match key" }, 400);
      matchKey = requested;
    } else {
      const latest = this.ctx.storage.sql.exec(
        "SELECT match_key FROM ranking_matches ORDER BY finished_at DESC LIMIT 1",
      ).toArray()[0];
      if (latest === undefined) return json({ error: "no_finished_match" }, 404);
      matchKey = String(latest.match_key);
    }
    const matchRow = this.ctx.storage.sql.exec(
      "SELECT finished_at FROM ranking_matches WHERE match_key = ?", matchKey,
    ).toArray()[0];
    if (matchRow === undefined) {
      if (this.game !== null && this.rankingMatchKey(this.game) === matchKey) {
        return json({ error: "match_not_finished" }, 409);
      }
      return json({ error: "match_not_found" }, 404);
    }
    const rows = this.ctx.storage.sql.exec(
      "SELECT seq, revision, kind, snapshot FROM paipu_events WHERE match_key = ? ORDER BY seq",
      matchKey,
    ).toArray();
    if (rows.length === 0) return json({ error: "paipu_expired" }, 410);
    const results = this.ctx.storage.sql.exec(
      "SELECT seat, participant_id, display_name, icon, score, rank FROM ranking_results WHERE match_key = ? ORDER BY seat",
      matchKey,
    ).toArray().map(row => ({
      seat: Number(row.seat),
      participant_id: String(row.participant_id),
      display_name: String(row.display_name),
      icon: row.icon === null || row.icon === undefined ? null : String(row.icon),
      score: Number(row.score),
      rank: Number(row.rank),
    }));
    const first = rows[0];
    const lastRow = rows[rows.length - 1];
    const header = {
      type: "paipu_header",
      schema_version: 1,
      room_id: this.roomId,
      match_key: matchKey,
      exported_at: Date.now(),
      event_count: rows.length,
      first_seq: Number(first.seq),
      last_seq: Number(lastRow.seq),
      // The stream is complete when it starts with the match's init event.
      complete: String(first.kind) === "init",
      requested_by: who.role,
    };
    const footer = {
      type: "paipu_footer",
      match_key: matchKey,
      finished_at: Number(matchRow.finished_at),
      results,
    };
    const lines = [JSON.stringify(header)];
    for (const row of rows) {
      lines.push(JSON.stringify({
        type: "event",
        seq: Number(row.seq),
        revision: Number(row.revision),
        kind: String(row.kind),
        state: JSON.parse(String(row.snapshot)) as unknown,
      }));
    }
    lines.push(JSON.stringify(footer));
    const safeKey = matchKey.replace(/[^a-zA-Z0-9_-]+/g, "_");
    return new Response(lines.join("\n") + "\n", {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="paipu-${this.roomId ?? "room"}-${safeKey}.ndjson"`,
        "cache-control": "no-store",
      },
    });
  }

  /** Invite grant policy is centralized for future delegated inviter roles. */
  private canIssueInvites(who: Principal): boolean {
    return who.role === "master";
  }

  /** Stored moderation policy; lowering the threshold never unhides past cheers. */
  private cheerFlagThreshold(): number {
    const value = Number(this.metaGet("cheer_flag_threshold") ?? DEFAULT_CHEER_FLAG_THRESHOLD);
    return isInt(value) && value >= 1 && value <= MAX_CHEER_FLAG_THRESHOLD
      ? value : DEFAULT_CHEER_FLAG_THRESHOLD;
  }

  /**
   * Public endpoint: POST /rooms/{roomId}/cheer-settings (Room Master only).
   * The Worker forwards that room-scoped public path to DO-internal
   * POST /cheer-settings; the short path is NOT a public Worker endpoint.
   * Threshold defaults to 5 and changing it does not unhide past comments.
   */
  private async handleCheerSettings(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "master") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const value = parsed.flag_threshold ?? parsed.threshold;
    if (!isInt(value) || value < 1 || value > MAX_CHEER_FLAG_THRESHOLD) {
      return json({ error: "invalid flag_threshold" }, 400);
    }
    const idem = parsed.idempotency_key;
    if (idem !== undefined && (typeof idem !== "string" || !idem.length || idem.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
      return json({ error: "invalid idempotency_key" }, 400);
    }
    const key = typeof idem === "string" ? `cheer-settings:${idem}` : null;
    const hash = key === null ? null : await sha256Hex(canonicalJson({
      actor: who.participant_id, flag_threshold: value,
    }));
    if (key !== null) {
      const previous = this.findIdempotency(key);
      if (previous !== null) {
        if (previous.request_hash !== hash) return json({ error: "IDEMPOTENCY_CONFLICT" }, 409);
        return new Response(previous.result, {
          status: previous.status_code,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-idempotent-replay": "1" },
        });
      }
    }
    const result = { ok: true, flag_threshold: value };
    this.ctx.storage.transactionSync(() => {
      this.metaSet("cheer_flag_threshold", String(value));
      this.opsLog("cheer_flag_threshold_changed", { by: who.participant_id, flag_threshold: value });
      if (key !== null && hash !== null) {
        this.ctx.storage.sql.exec(
          "INSERT INTO idempotency (key, request_hash, result, status_code, created_at) VALUES (?, ?, ?, 200, ?)",
          key, hash, JSON.stringify(result), Date.now(),
        );
      }
    });
    return json(result);
  }

  /** Every Player/Spectator credential may cast one vote per known cheer ID. */
  private async handleFlagCheer(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "player" && who.role !== "spectator") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const seq = parsed.seq;
    if (!isInt(seq) || seq < 1) return json({ error: "invalid cheer seq" }, 400);
    const now = Date.now();
    let response: { ok: true; seq: number; flag_count: number; hidden: boolean; flagged_by_me: true; reused: boolean; flag_threshold: number } | null = null;
    this.ctx.storage.transactionSync(() => {
      const cheer = this.ctx.storage.sql.exec(
        "SELECT id, hidden FROM cheers WHERE id = ?", seq,
      ).toArray()[0];
      if (cheer === undefined) return;
      const previous = this.ctx.storage.sql.exec(
        "SELECT 1 AS yes FROM cheer_flags WHERE cheer_id = ? AND participant_id = ?", seq, who.participant_id,
      ).toArray()[0];
      const reused = previous !== undefined;
      if (!reused) {
        this.ctx.storage.sql.exec(
          "INSERT INTO cheer_flags (cheer_id, participant_id, created_at) VALUES (?, ?, ?)",
          seq, who.participant_id, now,
        );
      }
      const row = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM cheer_flags WHERE cheer_id = ?", seq,
      ).toArray()[0];
      const count = Number(row.n);
      const threshold = this.cheerFlagThreshold();
      let hidden = Number(cheer.hidden) === 1;
      if (!hidden && count >= threshold) {
        this.ctx.storage.sql.exec(
          "UPDATE cheers SET hidden = 1, hidden_at = ? WHERE id = ? AND hidden = 0", now, seq,
        );
        hidden = true;
        this.opsLog("cheer_hidden", { seq, flag_count: count, threshold });
      }
      if (!reused) {
        this.opsLog("cheer_flagged", { seq, participant_id: who.participant_id, flag_count: count });
      }
      response = { ok: true, seq, flag_count: count, hidden, flagged_by_me: true, reused, flag_threshold: threshold };
    });
    return response === null ? json({ error: "cheer not found" }, 404) : json(response);
  }

  private async handleInvites(request: Request, who: Principal): Promise<Response> {
    if (!this.canIssueInvites(who)) return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    if (parsed.role !== "player" && parsed.role !== "spectator") return json({ error: "invalid role" }, 400);
    const role = parsed.role;
    const seat = parsed.seat === undefined || parsed.seat === null ? null : parsed.seat;
    if (seat !== null && !isSeat(seat)) return json({ error: "invalid seat" }, 400);
    if (role === "player" && seat === null) return json({ error: "player seat required" }, 400);
    const lifetime = parsed.expires_in_seconds === undefined ? 86400 : parsed.expires_in_seconds;
    const maxUses = parsed.max_uses === undefined ? 1 : parsed.max_uses;
    if (!isInt(lifetime) || lifetime < 60 || lifetime > MAX_INVITE_LIFETIME_SEC ||
        !isInt(maxUses) || maxUses < 1 || maxUses > 100) {
      return json({ error: "invalid expiry or usage limit" }, 400);
    }
    const now = Date.now();
    const expires = now + lifetime * 1000;
    const code = randomToken();
    const codeHash = await sha256Hex(code);
    const roomId = this.roomId;
    if (!roomId) return json({ error: "room id unavailable" }, 500);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO invites (code_hash, room_id, role, seat, expires_at, max_uses, used_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
        codeHash, roomId, role, seat, expires, maxUses, now,
      );
      this.opsLog("invite_created", { role, seat, expires_at: expires, max_uses: maxUses });
    });
    return json({ invite_code: code, room_id: roomId, role, seat, expires_at: expires, max_uses: maxUses }, 201);
  }

  private async handleJoin(request: Request): Promise<Response> {
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    if (typeof parsed.invite_code !== "string" || !/^[0-9a-f]{48}$/.test(parsed.invite_code)) {
      return json({ error: "invalid invite code" }, 400);
    }
    const nameError = validateName(parsed.display_name, "display_name");
    if (nameError) return json({ error: nameError }, 400);
    if (parsed.icon !== undefined &&
        (typeof parsed.icon !== "string" || Array.from(parsed.icon).length > 12)) {
      return json({ error: "invalid icon" }, 400);
    }
    if (!validateAvatarUrl(parsed.avatar_url)) return json({ error: "invalid avatar_url" }, 400);
    const requestedSeat = parsed.support_seat === undefined || parsed.support_seat === null ? null : parsed.support_seat;
    if (requestedSeat !== null && !isSeat(requestedSeat)) return json({ error: "invalid support_seat" }, 400);
    const codeHash = await sha256Hex(parsed.invite_code);
    const token = randomToken();
    const hash = await sha256Hex(token);
    const pid = crypto.randomUUID();
    const now = Date.now();
    let joined: { role: "player" | "spectator"; seat: number | null } | null = null;
    let denied = "invite unavailable";
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec(
        "SELECT code_hash, room_id, role, seat, expires_at, max_uses, used_count FROM invites WHERE code_hash = ?", codeHash,
      ).toArray()[0];
      if (!row || String(row.room_id) !== this.roomId || Number(row.expires_at) <= now ||
          Number(row.used_count) >= Number(row.max_uses)) return;
      const role = row.role;
      if (role !== "player" && role !== "spectator") return;
      const assigned = row.seat === null ? null : Number(row.seat);
      if (role === "player" && !isSeat(assigned)) return;
      if (role === "player" && requestedSeat !== null) {
        denied = "support_seat only for spectator";
        return;
      }
      if (role === "spectator" && assigned !== null && requestedSeat !== null && requestedSeat !== assigned) {
        denied = "support seat fixed by invite";
        return;
      }
      const seat = role === "player" ? assigned : (assigned ?? requestedSeat);
      if (seat !== null && !isSeat(seat)) return;
      this.ctx.storage.sql.exec(
        "UPDATE invites SET used_count = used_count + 1 WHERE code_hash = ?", codeHash,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO credentials (token_hash, participant_id, role, seat, display_name, icon, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        hash, pid, role, seat, String(parsed.display_name).trim(), parsed.icon ?? null, parsed.avatar_url ?? null, now,
      );
      // Existing /join stays valid. An open seat is assigned immediately;
      // a second same-seat invite may register, but is not the current holder.
      if (role === "player" && isSeat(seat)) {
        this.promoteWaitingTx(); // FIFO has priority over a late direct invite.
        if (this.currentHolder(seat) === null) {
          this.ctx.storage.sql.exec(
            "INSERT INTO rotation_seat_holders (seat, participant_id, token_hash, assigned_at, source) VALUES (?, ?, ?, ?, ?)",
            seat, pid, hash, now, parsed.bot === true ? "bot" : "invite",
          );
          this.metaSet(`timeout_streak:${seat}`, "0");
          this.metaSet(`rotation_grace:${seat}`, "1");
          this.metaSet(`proxy_active:${seat}`, "0");
          this.metaSet(`proxy_count:${seat}`, "0");
        }
      }
      this.opsLog("participant_joined", { participant_id: pid, role, seat });
      this.bumpOccupancyRevisionTx();
      joined = { role, seat };
    });
    if (!joined) return json({ error: denied }, denied.startsWith("support") ? 403 : 409);
    const member = joined as { role: "player" | "spectator"; seat: number | null };
    return json({ participant_id: pid, role: member.role, seat: member.seat,
      support_seat: member.role === "spectator" ? member.seat : null, token }, 201);
  }

  private async handleCreateSpectator(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "master") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const err = validateName(parsed.display_name, "display_name");
    if (err) return json({ error: err }, 400);
    const seat = parsed.support_seat === undefined || parsed.support_seat === null ? null : parsed.support_seat;
    if (seat !== null && !isSeat(seat)) return json({ error: "invalid support_seat" }, 400);
    const token = randomToken();
    const hash = await sha256Hex(token);
    const pid = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO credentials (token_hash, participant_id, role, seat, display_name, created_at) VALUES (?, ?, 'spectator', ?, ?, ?)",
        hash, pid, seat, String(parsed.display_name).trim(), Date.now(),
      );
      this.opsLog("spectator_created", { participant_id: pid, support_seat: seat });
      this.bumpOccupancyRevisionTx();
    });
    return json({ participant_id: pid, role: "spectator", support_seat: seat, token }, 201);
  }

  private async handleChangeSupport(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "spectator") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const seat = parsed.support_seat === null ? null : parsed.support_seat;
    if (seat !== null && !isSeat(seat)) return json({ error: "invalid support_seat" }, 400);
    if (this.game?.phase !== "finished") return json({ error: "support seat locked during match" }, 409);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE credentials SET seat = ? WHERE participant_id = ?", seat, who.participant_id);
      this.opsLog("spectator_support_changed", { participant_id: who.participant_id, seat });
      if (who.seat !== seat) this.bumpOccupancyRevisionTx();
    });
    return json({ ok: true, support_seat: seat });
  }

  /** Phase-3b existing rooms: owner reissues bootstrap Player tokens after migration. */
  private async handleSeatTokens(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "master") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    if (parsed.seat !== undefined && !isSeat(parsed.seat)) return json({ error: "invalid seat" }, 400);
    if (parsed.rotate !== undefined && typeof parsed.rotate !== "boolean") return json({ error: "invalid rotate" }, 400);
    const seats = parsed.seat === undefined ? [0, 1, 2, 3] : [parsed.seat as number];
    const rotate = parsed.rotate === true;
    const tokens = seats.map(seat => ({ seat, token: randomToken() }));
    const hashes = await Promise.all(tokens.map(async t => ({ seat: t.seat, hash: await sha256Hex(t.token) })));
    let conflict = false;
    this.ctx.storage.transactionSync(() => {
      for (const t of hashes) {
        const pid = `bootstrap:${t.seat}`;
        const row = this.ctx.storage.sql.exec("SELECT token_hash FROM credentials WHERE participant_id = ?", pid).toArray()[0];
        if (row && !rotate) { conflict = true; return; }
      }
      for (const t of hashes) {
        const pid = `bootstrap:${t.seat}`;
        this.ctx.storage.sql.exec("DELETE FROM credentials WHERE participant_id = ?", pid);
        this.ctx.storage.sql.exec("DELETE FROM leases WHERE participant_id = ?", pid);
        this.ctx.storage.sql.exec(
          "INSERT INTO credentials (token_hash, participant_id, role, seat, display_name, created_at) VALUES (?, ?, 'player', ?, ?, ?)",
          t.hash, pid, t.seat, `Seat ${t.seat}`, Date.now(),
        );
      }
      this.opsLog("seat_tokens_issued", { seats, rotated: rotate });
    });
    if (conflict) return json({ error: "seat token exists; set rotate=true" }, 409);
    return json({ player_tokens: tokens }, 201);
  }

  private async handlePostCheer(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "spectator" || who.seat === null) return json({ error: "support seat required" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    if (typeof parsed.text !== "string" || !parsed.text.trim() ||
        Array.from(parsed.text.trim()).length > MAX_CHEER_LENGTH || /[\u0000-\u0008]/.test(parsed.text)) {
      return json({ error: "invalid cheer text" }, 400);
    }
    const cheerText = parsed.text.trim();
    const nonce = parsed.client_nonce === undefined ? null : parsed.client_nonce;
    if (nonce !== null && (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 100)) {
      return json({ error: "invalid client_nonce" }, 400);
    }
    const now = Date.now();
    let result: { seq: number; reused: boolean } | null = null;
    let limited = false;
    this.ctx.storage.transactionSync(() => {
      if (nonce !== null) {
        const old = this.ctx.storage.sql.exec(
          "SELECT id, body FROM cheers WHERE spectator_id = ? AND nonce = ?", who.participant_id, nonce,
        ).toArray()[0];
        if (old) {
          if (String(old.body) !== cheerText) { limited = true; return; }
          result = { seq: Number(old.id), reused: true };
          return;
        }
      }
      const latest = this.ctx.storage.sql.exec(
        "SELECT MAX(created_at) AS n FROM cheers WHERE spectator_id = ?", who.participant_id,
      ).toArray()[0];
      if (latest && latest.n !== null && now - Number(latest.n) < CHEER_INTERVAL_MS) {
        limited = true; return;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO cheers (spectator_id, target_seat, body, nonce, created_at) VALUES (?, ?, ?, ?, ?)",
        who.participant_id, who.seat, cheerText, nonce, now,
      );
      const inserted = this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS id").toArray()[0];
      result = { seq: Number(inserted.id), reused: false };
      this.opsLog("cheer_sent", { spectator_id: who.participant_id, seat: who.seat, seq: result.seq });
    });
    if (!result) return json({ error: limited ? "cheer rate limited or nonce conflict" : "cheer rejected" }, limited ? 429 : 409);
    const sent = result as { seq: number; reused: boolean };
    return json({ ok: true, seq: sent.seq, reused: sent.reused }, sent.reused ? 200 : 201);
  }

  /**
   * Deliver only visible private cheers. The cursor tracks SCANNED rows, not
   * displayed rows, so hidden messages never pin pagination in place.
   * Players read their own seat's cheers; Spectators read the cheers of the
   * seat they support (owner decision 2026-11-02, supersedes the Phase 4
   * 403 rule); Master can inspect every cheer, including hidden ones.
   */
  private async handleGetCheers(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "master" && who.role !== "player" && who.role !== "spectator") {
      return json({ error: "forbidden" }, 403);
    }
    if (who.role !== "master" && who.seat === null) return json({ error: "forbidden" }, 403);
    const after = parseCursor(new URL(request.url));
    if (after === null) return json({ error: "invalid after cursor" }, 400);
    const settled = this.settleNow("lazy_settle");
    await this.syncIfNeeded(settled);
    this.injectTime();
    if (who.role === "player" && this.policy.raw_mode && this.policy.defer_during_raw_decision &&
        currentDecisions(this.game!).some(d => d.seat === who.seat)) {
      return json({ comments: [], latest_seq: after, deferred: true, has_more: false });
    }

    const filter = who.role === "master" ? "" : "AND c.target_seat = ?";
    const params: Array<string | number> = [after];
    if (who.role !== "master") params.push(who.seat as number);
    const rows = this.ctx.storage.sql.exec(
      `SELECT c.id, c.body, c.created_at, c.target_seat, c.hidden, p.display_name,
        (SELECT COUNT(*) FROM cheer_flags f WHERE f.cheer_id = c.id) AS flag_count,
        EXISTS(SELECT 1 FROM cheer_flags f WHERE f.cheer_id = c.id AND f.participant_id = ?) AS flagged_by_me
        FROM cheers c JOIN credentials p ON p.participant_id = c.spectator_id
        WHERE c.id > ? ${filter} ORDER BY c.id LIMIT ?`,
      who.participant_id, ...params, MAX_EVENTS_PAGE,
    ).toArray();
    const comments = rows.filter(row => who.role === "master" || Number(row.hidden) !== 1)
      .map(row => ({
        seq: Number(row.id), text: String(row.body), from: String(row.display_name),
        created_at: Number(row.created_at), target_seat: Number(row.target_seat),
        flag_count: Number(row.flag_count), flagged_by_me: Number(row.flagged_by_me) === 1,
        ...(who.role === "master" ? { hidden: Number(row.hidden) === 1 } : {}),
      }));
    const cursor = rows.length ? Number(rows[rows.length - 1].id) : after;
    const nextParams: Array<string | number> = [cursor];
    if (who.role !== "master") nextParams.push(who.seat as number);
    const remaining = this.ctx.storage.sql.exec(
      `SELECT 1 AS yes FROM cheers c WHERE c.id > ? ${filter} LIMIT 1`, ...nextParams,
    ).toArray().length > 0;
    return json({ comments, latest_seq: cursor, has_more: remaining, deferred: false,
      flag_threshold: this.cheerFlagThreshold() });
  }

  // ---- Authentication, Phase 4 HTTP routing, initialization and game actions ----

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/init" && request.method === "POST") return await this.handleInit(request);
      if ((path === "/debug" || path === "/dev/advance-time") && !this.devMode) {
        return json({ error: "not found" }, 404);
      }
      // Only the high-entropy invitation code grants anonymous /join access.
      if (path === "/join" && request.method === "POST") {
        if (this.game === null) return json({ error: "room not initialized" }, 404);
        return await this.handleJoin(request);
      }
      // Phase R2 queue endpoints authenticate with the queue token itself.
      if (path === "/queue" || path === "/queue-status" || path === "/queue/leave") {
        if (this.game === null) return json({ error: "room not initialized" }, 404);
        if (path === "/queue" && request.method === "POST") return await this.handleQueue(request);
        if (path === "/queue-status" && request.method === "GET") return await this.handleQueueStatus(request);
        if (path === "/queue/leave" && request.method === "POST") return await this.handleQueueLeave(request);
        return json({ error: "not found" }, 404);
      }
      let principal = await this.authenticate(request);
      if (!principal && path === "/cheers" &&
          (request.method === "GET" || request.method === "POST")) {
        // Password-only watch guests (page or API) may read and post cheers
        // for a chosen support seat without a registered spectator token.
        principal = await this.watchCheerPrincipal(request);
      }
      if (!principal && (path === "/state" || path === "/watch-events") &&
          request.method === "GET") {
        // Human spectator page: a room watch password grants the outer
        // spectator view (all hands hidden) for state reads only.
        principal = await this.watchPrincipal(request);
      }
      if (!principal) return json({ error: "unauthorized" }, 401);
      if (this.game === null) return json({ error: "room not initialized" }, 404);
      // Existing DOs did not save room_id; the trusted Worker supplies it.
      const conveyedId = request.headers.get("x-janso-room-id");
      if (this.roomId === null && conveyedId && /^[a-zA-Z0-9_-]{1,128}$/.test(conveyedId)) {
        this.metaSet("room_id", conveyedId);
        this.roomId = conveyedId;
      }
      if (path === "/leave" && request.method === "POST") return await this.handleLeave(principal);
      if (path === "/vacate" && request.method === "POST") return await this.handleVacate(request, principal);
      if (path === "/rematch" && request.method === "POST") return await this.handleRematch(request, principal);
      if (path === "/proxy" && request.method === "POST") return await this.handleProxy(request, principal);
      if (path === "/profile" && request.method === "POST") return await this.handleProfile(request, principal);
      if (path === "/state" && request.method === "GET") return await this.handleState(principal);
      if (path === "/watch-digest" && request.method === "GET") return await this.handleWatchDigest(request, principal);
      if (path === "/hands/latest" && request.method === "GET") return await this.handleHandsLatest(principal);
      if (path === "/events" && request.method === "GET") return await this.handleEvents(request, principal);
      if (path === "/watch-events" && request.method === "GET") return await this.handleWatchEvents(request);
      if (path === "/paipu" && request.method === "GET") return await this.handlePaipu(request, principal);
      if (path === "/actions" && request.method === "POST") return await this.handleActions(request, principal);
      if (path === "/claim" && request.method === "POST") return await this.handleClaim(request, principal);
      if (path === "/invites" && request.method === "POST") return await this.handleInvites(request, principal);
      if (path === "/spectators" && request.method === "POST") return await this.handleCreateSpectator(request, principal);
      if (path === "/spectators/support" && request.method === "POST") return await this.handleChangeSupport(request, principal);
      if (path === "/seat-tokens" && request.method === "POST") return await this.handleSeatTokens(request, principal);
      if (path === "/watch-password" && request.method === "POST") return await this.handleWatchPassword(request, principal);
      if (path === "/watch-open" && request.method === "POST") return await this.handleWatchOpen(request, principal);
      if (path === "/cheers" && request.method === "POST") return await this.handlePostCheer(request, principal);
      if (path === "/cheers" && request.method === "GET") return await this.handleGetCheers(request, principal);
      if (path === "/cheers/flag" && request.method === "POST") return await this.handleFlagCheer(request, principal);
      // Worker public path: /rooms/{roomId}/cheer-settings.
      // Only its DO-internal suffix is checked here; /cheer-settings is not a public route.
      if (path === "/cheer-settings" && request.method === "POST") return await this.handleCheerSettings(request, principal);
      if (path === "/debug" && request.method === "GET") {
        return principal.role === "master" ? this.handleDebug() : json({ error: "forbidden" }, 403);
      }
      if (path === "/dev/advance-time" && request.method === "POST") {
        return principal.role === "master" ? await this.handleAdvanceTime(request) : json({ error: "forbidden" }, 403);
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      console.error("RoomDO request failed", safeError(error));
      return json(this.devMode ? { error: "internal", detail: safeError(error) } : { error: "internal" }, 500);
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    if (typeof parsed.room_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(parsed.room_id)) {
      return json({ error: "invalid room_id" }, 400);
    }
    if (typeof parsed.master_token_hash !== "string" || !/^[a-f0-9]{64}$/i.test(parsed.master_token_hash)) {
      return json({ error: "invalid master_token_hash" }, 400);
    }
    if (!Array.isArray(parsed.player_token_hashes) || parsed.player_token_hashes.length !== 4) {
      return json({ error: "four player token hashes required" }, 400);
    }
    const entries = parsed.player_token_hashes;
    const seats = new Set<number>();
    const hashes = new Set<string>();
    for (const entry of entries) {
      if (!isObject(entry) || !isSeat(entry.seat) ||
          typeof entry.token_hash !== "string" || !/^[a-f0-9]{64}$/i.test(entry.token_hash) ||
          seats.has(entry.seat) || hashes.has(entry.token_hash)) {
        return json({ error: "invalid player token hashes" }, 400);
      }
      seats.add(entry.seat);
      hashes.add(entry.token_hash);
    }
    if (parsed.seed !== undefined && parsed.seed !== null && !isInt(parsed.seed)) return json({ error: "invalid seed" }, 400);
    if (parsed.ruleset !== undefined && parsed.ruleset !== null && !isObject(parsed.ruleset)) return json({ error: "invalid ruleset" }, 400);
    if (parsed.player_visibility !== "seat_only" && parsed.player_visibility !== "all") {
      return json({ error: "invalid player_visibility" }, 400);
    }
    if (parsed.spectator_policy !== undefined && !isObject(parsed.spectator_policy)) {
      return json({ error: "invalid spectator_policy" }, 400);
    }
    if (parsed.time_offset_ms !== undefined && (!this.devMode || !isInt(parsed.time_offset_ms))) {
      return json({ error: "invalid time_offset_ms" }, 400);
    }
    if (this.game !== null || this.metaGet("game") !== null) return json({ error: "already initialized" }, 409);
    const body = parsed as unknown as InitBody;
    const nextOffset = this.devMode ? (body.time_offset_ms ?? 0) : 0;
    const settings = body.spectator_policy ?? {};
    const policy: RoomPolicy = {
      player_visibility: body.player_visibility,
      raw_mode: body.ruleset?.mode === "raw",
      defer_during_raw_decision: settings.defer_during_raw_decision !== false,
      watch_open_hands: body.watch_open_hands === true,
    };
    this.injectTime(nextOffset);
    const seed = body.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const nextGame = newGame(seed, body.ruleset ?? null);
    const snapshot = JSON.stringify(nextGame);
    this.ctx.storage.transactionSync(() => {
      if (this.metaGet("game") !== null || this.metaGet("room_id") !== null) {
        throw new Error("room already initialized in storage");
      }
      this.metaSet("room_id", body.room_id);
      this.metaSet("room_policy", JSON.stringify(policy));
      this.metaSet("occupancy_revision", "1");
      this.metaSet("time_offset_ms", String(nextOffset));
      this.metaSet("game", snapshot);
      const now = Date.now();
      this.ctx.storage.sql.exec(
        "INSERT INTO credentials (token_hash, participant_id, role, seat, display_name, created_at) VALUES (?, 'master', 'master', NULL, 'Master', ?)",
        body.master_token_hash, now,
      );
      for (const entry of body.player_token_hashes) {
        this.ctx.storage.sql.exec(
          "INSERT INTO credentials (token_hash, participant_id, role, seat, display_name, created_at) VALUES (?, ?, 'player', ?, ?, ?)",
          entry.token_hash, `bootstrap:${entry.seat}`, entry.seat, `Seat ${entry.seat}`, now,
        );
      }
      this.opsLog("init", { seed, player_visibility: policy.player_visibility });
      this.appendEvent(nextGame, "init", policy, nextOffset);
    });
    this.game = nextGame;
    this.roomId = body.room_id;
    this.policy = policy;
    this.timeOffsetMs = nextOffset;
    this.savedRevision = nextGame.revision;
    await this.syncAlarmSafely();
    return json({ ok: true, state: this.expose(nextGame, { role: "master", seat: null }) });
  }

  private async handleState(who: Principal): Promise<Response> {
    const settled = this.settleNow("lazy_settle");
    await this.syncIfNeeded(settled);
    return json(this.expose(this.game!, who));
  }

  /** Reaction uses the decision's base revision, not exact current revision. */
  private precheck(body: ActionRequest): string | null {
    const g = this.game!;
    if (!isSeat(body.seat)) return "invalid seat";
    if (g.phase === "finished") return "game already finished";
    if (body.decision_id !== g.decision_id) return "stale decision";
    const rev = body.expected_revision;
    if (!isInt(rev) || rev < g.decision_base_revision || rev > g.revision) return "STALE_POSITION";
    return null;
  }

  private async handleActions(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "player" && who.role !== "master") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const error = validateAction(parsed);
    if (error) return json({ error }, 400);
    if (!this.canOperateSeat(who, parsed.seat as number)) return json({ error: "not current seat holder" }, 403);
    const body = parsed as unknown as ActionRequest;
    const idemKey = body.idempotency_key ?? null;
    const hash = idemKey === null ? null : await hashActionRequest(parsed, who.participant_id);
    // Keep the Phase-3b order: auth => successful replay => independently
    // committed expired decision => precheck => scoped lease => engine action.
    if (idemKey !== null) {
      const previous = this.findIdempotency(idemKey);
      if (previous !== null) {
        if (previous.request_hash !== hash) return json({ error: "IDEMPOTENCY_CONFLICT" }, 409);
        return new Response(previous.result, {
          status: previous.status_code,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-idempotent-replay": "1" },
        });
      }
    }
    const settled = this.settleNow("lazy_settle");
    const pre = this.precheck(body);
    if (pre) {
      await this.syncIfNeeded(settled);
      return json({ error: pre }, statusForEngineError(pre));
    }
    const seat = body.seat as number;
    // Recheck after any asynchronous parsing/hash; revoked former holders
    // must never commit a new action or consume a successful retry.
    if (!this.canOperateSeat(who, seat)) return json({ error: "not current seat holder" }, 403);
    const decisionId = body.decision_id as string;
    const lease = this.currentLease(decisionId, seat);
    if (lease && (lease.participant_id !== who.participant_id || body.claim_token !== lease.claim_token)) {
      await this.syncIfNeeded(settled);
      return json({ error: "decision claimed" }, 409);
    }
    // Phase-3b compatibility: an unclaimed seat can still act without a token.
    if (!lease && body.claim_token !== undefined) {
      await this.syncIfNeeded(settled);
      return json({ error: "invalid claim token" }, 403);
    }
    this.injectTime();
    const next = structuredClone(this.game!);
    const result = applyAction(next, body);
    if (!("ok" in result)) {
      await this.syncIfNeeded(settled);
      return json(result, statusForEngineError(result.error));
    }
    this.commitGame(next, {
      logKind: "action",
      logPayload: { participant_id: who.participant_id, seat, action: body.action, decision_id: decisionId },
      action: { idemKey, requestHash: hash, response: result, statusCode: 200, consumedSeat: seat, decisionId },
    });
    // A voluntary action by the seat's current holder resets their timeout
    // streak. Bootstrap (fill-in) actions never reset it.
    if (who.role === "player" && this.currentHolder(seat)?.participant_id === who.participant_id) {
      this.ctx.storage.transactionSync(() => {
        this.metaSet(`timeout_streak:${seat}`, "0");
        // Prompt-proxy reservation: while declared, plays marked
        // via:"prompt" are the holder's own prompt fill-in playing. The
        // holder must return in person before PROXY_MAX_PLAYS such plays;
        // a personal (unmarked) action ends the reservation, and reaching
        // the cap rotates the seat to the queue.
        if (this.metaGet(`proxy_active:${seat}`) === "1") {
          this.bumpOccupancyRevisionTx();
          if (body.via === "prompt") {
            const plays = Number(this.metaGet(`proxy_count:${seat}`) ?? "0") + 1;
            this.metaSet(`proxy_count:${seat}`, String(plays));
            if (plays >= PROXY_MAX_PLAYS) {
              this.opsLog("seat_proxy_expired", { participant_id: who.participant_id, seat, plays });
              this.vacateSeatTx(seat);
            }
          } else {
            this.metaSet(`proxy_active:${seat}`, "0");
            this.metaSet(`proxy_count:${seat}`, "0");
            this.opsLog("proxy_returned", { participant_id: who.participant_id, seat });
          }
        }
      });
    }
    await this.syncIfNeeded(true);
    return json(result);
  }

  private async handleClaim(request: Request, who: Principal): Promise<Response> {
    if (who.role !== "player" && who.role !== "master") return json({ error: "forbidden" }, 403);
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    if (!isSeat(parsed.seat)) return json({ error: "invalid seat" }, 400);
    if (!this.canOperateSeat(who, parsed.seat)) return json({ error: "not current seat holder" }, 403);
    if (typeof parsed.decision_id !== "string" || !parsed.decision_id ||
        parsed.decision_id.length > MAX_DECISION_ID_LENGTH) {
      return json({ error: "invalid decision_id" }, 400);
    }
    const settled = this.settleNow("lazy_settle");
    const g = this.game!;
    if (g.phase === "finished") {
      await this.syncIfNeeded(settled);
      return json({ error: "game already finished" }, 409);
    }
    if (parsed.decision_id !== g.decision_id) {
      await this.syncIfNeeded(settled);
      return json({ error: "stale decision" }, 409);
    }
    const seat = parsed.seat;
    if (!currentDecisions(g).some(d => d.seat === seat)) {
      await this.syncIfNeeded(settled);
      return json({ error: "no pending decision for seat" }, 403);
    }
    const decisionId = parsed.decision_id;
    const existing = this.currentLease(decisionId, seat);
    if (existing) {
      await this.syncIfNeeded(settled);
      if (existing.participant_id !== who.participant_id) return json({ error: "decision claimed" }, 409);
      return json({ ...existing, reused: true });
    }
    const now = this.engineNow();
    let expiry = now + LEASE_TTL_MS;
    if (g.clock !== null) {
      const deadline = Object.entries(g.dec_deadlines as Record<string, unknown>)
        .filter(([key]) => Number(key) === seat)
        .map(([, value]) => isObject(value) ? value.deadline : null)
        .find((value): value is number => isInt(value));
      if (deadline !== undefined) expiry = Math.min(expiry, deadline);
    }
    if (expiry <= now) {
      await this.syncIfNeeded(settled);
      return json({ error: "decision deadline expired" }, 409);
    }
    const lease: Lease = {
      decision_id: decisionId,
      seat,
      participant_id: who.participant_id,
      claim_token: randomToken(),
      expires_at: expiry,
    };
    this.ctx.storage.transactionSync(() => {
      if (!this.canOperateSeat(who, seat)) {
        throw new Error("claim authorization changed during processing");
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO leases (decision_id, seat, claim_token, participant_id, expires_at) VALUES (?, ?, ?, ?, ?)",
        lease.decision_id, seat, lease.claim_token, lease.participant_id, lease.expires_at,
      );
      this.opsLog("claim", { participant_id: who.participant_id, seat, decision_id: decisionId });
    });
    await this.syncIfNeeded(settled);
    return json({ ...lease, reused: false });
  }

  /** Development-only: advance the engine clock without changing game semantics. */
  private async handleAdvanceTime(request: Request): Promise<Response> {
    const parsed = await readJsonObject(request);
    if (parsed instanceof Response) return parsed;
    const hasOffset = Object.prototype.hasOwnProperty.call(parsed, "offset_ms");
    const hasAdvance = Object.prototype.hasOwnProperty.call(parsed, "advance_ms");
    if (!hasOffset && !hasAdvance) return json({ error: "offset_ms or advance_ms required" }, 400);
    if ((hasOffset && !isInt(parsed.offset_ms)) ||
        (hasAdvance && !isInt(parsed.advance_ms))) {
      return json({ error: "invalid time offset" }, 400);
    }
    const candidate = hasOffset ? (parsed.offset_ms as number) :
      this.timeOffsetMs + (parsed.advance_ms as number);
    if (!isInt(candidate)) return json({ error: "invalid time offset" }, 400);

    const logBefore = this.game!.clock_log?.length ?? 0;
    const next = structuredClone(this.game!);
    this.injectTime(candidate);
    let changed: boolean;
    try {
      changed = settleExpired(next);
      this.ctx.storage.transactionSync(() => {
        this.metaSet("time_offset_ms", String(candidate));
        if (changed) {
          const snapshot = JSON.stringify(next);
          this.metaSet("game", snapshot);
          if (this.matchBegunForOccupancy(this.game) !== this.matchBegunForOccupancy(next)) {
            this.bumpOccupancyRevisionTx();
          }
          if (typeof next.decision_id === "string") {
            this.ctx.storage.sql.exec("DELETE FROM leases WHERE decision_id <> ?", next.decision_id);
          } else {
            this.ctx.storage.sql.exec("DELETE FROM leases");
          }
          this.opsLog("dev_time_settle", { revision: next.revision, decision_id: next.decision_id });
          this.appendEvent(next, "dev_time_settle", this.policy, candidate);
          if (this.game?.phase !== "finished" && next.phase === "finished") {
            this.recordFinishedMatchTx(next);
            this.logCompletionMetrics(new TextEncoder().encode(snapshot).byteLength);
          }
        }
      });
    } catch (e) {
      this.injectTime();
      throw e;
    }
    this.timeOffsetMs = candidate;
    if (changed) {
      this.game = next;
      this.savedRevision = next.revision;
      this.processTimeoutsTx(logBefore, next);
    }
    await this.syncAlarmSafely(); // Always required when real<->engine clock mapping changes.
    this.injectTime();
    return json({ time_offset_ms: this.timeOffsetMs, state: publicState(this.game!) });
  }

  /** Development-only; intentionally does not perform lazy timeout settlement. */
  private handleDebug(): Response {
    const g = this.game!;
    const leases = this.allCurrentLeases();
    const snapshot = JSON.stringify(g);
    return json({
      room_initialized: true,
      revision: g.revision,
      decision_id: g.decision_id,
      phase: g.phase,
      time_offset_ms: this.timeOffsetMs,
      alarm_count: this.alarmCount,
      alarm_set_count: this.alarmSetCount,
      last_alarm_at: this.lastAlarmAt,
      // Legacy alias for tests that only ever expected one lease.
      lease: leases.length === 1 ? leases[0] : null,
      leases,
      participants: this.ctx.storage.sql.exec("SELECT role, COUNT(*) AS c FROM credentials GROUP BY role").toArray(),
      event_count: Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM events").toArray()[0].c),
      invite_count: Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM invites").toArray()[0].c),
      cheer_count: Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM cheers").toArray()[0].c),
      cheer_flags: Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM cheer_flags").toArray()[0].c),
      hidden_cheers: Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM cheers WHERE hidden = 1").toArray()[0].c),
      cheer_flag_threshold: this.cheerFlagThreshold(),
      player_visibility: this.policy.player_visibility,
      idempotency_keys: this.countRows("idempotency"),
      ops: this.countRows("ops"),
      saved_revision: this.savedRevision,
      snapshot_bytes: new TextEncoder().encode(snapshot).byteLength,
      database_size_bytes: this.ctx.storage.sql.databaseSize,
      databaseSize: this.ctx.storage.sql.databaseSize,
      alarm_sync_failed: this.alarmSyncFailed,
    });
  }
}
