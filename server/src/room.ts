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
  const param = url.searchParams.get("after") ?? "0";
  if (!/^(0|[1-9]\d{0,14})$/.test(param)) return null;
  const after = Number(param);
  return Number.isSafeInteger(after) ? after : null;
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
    const snapshot = JSON.stringify(next);
    const snapshotBytes = new TextEncoder().encode(snapshot).byteLength;
    this.ctx.storage.transactionSync(() => {
      this.metaSet("game", snapshot);
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
    const next = structuredClone(this.game);
    const changed = settleExpired(next);
    if (!changed) return false;
    this.commitGame(next, {
      logKind: kind,
      logPayload: { revision: next.revision, decision_id: next.decision_id },
    });
    return true;
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


  /** Only public, allowlisted fields enter the event-history projection. */
  private appendEvent(next: Game, kind: string, policy: RoomPolicy = this.policy,
                      timeOffsetMs = this.timeOffsetMs): void {
    this.injectTime(timeOffsetMs);
    const raw: unknown = publicState(next);
    const archival = viewState(raw, { role: "master", seat: null }, policy);
    this.ctx.storage.sql.exec(
      "INSERT INTO events (revision, kind, snapshot, created_at) VALUES (?, ?, ?, ?)",
      next.revision, kind, JSON.stringify(archival), Date.now(),
    );
    const last = this.ctx.storage.sql.exec("SELECT MAX(seq) AS n FROM events").toArray()[0];
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
      this.ctx.storage.sql.exec(
        "UPDATE rotation_queue SET status = 'promoted', seat = ?, participant_id = ?, grant_nonce = ?, promoted_at = ? WHERE id = ? AND status = 'waiting'",
        seat, participant, salt, now, id,
      );
      this.opsLog("queue_promoted", { queue_id: id, seat, participant_id: participant });
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
      "SELECT id, queue_hash, display_name, icon, status, seat, participant_id, grant_nonce FROM rotation_queue WHERE queue_hash = ?",
      hash,
    ).toArray()[0];
    return row ? {
      id: Number(row.id), queue_hash: String(row.queue_hash),
      display_name: String(row.display_name),
      icon: row.icon === null ? null : String(row.icon),
      status: String(row.status), seat: row.seat === null ? null : Number(row.seat),
      participant_id: row.participant_id === null ? null : String(row.participant_id),
      grant_nonce: row.grant_nonce === null ? null : String(row.grant_nonce),
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
    this.ctx.storage.transactionSync(() => {
      const fresh = this.queueEntry(secret.hash);
      const holder = this.currentHolder(row.seat!);
      if (!fresh || fresh.status !== "promoted" || !holder ||
          holder.participant_id !== row.participant_id ||
          (holder.token_hash !== secret.hash && holder.token_hash !== playerHash)) {
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
      }
    });
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
      this.opsLog("player_left", { participant_id: who.participant_id, seat });
      const promoted = this.promoteWaitingTx();
      data = { ok: true, seat, open: this.currentHolder(seat) === null, promoted: promoted > 0 };
    });
    return json(data, status);
  }

  /** Master-initiated seat vacating (timeout rotation): same effects as
   *  /leave, but triggered by the room master for a stalled holder. */
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
      const holder = this.currentHolder(seat);
      if (holder === null) {
        data = { ok: true, seat, open: true, vacated: false };
        return;
      }
      this.ctx.storage.sql.exec("UPDATE credentials SET enabled = 0 WHERE token_hash = ?", holder.token_hash);
      this.ctx.storage.sql.exec("DELETE FROM leases WHERE seat = ?", seat);
      this.ctx.storage.sql.exec("DELETE FROM rotation_seat_holders WHERE seat = ?", seat);
      this.opsLog("seat_vacated", { participant_id: holder.participant_id, seat });
      const promoted = this.promoteWaitingTx();
      data = { ok: true, seat, open: this.currentHolder(seat) === null, vacated: true, promoted: promoted > 0 };
    });
    return json(data, 200);
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
    type PublicPlayer = { display_name: string; icon: string | null };
    type SeatSummary = {
      seat: number;
      joined: boolean;
      in_match: boolean;
      display_name: string | null;
      icon: string | null;
      participant_count: number;
      participants: PublicPlayer[];
      open: boolean;
    };
    type SpectatorGroup = { count: number; names: string[] };

    const seats: SeatSummary[] = Array.from({ length: 4 }, (_, seat) => ({
      seat, joined: false, in_match: false, display_name: null, icon: null,
      participant_count: 0, participants: [], open: this.currentHolder(seat) === null,
    }));
    const bySeat: Array<SpectatorGroup & { seat: number }> =
      Array.from({ length: 4 }, (_, seat) => ({ seat, count: 0, names: [] }));
    const withoutSupport: SpectatorGroup = { count: 0, names: [] };
    let spectatorTotal = 0;

    const rows = this.ctx.storage.sql.exec(
      "SELECT participant_id, role, seat, display_name, icon FROM credentials " +
      "WHERE enabled = 1 AND role IN ('player', 'spectator') " +
      "ORDER BY created_at, participant_id",
    ).toArray();
    for (const row of rows) {
      const role = String(row.role);
      const seat = row.seat === null ? null : Number(row.seat);
      const name = String(row.display_name);
      const icon = row.icon === null || row.icon === undefined ? null : String(row.icon);
      if (role === "player") {
        // A bootstrap credential is NEVER evidence that a Muse joined.
        if (String(row.participant_id).startsWith("bootstrap:") || !isSeat(seat)) continue;
        const item = seats[seat];
        item.participants.push({ display_name: name, icon });
        item.participant_count += 1;
        if (!item.joined) {
          item.joined = true;
          item.display_name = name;
          item.icon = icon;
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
            "INSERT INTO rotation_seat_holders (seat, participant_id, token_hash, assigned_at, source) VALUES (?, ?, ?, ?, 'invite')",
            seat, pid, hash, now,
          );
        }
      }
      this.opsLog("participant_joined", { participant_id: pid, role, seat });
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
      if (!principal && path === "/state" && request.method === "GET") {
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
      if (path === "/state" && request.method === "GET") return await this.handleState(principal);
      if (path === "/events" && request.method === "GET") return await this.handleEvents(request, principal);
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
          if (typeof next.decision_id === "string") {
            this.ctx.storage.sql.exec("DELETE FROM leases WHERE decision_id <> ?", next.decision_id);
          } else {
            this.ctx.storage.sql.exec("DELETE FROM leases");
          }
          this.opsLog("dev_time_settle", { revision: next.revision, decision_id: next.decision_id });
          this.appendEvent(next, "dev_time_settle");
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
