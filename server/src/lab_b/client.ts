/** New page behaviours only. All credential access delegates to the deployed helper. */
export const LAB_CLIENT=String.raw`
(function(host){
 'use strict';
 var cfg=JSON.parse(document.getElementById('lab-config').textContent);
 var api=host.MuseWatchSecret;
 var gate=document.getElementById('lab-gate');
 var form=document.getElementById('lab-gate-form');
 var input=document.getElementById('lab-password');
 var submit=document.getElementById('lab-gate-submit');
 var retry=document.getElementById('lab-gate-retry');
 var message=document.getElementById('lab-gate-message');
 var content=document.getElementById('lab-content');
 var badge=document.getElementById('lab-auth-status');
 var status=document.getElementById('lab-operation-status');
 var workbench=document.getElementById('lab-workbench');
 var shell=document.getElementById('lab-shell');
 var frame=null, dirty=false, ready=false, generation=0, authAbort=null, assetAbort=null, disposed=false;
 var objectUrls=[], assetGeneration=0;
 function cancelAssets(){assetGeneration++;if(assetAbort)assetAbort.abort();assetAbort=null;}
 function setReady(value){
  ready=value;content.hidden=!value;gate.hidden=value;
  badge.dataset.status=value?'accepted':'locked';
  badge.textContent=value?'合言葉を確認済み':'合言葉を確認';
 }
 function cancelPending(){
  generation++;if(authAbort)authAbort.abort();cancelAssets();
  authAbort=null;submit.disabled=false;retry.disabled=false;
  form.removeAttribute('aria-busy');
 }
 function readPassword(){
  if(!api||typeof api.getPassword!=='function')throw Error('helper_missing');
  return api.getPassword();
 }
 function helperAvailable(){return !!(api&&typeof api.getPassword==='function'&&typeof api.verifyPassword==='function'&&typeof api.savePassword==='function');}
 async function authenticate(value,fromForm){
  cancelPending();var myGeneration=generation;setReady(false);
  if(!helperAvailable()){
   message.textContent='資格ヘルパーを読み込めませんでした。表紙に戻るか、管理者へ確認してください。';
   submit.disabled=true;retry.disabled=true;return;
  }
  if(!cfg.probeRoomIds.length){
   message.textContent='確認先の卓が設定されていません。合言葉を新しく作らず、管理者へ確認してください。';submit.disabled=true;return;
  }
  if(!value){message.textContent='表紙と同じ合言葉を入力してください。';return;}
  authAbort=new AbortController();submit.disabled=true;retry.disabled=true;form.setAttribute('aria-busy','true');
  message.textContent='既存の卓で合言葉を確認しています…';badge.textContent='確認中';
  var before;try{before=readPassword();}catch(_){before='';}
  try{
   var result=await api.verifyPassword(value,cfg.probeRoomIds,{signal:authAbort.signal,timeoutMs:8000});
   if(disposed||myGeneration!==generation)return;
   if(result.status==='accepted'){
    // A newer credential changed elsewhere takes precedence over this old response.
    if(readPassword()!==before){fromStorage();return;}
    var warning='';
    if(fromForm){
     var saved=api.savePassword(value);
     if(!saved.ok||!saved.persistent)warning='合言葉は確認できましたが、ブラウザへ保存できませんでした。この画面だけ利用できます。';
    }
    input.value='';setReady(true);message.textContent='';status.textContent=warning;
   }else if(result.status==='rejected'){
    message.textContent='合言葉を確認できませんでした。入力し直すか、表紙で変更してください。保存済みの資格は削除していません。';
   }else if(result.status==='not_configured'){
    message.textContent='合言葉の確認先を設定できませんでした。管理者へ確認してください。';
   }else if(result.status==='invalid_input'){
    message.textContent='合言葉の入力を確認してください。';
   }else if(result.status!=='cancelled'){
    message.textContent='卓へ接続できませんでした。合言葉の誤りとは限りません。通信を確認して再試行してください。';
   }
  }catch(_){
   if(myGeneration===generation&&!disposed)message.textContent='合言葉の確認中に通信できませんでした。保存済みの資格は変更していません。';
  }finally{
   if(myGeneration===generation){authAbort=null;submit.disabled=false;retry.disabled=false;form.removeAttribute('aria-busy');if(!ready)badge.textContent='未確認';}
  }
 }
 function fromStorage(){
  setReady(false);
  if(!helperAvailable()){authenticate('',false);return;}
  try{authenticate(readPassword(),false);}catch(_){message.textContent='保存済みの資格を読み取れません。表紙から確認してください。';}
 }
 form.addEventListener('submit',function(e){e.preventDefault();authenticate(input.value.trim(),true);});
 input.addEventListener('input',function(){if(authAbort){cancelPending();badge.textContent='未確認';message.textContent='入力を変更しました。確認して入るを押してください。';}});
 retry.addEventListener('click',function(){fromStorage();});
 function getAsset(id){var a=cfg.assets.find(function(a){return a.id===id;});if(!a)throw Error('asset_missing');return a;}
 async function assetBytes(id){
  if(!ready)throw Error('auth_required');
  cancelAssets();assetAbort=new AbortController();
  var operation=assetGeneration;
  var token=generation;var asset=getAsset(id);
  var result=await host.fetch(asset.url,{method:'GET',credentials:'omit',mode:'same-origin',redirect:'error',cache:'no-store',signal:assetAbort.signal});
  if(!result.ok||result.redirected)throw Error('asset_unavailable');
  var bytes=await result.arrayBuffer();
  if(token!==generation||operation!==assetGeneration||!ready||disposed)throw Error('stale_request');
  if(bytes.byteLength!==asset.bytes)throw Error('integrity');
  if(!host.crypto||!host.crypto.subtle)throw Error('secure_context');
  var digest=Array.from(new Uint8Array(await host.crypto.subtle.digest('SHA-256',bytes))).map(function(x){return x.toString(16).padStart(2,'0');}).join('');
  if(digest!==asset.sha256)throw Error('integrity');
  if(token!==generation||operation!==assetGeneration||!ready||disposed)throw Error('stale_request');
  return {asset:asset,bytes:bytes};
 }
 function assetError(error){
  if(error&&error.name==='AbortError')return;
  var m=error&&error.message;
  if(m==='stale_request')return;
  status.textContent=m==='secure_context'?'安全な接続（HTTPSまたはlocalhost）で開き直してください。':
   m==='integrity'?'配布データのハッシュが一致しません。実行・保存を中止しました。管理者へ確認してください。':
   m==='stale_request'||m==='auth_required'?'合言葉を確認してから、もう一度選んでください。':'配布データを取得できませんでした。入力中の配置は変更していません。';
 }
 async function download(id){
  try{
   status.textContent='配布データを確認しています…';var value=await assetBytes(id);
   var url=URL.createObjectURL(new Blob([value.bytes],{type:value.asset.contentType}));objectUrls.push(url);
   var link=document.createElement('a');link.href=url;link.download=value.asset.filename;document.body.appendChild(link);link.click();link.remove();
   setTimeout(function(){URL.revokeObjectURL(url);objectUrls=objectUrls.filter(function(x){return x!==url;});},60000);
   status.textContent='SHA-256を確認し、ダウンロードを開始しました。'+value.asset.filename;
  }catch(error){assetError(error);}
 }
 function decorateStudio(html,sample){
  // Only the verified, unmodified shipped HTML enters this sandbox. No credential or live game state enters it.
  var n=cfg.nonce;
  var policy="default-src 'none'; script-src 'nonce-"+n+"'; style-src 'nonce-"+n+"'; style-src-attr 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
  html=html.replace(/<style\b/g,'<style nonce="'+n+'"').replace(/<script\b/g,'<script nonce="'+n+'"');
  html=html.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="'+policy+'">');
  // The sample is from a fixed enum. This extra UI action does not edit the original studio/engine bytes.
  var boot="window.addEventListener('load',function(){var p=document.getElementById('example-picker');if(p){p.value="+JSON.stringify(sample)+";p.dispatchEvent(new Event('change',{bubbles:true}));}});";
  return html.replace('</body>','<script nonce="'+n+'">'+boot+'<\/script></body>');
 }
 async function openStudio(sample){
  if(!['unseen','tanyao','menzen'].includes(sample))return;
  if(dirty&&!window.confirm('現在の配置は自動保存されません。必要ならキャンセルしてスタジオの「保存」を使ってください。選び直しますか？'))return;
  try{
   status.textContent='スタジオの配布ハッシュを確認しています…';var value=await assetBytes('studio');
   var html=new TextDecoder('utf-8',{fatal:true}).decode(value.bytes);
   var next=document.createElement('iframe');next.title='牌チップスタジオ v0.3候補（ローカル試験）';
   next.id='lab-studio-frame';next.setAttribute('sandbox','allow-scripts allow-downloads allow-modals');
   next.referrerPolicy='no-referrer';next.srcdoc=decorateStudio(html,sample);
   if(frame)frame.remove();frame=next;
   document.getElementById('lab-frame-host').appendChild(frame);
   dirty=true;workbench.hidden=false;shell.classList.add('studio-active');
   document.getElementById('lab-overview').hidden=true;
   status.textContent='ブラウザ内の試験です。卓への接続・自動保存はありません。閉じる前に配置を保存してください。';
   document.getElementById('lab-close-studio').focus();
  }catch(error){assetError(error);}
 }
 document.querySelectorAll('[data-download]').forEach(function(el){el.addEventListener('click',function(){download(el.dataset.download);});});
 document.querySelectorAll('[data-open-studio]').forEach(function(el){el.addEventListener('click',function(){openStudio(el.dataset.openStudio);});});
 document.getElementById('lab-close-studio').addEventListener('click',function(){
  if(dirty&&!confirm('配置は自動保存されません。必要なJSONを保存しましたか？スタジオを閉じますか？'))return;
  cancelAssets();if(frame)frame.remove();frame=null;dirty=false;workbench.hidden=true;shell.classList.remove('studio-active');
  document.getElementById('lab-overview').hidden=false;status.textContent='スタジオを閉じました。保存したJSONは手元のファイルから再度読み込めます。';
  var first=document.querySelector('[data-open-studio]');if(first)first.focus();
 });
 window.addEventListener('beforeunload',function(event){if(dirty){event.preventDefault();event.returnValue='';}});
 window.addEventListener('storage',function(event){
  if(event.key==='watchSecret'||event.key===null){cancelPending();input.value='';fromStorage();}
 });
 window.addEventListener('pagehide',function(){disposed=true;cancelPending();objectUrls.forEach(function(u){URL.revokeObjectURL(u);});objectUrls=[];});
 window.addEventListener('pageshow',function(event){disposed=false;if(event.persisted){cancelPending();input.value='';fromStorage();}});
 // No direct credential storage, no server writes and no table lifecycle calls.
 fromStorage();
})(window);`;
