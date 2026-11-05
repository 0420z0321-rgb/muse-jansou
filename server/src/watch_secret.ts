/**
 * Phase A: password storage only. Never grants a server role.
 * DOM-free, injected Storage interface; reused verbatim by the browser bundle.
 * The factory is self-contained because tools/generate_browser_bundle.mjs
 * serializes its compiled source AT BUILD TIME, not inside Workers. No eval/CDN.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface StorageAccess {
  local(): KeyValueStorage | null;
  session(): KeyValueStorage | null;
}
export type AuthMode = "pw" | "token";
export interface SecretRead {
  value: string;
  source: "local" | "session" | "none";
  migrated: boolean;
  persistent: boolean;
  warning: string | null;
}
export interface StorageWrite {
  ok: boolean;
  persistent: boolean;
  warning: string | null;
}

export function createWatchSecretStore(access: StorageAccess) {
  const KEY = "watchSecret";
  const TOKEN_KEY = "watchToken";
  const MODE_KEY = "watchMode";
  // Prevent an old tab's session password from being resurrected after logout.
  // Not a password, authentication bit, server token or additional credential.
  const MIGRATED_KEY = "muse.watchSecret.local.v1";
  const valid = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);
  function storage(kind: "local" | "session"): KeyValueStorage | null {
    try { return access[kind](); } catch { return null; }
  }
  function read(s: KeyValueStorage | null, key: string) {
    try { return { ok: s !== null, value: s?.getItem(key) ?? null }; }
    catch { return { ok: false, value: null }; }
  }
  function put(s: KeyValueStorage | null, key: string, value: string): boolean {
    if (!s) return false;
    try { s.setItem(key, value); return s.getItem(key) === value; }
    catch { return false; }
  }
  function remove(s: KeyValueStorage | null, key: string): boolean {
    if (!s) return false;
    try { s.removeItem(key); return s.getItem(key) === null; }
    catch { return false; }
  }
  function mode(): AuthMode {
    return read(storage("session"), MODE_KEY).value === "token" ? "token" : "pw";
  }
  /** Token never enters localStorage. Failure keeps the legacy session intact. */
  function migrateLegacyToken(): boolean {
    const s = storage("session");
    const m = read(s, MODE_KEY);
    if (!m.ok) return false;
    if (m.value !== "token") return true;
    const legacy = read(s, KEY);
    if (!legacy.ok) return false;
    if (!valid(legacy.value)) return true;
    const current = read(s, TOKEN_KEY);
    if (!current.ok) return false;
    if (!valid(current.value) && !put(s, TOKEN_KEY, legacy.value)) return false;
    return remove(s, KEY);
  }
  function getToken(): string {
    migrateLegacyToken();
    const s = storage("session");
    const token = read(s, TOKEN_KEY).value;
    if (valid(token)) return token;
    // A blocked write must not log the user out of their existing token session.
    const legacy = read(s, KEY).value;
    return mode() === "token" && valid(legacy) ? legacy : "";
  }
  function readPassword(): SecretRead {
    const l = storage("local"), s = storage("session");
    // Must happen before any caller switches the old token page back to pw mode.
    migrateLegacyToken();
    const local = read(l, KEY);
    if (valid(local.value)) {
      put(l, MIGRATED_KEY, "1");
      return { value: local.value, source: "local", migrated: false, persistent: true, warning: null };
    }
    if (read(l, MIGRATED_KEY).value === "1") {
      return { value: "", source: "none", migrated: false, persistent: false, warning: null };
    }
    // Unknown auth mode is not permission to reinterpret a token as a password.
    const m = read(s, MODE_KEY);
    if (!m.ok) return { value: "", source: "none", migrated: false, persistent: false, warning: "storage_unavailable" };
    const old = m.value === "token" ? { ok: true, value: null } : read(s, KEY);
    const veryOld = read(s, "watchPw");
    const value = valid(old.value) ? old.value : valid(veryOld.value) ? veryOld.value : "";
    if (!value) return { value: "", source: "none", migrated: false, persistent: false, warning: local.ok ? null : "storage_unavailable" };
    if (!put(l, KEY, value)) {
      return { value, source: "session", migrated: false, persistent: false, warning: "local_write_failed" };
    }
    put(l, MIGRATED_KEY, "1");
    // Delete old password copies only after a verified localStorage write.
    let clean = true;
    if (m.value !== "token") clean = remove(s, KEY) && clean;
    clean = remove(s, "watchPw") && clean;
    return { value, source: "local", migrated: true, persistent: true, warning: clean ? null : "legacy_cleanup_failed" };
  }
  /** Invoke only after existing server authentication has accepted the input. */
  function savePassword(value: string): StorageWrite {
    if (!valid(value) || !value.trim()) return { ok: false, persistent: false, warning: "invalid_input" };
    const l = storage("local"), s = storage("session");
    const tokenSafe = migrateLegacyToken();
    if (!put(l, KEY, value)) return { ok: false, persistent: false, warning: "local_write_failed" };
    put(l, MIGRATED_KEY, "1");
    const m = read(s, MODE_KEY);
    let clean = tokenSafe;
    if (m.ok && m.value !== "token") clean = remove(s, KEY) && clean;
    clean = remove(s, "watchPw") && clean;
    return { ok: true, persistent: true, warning: clean ? null : "legacy_cleanup_failed" };
  }
  /** Remove only the password, not tokens, preferences or chip JSON. */
  function clearPassword(expected?: string): StorageWrite {
    const l = storage("local"), s = storage("session");
    const current = read(l, KEY);
    if (!current.ok) return { ok: false, persistent: false, warning: "local_read_failed" };
    // A late 401 for A must never delete a newer password B from another tab.
    if (expected !== undefined && valid(current.value) && current.value !== expected)
      return { ok: false, persistent: true, warning: "newer_value_preserved" };
    // A deletion marker blocks migration from old, suspended tabs after logout.
    if (!put(l, MIGRATED_KEY, "1")) return { ok: false, persistent: false, warning: "local_write_failed" };
    if (!remove(l, KEY)) return { ok: false, persistent: false, warning: "local_remove_failed" };
    const m = read(s, MODE_KEY);
    let clean = true;
    if (m.ok && m.value !== "token") clean = remove(s, KEY) && clean;
    clean = remove(s, "watchPw") && clean;
    return { ok: true, persistent: false, warning: clean ? null : "legacy_cleanup_failed" };
  }
  function setMode(value: AuthMode): boolean {
    if (value !== "pw" && value !== "token") return false;
    const s = storage("session");
    if (value === "pw" && !migrateLegacyToken()) return false;
    if (value === "token") {
      // Preserve any legacy password before reinterpreting the old storage slot.
      const before = read(s, MODE_KEY);
      const legacy = read(s, KEY).value;
      if (before.value !== "token" && valid(legacy)) {
        const password = readPassword();
        if (!password.persistent || !remove(s, KEY)) return false;
      }
    }
    return put(s, MODE_KEY, value);
  }
  function saveToken(value: string): StorageWrite {
    if (!valid(value) || !value.trim()) return { ok: false, persistent: false, warning: "invalid_input" };
    const s = storage("session");
    if (!put(s, TOKEN_KEY, value)) return { ok: false, persistent: false, warning: "session_write_failed" };
    if (!setMode("token")) return { ok: false, persistent: false, warning: "mode_write_failed" };
    // If legacy mode was token, this now safely prefers the newly saved token.
    migrateLegacyToken();
    return { ok: true, persistent: false, warning: null };
  }
  function clearToken(): StorageWrite {
    const s = storage("session");
    const m = read(s, MODE_KEY);
    if (!m.ok) return { ok: false, persistent: false, warning: "session_read_failed" };
    let ok = remove(s, TOKEN_KEY);
    if (m.value === "token") ok = remove(s, KEY) && ok;
    return { ok, persistent: false, warning: ok ? null : "session_remove_failed" };
  }
  function getPassword(): string { return readPassword().value; }
  function getCredential(selectedMode?: AuthMode): string {
    return (selectedMode ?? mode()) === "token" ? getToken() : getPassword();
  }
  function getHeaders(selectedMode?: AuthMode): Record<string, string> {
    const m = selectedMode ?? mode();
    const value = getCredential(m);
    return m === "token" ? { Authorization: "Bearer " + value } : { "X-Watch-Password": value };
  }
  return Object.freeze({ readPassword, getPassword, savePassword, clearPassword, getToken, saveToken, clearToken, getCredential, getHeaders, getMode: mode, setMode });
}
