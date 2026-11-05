/** Browser-only source, embedded by cover_page.ts. No additional asset route. */
export const COVER_CLIENT = String.raw`
(function () {
  "use strict";
  var api = window.MuseWatchSecret;
  var config = JSON.parse(document.getElementById("cover-config").textContent);
  var form = document.getElementById("gate-form");
  var input = document.getElementById("watch-password");
  var submit = document.getElementById("gate-submit");
  var error = document.getElementById("gate-message");
  var saved = document.getElementById("saved-box");
  var savedText = document.getElementById("saved-text");
  var cancelChange = document.getElementById("cancel-change");
  var links = Array.from(document.querySelectorAll("[data-building]"));
  var unlocked = false, generation = 0, active = null, disposed = false;

  function cancelPending() {
    generation++;
    if (active) active.abort();
    active = null;
    submit.disabled = config.probeRoomIds.length === 0;
    submit.textContent = "合言葉を確認して保存";
    form.removeAttribute("aria-busy");
  }
  function setLinks(ready) {
    unlocked = ready;
    links.forEach(function (link) {
      link.setAttribute("aria-disabled", ready ? "false" : "true");
      link.tabIndex = ready ? 0 : -1;
    });
    document.getElementById("destination-note").textContent = ready
      ? "行きたい建物を選んでください。各ページでは既存の認証が行われます。"
      : "合言葉を保存すると、建物を選べます。";
  }
  function fromStorage() {
    var result = api.readPassword();
    error.textContent = "";
    form.hidden = !!result.value;
    saved.hidden = !result.value;
    cancelChange.hidden = true;
    setLinks(!!result.value);
    if (result.value) {
      savedText.textContent = result.persistent
        ? (result.migrated ? "以前の合言葉を、このブラウザの保存領域へ移しました。" : "このブラウザに合言葉を保存済みです。")
        : "このタブの合言葉を使用中です。ブラウザへの永続保存はできませんでした。";
      if (result.warning === "legacy_cleanup_failed") savedText.textContent += " 古いタブ内データの整理は完了していません。";
    } else if (!config.probeRoomIds.length) {
      error.textContent = "確認先の卓が未設定です。監督側で既存の卓IDを設定してください。";
    } else if (result.warning === "storage_unavailable") {
      error.textContent = "ブラウザの保存領域を利用できません。サイトの保存設定を確認してください。";
    }
    submit.disabled = !config.probeRoomIds.length;
  }
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (disposed || submit.disabled) return;
    var value = input.value.trim();
    if (!value) { error.textContent = "合言葉を入力してください。"; input.focus(); return; }
    cancelPending();
    var run = generation;
    var request = new AbortController();
    active = request;
    submit.disabled = true;
    submit.textContent = "確認しています…";
    form.setAttribute("aria-busy", "true");
    error.textContent = "";
    var result = await api.verifyPassword(value, config.probeRoomIds, {signal: request.signal});
    if (disposed || run !== generation) return;
    active = null;
    submit.disabled = false;
    submit.textContent = "合言葉を確認して保存";
    form.removeAttribute("aria-busy");
    if (result.status === "accepted") {
      var write = api.savePassword(value);
      if (!write.ok) {
        error.textContent = "合言葉は受理されましたが、ブラウザへ保存できませんでした。保存設定を確認して、もう一度お試しください。";
        return;
      }
      input.value = "";
      fromStorage();
      savedText.textContent = "合言葉を確認し、このブラウザに保存しました。";
      if (write.warning) savedText.textContent += " 古いセッションの整理は未完了ですが、新しい保存値を優先します。";
      links[0].focus();
    } else if (result.status === "rejected") {
      error.textContent = "合言葉が受理されませんでした。入力を確認してください。";
      input.focus();
    } else if (result.status === "invalid_input") {
      error.textContent = "合言葉の入力を確認してください。空欄や改行は使えません。";
    } else if (result.status === "not_configured") {
      error.textContent = "確認先が未設定です。既存の卓IDと配信元を確認してください。";
    } else if (result.status !== "cancelled") {
      error.textContent = "現在、確認先に接続できません。保存済みの合言葉は変更していません。時間をおいてお試しください。";
    }
  });
  input.addEventListener("input", function () {
    if (active) { cancelPending(); error.textContent = "入力が変わったため、確認を中止しました。"; }
  });
  document.getElementById("change-secret").addEventListener("click", function () {
    cancelPending();
    form.hidden = false; saved.hidden = true; cancelChange.hidden = false;
    error.textContent = "新しい合言葉が受理されるまでは、現在の保存値を変更しません。";
    input.value = ""; setLinks(false); input.focus();
  });
  cancelChange.addEventListener("click", function () { cancelPending(); input.value = ""; fromStorage(); });
  document.getElementById("forget-secret").addEventListener("click", function () {
    cancelPending();
    var result = api.clearPassword();
    if (!result.ok) { savedText.textContent = "保存の解除ができませんでした。ブラウザのサイトデータ設定を確認してください。"; return; }
    input.value = ""; fromStorage();
    error.textContent = "このブラウザの合言葉を解除しました。チップ配置や観戦トークンは削除していません。";
    input.focus();
  });
  links.forEach(function (link) {
    link.addEventListener("click", function (event) {
      if (!unlocked) { event.preventDefault(); input.focus(); }
    });
  });
  document.querySelectorAll(".building-image").forEach(function (image) {
    function failed() {
      image.hidden = true;
      document.getElementById(image.dataset.fallback).hidden = false;
    }
    image.addEventListener("error", failed);
    if (image.complete && !image.naturalWidth) failed();
  });
  window.addEventListener("storage", function (event) {
    if (event.key !== "watchSecret") return;
    cancelPending(); input.value = ""; fromStorage();
  });
  window.addEventListener("pagehide", function () { disposed = true; cancelPending(); });
  window.addEventListener("pageshow", function (event) {
    disposed = false;
    if (event.persisted) { cancelPending(); input.value = ""; fromStorage(); }
  });
  fromStorage();
})();`;
