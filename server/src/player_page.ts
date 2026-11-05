// Human player page. Served at GET /rooms/{id}/play.
// A person joins with an invite code (the join is marked human:true and the
// server refuses it unless the table's ruleset opens human seats) or
// re-enters with a saved player token. The page polls GET /state with the
// player token, so it only ever receives the caller's own hand, renders the
// server's legal decisions as buttons / clickable tiles, and performs the
// claim -> action sequence for every move. It decides nothing itself.
import { COVER_RETURN_LINK, COVER_RETURN_STYLE } from "./cover_navigation.ts";

export const PLAY_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse雀荘 対局（人の席）</title>
<style>
  body { background:#12352a; color:#f2f2e9; font-family:sans-serif; margin:0; padding:12px; }
  h1 { font-size:18px; margin:4px 0 8px; }
  #meta { font-size:14px; opacity:.92; margin-bottom:8px; }
  #gate { background:#1d4a3a; border:1px solid #3a7a5f; border-radius:8px; padding:16px; max-width:360px; margin:32px auto; }
  #gate h2 { font-size:15px; margin:10px 0 6px; }
  #gate input { font-size:16px; padding:8px; width:92%; border-radius:6px; border:none; margin-bottom:8px; }
  #gate button { font-size:15px; padding:8px 14px; border-radius:6px; border:none; background:#e8b13c; color:#222; cursor:pointer; }
  #gate .note { font-size:12px; opacity:.85; }
  .err { color:#ff9a9a; min-height:20px; font-size:13px; }
  #status { font-size:13px; min-height:18px; color:#ffe9a8; margin:4px 0; }
  .seats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; margin-bottom:8px; }
  @media (min-width:720px) { .seats { grid-template-columns:repeat(4,minmax(0,1fr)); } }
  .seat { background:#194b39; border:1px solid #2c5f4b; border-radius:8px; padding:6px 8px; min-width:0; }
  .seat.turn { border-color:#e8b13c; box-shadow:0 0 8px #e8b13c66; }
  .seat.me { border-color:#ffd968; }
  .seat .nm { font-weight:bold; font-size:14px; overflow-wrap:anywhere; }
  .seat .sc { color:#ffd968; font-weight:bold; }
  .seat .sub { font-size:11px; opacity:.85; }
  .badge { display:inline-block; background:#7a1f1f; color:#fff; font-size:10px; border-radius:3px; padding:1px 5px; margin-left:4px; vertical-align:2px; }
  .river { display:flex; flex-wrap:wrap; gap:2px; margin-top:4px; min-height:20px; }
  .melds { display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; }
  .meld { display:flex; gap:1px; background:#0f2f1f; border-radius:4px; padding:1px 2px; }
  .tile { display:inline-block; background:linear-gradient(180deg,#fffef9 0%,#fdf8e7 55%,#f2ead0 100%);
    border-radius:4px; box-shadow:inset 0 0 0 1px rgba(90,80,40,.28), inset 0 2px 1px rgba(255,255,255,.9), inset 0 -3px 0 rgba(163,148,98,.6), 0 3px 0 #5d7a58, 0 5px 6px rgba(0,0,0,.45);
    padding:0; line-height:0; vertical-align:middle; box-sizing:border-box; }
  .tile svg { display:block; width:100%; height:100%; }
  .tile.s { width:21px; height:28px; }
  .tile.aka { background:linear-gradient(180deg,#fff5f2 0%,#fdeae4 55%,#f6d9d2 100%); box-shadow:inset 0 0 0 2px #c0392b, inset 0 -3px 0 rgba(163,80,60,.45), 0 3px 0 #5d7a58, 0 5px 6px rgba(0,0,0,.45); }
  .tile.last { outline:2px solid #e8b13c; }
  #hand { display:flex; flex-wrap:wrap; gap:3px; align-items:flex-end; background:#1d4a3a; border:2px solid #2c5f4b; border-radius:8px; padding:10px 8px; }
  #hand .tile { width:38px; height:51px; }
  #hand .tile.drawn { margin-left:12px; outline:2px solid #7fc8a9; }
  #hand .tile.can { cursor:pointer; }
  #hand .tile.can:hover { transform:translateY(-5px); }
  #hand .tile.dim { opacity:.45; }
  #actions { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
  #actions button { font-size:16px; padding:10px 16px; border-radius:8px; border:none; background:#e8b13c; color:#222; cursor:pointer; font-weight:bold; }
  #actions button.sub { background:#2c5f4b; color:#f2f2e9; }
  #actions button.armed { background:#b02318; color:#fff; }
  #actions button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .small { font-size:12px; opacity:.85; }
  #forget { background:none; border:1px solid #418262; color:#d1e1d0; border-radius:6px; padding:5px 10px; cursor:pointer; font-size:12px; }
  #leaveBtn { background:#5a2d20; border:1px solid #c96f4a; color:#ffd9c4; border-radius:6px; padding:5px 12px; cursor:pointer; font-size:12px; font-weight:bold; }
${COVER_RETURN_STYLE}
</style>
</head>
<body>
<h1>🀄 Muse雀荘 対局（人の席）</h1>
<div id="gate">
  ${COVER_RETURN_LINK}
  <div class="note">人の席が開いている卓で遊べます。招待コードで参加するか、お持ちの資格情報で再入場してください。</div>
  <h2>招待コードで参加</h2>
  <input id="inv" placeholder="招待コード" autocomplete="off">
  <input id="nm" placeholder="表示名" autocomplete="off">
  <button id="joinBtn">参加する</button>
  <h2>資格情報で再入場</h2>
  <input id="tok" placeholder="資格情報（トークン）" autocomplete="off">
  <button id="reBtn">再入場する</button>
  <div class="err" id="gateErr"></div>
</div>
<div id="main" style="display:none">
  <div id="meta"></div>
  <div class="seats" id="seats"></div>
  <div id="status"></div>
  <div id="actions"></div>
  <div id="hand"></div>
  <div class="row" style="margin-top:10px">
    <span class="small" id="whoami"></span>
    <button id="leaveBtn">退室する（席を空ける）</button>
    <button id="forget">この端末から資格情報を消す</button>
  </div>
  <div style="margin-top:14px;border-top:1px solid #2b4638;padding-top:10px">
    <div class="small">人作チップで打つ（任意）：研究所の工房へ預けた配置をこの席に結び付けると、その配置が自動で打ちます。手動で打った判断はそちらが優先され、チップが失敗した手番は時計の扱いに委ねられます（代わりの手は打たれません）。</div>
    <div class="small" id="chipState" style="margin:6px 0"></div>
    <div class="row">
      <input id="chipWs" placeholder="工房ID（hw_…）" autocomplete="off" size="30">
      <input id="chipVer" placeholder="版" autocomplete="off" size="4">
      <input id="chipKey" placeholder="所有者鍵" autocomplete="off" size="24">
    </div>
    <div class="row">
      <button id="chipBind">チップを結ぶ</button>
      <button id="chipUnbind">結びを外す（手動に戻す）</button>
    </div>
    <div class="err" id="chipErr"></div>
  </div>
</div>
<script>
"use strict";
var roomId = (location.pathname.match(/^\\/rooms\\/([^/]+)\\/play/) || [])[1] || "";
var storeKey = "jansou-play:" + roomId;
var cred = null;
try { cred = JSON.parse(localStorage.getItem(storeKey) || "null"); } catch (e) { cred = null; }
var lastState = null;
var riichiArmed = false;
var busy = false;

function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function api(method, suffix, body, token) {
  var h = { "Content-Type": "application/json" };
  var tk = token || (cred && cred.token);
  if (tk) h["Authorization"] = "Bearer " + tk;
  return fetch("/rooms/" + roomId + "/" + suffix, {
    method: method, headers: h, body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      return j;
    });
  });
}
function saveCred() {
  if (cred) localStorage.setItem(storeKey, JSON.stringify(cred));
  else localStorage.removeItem(storeKey);
}
function idem() {
  if (crypto && crypto.randomUUID) return "hp-" + crypto.randomUUID();
  return "hp-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
}

$("joinBtn").addEventListener("click", function () {
  var code = $("inv").value.trim(), name = $("nm").value.trim();
  $("gateErr").textContent = "";
  if (!code || !name) { $("gateErr").textContent = "招待コードと表示名を入れてください。"; return; }
  api("POST", "join", { invite_code: code, display_name: name, human: true }, "")
    .then(function (j) {
      cred = { token: j.token, seat: j.seat };
      saveCred();
      enter();
    })
    .catch(function (e) {
      $("gateErr").textContent = e.message === "human seats are not open in this room"
        ? "この卓は人の席が開いていません。" : ("参加できませんでした：" + e.message);
    });
});
$("reBtn").addEventListener("click", function () {
  var tk = $("tok").value.trim();
  $("gateErr").textContent = "";
  if (!tk) { $("gateErr").textContent = "資格情報を入れてください。"; return; }
  api("GET", "state", null, tk).then(function (st) {
    if (!st.viewer || st.viewer.role !== "player" || typeof st.viewer.seat !== "number") {
      throw new Error("この資格情報では席に着けません。");
    }
    cred = { token: tk, seat: st.viewer.seat };
    saveCred();
    enter();
  }).catch(function (e) { $("gateErr").textContent = "再入場できませんでした：" + e.message; });
});
$("forget").addEventListener("click", function () {
  cred = null; saveCred(); location.reload();
});
$("leaveBtn").addEventListener("click", function () {
  if (!cred || !cred.token) return;
  if (!window.confirm("退室すると席が空き、待ち列の方と交代します。この資格情報では再入場できなくなります。退室しますか？")) return;
  var btn = this;
  btn.disabled = true;
  api("POST", "leave", {})
    .then(function () {
      cred = null; saveCred(); location.href = "/cover";
    })
    .catch(function (e) {
      btn.disabled = false;
      window.alert("退室できませんでした：" + e.message);
    });
});

var NUM = ["一","二","三","四","五","六","七","八","九"];
var WINDS = ["東","南","西","北"];
function face(t) {
  if (t < 9) return NUM[t] + "萬";
  if (t < 18) return String(t - 8) + "筒";
  if (t < 27) return String(t - 17) + "索";
  if (t < 34) return "東南西北白發中"[t - 27];
  if (t === 34) return "赤5萬";
  if (t === 35) return "赤5筒";
  return "赤5索";
}
function tileEl(t, size, extra) {
  var s = el("span", "tile " + (size || "s") + (t >= 34 ? " aka" : "") + (extra ? " " + extra : ""));
  s.innerHTML = '<svg viewBox="0 0 30 40" aria-label="' + face(t) + '">' + faceSVG(kindOfCode(t)) + "</svg>";
  return s;
}
var KANJI_NUM = ["一","二","三","四","五","六","七","八","九"];
var HONOR_CH = ["東","南","西","北","白","發","中"];
var CB = "#2456a6", CG = "#1e8a4c", CR = "#c62f3b", IVORY = "#f7f2e2";
function kindOfCode(n) { return n === 34 ? 4 : n === 35 ? 13 : n === 36 ? 22 : n; }
function circ(x, y, r, fill) { return '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + fill + '" stroke="rgba(0,0,0,.22)" stroke-width="0.6"/>'; }
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
    return circ(p[0], p[1], r, p[2]) + circ(p[0], p[1], r * 0.58, IVORY) +
      circ(p[0], p[1], r * 0.34, p[2]) + circ(p[0], p[1], r * 0.13, IVORY);
  }).join("");
}
function stick(x, y, color, rot) {
  return '<g transform="translate(' + x + ' ' + y + ')' + (rot ? ' rotate(' + rot + ')' : '') + '">' +
    '<rect x="-2.6" y="-5.5" width="5.2" height="11" rx="2.4" fill="' + color + '" stroke="rgba(0,0,0,.22)" stroke-width="0.5"/>' +
    '<rect x="-2.6" y="-2.9" width="5.2" height="1.3" fill="' + IVORY + '" opacity="0.85"/>' +
    '<rect x="-2.6" y="1.8" width="5.2" height="1.3" fill="' + IVORY + '" opacity="0.85"/></g>';
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
function chipApi(method, body, ownerKey) {
  var h = { "Content-Type": "application/json", "X-Lab-Client": "human-workshop-v1" };
  if (cred && cred.token) h["Authorization"] = "Bearer " + cred.token;
  if (ownerKey) h["X-Lab-Owner-Key"] = ownerKey;
  return fetch("/rooms/" + roomId + "/human-chip", {
    method: method, headers: h, body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      return j;
    });
  });
}
$("chipBind").addEventListener("click", function () {
  var ws = $("chipWs").value.trim(), ver = parseInt($("chipVer").value, 10), key = $("chipKey").value;
  $("chipErr").textContent = "";
  if (!/^hw_[0-9a-f]{32}$/.test(ws)) { $("chipErr").textContent = "工房ID（hw_…）を確認してください。"; return; }
  if (!Number.isInteger(ver) || ver < 1) { $("chipErr").textContent = "版番号を入れてください。"; return; }
  if (!key) { $("chipErr").textContent = "所有者鍵を入れてください（鍵は保存されません）。"; return; }
  var btn = this; btn.disabled = true;
  chipApi("POST", { workshop_id: ws, version: ver }, key)
    .then(function () { $("chipKey").value = ""; btn.disabled = false; refresh(); })
    .catch(function (e) { $("chipKey").value = ""; btn.disabled = false; $("chipErr").textContent = "結べませんでした：" + e.message; });
});
$("chipUnbind").addEventListener("click", function () {
  $("chipErr").textContent = "";
  var btn = this; btn.disabled = true;
  chipApi("DELETE", null, null)
    .then(function () { btn.disabled = false; refresh(); })
    .catch(function (e) { btn.disabled = false; $("chipErr").textContent = "外せませんでした：" + e.message; });
});
function renderChipState(st) {
  var host = $("chipState");
  if (!host) return;
  var mine = null;
  (st.human_chip_drivers || []).forEach(function (d) { if (d.seat === cred.seat) mine = d; });
  host.textContent = mine
    ? "現在の打ち手：人作チップ（工房 " + mine.workshop_id + " ／ 版" + mine.version + "）。手動でも打てます。"
    : "現在の打ち手：手動です。";
}

function riichiDeclared(st, seat) {
  var r = (st.riichi || [])[seat];
  return r === true || (r && typeof r === "object" && r.declared === true);
}
function myDecision(st) {
  var ds = st.decisions || [];
  for (var i = 0; i < ds.length; i++) if (ds[i].seat === cred.seat) return ds[i];
  return null;
}

function render(st) {
  lastState = st;
  var me = cred.seat;
  var dealer = st.dealer || 0;
  var round = (st.round && st.round.label) || "";
  var meta = round + "　" + (st.honba || 0) + "本場　供託" + (st.kyotaku || 0) +
    "　山残り" + (st.wall_count != null ? st.wall_count : "?");
  var dora = st.dora_indicators || [];
  if (dora.length) meta += "　ドラ表示：" + dora.map(face).join(" ");
  if (st.ruleset && st.ruleset.allow_human_players) meta += "　（人の席：開）";
  if (st.clock && st.clock.remaining_ms) {
    var ms = st.clock.remaining_ms[me];
    if (typeof ms === "number") meta += "　持ち時間：" + Math.floor(ms / 60000) + "分" + Math.floor((ms % 60000) / 1000) + "秒";
  }
  $("meta").textContent = meta;
  renderChipState(st);

  var occ = (st.occupancy && st.occupancy.seats) || [];
  var host = $("seats");
  host.textContent = "";
  [0, 1, 2, 3].map(function (k) { return (me + k) % 4; }).forEach(function (s) {
    var box = el("div", "seat" + (st.turn === s && st.phase !== "finished" ? " turn" : "") + (s === me ? " me" : ""));
    var o = occ[s] || {};
    var nm = el("div", "nm", (o.display_name || ("席" + s)) + (s === me ? "（あなた）" : ""));
    box.appendChild(nm);
    var line = el("div", "sub");
    var sc = el("span", "sc", String((st.scores || [])[s] != null ? st.scores[s] : ""));
    line.appendChild(document.createTextNode(WINDS[(s - dealer + 4) % 4] + "家 "));
    line.appendChild(sc);
    if (s === dealer) line.appendChild(document.createTextNode(" 親"));
    if (riichiDeclared(st, s)) { var b = el("span", "badge", "リーチ"); line.appendChild(b); }
    var cnt = (st.hand_counts || [])[s];
    if (s !== me && typeof cnt === "number") line.appendChild(document.createTextNode(" 手牌" + cnt + "枚"));
    box.appendChild(line);
    var river = el("div", "river");
    var ds = (st.discards || [])[s] || [];
    ds.forEach(function (t, i) { river.appendChild(tileEl(t, "s", i === ds.length - 1 && st.from_seat === s ? "last" : "")); });
    box.appendChild(river);
    var melds = (st.melds || [])[s] || [];
    if (melds.length) {
      var mh = el("div", "melds");
      melds.forEach(function (m) {
        var g = el("span", "meld");
        (m.tiles || []).forEach(function (t) { g.appendChild(tileEl(t, "s")); });
        mh.appendChild(g);
      });
      box.appendChild(mh);
    }
    host.appendChild(box);
  });

  // My hand
  var handHost = $("hand");
  handHost.textContent = "";
  var hand = ((st.hands || [])[me] || []).slice().sort(function (a, b) { return a - b; });
  var drawn = (st.turn === me && st.phase === "discard") ? st.last_drawn : null;
  var drawnIdx = -1;
  if (drawn != null) { drawnIdx = hand.indexOf(drawn); if (drawnIdx >= 0) { hand.splice(drawnIdx, 1); hand.push(drawn); drawnIdx = hand.length - 1; } }
  var dec = myDecision(st);
  var discardable = {};
  if (dec) dec.actions.forEach(function (a) { if (a.type === "discard") discardable[a.tile] = a; });
  hand.forEach(function (t, i) {
    var can = dec && discardable[t] && i === hand.lastIndexOf(t) || (dec && discardable[t]);
    var tile = tileEl(t, "b", (i === drawnIdx ? "drawn" : "") + (dec ? (discardable[t] ? " can" : " dim") : ""));
    if (dec && discardable[t]) {
      (function (action) {
        tile.addEventListener("click", function () { doAction(action); });
      })(discardable[t]);
    }
    handHost.appendChild(tile);
  });

  // Action buttons
  var bar = $("actions");
  bar.textContent = "";
  if (st.match_status === "finished") {
    $("status").textContent = "対局は終了しました。";
    var scores = (st.scores || []).map(function (v, s) { return { s: s, v: v }; }).sort(function (a, b) { return b.v - a.v; });
    bar.appendChild(el("div", null, "最終：" + scores.map(function (x) {
      var o = occ[x.s] || {}; return (o.display_name || ("席" + x.s)) + " " + x.v;
    }).join(" ／ ")));
    return;
  }
  if (!dec) {
    $("status").textContent = st.phase === "discard" ? "相手の番です。" : "進行中…";
    return;
  }
  $("status").textContent = "あなたの番です。";
  var labels = { tsumo: "ツモ", ron: "ロン", pon: "ポン", kan: "カン", pass: "パス", declare_ron: "ロン申告" };
  dec.actions.forEach(function (a) {
    if (a.type === "discard") return;
    var label = labels[a.type] || a.type;
    if (a.type === "chi") label = "チー（" + (a.consume || []).map(face).join("・") + "）";
    if (a.type === "ankan") label = "暗槓（" + face(a.tile) + "）";
    if (a.type === "kakan") label = "加槓（" + face(a.tile) + "）";
    var btn = el("button", a.type === "pass" ? "sub" : null, label);
    btn.addEventListener("click", function () { doAction(a); });
    bar.appendChild(btn);
  });
  // Riichi toggle: menzen (no open melds), not declared yet, discard decision.
  var myMelds = (st.melds || [])[me] || [];
  var menzen = myMelds.every(function (m) { return !m.open; });
  if (dec.actions.some(function (a) { return a.type === "discard"; }) && menzen && !riichiDeclared(st, me)) {
    var rb = el("button", riichiArmed ? "armed" : "sub", riichiArmed ? "リーチ宣言中：切る牌を選んでください" : "リーチ宣言する");
    rb.addEventListener("click", function () { riichiArmed = !riichiArmed; render(lastState); });
    bar.appendChild(rb);
  }
}

function doAction(action) {
  if (busy || !lastState) return;
  var dec = myDecision(lastState);
  if (!dec) return;
  busy = true;
  $("status").textContent = "送信中…";
  var seat = cred.seat;
  api("POST", "claim", { seat: seat, decision_id: dec.decision_id })
    .then(function (c) { return c.claim_token; }, function () { return null; })
    .then(function (claimToken) {
      var body = {
        seat: seat, decision_id: dec.decision_id,
        expected_revision: lastState.revision, idempotency_key: idem(),
        action: action.type,
      };
      if (action.tile !== undefined) body.tile = action.tile;
      if (action.consume) body.consume = action.consume;
      if (riichiArmed && action.type === "discard") body.riichi = true;
      if (claimToken) body.claim_token = claimToken;
      return api("POST", "actions", body);
    })
    .then(function () { riichiArmed = false; busy = false; refresh(); })
    .catch(function (e) { busy = false; $("status").textContent = "できませんでした：" + e.message; refresh(); });
}

function refresh() {
  if (!cred) return;
  api("GET", "state", null).then(render).catch(function (e) {
    $("status").textContent = "状態を取得できません：" + e.message;
  });
}
function enter() {
  $("gate").style.display = "none";
  $("main").style.display = "";
  $("whoami").textContent = "席" + cred.seat + " で対局中";
  refresh();
  setInterval(refresh, 2500);
}
if (cred && cred.token) enter();
</script>
</body>
</html>
`;
