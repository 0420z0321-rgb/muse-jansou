// Spectator page for humans. Served at GET /rooms/{id}/watch.
// The page asks for the room's watch password and polls GET /rooms/{id}/state
// with the X-Watch-Password header. The server answers with the outer
// spectator view; hands stay hidden unless the host turns the room's
// watch_open_hands policy on, in which case password guests see every hand.
// Password guests may also pick a support seat and post cheer comments
// (guest identity = watch password + a per-browser client id). A registered
// spectator may instead open the page with their own spectator token
// (Authorization: Bearer); the server then returns that spectator's scoped
// view, in which only their support seat's hand is visible. The page simply
// renders whatever hands the state carries.
export const WATCH_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse雀荘 観戦</title>
<style>
  body { background:#12352a; color:#f2f2e9; font-family:sans-serif; margin:0; padding:12px; }
  h1 { font-size:18px; margin:4px 0 8px; }
  #meta { font-size:14px; opacity:.9; margin-bottom:10px; }
  #occupancy { background:#194b39; border:1px solid #418262; border-radius:9px; padding:9px 11px; margin:0 0 10px; }
  #ranking { background:#194b39; border:1px solid #e8b13c; border-radius:9px; padding:9px 11px; margin:0 0 10px; }
  .rank-title { font-size:14px; font-weight:bold; color:#f3cd72; margin-bottom:5px; }
  .rank-row { font-size:13px; padding:2px 0; overflow-wrap:anywhere; }
  .rank-recent { font-size:12px; opacity:.85; margin-top:5px; overflow-wrap:anywhere; }
  .occ-seats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; }
  .occ-seat { background:#23543f; border-radius:6px; padding:6px 7px; min-width:0; }
  .occ-label { display:block; font-size:11px; color:#d1e1d0; }
  .occ-name { display:block; font-size:13px; font-weight:bold; overflow-wrap:anywhere; }
  .occ-spectators { font-size:12px; margin-top:7px; color:#e7eedb; overflow-wrap:anywhere; }
  @media (max-width:560px) { .occ-seats { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  #gate { background:#1d4a3a; border:1px solid #3a7a5f; border-radius:8px; padding:16px; max-width:340px; margin:40px auto; text-align:center; }
  #gate input { font-size:16px; padding:8px; width:70%; border-radius:6px; border:none; }
  #gate select { font-size:14px; padding:8px; width:76%; border-radius:6px; border:none; margin-bottom:8px; }
  #gate .note { font-size:12px; opacity:.85; }
  .htiles.open .tile { outline:1px solid #c9a227; }
  .tile.aka { background:#fbe9e7; box-shadow:inset 0 0 0 2px #c0392b; }
  .seatnote { font-size:11px; color:#e8b13c; }
  #gate button { font-size:16px; padding:8px 14px; border-radius:6px; border:none; background:#e8b13c; color:#222; cursor:pointer; }
  #gate .err { color:#ff9a9a; min-height:20px; font-size:13px; }
  #table { display:none; }
  body { overflow-x:hidden; }
  #boardWrap { overflow:hidden; }
  #tableInner { width:700px; margin:0 auto; }
  #board { display:grid; grid-template-columns:auto 1fr auto; grid-template-rows:auto auto auto; gap:6px; flex:1; align-self:center; }
  #midRow { display:flex; gap:6px; align-items:stretch; }
  .feltcell { background:#143527; border:1px solid #2c5f4b; border-radius:8px; }
  #corecell { display:flex; align-items:center; justify-content:center; padding:4px; }
  .corebox { text-align:center; font-size:11px; width:100%; color:#f2f2e9; }
  .corebox .round { font-size:16px; font-weight:bold; }
  .corebox .sub { opacity:.9; font-size:11px; }
  .corebox .tile { width:19px; height:26px; }
  .core-mid { display:flex; align-items:center; justify-content:space-between; gap:2px; }
  .core-side { font-size:10px; opacity:.85; white-space:nowrap; }
  .core-side .sc { color:#ffd968; font-weight:bold; }
  .core-side.turn { opacity:1; }
  .core-side.turn .sc { text-decoration:underline; }
  .core-center { flex:1; }
  .handstrip { background:#1d4a3a; border:2px solid #2c5f4b; border-radius:8px; padding:6px 8px; display:flex; align-items:center; gap:8px; min-height:47px; margin:4px 0; }
  .handstrip.turn { border-color:#e8b13c; box-shadow:0 0 8px #e8b13c88; }
  .handstrip.v { flex-direction:column; width:51px; padding:8px 4px; margin:0; }
  .handstrip .chip { font-size:12px; font-weight:bold; white-space:nowrap; text-align:center; line-height:1.5; }
  .handstrip .chip .score { color:#ffd968; display:block; }
  .avatar { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:50%; background:#fdfdf6; border:2px solid #c8c8b8; font-size:16px; margin-right:5px; vertical-align:-8px; overflow:hidden; }
  .handstrip.turn .avatar { border-color:#e8b13c; box-shadow:0 0 9px #e8b13c; }
  .chip .pname { font-weight:normal; opacity:.92; margin-left:5px; }
  #danmaku { position:fixed; left:0; right:0; top:0; height:44%; pointer-events:none; overflow:hidden; z-index:40; }
  #animLayer { position:fixed; inset:0; pointer-events:none; overflow:hidden; z-index:41; }
  .animtile { position:absolute; width:30px; height:40px; transition:transform .5s ease, opacity .5s ease; will-change:transform,opacity; }
  .animtile.withcarrier { width:44px; height:78px; margin:-38px 0 0 -7px; text-align:center; }
  .animtile .carrier { display:block; width:40px; height:40px; object-fit:contain; margin:0 auto 2px; animation:carrierHop .26s ease-in-out infinite alternate; }
  @keyframes carrierHop { from { transform:translateY(0); } to { transform:translateY(-6px); } }
  .fxglow { animation:fxglowA .7s ease; }
  @keyframes fxglowA { 0% { box-shadow:0 0 0 0 rgba(255,217,104,0); } 30% { box-shadow:0 0 18px 6px rgba(255,217,104,.85); } 100% { box-shadow:0 0 0 0 rgba(255,217,104,0); } }
  .fxwin { animation:fxwinA .7s ease 2; }
  @keyframes fxwinA { 0% { box-shadow:0 0 0 0 rgba(255,120,160,0); } 30% { box-shadow:0 0 22px 9px rgba(255,120,160,.9); } 100% { box-shadow:0 0 0 0 rgba(255,120,160,0); } }
  .dm { position:absolute; left:100%; white-space:nowrap; font-weight:bold; font-size:21px; color:#fff; text-shadow:1px 1px 2px #000, -1px 0 2px #000, 0 0 6px rgba(0,0,0,.6); }
  .dm .dm-name { font-size:13px; opacity:.85; margin-right:7px; }
  .fxbar { text-align:center; margin:2px 0 4px; }
  .fxbar button { margin:0 3px; padding:5px 12px; border-radius:6px; border:1px solid #418262; background:#23543f; color:#f2f2e9; cursor:pointer; font-size:13px; }
  .fxbar button.sel { background:#e8b13c; color:#222; border-color:#e8b13c; font-weight:bold; }
  .fxbar button.gold { background:#e8b13c; color:#222; border-color:#e8b13c; font-weight:bold; }
  #membersOverlay { position:fixed; inset:0; background:rgba(4,18,12,.62); z-index:60; display:flex; justify-content:flex-end; }
  #membersPanel { background:#123524; color:#f2ead8; width:min(430px,94vw); height:100%; overflow-y:auto; box-shadow:-6px 0 18px rgba(0,0,0,.45); padding:14px 14px 22px; box-sizing:border-box; }
  .mp-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
  .mp-title { font-size:18px; font-weight:bold; color:#ffd968; }
  #membersClose { padding:6px 12px; border-radius:6px; border:1px solid #418262; background:#23543f; color:#f2f2e9; cursor:pointer; font-size:13px; }
  .mb-member { display:flex; gap:12px; background:#1a4630; border:1px solid #ffd96855; border-radius:14px; padding:12px 13px; margin:10px 0; }
  .mb-avatar { flex:0 0 auto; width:54px; height:54px; border-radius:50%; background:#0f2f1f; border:2px solid #ffd96888; display:flex; align-items:center; justify-content:center; font-size:26px; overflow:hidden; }
  .mb-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
  .mb-body { flex:1 1 auto; min-width:0; }
  .mb-name { font-size:16px; font-weight:bold; overflow-wrap:anywhere; }
  .mb-chip { display:inline-block; background:#0f2f1f; border:1px solid #ffffff2e; border-radius:999px; padding:1px 9px; font-size:12px; margin-left:7px; vertical-align:2px; font-weight:normal; }
  .mb-chip.seated { border-color:#ffd968; color:#ffd968; }
  .mb-rank { font-size:13px; opacity:.92; margin-top:2px; }
  .mb-bio { font-size:14px; line-height:1.65; margin-top:6px; white-space:pre-line; overflow-wrap:anywhere; }
  .mb-empty { opacity:.8; font-size:14px; padding:10px 2px; }
  .mb-foot { font-size:12.5px; opacity:.85; margin-top:12px; }
  .mb-foot a { color:#ffd968; }
  .avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; display:block; }
  .occ-avatar { width:22px; height:22px; border-radius:50%; object-fit:cover; vertical-align:-6px; margin-right:5px; }
  .htiles { display:flex; gap:2px; align-items:center; }
  .handstrip.v .htiles { flex-direction:column; gap:0; }
  .handstrip.top .tile { transform:rotate(180deg); }
  .handstrip.right .tile { transform:rotate(-90deg); }
  .handstrip.left .tile { transform:rotate(90deg); }
  .handstrip.v .tile { margin:-4px 0; }
  .handstrip .melds { margin:0 0 0 10px; }
  .handstrip.v .melds { margin:10px 0 0; }
  .tile.back { background:linear-gradient(180deg,#35709e,#2456a6); }
  .handstrip .score { color:#ffd968; }
  .riichi { background:#c0392b; color:#fff; border-radius:4px; padding:0 6px; font-size:12px; margin-left:6px; }
  .backs { font-size:12px; letter-spacing:1px; min-height:16px; }
  .melds { font-size:12px; margin:2px 0; overflow-wrap:anywhere; }
  .pondbox { background:#0e2a20; border:1px solid #2c5f4b; border-radius:8px; padding:5px; min-height:44px; display:flex; flex-direction:column; gap:2px; justify-content:flex-start; align-items:center; --rot:0deg; }
  .pondrow { display:flex; gap:2px; justify-content:center; }
  .pondcol { display:flex; flex-direction:column; gap:0; width:28px; align-items:center; }
  .pondcol .tile { margin:-3px 0; }
  .pondbox.pos-top { flex-direction:column-reverse; --rot:180deg; }
  .pondbox.pos-top .pondrow { flex-direction:row-reverse; }
  .pondbox.pos-right { flex-direction:row; --rot:-90deg; }
  .pondbox.pos-right .pondcol { flex-direction:column-reverse; }
  .pondbox.pos-left { flex-direction:row-reverse; --rot:90deg; }
  .pondbox .tile { transform:rotate(var(--rot)); }
  .pondbox .tile.ri { transform:rotate(calc(var(--rot) + 90deg)); }
  .pondbox.turn { border-color:#e8b13c; }
  .tile { display:inline-block; background:linear-gradient(180deg,#fffdf4,#f1ead3); border-radius:3.5px; box-shadow:0 2px 0 #b3a888, 0 3px 4px rgba(0,0,0,.35); padding:0; line-height:0; vertical-align:middle; }
  .tile svg { display:block; width:100%; height:100%; }
  .pondbox .tile { width:21px; height:28px; }
  .handstrip .tile { width:26px; height:35px; }
  #meta .tile { width:19px; height:26px; }
  .melds .tile { width:22px; height:30px; }
  .meldgroup { margin-right:6px; white-space:nowrap; }
  .tile.txt { color:#222; font-size:12px; line-height:1.4; padding:1px 4px; min-width:16px; text-align:center; }
  .tile.dim { filter:grayscale(.7); opacity:.5; }

  #center { text-align:center; font-size:15px; margin:10px 0; }
  #status { text-align:center; font-size:13px; opacity:.8; margin-top:8px; }
  button#refresh { display:block; margin:10px auto; padding:6px 16px; border-radius:6px; border:none; background:#3a7a5f; color:#fff; cursor:pointer; }
  #cheerPanel { background:#1d5c40; border:2px solid #e8b13c; border-radius:9px; padding:12px 14px; margin:10px 0; }
  .cheer-title { font-weight:bold; font-size:17px; margin-bottom:4px; }
  .cheer-lead { font-size:13px; margin-bottom:8px; }
  #supportRow button { margin:2px 4px 2px 0; padding:5px 10px; border-radius:6px; border:1px solid #418262; background:#23543f; color:#f2f2e9; cursor:pointer; }
  #supportRow button.sel { background:#e8b13c; color:#222; border-color:#e8b13c; font-weight:bold; }
  #cheerName { padding:6px; border-radius:6px; border:none; margin:6px 0; width:55%; font-size:14px; }
  #cheerList { max-height:190px; overflow-y:auto; font-size:13px; margin:6px 0; }
  .cheer-item { padding:3px 0; border-bottom:1px solid #2c5f4b; overflow-wrap:anywhere; }
  .cheer-time { opacity:.65; font-size:11px; margin-left:6px; }
  .cheer-form { display:flex; gap:6px; }
  #cheerText { flex:1; padding:7px; border-radius:6px; border:none; font-size:14px; }
  #cheerSend { padding:7px 14px; border-radius:6px; border:none; background:#e8b13c; color:#222; cursor:pointer; }
  #cheerMsg { font-size:12px; color:#ffd968; min-height:16px; margin-top:4px; }
  #cheerTab { position:fixed; right:12px; bottom:calc(16px + env(safe-area-inset-bottom, 0px)); z-index:45; padding:11px 16px; border-radius:999px; border:2px solid #b98a1e; background:#e8b13c; color:#222; font-weight:bold; font-size:14px; box-shadow:0 4px 14px rgba(0,0,0,.45); cursor:pointer; }
</style>
</head>
<body>
<div id="gate">
  <h1>🀄 Muse雀荘 観戦</h1>
  <select id="mode">
    <option value="pw">合言葉で観戦（外野）</option>
    <option value="token">観戦トークンで観戦（応援席の手牌が見えます）</option>
  </select>
  <p id="prompt">合言葉を入れてください</p>
  <input id="pw" type="password" autocomplete="off">
  <button id="go">観戦する</button>
  <p class="note">観戦トークンは、観戦登録した方ご本人のものです。他の人に渡さないでください。</p>
  <div class="err" id="err"></div>
</div>
<div id="table">
  <h1>🀄 Muse雀荘 観戦</h1>
  <div style="text-align:right;margin:-6px 0 6px"><a href="/members" style="color:#ffd968;font-size:13.5px">📖 選手名鑑</a>　<a href="/t" style="color:#ffd968;font-size:13.5px">🚪 入口</a></div>
  <div id="danmaku"></div>
  <div id="animLayer"></div>
  <div class="fxbar"><button id="dmToggle">💬 コメントを流す</button> <button id="seButton">🔊 音ON</button> <button id="membersBtn" class="gold">📖 選手名鑑</button></div>
  <div id="meta"></div>
  <div id="occupancy" aria-label="参加・観戦状況" aria-live="polite" style="display:none"></div>
  <div id="ranking" aria-label="ランキング" aria-live="polite" style="display:none"></div>
  <div id="boardWrap">
  <div id="tableInner">
    <div class="handstrip" id="hand-top"></div>
    <div id="midRow">
      <div class="handstrip v" id="hand-left"></div>
      <div id="board">
        <div class="feltcell"></div>
        <div class="pondbox" id="pond-top"></div>
        <div class="feltcell"></div>
        <div class="pondbox" id="pond-left"></div>
        <div class="feltcell" id="corecell"></div>
        <div class="pondbox" id="pond-right"></div>
        <div class="feltcell"></div>
        <div class="pondbox" id="pond-bottom"></div>
        <div class="feltcell"></div>
      </div>
      <div class="handstrip v" id="hand-right"></div>
    </div>
    <div class="handstrip" id="hand-bottom"></div>
  </div>
  </div>
  <div id="cheerPanel" style="display:none">
    <div class="cheer-title">📣 応援コメント（あなたも書けます）</div>
    <div class="cheer-lead">応援する席を選ぶと、その席への応援コメントが読めて、あなたも書き込めます。</div>
    <div id="supportRow"><span style="font-size:13px">応援席：</span></div>
    <div id="cheerList"></div>
    <div class="cheer-form">
      <input id="cheerText" placeholder="この席への応援を書く" maxlength="500">
      <button id="cheerSend">応援を送る</button>
    </div>
    <input id="cheerName" placeholder="名前（任意）" maxlength="20">
    <div id="cheerMsg"></div>
  </div>
  <button id="cheerTab" style="display:none">💬 応援を書く</button>
  <button id="refresh">更新</button>
  <div id="status"></div>
</div>
<div id="membersOverlay" style="display:none">
  <div id="membersPanel">
    <div class="mp-head"><span class="mp-title">📖 選手名鑑（この卓）</span><button id="membersClose">✕ 閉じる</button></div>
    <div id="membersList"><div class="mb-empty">読み込み中…</div></div>
    <div class="mb-foot">両卓まとめて見る → <a href="/members">選手名鑑ページ</a></div>
  </div>
</div>
<script>
var roomId = location.pathname.split("/")[2];
var NAMES = ["1m","2m","3m","4m","5m","6m","7m","8m","9m","1p","2p","3p","4p","5p","6p","7p","8p","9p","1s","2s","3s","4s","5s","6s","7s","8s","9s","東","南","西","北","白","發","中"];
function kindOfCode(n) { return n === 34 ? 4 : n === 35 ? 13 : n === 36 ? 22 : n; }
function tname(t) {
  if (t === null || t === undefined) return "?";
  if (typeof t === "number") return t >= 34 && t <= 36 ? "赤" + (NAMES[kindOfCode(t)] || "") : (NAMES[t] || ("#" + t));
  if (typeof t === "string") return t;
  if (typeof t === "object") {
    if (typeof t.name === "string") return t.name;
    return tname(t.tile);
  }
  return "?";
}
var KANJI_NUM = ["一","二","三","四","五","六","七","八","九"];
var HONOR_CH = ["東","南","西","北","白","發","中"];
var CB = "#2456a6", CG = "#1e8a4c", CR = "#c62f3b", IVORY = "#f7f2e2";
function circ(x, y, r, fill) { return '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + fill + '"/>'; }
function pinzuFace(n) {
  if (n === 1) {
    return circ(15, 20, 10.5, CG) + circ(15, 20, 8, IVORY) +
      '<circle cx="15" cy="20" r="6.2" fill="none" stroke="' + CR + '" stroke-width="2.2"/>' +
      circ(15, 20, 3.4, CB) + circ(15, 20, 1.3, IVORY);
  }
  var P = {
    2: [[15,10,CB],[15,30,CG]],
    3: [[9,9,CB],[15,20,CR],[21,31,CG]],
    4: [[9,10,CB],[21,10,CG],[9,30,CG],[21,30,CB]],
    5: [[9,10,CB],[21,10,CG],[15,20,CR],[9,30,CG],[21,30,CB]],
    6: [[10,8,CG],[20,8,CG],[10,20,CB],[20,20,CB],[10,32,CB],[20,32,CB]],
    7: [[8,7,CR],[11,17,CG],[20,17,CG],[11,24,CB],[20,24,CB],[11,31,CG],[20,31,CG]],
    8: [[9,6,CB],[21,6,CB],[9,15,CB],[21,15,CB],[9,25,CB],[21,25,CB],[9,34,CB],[21,34,CB]],
    9: [[7,9,CR],[15,9,CR],[23,9,CR],[7,20,CG],[15,20,CG],[23,20,CG],[7,31,CB],[15,31,CB],[23,31,CB]]
  };
  var r = n <= 3 ? 5 : n <= 5 ? 4.8 : n === 9 ? 4 : 3.6;
  return (P[n] || []).map(function(p) {
    return circ(p[0], p[1], r, p[2]) + circ(p[0], p[1], r * 0.42, IVORY);
  }).join("");
}
function stick(x, y, color, rot) {
  return '<g transform="translate(' + x + ' ' + y + ')' + (rot ? ' rotate(' + rot + ')' : '') + '">' +
    '<rect x="-2.6" y="-5.5" width="5.2" height="11" rx="2.4" fill="' + color + '"/>' +
    '<rect x="-2.6" y="-0.7" width="5.2" height="1.4" fill="' + IVORY + '" opacity="0.85"/></g>';
}
function souzuFace(n) {
  var G = CG, B = CB, R = CR;
  switch (n) {
    case 1: return stick(15,27,G) + stick(8,25,G,-20) + stick(22,25,G,20) + stick(11,23,B,-9) + stick(19,23,B,9) + stick(15,16,G) + circ(15,9,3.2,R);
    case 2: return stick(15,10,G) + stick(15,27,B);
    case 3: return stick(15,9,G) + stick(9,28,G) + stick(21,28,G);
    case 4: return stick(9,10,G) + stick(21,10,B) + stick(9,27,B) + stick(21,27,G);
    case 5: return stick(9,10,G) + stick(21,10,B) + stick(15,20,R) + stick(9,29,B) + stick(21,29,G);
    case 6: return stick(9,8,G) + stick(21,8,G) + stick(9,20,R) + stick(21,20,R) + stick(9,32,R) + stick(21,32,R);
    case 7: return stick(9,8,G) + stick(21,8,G) + stick(9,20,G) + stick(21,20,G) + stick(9,32,G) + stick(21,32,G) + stick(15,20,R);
    case 8: return stick(9,6,B) + stick(21,6,B) + stick(9,15,B) + stick(21,15,B) + stick(9,25,R) + stick(21,25,R) + stick(9,34,R) + stick(21,34,R);
    case 9: return stick(7,8,G) + stick(15,8,R) + stick(23,8,G) + stick(7,20,G) + stick(15,20,G) + stick(23,20,G) + stick(7,32,G) + stick(15,32,G) + stick(23,32,G);
  }
  return "";
}
function textFace(lines) {
  return lines.map(function(L) {
    return '<text x="15" y="' + L[1] + '" font-size="' + L[2] + '" fill="' + L[3] +
      '" text-anchor="middle" font-weight="700" font-family="Hiragino Mincho ProN, YuMincho, Yu Mincho, serif">' + L[0] + "</text>";
  }).join("");
}
function faceSVG(n) {
  if (n < 9) return textFace([[KANJI_NUM[n], 15, 12.5, "#20304a"], ["萬", 33, 16, CR]]);
  if (n < 18) return pinzuFace(n - 8);
  if (n < 27) return souzuFace(n - 17);
  var h = n - 27;
  if (h === 4) return '<rect x="6.5" y="7" width="17" height="26" fill="none" stroke="' + CB + '" stroke-width="2"/>';
  var fills = ["#1c1c1c", "#1c1c1c", "#1c1c1c", "#1c1c1c", "#1c1c1c", CG, CR];
  return textFace([[HONOR_CH[h], 28, 19, fills[h]]]);
}
function tileSpan(t, cls) {
  var n = (typeof t === "object" && t) ? t.tile : t;
  if (typeof n !== "number" || n < 0 || n > 36) {
    return '<span class="tile txt' + (cls ? " " + cls : "") + '">' + tname(t) + "</span>";
  }
  var aka = n >= 34 ? " aka" : "";
  return '<span class="tile' + aka + (cls ? " " + cls : "") + '"><svg viewBox="0 0 30 40" aria-label="' + tname(t) + '">' + faceSVG(kindOfCode(n)) + "</svg></span>";
}
function windName(seat, dealer) {
  return ["東家","南家","西家","北家"][(seat - dealer + 4) % 4];
}
function riichiOn(st, seat) {
  var r = st.riichi && st.riichi[seat];
  if (r === true || r === 1) return true;
  if (r && typeof r === "object") return !!(r.declared || r.enabled);
  if (Array.isArray(st.riichi_flags)) return !!st.riichi_flags[seat];
  return false;
}
function renderOccupancy(st) {
  var host = document.getElementById("occupancy");
  var occ = st && st.occupancy;
  if (!occ || !Array.isArray(occ.seats) || occ.seats.length !== 4 || !occ.spectators) {
    host.style.display = "none";
    host.textContent = "";
    return;
  }
  host.style.display = "block";
  // Use textContent and DOM nodes, never interpolate participant-supplied names
  // or icons into HTML. The server's occupancy contains no private game state.
  host.textContent = "";
  var row = document.createElement("div");
  row.className = "occ-seats";
  var seats = ["東席", "南席", "西席", "北席"];
  for (var i = 0; i < 4; i++) {
    var item = occ.seats[i] || {};
    var cell = document.createElement("div");
    cell.className = "occ-seat";
    var label = document.createElement("span");
    label.className = "occ-label";
    label.textContent = seats[i];
    var value = document.createElement("span");
    value.className = "occ-name";
    if (!item.joined && item.in_match && item.open) {
      value.textContent = "対局中・席は空き";
    } else if (!item.joined && item.in_match) {
      value.textContent = "対局中";
    } else if (!item.joined) {
      value.textContent = "空席";
    } else {
      var icon = typeof item.icon === "string" && item.icon ? item.icon + " " : "";
      var name = typeof item.display_name === "string" && item.display_name ? item.display_name : "参加者";
      var others = typeof item.participant_count === "number" && item.participant_count > 1 ?
        " ほか" + (item.participant_count - 1) + "名" : "";
      value.textContent = icon + name + others;
      if (Array.isArray(item.participants)) {
        cell.title = item.participants.map(function(p) { return p && p.display_name || ""; }).filter(Boolean).join("、");
      }
    }
    cell.appendChild(label);
    cell.appendChild(value);
    if (typeof item.avatar_url === "string" && item.avatar_url.indexOf("https://") === 0) {
      var avImg = document.createElement("img");
      avImg.className = "occ-avatar"; avImg.src = item.avatar_url; avImg.alt = "";
      cell.insertBefore(avImg, value);
    }
    row.appendChild(cell);
  }
  host.appendChild(row);
  var spectators = occ.spectators;
  var bySeat = Array.isArray(spectators.by_seat) ? spectators.by_seat : [];
  var parts = [];
  for (var j = 0; j < 4; j++) {
    var entry = bySeat[j] || {};
    parts.push(["東", "南", "西", "北"][j] + ":" + (typeof entry.count === "number" ? entry.count : 0));
  }
  var outside = spectators.without_support || {};
  parts.push("外野:" + (typeof outside.count === "number" ? outside.count : 0));
  var foot = document.createElement("div");
  foot.className = "occ-spectators";
  foot.textContent = "観戦登録 合計" + (typeof spectators.total === "number" ? spectators.total : 0) + "人 / " + parts.join("  ");
  var names = bySeat.map(function(x) { return x && Array.isArray(x.names) ? x.names : []; });
  names.push(Array.isArray(outside.names) ? outside.names : []);
  foot.title = names.map(function(list, k) {
    return ["東席", "南席", "西席", "北席", "外野"][k] + ": " + (list.length ? list.join("、") : "なし");
  }).join(" / ");
  host.appendChild(foot);
  var queue = Array.isArray(occ.queue) ? occ.queue.filter(function(n) { return typeof n === "string" && n; }) : [];
  if (queue.length) {
    var qline = document.createElement("div");
    qline.className = "occ-spectators";
    qline.textContent = "交代待ち（待ち列）: " + queue.join(" → ");
    host.appendChild(qline);
  }
}
function renderRanking(st) {
  var host = document.getElementById("ranking");
  var list = st && Array.isArray(st.ranking) ? st.ranking : [];
  if (!list.length) { host.style.display = "none"; host.textContent = ""; return; }
  host.style.display = "block";
  host.textContent = "";
  var title = document.createElement("div");
  title.className = "rank-title";
  title.textContent = "\u{1F3C6} ランキング（この卓の通算）";
  host.appendChild(title);
  list.forEach(function(e, i) {
    var row = document.createElement("div");
    row.className = "rank-row";
    var diff = typeof e.total_diff === "number" ? e.total_diff : 0;
    var diffText = (diff > 0 ? "+" : "") + diff;
    var icon = typeof e.icon === "string" && e.icon ? e.icon + " " : "";
    var name = typeof e.display_name === "string" && e.display_name ? e.display_name : "参加者";
    row.textContent = (i + 1) + "位 " + icon + name + "　" + diffText + "点 / " +
      (e.matches || 0) + "対局 ・ 1位" + (e.wins || 0) + "回 ・ 平均" + (e.avg_rank || 0) +
      "位 ・ 平均" + (e.avg_score || 0) + "点 ・ 最高" + (e.best_score || 0) + "点";
    host.appendChild(row);
  });
  var recent = st && Array.isArray(st.recent_results) ? st.recent_results : [];
  if (recent.length && Array.isArray(recent[0].standings)) {
    var line = document.createElement("div");
    line.className = "rank-recent";
    line.textContent = "直近の結果: " + recent[0].standings.map(function(x) {
      return x.rank + "位 " + (x.display_name || "") + " " + x.score + "点";
    }).join("、");
    host.appendChild(line);
  }
}
function render(st) {
  renderOccupancy(st);
  renderRanking(st);
  var round = (st.round && st.round.label) || st.round_label || "";
  var honba = (st.round && st.round.honba) ?? st.honba ?? 0;
  var dora = (st.dora_indicators || []).map(function(t){ return tileSpan(t); }).join(" ");
  document.getElementById("meta").innerHTML =
    esc(round) + " " + honba + "本場 / 供託 " + (st.kyotaku ?? 0) + " / 山 残り" + (st.wall_count ?? "?") + "枚 / ドラ表示 " + (dora || "―");
  var dealer = st.dealer ?? 0;
  var pivot = viewPivot(st);
  // Table layout: the four ponds form a square in the middle (no center
  // display; round info lives in the meta line). Each player's hand sits
  // outside its pond as one neat row (a column for the side players),
  // tiles facing that player, like a real table.
  var posByRel = ["bottom", "right", "top", "left"];
  for (var s = 0; s < 4; s++) {
    var pos = posByRel[(s - pivot + 4) % 4];
    var isTurn = (st.turn === s && st.match_status !== "finished");
    var strip = document.getElementById("hand-" + pos);
    strip.className = "handstrip " + pos + ((pos === "left" || pos === "right") ? " v" : "") + (isTurn ? " turn" : "");
    var occSeat = (st.occupancy && st.occupancy.seats && st.occupancy.seats[s]) || null;
    var avUrl = (occSeat && occSeat.joined && typeof occSeat.avatar_url === "string" && occSeat.avatar_url.indexOf("https://") === 0) ? occSeat.avatar_url : null;
    var avIcon = (occSeat && occSeat.joined && typeof occSeat.icon === "string" && occSeat.icon) ? occSeat.icon : windName(s, dealer);
    var avInner = avUrl ? '<img src="' + esc(avUrl) + '" alt="">' : esc(avIcon);
    var avName = (occSeat && occSeat.joined && typeof occSeat.display_name === "string" && occSeat.display_name) ? '<span class="pname">' + esc(occSeat.display_name) + "</span>" : "";
    var chip = '<div class="chip"><span class="avatar">' + avInner + "</span>" + windName(s, dealer) + avName +
      (riichiOn(st, s) ? '<span class="riichi">リーチ</span>' : "") +
      '<span class="score">' + ((st.scores || [])[s] ?? "?") + "点</span></div>";
    var hand = (st.hands || [])[s];
    var handHtml = "";
    if (Array.isArray(hand)) {
      var note = "";
      if (st.viewer && st.viewer.watch_open_hands) note = "手牌（公開中）";
      else if (st.viewer && st.viewer.role === "spectator" && st.viewer.seat === s) note = "応援席の手牌（あなただけに見えています）";
      var spans = hand.map(function(t){ return tileSpan(t); });
      if (pos === "top" || pos === "right") spans.reverse();
      handHtml = '<div class="htiles open">' + spans.join("") + "</div>" +
        (note ? '<div class="seatnote">' + note + "</div>" : "");
    }
    var cnt = (st.hand_counts || [])[s];
    var backs = "";
    if (!handHtml) {
      var nBack = Math.min(cnt == null ? 0 : cnt, 14);
      var bHtml = "";
      for (var bi = 0; bi < nBack; bi++) bHtml += '<span class="tile back"></span>';
      backs = '<div class="htiles">' + bHtml + "</div>" +
        '<div class="backs">' + (cnt == null ? "" : "手牌 " + cnt + "枚") + "</div>";
    }
    var melds = (st.melds || [])[s] || [];
    var meldHtml = "";
    if (melds.length) {
      meldHtml = '<div class="melds">' + melds.map(function(m){
        var tiles = (m && m.tiles) || [];
        return '<span class="meldgroup">' + tiles.map(function(t){ return tileSpan(t); }).join("") + "</span>";
      }).join("") + "</div>";
    }
    strip.innerHTML = chip + handHtml + backs + meldHtml;
    var pond = (st.discards || [])[s] || [];
    var pondEl = document.getElementById("pond-" + pos);
    pondEl.className = "pondbox pos-" + pos + (isTurn ? " turn" : "");
    var pondTile = function(d){
      var cls = "";
      if (d && typeof d === "object") {
        if (d.tsumogiri) cls += " dim";
        if (d.riichi || d.riichi_discard) cls += " ri";
      }
      return tileSpan(d, cls);
    };
    var chunked = "";
    if (pos === "left" || pos === "right") {
      for (var ci = 0; ci < pond.length; ci += 6) {
        chunked += '<div class="pondcol">' + pond.slice(ci, ci + 6).map(pondTile).join("") + "</div>";
      }
    } else {
      for (var rj = 0; rj < pond.length; rj += 6) {
        chunked += '<div class="pondrow">' + pond.slice(rj, rj + 6).map(pondTile).join("") + "</div>";
      }
    }
    pondEl.innerHTML = chunked;
  }
  var sideFor = function(rel) {
    var seat = (pivot + rel) % 4;
    var turnCls = (st.turn === seat && st.match_status !== "finished") ? " turn" : "";
    return '<div class="core-side' + turnCls + '">' + windName(seat, dealer) + '<br><span class="sc">' +
      ((st.scores || [])[seat] ?? "?") + "</span></div>";
  };
  var coreHtml = '<div class="corebox">' + sideFor(2) +
    '<div class="core-mid">' + sideFor(3) +
    '<div class="core-center"><div class="round">' + esc(round || "対局") + "</div>" +
    '<div class="sub">' + honba + "本場 / 供託 " + (st.kyotaku ?? 0) + "</div>" +
    '<div class="sub">ドラ表示 ' + (dora || "―") + "</div></div>" +
    sideFor(1) + "</div>" + sideFor(0) + "</div>";
  document.getElementById("corecell").innerHTML = coreHtml;
  var status = "";
  if (st.match_status === "finished") {
    status = "対局終了";
    if (Array.isArray(st.rankings)) status += "：" + st.rankings.map(function(r, i){ return (i + 1) + "位 " + (r.score ?? r) + "点"; }).join(" / ");
  } else if (st.winner !== null && st.winner !== undefined) {
    status = windName(st.winner, dealer) + " の和了";
  } else if (typeof st.turn === "number") {
    status = windName(st.turn, dealer) + " の番です";
  }
  document.getElementById("status").textContent = status + "（自動更新中）";
  fitBoard();
}
function load() {
  var mode = sessionStorage.getItem("watchMode") || "pw";
  var secret = sessionStorage.getItem("watchSecret") || "";
  var headers = mode === "token"
    ? { "Authorization": "Bearer " + secret }
    : { "X-Watch-Password": secret };
  fetch("/rooms/" + roomId + "/state", { headers: headers })
    .then(function(res) {
      if (res.status === 401) {
        document.getElementById("err").textContent = mode === "token" ? "トークンが違うようです" : "合言葉が違うようです";
        document.getElementById("gate").style.display = "block";
        document.getElementById("table").style.display = "none";
        throw new Error("unauthorized");
      }
      return res.json();
    })
    .then(function(st) {
      document.getElementById("gate").style.display = "none";
      document.getElementById("table").style.display = "block";
      render(st);
      afterRender(st);
      maybeInitWatchFX();
    })
    .catch(function(e) { if (String(e.message) !== "unauthorized") console.log(e); });
}
function fitBoard() {
  var wrap = document.getElementById("boardWrap");
  var board = document.getElementById("tableInner");
  if (!wrap || !board) return;
  var avail = wrap.clientWidth;
  var design = 700;
  if (!avail || avail >= design) {
    board.style.width = "100%";
    board.style.transform = "";
    wrap.style.height = "";
    return;
  }
  var sc = avail / design;
  board.style.width = design + "px";
  board.style.transform = "scale(" + sc + ")";
  board.style.transformOrigin = "top left";
  wrap.style.height = (board.offsetHeight * sc) + "px";
}
window.addEventListener("resize", fitBoard);
document.getElementById("mode").addEventListener("change", function() {
  document.getElementById("prompt").textContent =
    this.value === "token" ? "観戦トークンを入れてください" : "合言葉を入れてください";
});
document.getElementById("go").addEventListener("click", function() {
  sessionStorage.setItem("watchMode", document.getElementById("mode").value);
  sessionStorage.setItem("watchSecret", document.getElementById("pw").value.trim());
  load();
});
document.getElementById("pw").addEventListener("keydown", function(e) {
  if (e.key === "Enter") document.getElementById("go").click();
});
document.getElementById("refresh").addEventListener("click", load);
if (sessionStorage.getItem("watchPw") && !sessionStorage.getItem("watchSecret")) {
  sessionStorage.setItem("watchMode", "pw");
  sessionStorage.setItem("watchSecret", sessionStorage.getItem("watchPw"));
}
if (sessionStorage.getItem("watchSecret")) load();
setInterval(function() {
  if (document.getElementById("table").style.display === "block") load();
}, 5000);

// ---- danmaku (flowing cheers, Niconico style) ----
var dmSeeded = false, dmLanes = [], DM_LANES = 7, DM_COLORS = ["#ffd968", "#9adcff", "#ffb3c1", "#b6ffb6"];
var dmTokCursor = 0, dmTokSeeded = false, dmTokDead = false;
function dmEnabled() { return localStorage.getItem("watchDanmaku") !== "0"; }
function dmRefreshToggle() {
  var b = document.getElementById("dmToggle");
  if (b) b.className = dmEnabled() ? "sel" : "";
  var layer = document.getElementById("danmaku");
  if (layer && !dmEnabled()) layer.innerHTML = "";
}
function dmSpawn(text, name, seat) {
  if (!dmEnabled()) return;
  var layer = document.getElementById("danmaku");
  if (!layer || document.getElementById("table").style.display !== "block") return;
  if (layer.childElementCount >= 14) return;
  var now = Date.now(), lane = -1;
  for (var i = 0; i < DM_LANES; i++) { if (!dmLanes[i] || dmLanes[i] < now) { lane = i; break; } }
  if (lane < 0) return;
  var el = document.createElement("div");
  el.className = "dm";
  el.style.top = (6 + lane * 38) + "px";
  if (typeof seat === "number" && DM_COLORS[seat]) el.style.color = DM_COLORS[seat];
  if (name) { var nm = document.createElement("span"); nm.className = "dm-name"; nm.textContent = name; el.appendChild(nm); }
  el.appendChild(document.createTextNode(String(text)));
  layer.appendChild(el);
  var w = el.offsetWidth || 200, vw = window.innerWidth || 800;
  var dur = Math.max(3800, (vw + w) / 150 * 1000);
  dmLanes[lane] = now + Math.min(dur, (w + 90) / 150 * 1000);
  var anim = el.animate([{ transform: "translateX(0)" }, { transform: "translateX(-" + (vw + w + 30) + "px)" }], { duration: dur, easing: "linear" });
  anim.onfinish = function() { el.remove(); };
}
function dmFlowNew(list, seatHint, isLoop) {
  if (!isLoop) {
    dmLastFreshAt = Date.now();
    list.forEach(function(c) {
      if (!c || typeof c.text !== "string") return;
      var dup = dmLoopPool.some(function(p) {
        return (typeof c.seq === "number" && p.seq === c.seq) ||
          (p.text === c.text && p.from === c.from && p.target_seat === c.target_seat);
      });
      if (!dup) dmLoopPool.push(c);
    });
    while (dmLoopPool.length > 10) dmLoopPool.shift();
  }
  list.forEach(function(c, i) {
    setTimeout(function() { dmSpawn(c.text, c.from || "", (typeof c.target_seat === "number" ? c.target_seat : seatHint)); }, i * 650);
  });
}
// Loop replay: when no fresh cheers arrive for a while, the recent ones
// flow again in a slow cycle (rotating the starting point each round).
var dmLoopPool = [], dmLastFreshAt = 0, dmLoopOffset = 0;
setInterval(function() {
  if (!dmEnabled() || document.hidden) return;
  var tbl = document.getElementById("table");
  if (!tbl || tbl.style.display !== "block") return;
  if (!dmLoopPool.length) return;
  if (Date.now() - dmLastFreshAt < 12000) return;
  var n = dmLoopPool.length, off = dmLoopOffset % n;
  dmLoopOffset++;
  dmFlowNew(dmLoopPool.slice(off).concat(dmLoopPool.slice(0, off)), null, true);
}, 18000);
function dmPollToken() {
  if (dmTokDead) return;
  if ((sessionStorage.getItem("watchMode") || "pw") !== "token") return;
  var secret = sessionStorage.getItem("watchSecret") || "";
  if (!secret) return;
  fetch("/rooms/" + roomId + "/cheers?after=" + dmTokCursor, { headers: { "Authorization": "Bearer " + secret } })
    .then(function(res) { if (!res.ok) { dmTokDead = true; return null; } return res.json(); })
    .then(function(d) {
      if (!d || !Array.isArray(d.comments) || !d.comments.length) return;
      dmTokCursor = d.comments[d.comments.length - 1].seq;
      if (!dmTokSeeded) { dmTokSeeded = true; dmFlowNew(d.comments.slice(-2), null); }
      else dmFlowNew(d.comments, null);
    })
    .catch(function() {});
}
document.getElementById("dmToggle").addEventListener("click", function() {
  localStorage.setItem("watchDanmaku", dmEnabled() ? "0" : "1");
  dmRefreshToggle();
});
dmRefreshToggle();
setInterval(function() {
  if (document.getElementById("table").style.display === "block") dmPollToken();
}, 5000);
// ---- guest cheers (password mode only) ----
var cheerCursor = 0, cheerItems = [], cheerSupportSeen = null;
function esc(x) { return String(x).replace(/[&<>"']/g, function(c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function watchClientId() {
  var cid = localStorage.getItem("watchClientId");
  if (!cid) {
    cid = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    localStorage.setItem("watchClientId", cid);
  }
  return cid;
}
function guestSupport() {
  var v = localStorage.getItem("watchSupport");
  return (v === null || v === "") ? null : Number(v);
}
// The seat the table is viewed from: the chosen support seat when there is
// one (the board rotates so that seat sits at the bottom), else the
// spectator credential's own support seat, else the dealer as before.
function viewPivot(st) {
  var sup = guestSupport();
  if (sup !== null && sup >= 0 && sup <= 3) return sup;
  if (st && st.viewer && st.viewer.role === "spectator" && typeof st.viewer.seat === "number") return st.viewer.seat;
  return (st && typeof st.dealer === "number") ? st.dealer : 0;
}
function cheerHeaders() {
  var h = { "X-Watch-Password": sessionStorage.getItem("watchSecret") || "",
            "X-Watch-Client": watchClientId() };
  var sup = guestSupport();
  if (sup !== null) h["X-Watch-Support"] = String(sup);
  var nm = (localStorage.getItem("watchName") || "").trim();
  if (nm) h["X-Watch-Name"] = encodeURIComponent(nm);
  return h;
}
function renderCheers() {
  var el = document.getElementById("cheerList");
  if (!cheerItems.length) {
    el.innerHTML = '<div class="note">' + (guestSupport() === null
      ? "（応援席を選ぶと、ここにその席への応援コメントが並びます）"
      : "（まだコメントはありません。最初の応援をどうぞ）") + "</div>";
    return;
  }
  el.innerHTML = cheerItems.slice(-50).map(function(c) {
    var t = new Date(c.created_at);
    var hh = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2);
    return '<div class="cheer-item"><b>' + esc(c.from || "ゲスト") + "</b> " + esc(c.text) +
      '<span class="cheer-time">' + hh + "</span></div>";
  }).join("");
  el.scrollTop = el.scrollHeight;
}
function loadCheers() {
  if (guestSupport() === null) return;
  fetch("/rooms/" + roomId + "/cheers?after=" + cheerCursor, { headers: cheerHeaders() })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(d) {
      if (!d || !Array.isArray(d.comments)) return;
      if (d.comments.length) {
        var freshDm = d.comments;
        cheerItems = cheerItems.concat(d.comments);
        cheerCursor = d.comments[d.comments.length - 1].seq;
        renderCheers();
        if (!dmSeeded) { dmSeeded = true; dmFlowNew(freshDm.slice(-2), guestSupport()); }
        else dmFlowNew(freshDm, guestSupport());
      }
    })
    .catch(function() {});
}
function updateSupportRow(st) {
  var row = document.getElementById("supportRow");
  var occ = (st && st.occupancy && st.occupancy.seats) || [];
  var sup = guestSupport();
  var html = '<span style="font-size:13px">応援席：</span>';
  html += '<span class="note">選ぶと視点もその席に移ります</span>';
  for (var i = 0; i < 4; i++) {
    var nm = (occ[i] && occ[i].display_name) ? esc(occ[i].display_name) : ("席" + i);
    html += '<button data-seat="' + i + '"' + (sup === i ? ' class="sel"' : "") + ">" + nm + "</button>";
  }
  row.innerHTML = html;
  var btns = row.querySelectorAll("button");
  for (var j = 0; j < btns.length; j++) {
    btns[j].addEventListener("click", function() {
      localStorage.setItem("watchSupport", this.getAttribute("data-seat"));
      cheerCursor = 0; cheerItems = []; dmSeeded = false; renderCheers();
      document.getElementById("cheerMsg").textContent = "";
      updateSupportRow(window.__lastState);
      if (window.__lastState) render(window.__lastState);
      loadCheers();
    });
  }
}
// Fixed "write a cheer" tab: the cheer panel sits below the board and is
// easy to miss, so a pinned tab follows the reader and jumps to it. The
// tab hides itself while the panel is actually on screen.
var cheerTabWanted = false, cheerPanelInView = false;
function cheerTabSync() {
  var tab = document.getElementById("cheerTab");
  if (!tab) return;
  tab.style.display = (cheerTabWanted && !cheerPanelInView) ? "block" : "none";
}
function afterRender(st) {
  window.__lastState = st;
  var mode = sessionStorage.getItem("watchMode") || "pw";
  var panel = document.getElementById("cheerPanel");
  if (mode !== "pw") { panel.style.display = "none"; cheerTabWanted = false; cheerTabSync(); return; }
  panel.style.display = "block";
  cheerTabWanted = true; cheerTabSync();
  var sup = guestSupport();
  if (sup !== cheerSupportSeen) { cheerSupportSeen = sup; cheerCursor = 0; cheerItems = []; dmSeeded = false; renderCheers(); }
  else if (!cheerItems.length) { renderCheers(); }
  updateSupportRow(st);
  if (sup === null) {
    document.getElementById("cheerMsg").textContent = "応援席を選ぶと、その席への応援コメントが読めて書けます";
  }
  loadCheers();
}
(function() {
  var tab = document.getElementById("cheerTab");
  var panel = document.getElementById("cheerPanel");
  if (!tab || !panel) return;
  tab.addEventListener("click", function() {
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    if (guestSupport() !== null) {
      setTimeout(function() { document.getElementById("cheerText").focus({ preventScroll: true }); }, 500);
    }
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function(es) {
      cheerPanelInView = !!(es[0] && es[0].isIntersecting);
      cheerTabSync();
    }, { threshold: 0.12 }).observe(panel);
  }
})();
document.getElementById("cheerName").addEventListener("change", function() {
  localStorage.setItem("watchName", this.value.trim());
});
document.getElementById("cheerName").value = localStorage.getItem("watchName") || "";
document.getElementById("cheerSend").addEventListener("click", function() {
  var text = document.getElementById("cheerText").value.trim();
  var msg = document.getElementById("cheerMsg");
  if (guestSupport() === null) { msg.textContent = "先に応援席を選んでください"; return; }
  if (!text) { msg.textContent = "コメントが空です"; return; }
  var h = cheerHeaders(); h["Content-Type"] = "application/json";
  fetch("/rooms/" + roomId + "/cheers", {
    method: "POST", headers: h,
    body: JSON.stringify({ text: text, client_nonce: watchClientId() + "-" + Date.now() })
  }).then(function(res) {
    if (res.ok) {
      document.getElementById("cheerText").value = "";
      msg.textContent = "";
      loadCheers();
    } else if (res.status === 429) {
      msg.textContent = "連投制限中です。30秒あけてください";
    } else {
      msg.textContent = "送れませんでした（" + res.status + "）";
    }
  }).catch(function() { msg.textContent = "通信エラーです"; });
});
document.getElementById("cheerText").addEventListener("keydown", function(e) {
  if (e.key === "Enter") document.getElementById("cheerSend").click();
});

// ---- watch SE (delivered module; event polling shared with FX) ----
/* Muse雀荘 watch event stream + WebAudio SE v2, standalone browser snippet.
 * window.JansouSE.init({roomId, getAuthHeaders, button, intervalMs?:1500})
 * window.JansouEvents.subscribe(function (event) { ... }) -> unsubscribe()
 * event = {seq, revision, signals:[{type,seat?,tile?,call_type?,win_type?,from_seat?}]}
 * ONE polling loop shared by subscribers and audio; audio is ALWAYS OFF at load.
 * The draw event means hand DRAW/ryuukyoku. tile_draw means a player's tsumo.
 * Never persist, log, or embed authentication credentials.
 */
(function (global) {
  "use strict";

  var PREFERENCE_KEY = "muse-jansou-watch-se-preference-v1";
  var active = null;

  function readPreference() {
    try { return global.localStorage.getItem(PREFERENCE_KEY) === "1"; }
    catch (_) { return false; }
  }
  function savePreference(value) {
    try { global.localStorage.setItem(PREFERENCE_KEY, value ? "1" : "0"); }
    catch (_) { /* Storage may be disabled. Audio stays session-local. */ }
  }
  function validCursor(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 999999999999999;
  }
  function validSeat(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 3;
  }
  function sanitizeTile(value) {
    if (Number.isSafeInteger(value) && value >= 0 && value <= 135) return value;
    if (typeof value === "string" &&
        /^(?:[0-9]{1,2}[mpsz]|[mpsz][0-9]{1,2}|[1-9](?:man|pin|sou)|[一二三四五六七八九][萬万筒索]|[1-9][萬万筒索]|[東南西北白發発中]|[ESWNPCF]|[🀀-🀫]|(?:aka|red)[0-9][mps])$/iu.test(value)) {
      return value;
    }
    if (value && typeof value === "object" && !Array.isArray(value) &&
        ["m", "p", "s", "z"].indexOf(value.suit) !== -1 &&
        Number.isSafeInteger(value.rank) && value.rank >= 0 &&
        value.rank <= (value.suit === "z" ? 7 : 9)) {
      var copy = { suit: value.suit, rank: value.rank };
      if (value.red === true) copy.red = true;
      return copy;
    }
    return null;
  }
  function normalizeSignal(signal) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) return null;
    var seat = signal.seat;
    switch (signal.type) {
      case "tile_draw":
      case "riichi":
      case "score_change":
        return validSeat(seat) ? { type: signal.type, seat: seat } : null;
      case "discard":
        return validSeat(seat) ? { type: "discard", seat: seat,
          tile: sanitizeTile(signal.tile) } : null;
      case "call":
        return validSeat(seat) ? { type: "call", seat: seat,
          call_type: ["chi", "pon", "kan"].indexOf(signal.call_type) !== -1
            ? signal.call_type : null } : null;
      case "win":
        if (!validSeat(seat)) return null;
        var output = { type: "win", seat: seat,
          win_type: ["tsumo", "ron"].indexOf(signal.win_type) !== -1
            ? signal.win_type : null };
        if (output.win_type === "ron" && validSeat(signal.from_seat) && signal.from_seat !== seat) {
          output.from_seat = signal.from_seat;
        }
        return output;
      case "draw":        // Exhaustive/abortive hand draw, never a tile draw.
      case "hand_start":
      case "hand_end":
        return { type: signal.type };
      default:
        return null;
    }
  }
  function normalizeEvent(event, oldCursor, latest) {
    if (!event || !validCursor(event.seq) || event.seq <= oldCursor ||
        event.seq > latest || !Array.isArray(event.signals)) return null;
    var signals = [];
    for (var j = 0; j < Math.min(event.signals.length, 32); j++) {
      var signal = normalizeSignal(event.signals[j]);
      if (signal !== null) signals.push(signal);
    }
    // Deliver read-only records: one subscriber cannot accidentally change
    // the next subscriber's events or the SE synth's event types.
    for (var k = 0; k < signals.length; k++) {
      if (signals[k].tile && typeof signals[k].tile === "object") {
        Object.freeze(signals[k].tile);
      }
      Object.freeze(signals[k]);
    }
    Object.freeze(signals);
    return Object.freeze({ seq: event.seq,
      revision: Number.isSafeInteger(event.revision) ? event.revision : null,
      signals: signals });
  }

  function initJansouSE(options) {
    if (active !== null) throw new Error("JansouSE: already initialized; destroy first");
    if (!options || typeof options.roomId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(options.roomId) ||
        typeof options.getAuthHeaders !== "function" || !options.button) {
      throw new Error("JansouSE: roomId, getAuthHeaders, button are required");
    }
    var button = options.button;
    var AudioCtor = global.AudioContext || global.webkitAudioContext;
    var intervalMs = Math.max(1000, Number(options.intervalMs) || 1500);
    var endpoint = "/rooms/" + encodeURIComponent(options.roomId) + "/watch-events";
    var listeners = new Set();
    var preferredOn = readPreference();
    var audioOn = false;                // Even if preference was previously ON.
    var destroyed = false;
    var timer = null;
    var request = null;
    var busy = false;
    var cursor = null;                 // Initial tail poll silently seeks now.
    var generation = 0;
    var consecutiveErrors = 0;
    var catchingUp = false;
    var catchUpPages = 0;
    var authBlocked = false;
    var unlocking = false;
    var audio = null;
    var master = null;
    var noiseBuffer = null;

    function wanted() {
      return !destroyed && !authBlocked && (audioOn || listeners.size > 0);
    }
    function paint() {
      button.textContent = audioOn ? "音OFF" : "音ON";
      button.setAttribute("aria-pressed", audioOn ? "true" : "false");
      button.title = audioOn ? "効果音を止める（イベント表示は継続）" :
        (preferredOn ? "前回ON：クリックで音声を再開" : "クリックして効果音をON");
    }
    function muteOutput(muted) {
      if (!audio || !master) return;
      master.gain.cancelScheduledValues(audio.currentTime);
      master.gain.setValueAtTime(muted ? 0 : 0.12, audio.currentTime);
    }
    function stopPolling() {
      if (timer !== null) global.clearTimeout(timer);
      timer = null;
      if (request !== null) request.abort();
      request = null;
    }
    function schedule(delay) {
      if (timer !== null) global.clearTimeout(timer);
      timer = null;
      if (!wanted() || document.hidden) return;
      timer = global.setTimeout(poll, delay);
    }
    function resetBaseline() {
      generation++;
      cursor = null;
      catchingUp = false;
      catchUpPages = 0;
      consecutiveErrors = 0;
      stopPolling();
      if (wanted()) schedule(0);
    }
    function initAudio() {
      if (audio) return;
      if (!AudioCtor) throw new Error("WebAudio unavailable");
      audio = new AudioCtor();
      master = audio.createGain();
      master.gain.value = 0;
      master.connect(audio.destination);
      var count = Math.max(1, Math.floor(audio.sampleRate * 0.045));
      noiseBuffer = audio.createBuffer(1, count, audio.sampleRate);
      var samples = noiseBuffer.getChannelData(0);
      for (var i = 0; i < count; i++) {
        var fade = 1 - i / count;
        samples[i] = (Math.random() * 2 - 1) * fade * fade;
      }
    }
    function note(freq, when, seconds, level, shape) {
      var oscillator = audio.createOscillator();
      var envelope = audio.createGain();
      oscillator.type = shape || "sine";
      oscillator.frequency.setValueAtTime(freq, when);
      envelope.gain.setValueAtTime(0.0001, when);
      envelope.gain.exponentialRampToValueAtTime(level, when + 0.008);
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(when);
      oscillator.stop(when + seconds + 0.02);
    }
    function clickSound(when, softer) {
      var noise = audio.createBufferSource();
      noise.buffer = noiseBuffer;
      var filter = audio.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = softer ? 700 : 1100;
      var envelope = audio.createGain();
      envelope.gain.setValueAtTime(softer ? 0.16 : 0.28, when);
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + 0.042);
      noise.connect(filter);
      filter.connect(envelope);
      envelope.connect(master);
      noise.start(when);
      noise.stop(when + 0.045);
      note(softer ? 330 : 420, when, 0.06, 0.09, "triangle");
    }
    function play(type, when) {
      if (!audioOn || !audio || audio.state !== "running") return;
      switch (type) {
        case "discard": clickSound(when, false); break;
        case "call": clickSound(when, true); break;
        case "riichi":
          note(659.25, when, 0.13, 0.17, "sine");
          note(987.77, when + 0.12, 0.22, 0.13, "sine");
          break;
        case "win":
          note(523.25, when, 0.16, 0.13);
          note(659.25, when + 0.12, 0.16, 0.13);
          note(783.99, when + 0.24, 0.16, 0.13);
          note(1046.50, when + 0.36, 0.31, 0.12);
          break;
        case "draw":
          note(523.25, when, 0.16, 0.10);
          note(392.00, when + 0.13, 0.24, 0.09);
          break;
        case "hand_start": note(783.99, when, 0.14, 0.12, "triangle"); break;
        // tile_draw, hand_end and score_change are intentionally silent.
      }
    }
    function emitLive(records) {
      // Both SE and animation use the exact same validated live page.
      // Subscribers are isolated; one failure must not stall this cursor.
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        listeners.forEach(function (fn) {
          try { fn(record); }
          catch (_) { /* Do not log event bodies or credentials. */ }
        });
      }
      if (!audioOn || document.hidden || !audio || audio.state !== "running") return;
      var sounds = [];
      for (var k = 0; k < records.length; k++) {
        for (var j = 0; j < records[k].signals.length; j++) {
          var type = records[k].signals[j].type;
          if (["discard", "call", "riichi", "win", "draw", "hand_start"].indexOf(type) !== -1) {
            sounds.push(type);
          }
        }
      }
      sounds = sounds.slice(-8);  // Avoid an audio pile-up.
      var when = audio.currentTime + 0.025;
      for (var n = 0; n < sounds.length; n++) play(sounds[n], when + n * 0.16);
    }
    async function poll() {
      timer = null;
      if (!wanted() || document.hidden || busy) return;
      busy = true;
      var epoch = generation;
      var oldCursor = cursor;
      var isTail = cursor === null;
      var controller = new AbortController();
      request = controller;
      try {
        var headers = new Headers(options.getAuthHeaders());
        var response = await global.fetch(endpoint +
          (isTail ? "?tail=1" : "?after=" + cursor), {
          method: "GET", headers: headers, cache: "no-store",
          credentials: "omit", signal: controller.signal
        });
        if (controller.signal.aborted || epoch !== generation) return;
        if (response.status === 401 || response.status === 403) {
          authBlocked = true; // Resume only after refresh() on successful login.
          stopPolling();
          return;
        }
        if (response.status === 409) {
          var expired = await response.json();
          if (expired && expired.error === "EVENT_CURSOR_EXPIRED" &&
              validCursor(expired.latest_seq)) {
            cursor = expired.latest_seq;
            catchingUp = false;
            catchUpPages = 0;
            consecutiveErrors = 0;
            return; // Old history is intentionally NOT animated or played.
          }
          throw new Error("watch-events invalid cursor conflict");
        }
        if (!response.ok) throw new Error("watch-events HTTP " + response.status);
        var data = await response.json();
        if (!data || !validCursor(data.latest_seq) || !Array.isArray(data.events)) {
          throw new Error("watch-events invalid response");
        }
        if (controller.signal.aborted || epoch !== generation ||
            !wanted() || document.hidden) return;
        if (!isTail && data.latest_seq < oldCursor) {
          resetBaseline(); // Server reset; do not play old records.
          return;
        }
        var normalized = [];
        if (!isTail) {
          for (var i = 0; i < data.events.length; i++) {
            var record = normalizeEvent(data.events[i], oldCursor, data.latest_seq);
            if (record !== null) normalized.push(record);
          }
        }
        cursor = data.latest_seq;
        if (data.has_more) {
          catchingUp = true;
          catchUpPages++;
          if (catchUpPages >= 5) {
            resetBaseline(); // Bound pagination under a heavily active room.
          } else {
            schedule(150);
          }
        } else {
          if (!isTail && !catchingUp && normalized.length <= 12) emitLive(normalized);
          catchingUp = false;
          catchUpPages = 0;
        }
        consecutiveErrors = 0;
      } catch (_) {
        if (!controller.signal.aborted && epoch === generation && wanted()) {
          consecutiveErrors++;
          schedule(Math.min(30000, intervalMs * Math.pow(2, Math.min(consecutiveErrors, 5))));
        }
      } finally {
        if (request === controller) request = null;
        busy = false;
        if (epoch === generation && wanted() && !document.hidden && timer === null) {
          schedule(intervalMs);
        }
      }
    }
    async function toggleAudio() {
      if (destroyed || unlocking) return;
      if (audioOn) {
        audioOn = false;
        muteOutput(true);
        preferredOn = false;
        savePreference(false);
        paint();
        // Animation subscribers continue to receive events, without new GETs.
        if (!wanted()) resetBaseline();
        return;
      }
      unlocking = true;
      try {
        initAudio();
        await audio.resume(); // Triggered inside a real button-click handler.
        if (destroyed || audio.state !== "running") return;
        audioOn = true;
        muteOutput(false);
        preferredOn = true;
        savePreference(true);
        paint();
        if (cursor === null && !authBlocked) schedule(0);
      } catch (_) {
        audioOn = false;
        paint();
      } finally {
        unlocking = false;
      }
    }
    function subscribe(fn) {
      if (destroyed || typeof fn !== "function") throw new Error("JansouEvents: callback required");
      var before = wanted();
      listeners.add(fn);
      if (!before && wanted()) resetBaseline();
      var subscribed = true;
      return function unsubscribe() {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(fn);
        if (!wanted()) resetBaseline();
      };
    }
    function visibilityChanged() {
      if (document.hidden) {
        muteOutput(true);
        generation++;
        cursor = null;
        catchingUp = false;
        stopPolling();
      } else {
        muteOutput(!audioOn);
        resetBaseline(); // Do not animate events missed in the background.
      }
    }
    function refresh() {
      authBlocked = false; // Call after changing room password/token.
      resetBaseline();
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      audioOn = false;
      muteOutput(true);
      stopPolling();
      listeners.clear();
      button.removeEventListener("click", toggleAudio);
      document.removeEventListener("visibilitychange", visibilityChanged);
      global.removeEventListener("pagehide", destroy);
      if (audio) { audio.close().catch(function () {}); audio = null; }
      if (active === api) active = null;
    }

    var api = { refresh: refresh, destroy: destroy, subscribe: subscribe,
      isOn: function () { return audioOn; } };
    active = api;
    button.disabled = !AudioCtor;
    button.addEventListener("click", toggleAudio);
    document.addEventListener("visibilitychange", visibilityChanged);
    global.addEventListener("pagehide", destroy);
    paint();
    return api;
  }

  global.JansouSE = { init: initJansouSE };
  global.JansouEvents = {
    subscribe: function (callback) {
      if (active === null) throw new Error("JansouEvents: initialize JansouSE first");
      return active.subscribe(callback);
    }
  };
})(window);

// ---- watch FX: tile motion driven by the same events ----
var fxInited = false;
function fxSeatPos(seat) {
  var pivot = viewPivot(window.__lastState || null);
  return ["bottom", "right", "top", "left"][(seat - pivot + 4) % 4];
}
function fxCenter(el) {
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function fxAvatarUrl(seat) {
  var st = window.__lastState;
  var seats = st && st.occupancy && st.occupancy.seats;
  var s = seats && seats[seat];
  if (s && typeof s.avatar_url === "string" && s.avatar_url.indexOf("https://") === 0) return s.avatar_url;
  return null;
}
function fxCarrierHtml(seat, tileHtml) {
  var url = fxAvatarUrl(seat);
  if (!url) return tileHtml;
  var safe = url.replace(/["<>]/g, "");
  return '<img class="carrier" src="' + safe + '" alt="">' + tileHtml;
}
function fxFly(fromEl, toEl, html, rotate) {
  var layer = document.getElementById("animLayer");
  var a = fxCenter(fromEl), b = fxCenter(toEl);
  if (!layer || !a || !b) return;
  var d = document.createElement("div");
  d.className = "animtile" + (html.indexOf("carrier") >= 0 ? " withcarrier" : "");
  d.innerHTML = html;
  d.style.left = (a.x - 15) + "px";
  d.style.top = (a.y - 20) + "px";
  layer.appendChild(d);
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      d.style.transform = "translate(" + (b.x - a.x) + "px," + (b.y - a.y) + "px)" + (rotate ? " rotate(90deg)" : "");
      d.style.opacity = "0.15";
    });
  });
  setTimeout(function() { if (d.parentNode) d.parentNode.removeChild(d); }, 560);
}
function fxFlash(el, cls) {
  if (!el) return;
  el.classList.add(cls);
  setTimeout(function() { el.classList.remove(cls); }, 1500);
}
function fxOnEvent(ev) {
  if (!ev) return;
  if (ev.type === "hand_start") { fxFlash(document.getElementById("corecell"), "fxglow"); return; }
  if (typeof ev.seat !== "number") return;
  var pos = fxSeatPos(ev.seat);
  var hand = document.getElementById("hand-" + pos);
  var pond = document.getElementById("pond-" + pos);
  if (ev.type === "tile_draw") {
    fxFly(document.getElementById("corecell"), hand, fxCarrierHtml(ev.seat, '<span class="tile back"></span>'), false);
  } else if (ev.type === "discard") {
    fxFly(hand, pond, fxCarrierHtml(ev.seat, tileSpan(ev.tile)), !!ev.riichi);
  } else if (ev.type === "riichi" || ev.type === "call") {
    fxFlash(hand, "fxglow");
  } else if (ev.type === "win") {
    fxFlash(hand, "fxwin");
  }
}
function maybeInitWatchFX() {
  if (fxInited || !window.JansouSE) return;
  var secret = sessionStorage.getItem("watchSecret") || "";
  if (!secret) return;
  fxInited = true;
  try {
    window.JansouSE.init({
      roomId: roomId,
      button: document.getElementById("seButton"),
      getAuthHeaders: function() {
        var m = sessionStorage.getItem("watchMode") || "pw";
        var s = sessionStorage.getItem("watchSecret") || "";
        return m === "token" ? { "Authorization": "Bearer " + s } : { "X-Watch-Password": s };
      }
    });
    window.JansouEvents.subscribe(fxOnEvent);
  } catch (e) { console.log(e); }
}

// ---- members overlay: this room's registered players, without leaving
// the watch page. Data comes from GET /rooms/{id}/members, readable with
// the same credentials as the state read (watch password or a room token).
// Participant-supplied fields are rendered with textContent only.
var membersOpen = false;
function membersHeaders() {
  var mode = sessionStorage.getItem("watchMode") || "pw";
  var secret = sessionStorage.getItem("watchSecret") || "";
  return mode === "token" ? { "Authorization": "Bearer " + secret } : { "X-Watch-Password": secret };
}
function mbAvatar(m) {
  var av = document.createElement("div");
  av.className = "mb-avatar";
  if (typeof m.avatar_url === "string" && m.avatar_url.indexOf("https://") === 0) {
    var img = document.createElement("img");
    img.src = m.avatar_url; img.alt = "";
    av.appendChild(img);
  } else if (typeof m.icon === "string" && m.icon) {
    av.textContent = m.icon;
  } else {
    var name = typeof m.display_name === "string" && m.display_name ? m.display_name : "?";
    av.textContent = Array.from(name)[0] || "?";
  }
  return av;
}
function renderMembers(list) {
  var host = document.getElementById("membersList");
  host.textContent = "";
  if (!list.length) {
    var empty = document.createElement("div");
    empty.className = "mb-empty";
    empty.textContent = "まだ登録がありません";
    host.appendChild(empty);
    return;
  }
  list.forEach(function(m) {
    var card = document.createElement("div");
    card.className = "mb-member";
    card.appendChild(mbAvatar(m));
    var body = document.createElement("div");
    body.className = "mb-body";
    var nameRow = document.createElement("div");
    nameRow.className = "mb-name";
    nameRow.appendChild(document.createTextNode(
      typeof m.display_name === "string" && m.display_name ? m.display_name : "参加者"));
    var chips = [];
    if (m.status && m.status.kind === "seated") chips.push({ t: "着席中・席" + m.status.seat, gold: true });
    else if (m.status && m.status.kind === "waiting") chips.push({ t: "待ち列に並んでいます", gold: false });
    if (m.role === "spectator") chips.push({ t: "観戦" + (typeof m.support_seat === "number" ? "・応援席" + m.support_seat : ""), gold: false });
    chips.forEach(function(c) {
      var chip = document.createElement("span");
      chip.className = "mb-chip" + (c.gold ? " seated" : "");
      chip.textContent = c.t;
      nameRow.appendChild(chip);
    });
    body.appendChild(nameRow);
    if (m.role !== "spectator") {
      var rank = document.createElement("div");
      rank.className = "mb-rank";
      rank.textContent = m.ranking
        ? m.ranking.matches + "対局 ／ 平均順位 " + m.ranking.avg_rank + " ／ 最高 " + m.ranking.best_score + "点"
        : "まだ対局なし";
      body.appendChild(rank);
    }
    if (typeof m.bio === "string" && m.bio) {
      var bio = document.createElement("div");
      bio.className = "mb-bio";
      bio.textContent = m.bio;
      body.appendChild(bio);
    }
    card.appendChild(body);
    host.appendChild(card);
  });
}
function loadMembers() {
  fetch("/rooms/" + roomId + "/members", { headers: membersHeaders() })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(d) {
      var host = document.getElementById("membersList");
      if (!d || !Array.isArray(d.members)) {
        host.textContent = "";
        var e = document.createElement("div");
        e.className = "mb-empty";
        e.textContent = "名鑑を取得できませんでした";
        host.appendChild(e);
        return;
      }
      var panel = document.getElementById("membersPanel");
      var st = panel.scrollTop;
      renderMembers(d.members);
      panel.scrollTop = st;
    })
    .catch(function() {});
}
function setMembersOpen(open) {
  membersOpen = open;
  document.getElementById("membersOverlay").style.display = open ? "flex" : "none";
  if (open) loadMembers();
}
document.getElementById("membersBtn").addEventListener("click", function() { setMembersOpen(true); });
document.getElementById("membersClose").addEventListener("click", function() { setMembersOpen(false); });
document.getElementById("membersOverlay").addEventListener("click", function(e) { if (e.target === this) setMembersOpen(false); });
setInterval(function() {
  if (membersOpen && document.getElementById("table").style.display === "block") loadMembers();
}, 5000);
</script>
</body>
</html>
`;
