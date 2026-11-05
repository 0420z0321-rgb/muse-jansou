/**
 * Muse雀荘 Phase 4 — HTTP entry, room bootstrap and DO forwarding.
 * MASTER_TOKEN is an optional global room-creation secret in DEV_MODE only;
 * production refuses room creation when MASTER_TOKEN is missing.
 * A freshly created room has ONE room-Master token and FOUR seat Player tokens.
 * Only token hashes cross the Worker -> DO boundary for initialization.
 */
import { RoomDO } from "./room.ts";
import { WATCH_HTML } from "./watch_page.ts";
import { PLAY_HTML } from "./player_page.ts";
import { TABLES_HTML } from "./tables_page.ts";
import { MEMBERS_HTML } from "./members_page.ts";
import { INVITE_HTML } from "./invite_page.ts";
import { coverResponse } from "./cover_page.ts";
import { LAB_HTML } from "./lab_page.ts";
import { handleLabBRequest } from "./lab_b/routes.ts";
import { watchSecretBrowserSource } from "./watch_secret_browser.ts";
import { handleHumanLabRequest } from "./lab_c/routes.ts";
import { enableHumanDeposit } from "./lab_c/desk.ts";
export { RoomDO };
export { HumanChipVault } from "./lab_c/durable_object.ts";

interface Env {
  ROOMS: DurableObjectNamespace<RoomDO>;
  HUMAN_CHIP_VAULT: DurableObjectNamespace;
  DEV_MODE?: string;
  MASTER_TOKEN?: string;
}
type JsonObject = Record<string, unknown>;
const MAX_CREATE_BYTES = 32 * 1024;
const MAX_FORWARD_BYTES = 64 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isSafeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}
async function readJsonObject(request: Request, maxBytes: number, allowEmpty = false): Promise<JsonObject | Response> {
  const len = request.headers.get("content-length");
  if (len !== null && (!Number.isFinite(Number(len)) || Number(len) > maxBytes)) {
    return json({ error: "request too large" }, 413);
  }
  let raw: string;
  try { raw = await request.text(); }
  catch { return json({ error: "invalid request body" }, 400); }
  if (new TextEncoder().encode(raw).byteLength > maxBytes) return json({ error: "request too large" }, 413);
  if (raw.trim() === "") return allowEmpty ? {} : json({ error: "invalid json" }, 400);
  try {
    const value: unknown = JSON.parse(raw);
    return isObject(value) ? value : json({ error: "json object required" }, 400);
  } catch { return json({ error: "invalid json" }, 400); }
}
async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}
function validCreate(body: JsonObject, dev: boolean): string | null {
  if (body.seed !== undefined && body.seed !== null && !isSafeInteger(body.seed)) return "invalid seed";
  if (body.ruleset !== undefined && body.ruleset !== null && !isObject(body.ruleset)) return "invalid ruleset";
  if (isObject(body.ruleset) && body.ruleset.clock !== undefined && !isObject(body.ruleset.clock)) {
    // A string like "sprint" would be silently read as a disabled clock by
    // the engine's lenient ruleset parser; reject it at the door instead.
    return "invalid ruleset.clock (object required)";
  }
  if (isObject(body.ruleset) && body.ruleset.allow_human_players !== undefined &&
      typeof body.ruleset.allow_human_players !== "boolean") {
    return "invalid ruleset.allow_human_players";
  }
  if (body.player_visibility !== undefined && body.player_visibility !== "seat_only" && body.player_visibility !== "all") {
    return "invalid player_visibility";
  }
  if (body.spectator_policy !== undefined) {
    if (!isObject(body.spectator_policy)) return "invalid spectator_policy";
    const p = body.spectator_policy;
    if (p.defer_during_raw_decision !== undefined && typeof p.defer_during_raw_decision !== "boolean") {
      return "invalid spectator_policy.defer_during_raw_decision";
    }
  }
  if (body.time_offset_ms !== undefined && (!dev || !isSafeInteger(body.time_offset_ms))) {
    return "time_offset_ms is development-only or invalid";
  }
  return null;
}

