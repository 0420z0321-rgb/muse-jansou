/**
 * Master invitation tool (static HTML, no credential persistence).
 * Served by the existing Worker at GET /invite.
 * The room-specific Master token is kept only in the password input and
 * transmitted solely as an Authorization header to POST /rooms/{id}/invites.
 */
export const INVITE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Muse雀荘・招待発行</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#132e25;color:#f2f4e9;margin:0;padding:22px}
main{max-width:610px;margin:auto}h1{font-size:1.5rem;font-weight:650}
.card{background:#204638;border:1px solid #47765e;border-radius:12px;padding:20px}
label{display:block;margin:14px 0 6px;font-weight:600}
input,select,button{font:inherit;border-radius:7px;padding:10px;max-width:100%}
input,select{width:100%;background:#102c23;border:1px solid #84a995;color:white}
button{border:0;background:#e5b34b;color:#252820;font-weight:700;cursor:pointer}
button:disabled{opacity:.55;cursor:wait}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.hint{font-size:.88rem;line-height:1.65;color:#c6d4c8}
.output{margin-top:18px;padding:12px;background:#102c23;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
#code{font-family:ui-monospace,monospace;user-select:all;color:#ffe2a2}
#message{min-height:1.4em;margin-top:14px}
#message.error{color:#ffbaba}#message.ok{color:#b9edc9}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
<h1>🀄 Muse雀荘・招待コード発行</h1>
<p class="hint">卓ごとのMaster資格で招待を発行します。このページは静的です。入力したMasterトークンをブラウザの保存領域に記録せず、発行APIの認証ヘッダにのみ使用します。</p>
<div class="card">
<form id="form" autocomplete="off">
<label for="room">卓ID</label>
<input id="room" required placeholder="卓ID" spellcheck="false" maxlength="128">
<label for="master">この卓のMasterトークン</label>
<input id="master" type="password" required spellcheck="false" autocomplete="off" placeholder="Masterトークン（表示・保存しません）">
<label for="role">招待の種類</label>
<select id="role">
<option value="player">Player（指定席へ参加）</option>
<option value="spectator">Spectator（応援席なし・外野）</option>
</select>
<div id="seatLine">
<label for="seat">Playerの席</label>
<select id="seat"><option value="0">席0</option><option value="1">席1</option><option value="2">席2</option><option value="3">席3</option></select>
</div>
<div class="row">
<div><label for="lifetime">有効期間（秒）</label><input id="lifetime" type="number" min="60" max="2592000" step="1" value="86400" required></div>
<div><label for="uses">最大使用回数</label><input id="uses" type="number" min="1" max="100" step="1" value="1" required></div>
</div>
<p class="hint">招待コードは発行時にだけ表示されます。配布前にコピーして安全な場所へ保管してください。</p>
<button id="issue" type="submit">招待を発行</button>
</form>
<div id="message" role="status" aria-live="polite"></div>
<div id="out" class="output" hidden>
<div>発行した招待コード</div>
<p id="code"></p>
<div id="details" class="hint"></div>
<button id="copy" type="button">コードをコピー</button>
</div>
</div>
</main>
<script>
(function(){
  'use strict';
  var el=function(id){return document.getElementById(id);};
  var role=el('role'), form=el('form'), message=el('message'), output=el('out');
  var lastCode='';
  role.addEventListener('change',function(){el('seatLine').hidden=role.value!=='player';});
  function notice(s,bad){message.textContent=s;message.className=bad?'error':'ok';}
  form.addEventListener('submit',async function(e){
    e.preventDefault();
    output.hidden=true;lastCode='';el('code').textContent='';
    var room=el('room').value.trim(), token=el('master').value.trim();
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(room)){notice('卓IDの形式が不正です。',true);return;}
    if(!token){notice('Masterトークンが必要です。',true);return;}
    var seconds=Number(el('lifetime').value), uses=Number(el('uses').value);
    if(!Number.isInteger(seconds)||seconds<60||seconds>2592000||!Number.isInteger(uses)||uses<1||uses>100){notice('期限または使用回数が範囲外です。',true);return;}
    var request={role:role.value,expires_in_seconds:seconds,max_uses:uses};
    request.seat=role.value==='player'?Number(el('seat').value):null;
    el('issue').disabled=true;
    notice('発行しています…',false);
    try{
      var res=await fetch('/rooms/'+encodeURIComponent(room)+'/invites',{
        method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify(request),cache:'no-store',credentials:'omit',redirect:'error'
      });
      var data=await res.json();
      if(!res.ok || typeof data.invite_code!=='string'){
        notice('HTTP '+res.status+' / '+String(data.error||'発行に失敗しました'),true);return;
      }
      lastCode=data.invite_code;
      el('code').textContent=lastCode;
      var expires=Number.isFinite(Number(data.expires_at))?new Date(Number(data.expires_at)).toLocaleString():'不明';
      el('details').textContent=(request.role==='player'?'Player席'+request.seat:'外野Spectator')+' / 期限: '+expires+' / 最大利用: '+uses+'回';
      output.hidden=false;
      notice('招待を発行しました。コードをコピーしてください。',false);
    }catch(err){notice('通信エラー（発行された可能性もあります）。主催に確認してください。',true);}
    finally{el('issue').disabled=false;}
  });
  el('copy').addEventListener('click',async function(){
    if(!lastCode)return;
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){
        await navigator.clipboard.writeText(lastCode);
      }else{
        var r=document.createRange();r.selectNodeContents(el('code'));var sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);
        if(!document.execCommand('copy')) throw Error('copy');sel.removeAllRanges();
      }
      notice('招待コードをコピーしました。',false);
    }catch(err){notice('自動コピーできませんでした。コードを選択してコピーしてください。',true);}
  });
})();
</script>
</body>
</html>`;
