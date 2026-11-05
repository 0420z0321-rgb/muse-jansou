// 両卓の入口ページ。各卓の状態（席・待ち・進行）を合言葉で読み、
// 観戦ページへのリンクと合わせて表示する。合言葉は watch ページと
// 共通の MuseWatchSecret ヘルパー経由で読み書きする（localStorage 永続化＋
// sessionStorage からの移行はヘルパーが担う）ので、そのまま観戦へ入れる。
import { WATCH_SECRET_SCRIPT } from "./watch_secret_browser.ts";
import { COVER_RETURN_LINK, COVER_RETURN_STYLE } from "./cover_navigation.ts";

export const TABLES_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse雀荘 入口</title>
<style>
  body { margin:0; background:#123524; color:#f2ead8; font-family:"Hiragino Maru Gothic ProN","Hiragino Sans",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:22px 14px 40px; }
  h1 { font-size:26px; letter-spacing:.12em; text-align:center; margin:8px 0 2px; color:#ffd968; }
  .sub { text-align:center; opacity:.85; font-size:13px; margin-bottom:18px; }
  .gate { background:#1d4a30; border:1px solid #ffd96866; border-radius:12px; padding:14px; text-align:center; }
  .gate input { font-size:16px; padding:7px 10px; border-radius:8px; border:1px solid #999; width:180px; }
  .gate button { font-size:15px; padding:7px 16px; border-radius:8px; border:0; background:#ffd968; color:#402d00; font-weight:bold; cursor:pointer; }
  .card { background:#1a4630; border:1px solid #ffd96855; border-top:5px solid #ffd968; border-radius:14px; padding:16px 16px 14px; margin:14px 0; box-shadow:0 6px 18px rgba(0,0,0,.35); }
  .card h2 { margin:0 0 4px; font-size:21px; color:#ffd968; letter-spacing:.08em; }
  .status { font-size:14px; opacity:.92; margin-bottom:10px; }
  .seats { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
  .seat { background:#0f2f1f; border:1px solid #ffffff2e; border-radius:999px; padding:5px 12px; font-size:14px; }
  .seat.open { opacity:.55; border-style:dashed; }
  .watch { display:inline-block; background:#ffd968; color:#402d00; font-weight:bold; text-decoration:none; padding:9px 20px; border-radius:999px; font-size:16px; }
  .note { font-size:12.5px; opacity:.8; line-height:1.7; margin-top:16px; }
  .note a { color:#ffd968; }
  #err { color:#ffb3c1; text-align:center; min-height:18px; font-size:13px; }
${COVER_RETURN_STYLE}
</style>
</head>
<body>
${COVER_RETURN_LINK}
<div class="wrap">
  <h1>🀄 Muse雀荘</h1>
  <div class="sub">卓は2つあります。状態を見て、入りたい卓を選んでください。</div>
  <div class="gate" id="gate" style="display:none">
    合言葉 <input id="pw" type="password" autocomplete="off"> <button id="go">入る</button>
  </div>
  <div id="err"></div>
  <div id="cards"></div>
  <div class="note">
    参加（着席・待ち列）は Helper から行います。待ち列は卓ごとです。空いている卓ではなく、待ちたい卓で待つこともできます。待っている間ずっと張り付く必要はありません。
    登録したみなさんの紹介は<a href="/members">選手名鑑</a>で見られます。
  </div>
</div>
${WATCH_SECRET_SCRIPT}
<script>
var ROOMS = [
  { id: "c4c3d9be-ed74-458d-8956-11bd345c477c", name: "一卓" },
  { id: "06bf8829-4b64-4da6-b8f1-c6c8173ca4d0", name: "二卓" }
];
function esc(x) {
  return String(x == null ? "" : x).replace(/[&<>"']/g, function(c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function load() {
  var secret = window.MuseWatchSecret.getPassword();
  var headers = { "X-Watch-Password": secret };
  var cards = document.getElementById("cards");
  var pending = ROOMS.length;
  var anyOk = false;
  ROOMS.forEach(function(room, idx) {
    fetch("/rooms/" + room.id + "/state", { headers: headers })
      .then(function(res) {
        if (res.status === 401) throw new Error("unauthorized");
        return res.json();
      })
      .then(function(st) {
        anyOk = true;
        var occ = st.occupancy || {};
        var seats = (occ.seats || []).map(function(s) {
          if (s.open) return '<span class="seat open">空席</span>';
          return '<span class="seat">' + esc(s.icon || "") + " " + esc(s.display_name || "対局中") + "</span>";
        }).join("");
        var q = (occ.queue || []).length;
        var round = (st.round && st.round.label) || st.round_label || "";
        var phase = st.match_status === "finished" ? "試合終了（次の試合待ち）" :
          (round ? round + " 進行中" : "進行中");
        var html = '<div class="card"><h2>' + room.name + "</h2>" +
          '<div class="status">' + esc(phase) + " ／ 待ち列 " + q + "人</div>" +
          '<div class="seats">' + seats + "</div>" +
          '<a class="watch" href="/rooms/' + room.id + '/watch">観戦する</a></div>';
        var slot = document.getElementById("card-" + idx);
        if (slot) slot.innerHTML = html;
      })
      .catch(function(e) {
        var slot = document.getElementById("card-" + idx);
        if (slot) slot.innerHTML = '<div class="card"><h2>' + room.name + "</h2><div class=status>状態を取得できませんでした</div></div>";
      })
      .then(function() {
        pending--;
        if (pending === 0) {
          document.getElementById("gate").style.display = anyOk ? "none" : "block";
          document.getElementById("err").textContent = anyOk ? "" : "合言葉が違うようです";
        }
      });
  });
}
function boot() {
  var cards = document.getElementById("cards");
  cards.innerHTML = ROOMS.map(function(r, i) { return '<div id="card-' + i + '"></div>'; }).join("");
  if (!window.MuseWatchSecret.getPassword()) {
    document.getElementById("gate").style.display = "block";
  }
  load();
  setInterval(load, 15000);
}
document.getElementById("go").addEventListener("click", async function() {
  var button = this;
  var field = document.getElementById("pw");
  var message = document.getElementById("err");
  var value = field.value.trim();
  if (!value || button.disabled) return;
  button.disabled = true;
  message.textContent = "確認しています…";
  try {
    var result = await window.MuseWatchSecret.verifyPassword(
      value, ROOMS.map(function(room) { return room.id; })
    );
    if (field.value.trim() !== value) {
      message.textContent = "入力が変わったため、もう一度確認してください。";
      return;
    }
    if (result.status !== "accepted") {
      message.textContent = result.status === "rejected"
        ? "合言葉が受理されませんでした。"
        : "現在、合言葉を確認できません。保存値は変更していません。";
      return;
    }
    var saved = window.MuseWatchSecret.savePassword(value);
    if (!saved.ok) {
      message.textContent = "合言葉は受理されましたが、ブラウザへ保存できませんでした。";
      return;
    }
    if (!window.MuseWatchSecret.setMode("pw")) {
      message.textContent = "合言葉は保存済みですが、観戦モードを切り替えられません。";
      return;
    }
    field.value = "";
    message.textContent = "";
    load();
  } finally {
    button.disabled = false;
  }
});
boot();
</script>
</body>
</html>`;