/** DO exposes no public /init route. All public paths are explicitly enumerated here. */
const METHODS: Record<string, "GET" | "POST" | "BOTH"> = {
  state: "GET",
  "watch-digest": "GET",
  "hands/latest": "GET",
  events: "GET",
  "watch-events": "GET",
  paipu: "GET",
  proxy: "POST",
  profile: "POST",
  members: "GET",
  actions: "POST",
  claim: "POST",
  invites: "POST",
  join: "POST",
  leave: "POST",
  vacate: "POST",
  rematch: "POST",
  queue: "POST",
  "queue-status": "GET",
  "queue/leave": "POST",
  spectators: "POST",
  "spectators/support": "POST",
  cheers: "BOTH",
  "cheers/flag": "POST",
  "cheer-settings": "POST",
  "seat-tokens": "POST",
  watch: "GET",
  play: "GET",
  "watch-password": "POST",
  "watch-open": "POST",
  debug: "GET",
  "dev/advance-time": "POST",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const dev = env.DEV_MODE === "1";
      if (path === "/" && request.method === "GET") {
        return json({ ok: true, service: "muse-jansou", phase: "4" });
      }
      if (path === "/invite" && request.method === "GET") {
        return new Response(INVITE_HTML, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
          },
        });
      }
      // Short links for chat-room posts: long file URLs trip the main
      // room's privacy filter (long_number). Targets are public.
      if (path === "/k" && request.method === "GET") {
        return Response.redirect("https://muse.ai/files/1360881390449688/1589437386321725/o0fxvr8egwh6lvz81wo8lok2/jansou-kit-v11.zip", 302);
      }
      if (path === "/s" && request.method === "GET") {
        return Response.redirect("https://muse.ai/files/1360881390449688/1641330841069541/1qwslg7f0kbevgzbfniuhyae/senbra-low-package.zip", 302);
      }
      if (path === "/w" && request.method === "GET") {
        return Response.redirect("https://muse-jansou.muse-jansou.workers.dev/rooms/c4c3d9be-ed74-458d-8956-11bd345c477c/watch", 302);
      }
      if (path === "/w2" && request.method === "GET") {
        return Response.redirect("https://muse-jansou.muse-jansou.workers.dev/rooms/06bf8829-4b64-4da6-b8f1-c6c8173ca4d0/watch", 302);
      }
      if (path === "/cover" && request.method === "GET") {
        return coverResponse({
          probeRoomIds: [
            "c4c3d9be-ed74-458d-8956-11bd345c477c",
            "06bf8829-4b64-4da6-b8f1-c6c8173ca4d0",
          ],
        });
      }
      if (path === "/lab" && request.method === "GET") {
        return new Response(LAB_HTML, {
          headers: { "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store" },
        });
      }
      // Phase C human chip vault API (/lab/api/human...). Auth adapters
      // connect the lab modules to the existing server-side credentials:
      // MASTER is the same secret room creation uses; the watchword is
      // verified against a fixed probe room's Durable Object (never a
      // caller-supplied room), exactly like the browser helper's check.
      const humanResponse = await handleHumanLabRequest(request, {
        namespace: {
          idFromName: (name: string) => env.HUMAN_CHIP_VAULT.idFromName(name),
          get: (id: unknown) => env.HUMAN_CHIP_VAULT.get(id as DurableObjectId),
        },
        verifyMaster: (req: Request) =>
          !!env.MASTER_TOKEN && req.headers.get("x-master-token") === env.MASTER_TOKEN,
        verifyWatch: async (req: Request) => {
          const pw = req.headers.get("x-watch-password") ?? "";
          if (!pw || pw.length > 64) return false;
          const probe = env.ROOMS.get(
            env.ROOMS.idFromName("c4c3d9be-ed74-458d-8956-11bd345c477c"),
          );
          const res = await probe.fetch("https://do/state", {
            headers: { "x-watch-password": pw, "x-janso-room-id": "c4c3d9be-ed74-458d-8956-11bd345c477c" },
          });
          return res.status === 200;
        },
      });
      if (humanResponse !== null) return humanResponse;
      // Phase B laboratory interior pages (/lab/assemble etc. and the
      // fixed distribution assets). Exact-match only; null falls through
      // to the existing routing below.
      const labInterior = handleLabBRequest(request, {
        probeRoomIds: [
          "c4c3d9be-ed74-458d-8956-11bd345c477c",
          "06bf8829-4b64-4da6-b8f1-c6c8173ca4d0",
        ],
        watchSecretClientSource: watchSecretBrowserSource(),
      });
      if (labInterior !== null) {
        // Phase C: the deposit window page gains the live reception form;
        // every other lab page is returned untouched.
        if (request.method === "GET" && path === "/lab/deposit") {
          return await enableHumanDeposit(labInterior);
        }
        return labInterior;
      }
      if ((path === "/t" || path === "/tables") && request.method === "GET") {
        return new Response(TABLES_HTML, {
          headers: { "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store" },
        });
      }
      if (path === "/members" && request.method === "GET") {
        return new Response(MEMBERS_HTML, {
          headers: { "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store" },
        });
      }
      if (path === "/rooms" && request.method === "POST") {
        if (!dev && !env.MASTER_TOKEN) return json({ error: "MASTER_TOKEN not configured" }, 503);
        if (env.MASTER_TOKEN && request.headers.get("x-master-token") !== env.MASTER_TOKEN) {
          return json({ error: "master authorization required" }, 403);
        }
        const body = await readJsonObject(request, MAX_CREATE_BYTES, true);
        if (body instanceof Response) return body;
        const err = validCreate(body, dev);
        if (err !== null) return json({ error: err }, 400);

        const roomId = crypto.randomUUID();
        const masterToken = randomToken();
        const playerTokens = Array.from({ length: 4 }, (_, seat) => ({ seat, token: randomToken() }));
        const hashes = await Promise.all(playerTokens.map(async x => ({
          seat: x.seat, token_hash: await sha256Hex(x.token),
        })));
        const initBody: JsonObject = {
          room_id: roomId,
          seed: body.seed ?? null,
          ruleset: body.ruleset ?? null,
          player_visibility: body.player_visibility ?? "seat_only",
          spectator_policy: body.spectator_policy ?? {},
          master_token_hash: await sha256Hex(masterToken),
          player_token_hashes: hashes,
        };
        if (dev) initBody.time_offset_ms = body.time_offset_ms ?? 0;
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        const res = await stub.fetch("https://do/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(initBody),
        });
        if (!res.ok) {
          console.error("room init failed", res.status);
          return json({ error: "room init failed" }, 502);
        }
        const init: unknown = await res.json();
        if (!isObject(init) || init.ok !== true) return json({ error: "invalid room init response" }, 502);
        return json({
          room_id: roomId,
          master_token: masterToken,
          player_tokens: playerTokens,
          state: init.state,
        }, 201);
      }

      const m = path.match(/^\/rooms\/([^/]+)\/(state|watch-digest|hands\/latest|leave|vacate|rematch|queue\/leave|queue-status|queue|events|watch-events|paipu|proxy|profile|members|actions|claim|invites|join|spectators\/support|spectators|cheers\/flag|cheer-settings|cheers|seat-tokens|watch-password|watch-open|watch|play|human-chip|debug|dev\/advance-time)$/);
      if (!m) return json({ error: "not found" }, 404);
      const roomId = m[1];
      const suffix = m[2];
      if (roomId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(roomId)) return json({ error: "invalid room id" }, 400);
      if ((suffix === "debug" || suffix === "dev/advance-time") && !dev) return json({ error: "not found" }, 404);
      if (suffix === "human-chip") {
        // The execution-connection binding endpoint: GET (own binding),
        // POST (bind a deposited version), DELETE (unbind). The owner key
        // travels only in the X-Lab-Owner-Key header, only on this suffix.
        if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
          return json({ error: "method not allowed" }, 405);
        }
      } else {
        const expected = METHODS[suffix];
        if (!expected || (expected !== "BOTH" && request.method !== expected) ||
            (expected === "BOTH" && request.method !== "GET" && request.method !== "POST")) {
          return json({ error: "method not allowed" }, 405);
        }
      }
      if (suffix === "watch") {
        // Static human spectator page; access is gated by the watch password
        // on the state endpoint, so the page itself needs no credential.
        return new Response(WATCH_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (suffix === "play") {
        // Static human player page; the seat credential (invite join or a
        // saved player token) gates every state/action call it makes, and
        // human joins are refused server-side unless the table's ruleset
        // opens human seats.
        return new Response(PLAY_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const headers = new Headers();
      const forwardNames = ["authorization", "content-type", "x-room-token", "x-watch-password", "x-queue-token", "x-watch-client", "x-watch-support", "x-watch-name"];
      if (suffix === "human-chip") forwardNames.push("x-lab-client", "x-lab-owner-key");
      for (const name of forwardNames) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      // This is generated by the trusted Worker, not copied from user headers.
      headers.set("x-janso-room-id", roomId);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const init: RequestInit = { method: request.method, headers };
      if (request.method === "POST") {
        const len = request.headers.get("content-length");
        if (len !== null && (!Number.isFinite(Number(len)) || Number(len) > MAX_FORWARD_BYTES)) {
          return json({ error: "request too large" }, 413);
        }
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_FORWARD_BYTES) return json({ error: "request too large" }, 413);
        init.body = raw;
      }
      const query = (suffix === "events" || suffix === "watch-events" || suffix === "cheers" || suffix === "watch-digest" || suffix === "paipu") ? url.search : "";
      return stub.fetch("https://do/" + suffix + query, init);
    } catch (error) {
      console.error("Worker request failed", error);
      return json({ error: "internal" }, 500);
    }
  },
};
