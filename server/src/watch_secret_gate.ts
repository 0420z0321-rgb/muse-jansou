/** Authenticate against existing room read endpoints. No new password or API. */
export type GateResult =
  | { status: "accepted" }
  | { status: "rejected" | "unavailable" | "cancelled" | "invalid_input" | "not_configured" };
export interface VerifyOptions {
  origin: string;
  roomIds: readonly string[];
  fetcher: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
/** Self-contained for the compiled inline client; never returns/prints the secret. */
export async function verifyWatchPassword(password: string, options: VerifyOptions): Promise<GateResult> {
  if (typeof password !== "string" || !password.trim() || password.length > 4096 || /[\u0000-\u001f\u007f]/.test(password))
    return { status: "invalid_input" };
  if (!Array.isArray(options.roomIds) || options.roomIds.length === 0 || options.roomIds.length > 8 ||
      options.roomIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))
    return { status: "not_configured" };
  let origin: URL;
  try { origin = new URL(options.origin); } catch { return { status: "not_configured" }; }
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.origin !== options.origin)
    return { status: "not_configured" };
  if (options.signal?.aborted) return { status: "cancelled" };
  const timeout = Math.min(15000, Math.max(50, options.timeoutMs ?? 8000));
  if (!Number.isFinite(timeout)) return { status: "not_configured" };
  const roomIds = [...new Set(options.roomIds)];
  const controller = new AbortController();
  return await new Promise<GateResult>((resolve) => {
    let remaining = roomIds.length, denied = 0, finished = false;
    const complete = (result: GateResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCancel);
      controller.abort();
      resolve(result);
    };
    const onCancel = () => complete({ status: "cancelled" });
    const timer = setTimeout(() => complete({ status: "unavailable" }), timeout);
    options.signal?.addEventListener("abort", onCancel, { once: true });
    if (options.signal?.aborted) { onCancel(); return; }
    for (const room of roomIds) {
      (async () => {
        try {
          const path = "/rooms/" + encodeURIComponent(room) + "/state";
          const response = await options.fetcher(new URL(path, origin).href, {
            method: "GET", headers: { "X-Watch-Password": password, Accept: "application/json" },
            credentials: "omit", mode: "same-origin", cache: "no-store", redirect: "error",
            referrerPolicy: "no-referrer", signal: controller.signal,
          } as RequestInit);
          if (finished) return;
          if (response.status === 401 || response.status === 403) { denied++; return; }
          if (response.status !== 200 || response.redirected) return;
          const ct = response.headers.get("Content-Type") ?? "";
          if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(ct)) return;
          const state: unknown = await response.json();
          if (!state || typeof state !== "object" || Array.isArray(state)) return;
          const data = state as Record<string, unknown>;
          // A generic {ok:true} page, HTML, or API error is not a successful state read.
          if (data.error !== undefined || typeof data.phase !== "string" || data.phase.length === 0) return;
          complete({ status: "accepted" });
        } catch {
          // Network failures/timeouts are not proof of an incorrect password.
        } finally {
          remaining--;
          if (!finished && remaining === 0) complete({ status: denied === roomIds.length ? "rejected" : "unavailable" });
        }
      })();
    }
  });
}
