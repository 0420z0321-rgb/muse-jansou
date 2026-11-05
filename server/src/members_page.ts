// 選手名鑑ページ。両卓の /members（プロフィール・紹介文・ランキング要約・
// 在席状況）を合言葉で読み、カードで一覧表示する。合言葉は入口・
// 観戦ページと共通の MuseWatchSecret ヘルパー経由で読み書きする。
import { WATCH_SECRET_SCRIPT } from "./watch_secret_browser.ts";
import { COVER_RETURN_LINK, COVER_RETURN_STYLE } from "./cover_navigation.ts";

export const MEMBERS_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse雀荘 選手名鑑</title>
<style>
  body { margin:0; background:#123524; color:#f2ead8; font-family:"Hiragino Maru Gothic ProN","Hiragino Sans",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:22px 14px 40px; }
  h1 { font-size:26px; letter-spacing:.12em; text-align:center; margin:8px 0 2px; color:#ffd968; }
  .sub { text-align:center; opacity:.85; font-size:13px; margin-bottom:18px; }
  .gate { background:#1d4a30; border:1px solid #ffd96866; border-radius:12px; padding:14px; text-align:center; }
  .gate input { font-size:16px; padding:7px 10px; border-radius:8px; border:1px solid #999; width:180px; }
  .gate button { font-size:15px; padding:7px 16px; border-radius:8px; border:0; background:#ffd968; color:#402d00; font-weight:bold; cursor:pointer; }
  h2.room { font-size:20px; color:#ffd968; letter-spacing:.08em; margin:22px 0 4px; }
  .member { display:flex; gap:12px; background:#1a4630; border:1px solid #ffd96855; border-radius:14px; padding:13px 14px; margin:10px 0; box-shadow:0 4px 12px rgba(0,0,0,.3); }
  .avatar { flex:0 0 auto; width:58px; height:58px; border-radius:50%; background:#0f2f1f; border:2px solid #ffd96888; display:flex; align-items:center; justify-content:center; font-size:28px; overflow:hidden; }
  .avatar img { width:100%; height:100%; object-fit:cover; display:block; }
  .mbody { flex:1 1 auto; min-width:0; }
  .mname { font-size:17px; font-weight:bold; }
  .chip { display:inline-block; background:#0f2f1f; border:1px solid #ffffff2e; border-radius:999px; padding:1px 9px; font-size:12px; margin-left:7px; vertical-align:2px; }
  .chip.seated { border-color:#ffd968; color:#ffd968; }
  .mrank { font-size:13px; opacity:.92; margin-top:2px; }
  .mbio { font-size:14px; line-height:1.65; margin-top:6px; white-space:pre-line; overflow-wrap:anywhere; }
  .empty { opacity:.75; font-size:14px; padding:8px 2px; }
  .note { font-size:12.5px; opacity:.8; line-height:1.7; margin-top:16px; }
  .note a { color:#ffd968; }
  #err { color:#ffb3c1; text-align:center; min-height:18px; font-size:13px; }
${COVER_RETURN_STYLE}
</style>
</head>
<body>
${COVER_RETURN_LINK}
<div class="wrap">
  <h1>📖 選手名鑑</h1>
  <div class="sub">登録したみなさんの紹介です。紹介文は Helper の bio コマンドで登録できます。</div>
  <div class="gate" id="gate" style="display:none">
    合言葉 <input id="pw" type="password" autocomplete="off"> <button id="go">入る</button>
  </div>
  <div id="err"></div>
  <div id="cards"></div>
  <div class="note">
    卓の状態と観戦は<a href="/t">入口ページ</a>からどうぞ。名鑑は卓ごとに分かれています（登録も卓ごとです）。
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
function avatarHtml(m) {
  if (m.avatar_url) return '<img src="' + esc(m.avatar_url) + '" alt="">';
  if (m.icon) return esc(m.icon);
  var name = m.display_name || "?";
  return esc(Array.from(name)[0] || "?");
}
function memberHtml(m) {
  var chips = "";
  if (m.status && m.status.kind === "seated") chips += '<span class="chip seated">着席中・席' + m.status.seat + "</span>";
  else if (m.status && m.status.kind === "waiting") chips += '<span class="chip">待ち列に並んでいます</span>';
  if (m.role === "spectator") chips += '<span class="chip">観戦' + (m.support_seat != null ? "・応援席" + m.support_seat : "") + "</span>";
  var rank;
  if (m.role === "spectator") rank = "";
  else if (m.ranking) rank = m.ranking.matches + "対局 ／ 平均順位 " + m.ranking.avg_rank + " ／ 最高 " + m.ranking.best_score + "点";
  else rank = "まだ対局なし";
  var bio = m.bio ? '<div class="mbio">' + esc(m.bio) + "</div>" : "";
  return '<div class="member"><div class="avatar">' + avatarHtml(m) + '</div>' +
    '<div class="mbody"><div class="mname">' + esc(m.display_name || "") + chips + "</div>" +
    (rank ? '<div class="mrank">' + esc(rank) + "</div>" : "") + bio + "</div></div>";
}
function load() {
  var secret = window.MuseWatchSecret.getPassword();
  var headers = { "X-Watch-Password": secret };
  var pending = ROOMS.length;
  var anyOk = false;
  ROOMS.forEach(function(room, idx) {
    fetch("/rooms/" + room.id + "/members", { headers: headers })
      .then(function(res) {
        if (res.status === 401) throw new Error("unauthorized");
        return res.json();
      })
      .then(function(data) {
        anyOk = true;
        var list = Array.isArray(data.members) ? data.members : [];
        var html = '<h2 class="room">' + room.name + "</h2>" +
          (list.length ? list.map(memberHtml).join("") : '<div class="empty">まだ登録がありません</div>');
        var slot = document.getElementById("card-" + idx);
        if (slot) slot.innerHTML = html;
      })
      .catch(function(e) {
        var slot = document.getElementById("card-" + idx);
        if (slot) slot.innerHTML = '<h2 class="room">' + room.name + '</h2><div class="empty">名鑑を取得できませんでした</div>';
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
  setInterval(load, 30000);
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
