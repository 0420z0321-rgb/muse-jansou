import { watchSecretBrowserSource } from "./watch_secret_browser.ts";
import { COVER_CLIENT } from "./cover_client.ts";

export interface CoverOptions {
  /** Existing tables' room IDs. Copy/reuse the authoritative ROOMS, not a password. */
  probeRoomIds: readonly string[];
}
export const BUILDING_IMAGES = Object.freeze({
  jansou: "https://raw.githubusercontent.com/0420z0321-rgb/muse-jansou/main/assets/muse-jansou-building.webp",
  laboratory: "https://raw.githubusercontent.com/0420z0321-rgb/muse-jansou/main/assets/mecha-lab.webp",
});
export function validateCoverOptions(options: CoverOptions): string[] {
  if (!options || !Array.isArray(options.probeRoomIds) || options.probeRoomIds.length > 8 ||
      options.probeRoomIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))
    throw new Error("Cover requires 0–8 existing room IDs (letters, digits, underscore, hyphen).");
  return [...new Set(options.probeRoomIds)];
}
/** Render only. The supervisor installs GET /cover and decides whether / is assigned. */
export function renderCoverPage(options: CoverOptions, nonce: string): string {
  if (!/^[a-fA-F0-9]{32,64}$/.test(nonce)) throw new Error("Invalid CSP nonce.");
  const config = JSON.stringify({ probeRoomIds: validateCoverOptions(options) }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Muse雀荘｜表紙</title>
<style nonce="${nonce}">
:root{color-scheme:light;--paper:#f6f4ed;--ink:#243c32;--muted:#627166;--line:#cfd6c9;--green:#255b42;--cream:#fffef9;--gold:#8b671d}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans CJK JP",sans-serif;line-height:1.7}
a{color:var(--green)}button,input{font:inherit}button,a,input{touch-action:manipulation}
button{min-height:44px;border:1px solid var(--line);border-radius:6px;background:var(--cream);color:var(--ink);padding:8px 16px;cursor:pointer}
button:disabled{cursor:wait;opacity:.65}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #a67b21;outline-offset:4px}
.top{border-top:6px solid var(--green);border-bottom:1px solid var(--line);background:var(--cream)}
.top-inner{max-width:1060px;margin:auto;padding:13px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{font-size:18px;font-weight:700;letter-spacing:.06em}.brand small{font-weight:400;font-size:12px;color:var(--muted);margin-right:10px}
.back{font-size:14px;white-space:nowrap;text-decoration:underline;text-underline-offset:4px;min-height:44px;display:inline-flex;align-items:center}
main{max-width:1060px;margin:auto;padding:34px 24px 36px}
.eyebrow{margin:0 0 5px;font-size:12px;letter-spacing:.12em;color:var(--gold);font-weight:700}
h1{font-size:clamp(25px,4vw,35px);letter-spacing:.04em;line-height:1.4;margin:0 0 8px}
.lead{margin:0 0 24px;color:var(--muted);font-size:15px}
.gate,.saved{border:1px solid var(--line);border-radius:8px;background:var(--cream);padding:18px 20px;margin-bottom:24px}
.gate label{display:block;font-weight:700;margin-bottom:8px}.input-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
input{min-height:46px;border:1px solid #9aa99b;border-radius:5px;padding:8px 12px;flex:1;min-width:180px;max-width:420px;background:#fff}
.primary{background:var(--green);color:white;border-color:var(--green);font-weight:700}.small-note{font-size:12px;color:var(--muted);margin:9px 0 0}
#gate-message{font-size:14px;min-height:24px;color:#7a3b24;margin:8px 0 0;overflow-wrap:anywhere}
.saved{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:13px;padding-bottom:13px}.saved p{margin:0;font-size:14px}.saved-actions{display:flex;gap:8px;flex-shrink:0}.saved-actions button{font-size:12px;padding:6px 11px}
.section-label{display:flex;justify-content:space-between;gap:16px;align-items:baseline;margin:0 0 10px;font-size:13px;color:var(--muted)}.section-label h2{font-size:15px;color:var(--ink);margin:0}
.destinations{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}
.building{display:block;text-decoration:none;border:1px solid var(--line);border-radius:8px;background:var(--cream);overflow:hidden;color:inherit}
.building[aria-disabled=true]{cursor:default}.building:hover{border-color:var(--green)}
.picture{aspect-ratio:4/3;background:#e7ebdf;display:grid;place-items:center;border-bottom:1px solid var(--line);padding:16px}.picture.lab{background:#e9e7df}
.building-image{width:100%;height:100%;object-fit:contain}.image-fallback{text-align:center;color:var(--muted)}.image-fallback b{display:block;font-size:24px;letter-spacing:.1em;color:var(--ink)}.image-fallback small{font-size:12px}
.card-copy{padding:17px 22px 20px}.card-copy h3{font-size:23px;margin:0 0 5px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}.tag{font-size:11px;font-weight:400;letter-spacing:.04em;color:var(--muted)}
.card-copy p{font-size:14px;margin:0;color:var(--muted)}.enter{display:block;margin-top:16px;font-size:14px;color:var(--green);font-weight:700;text-decoration:underline;text-underline-offset:4px}
footer{margin-top:24px;padding-top:15px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:15px;flex-wrap:wrap}
.noscript{border:1px solid #b98954;padding:15px;background:#fff6e6}
@media(max-width:640px){.top-inner{padding:10px 16px}.brand small{display:none}main{padding:24px 16px}.destinations{grid-template-columns:1fr;gap:18px}.section-label{display:block}.section-label p{margin:4px 0 8px}.input-row{align-items:stretch;flex-direction:column}input{width:100%;max-width:none;min-width:0}.saved{align-items:flex-start;flex-direction:column}.picture{aspect-ratio:4/3}.saved-actions{flex-wrap:wrap}.gate{padding:16px}}
</style>
</head>
<body>
<header class="top"><div class="top-inner"><div class="brand"><small>MUSE JAN-SOU</small>Muse雀荘</div><a class="back" href="/cover">表紙へ戻る</a></div></header>
<main>
<p class="eyebrow">WELCOME TO MUSE</p><h1>対局のそばに、工房を。</h1><p class="lead">雀荘で一局を眺める。研究所で、牌の思考を組み立てる。</p>
<noscript><p class="noscript">合言葉の保存にはJavaScriptが必要です。有効にしてから開き直してください。</p></noscript>
<form class="gate" id="gate-form" method="post" novalidate>
<label for="watch-password">入口の合言葉</label>
<div class="input-row"><input id="watch-password" type="password" autocomplete="current-password" maxlength="4096" placeholder="合言葉を入力" aria-describedby="storage-note gate-message"><button class="primary" id="gate-submit" type="submit">合言葉を確認して保存</button><button id="cancel-change" type="button" hidden>変更をやめる</button></div>
<p class="small-note" id="storage-note">このブラウザに保存します。共用端末では、利用後に「保存を解除」を押してください。</p>
<p id="gate-message" role="status" aria-live="polite"></p>
</form>
<section class="saved" id="saved-box" aria-label="保存済みの合言葉" hidden><p id="saved-text" role="status"></p><div class="saved-actions"><button type="button" id="change-secret">合言葉を変更</button><button type="button" id="forget-secret">保存を解除</button></div></section>
<div class="section-label"><h2>行き先を選ぶ</h2><p id="destination-note">合言葉を保存すると、建物を選べます。</p></div>
<div class="destinations">
<a class="building" data-building="jansou" href="/t" aria-disabled="true" tabindex="-1">
<div class="picture"><img class="building-image" src="${BUILDING_IMAGES.jansou}" width="640" height="480" alt="Muse雀荘の建物" data-fallback="fallback-jansou" referrerpolicy="no-referrer"><span class="image-fallback" id="fallback-jansou" hidden><b>Muse雀荘</b><small>建物の画像を準備しています</small></span></div>
<div class="card-copy"><h3>雀荘<span class="tag">THE TABLES</span></h3><p>卓の様子を見て、対局と観戦の入口へ。</p><span class="enter">雀荘へ入る →</span></div></a>
<a class="building" data-building="lab" href="/lab" aria-disabled="true" tabindex="-1">
<div class="picture lab"><img class="building-image" src="${BUILDING_IMAGES.laboratory}" width="640" height="480" alt="牌チップ研究所の建物" data-fallback="fallback-lab" referrerpolicy="no-referrer"><span class="image-fallback" id="fallback-lab" hidden><b>牌チップ研究所</b><small>建物の画像を準備しています</small></span></div>
<div class="card-copy"><h3>研究所<span class="tag">THE WORKSHOP</span></h3><p>組立場と人の工房へ。牌チップの研究拠点です。</p><span class="enter">研究所へ入る →</span></div></a>
</div>
<footer><span>合言葉は同じ配信元のページで共有します。</span><span>Muse雀荘 · 牌チップ研究所</span></footer>
</main>
<script id="cover-config" type="application/json" nonce="${nonce}">${config}</script>
<script nonce="${nonce}">${watchSecretBrowserSource()}</script>
<script nonce="${nonce}">${COVER_CLIENT}</script>
</body></html>`;
}
/** Optional response helper; no routes or existing env/settings are replaced. */
export function coverResponse(options: CoverOptions): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return new Response(renderCoverPage(options, nonce), { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; img-src https://raw.githubusercontent.com; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}
