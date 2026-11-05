import { LAB_MENU, htmlEscape as esc, scriptJson, validateLabOptions, type LabOptions, type LabConfig } from './config.ts';
import { LAB_CLIENT } from './client.ts';
import { LAB_STYLE } from './styles.ts';
import { LAB_ASSETS } from './assets.generated.ts';
import { pageContent, PAGE_TITLES, type PageId } from './content.ts';
export function renderLabBPage(page: PageId, options: LabOptions, nonce: string): string {
 if(!Object.hasOwn(PAGE_TITLES,page))throw new Error('Unknown Phase B page.');
 if(!/^[a-f0-9]{32,64}$/.test(nonce))throw new Error('Invalid CSP nonce.');
 const c=validateLabOptions(options);
 const config={page,nonce,probeRoomIds:c.probeRoomIds,paths:c.paths,assets:LAB_ASSETS.map(({base64,...a})=>({...a,url:c.paths.assets+'/'+a.filename}))};
 return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${PAGE_TITLES[page]} | 牌チップ研究所</title><style nonce="${nonce}">${LAB_STYLE}</style></head><body>
<a class="skip" href="#lab-main">本文へ移動</a>
<header class="topbar"><a class="brand" href="/lab"><span class="brand-mark" aria-hidden="true">牌</span><span><strong>牌チップ研究所</strong><small>MUSE / PAI CHIP LABORATORY</small></span></a><div class="toplinks"><span class="auth-status" id="lab-auth-status" role="status" data-status="locked">合言葉を確認</span><a href="/lab">研究所の入口</a><a href="/cover">外に出る ↗</a></div></header>
<div class="shell" id="lab-shell"><aside class="rail"><span class="rail-label">WORKSHOP NAVIGATION</span><nav aria-label="研究所内のメニュー">${LAB_MENU.map((m,i)=>`<a href="${c.paths[m.id]}"${page===m.id?' aria-current="page"':''}><i>0${i+1}</i>${m.label}</a>`).join('')}</nav><div class="rail-note"><b>PHASE B / FOUNDATION</b>卓の実行系には未接続。<br>観測と推定を分けて、<br>判断の理由を組み立てます。</div></aside>
<main id="lab-main"><div class="breadcrumb"><a href="/lab">研究所</a><span aria-hidden="true">/</span><span>${PAGE_TITLES[page]}</span></div>
<section class="gate-wrap" id="lab-gate" aria-labelledby="gate-title"><p class="section-eyebrow">WORKSHOP ACCESS</p><h1 id="gate-title">作業場に入る</h1><p>表紙と同じ合言葉で入れます。保存済みなら自動で確認します。新しい合言葉や対局の資格は発行しません。</p><form id="lab-gate-form" novalidate><label for="lab-password">合言葉</label><div class="gate-input"><input id="lab-password" type="password" autocomplete="current-password" maxlength="4096" placeholder="表紙と同じ合言葉"><button class="button primary" id="lab-gate-submit" type="submit">確認して入る</button></div></form><p class="gate-message" id="lab-gate-message" aria-live="polite" role="status"></p><div class="actions"><button class="button flat" type="button" id="lab-gate-retry">保存済みの合言葉で再確認</button></div><p class="tiny">合言葉の保存・移行は本番のMuseWatchSecretが担当します。共用端末の解除は表紙から行ってください。</p></section>
<noscript><p>JavaScriptを有効にしてください。合言葉の確認とスタジオの実行に必要です。</p></noscript>
<div id="lab-content" hidden><p class="inline-status" id="lab-operation-status" role="status" aria-live="polite"></p><div id="lab-overview">${pageContent(page,c)}</div>
<section class="workbench" id="lab-workbench" aria-label="ローカルのチップ組立場" hidden><header class="workbench-bar"><div><strong>CHIP WORKBENCH / v0.3候補</strong><p>対局とは独立したローカル試験。閉じる前に「保存」で配置JSONを受け取ってください。</p></div><button id="lab-close-studio" class="button" type="button">スタジオを閉じる</button></header><div id="lab-frame-host"></div><div class="workbench-info">資格・対局状態はスタジオへ渡しません。自動保存と版管理はPhase D、受付はPhase Cです。</div></section>
<footer class="footer"><span>牌チップ研究所 / Muse雀荘</span><span>Phase B v1 · 入力・演算・分岐を、自分の手で。</span></footer></div></main></div>
<script type="application/json" id="lab-config" nonce="${nonce}">${scriptJson(config)}</script>
<script nonce="${nonce}">${c.watchSecretClientSource}</script><script nonce="${nonce}">${LAB_CLIENT}</script></body></html>`;
}
export function labBPageResponse(page: PageId, options: LabOptions): Response {
 const nonce=crypto.randomUUID().replace(/-/g,'');
 return new Response(renderLabBPage(page,options,nonce),{headers:{
  'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src data: blob:; frame-src 'self' about:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`,
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 }});
}
