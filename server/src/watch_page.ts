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
  <button id="refresh">更新</button>
  <div id="status"></div>
</div>
<script>
var roomId = location.pathname.split("/")[2];
var NAMES = ["1m","2m","3m","4m","5m","6m","7m","8m","9m","1p","2p","3p","4p","5p","6p","7p","8p","9p","1s","2s","3s","4s","5s","6s","7s","8s","9s","東","南","西","北","白","發","中"];
function tname(t) {
  if (t === null || t === undefined) return "?";
  if (typeof t === "number") return NAMES[t] || ("#" + t);
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
  if (typeof n !== "number" || n < 0 || n > 33) {
    return '<span class="tile txt' + (cls ? " " + cls : "") + '">' + tname(t) + "</span>";
  }
  return '<span class="tile' + (cls ? " " + cls : "") + '"><svg viewBox="0 0 30 40" aria-label="' + tname(t) + '">' + faceSVG(n) + "</svg></span>";
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
  // Table layout: the four ponds form a square in the middle (no center
  // display; round info lives in the meta line). Each player's hand sits
  // outside its pond as one neat row (a column for the side players),
  // tiles facing that player, like a real table.
  var posByRel = ["bottom", "right", "top", "left"];
  for (var s = 0; s < 4; s++) {
    var pos = posByRel[(s - dealer + 4) % 4];
    var isTurn = (st.turn === s && st.match_status !== "finished");
    var strip = document.getElementById("hand-" + pos);
    strip.className = "handstrip " + pos + ((pos === "left" || pos === "right") ? " v" : "") + (isTurn ? " turn" : "");
    var chip = '<div class="chip">' + windName(s, dealer) +
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
    var seat = (dealer + rel) % 4;
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
        cheerItems = cheerItems.concat(d.comments);
        cheerCursor = d.comments[d.comments.length - 1].seq;
        renderCheers();
      }
    })
    .catch(function() {});
}
function updateSupportRow(st) {
  var row = document.getElementById("supportRow");
  var occ = (st && st.occupancy && st.occupancy.seats) || [];
  var sup = guestSupport();
  var html = '<span style="font-size:13px">応援席：</span>';
  for (var i = 0; i < 4; i++) {
    var nm = (occ[i] && occ[i].display_name) ? esc(occ[i].display_name) : ("席" + i);
    html += '<button data-seat="' + i + '"' + (sup === i ? ' class="sel"' : "") + ">" + nm + "</button>";
  }
  row.innerHTML = html;
  var btns = row.querySelectorAll("button");
  for (var j = 0; j < btns.length; j++) {
    btns[j].addEventListener("click", function() {
      localStorage.setItem("watchSupport", this.getAttribute("data-seat"));
      cheerCursor = 0; cheerItems = []; renderCheers();
      document.getElementById("cheerMsg").textContent = "";
      updateSupportRow(window.__lastState);
      loadCheers();
    });
  }
}
function afterRender(st) {
  window.__lastState = st;
  var mode = sessionStorage.getItem("watchMode") || "pw";
  var panel = document.getElementById("cheerPanel");
  if (mode !== "pw") { panel.style.display = "none"; return; }
  panel.style.display = "block";
  var sup = guestSupport();
  if (sup !== cheerSupportSeen) { cheerSupportSeen = sup; cheerCursor = 0; cheerItems = []; renderCheers(); }
  else if (!cheerItems.length) { renderCheers(); }
  updateSupportRow(st);
  if (sup === null) {
    document.getElementById("cheerMsg").textContent = "応援席を選ぶと、その席への応援コメントが読めて書けます";
  }
  loadCheers();
}
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
</script>
</body>
</html>
`;
