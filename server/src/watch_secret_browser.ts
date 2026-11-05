import { WATCH_SECRET_CLIENT_SOURCE } from "./watch_secret_client.generated.ts";
/** Static string: safe under Wrangler/esbuild transforms; no runtime serialization. */
export function watchSecretBrowserSource(): string { return WATCH_SECRET_CLIENT_SOURCE; }
/** Insert before each page's application script. Use a nonce tag if its CSP needs one. */
export const WATCH_SECRET_SCRIPT = "<script>" + WATCH_SECRET_CLIENT_SOURCE + "</script>";
