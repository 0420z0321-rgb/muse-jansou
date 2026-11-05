/* Browser-only view/editor. Engine functions are compiled from chip_engine.ts and inlined into this file. */
const $=(id)=>document.getElementById(id);
const clone=(o)=>JSON.parse(JSON.stringify(o));
const escapeHtml=(s)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const typeName=(t)=>t.replace(/^MJ_/,"");
const C=156, R=102, NODE_W=132;
function boardSize(){return {columns:Math.max(7,program.layout?.columns??7,...program.nodes.map(n=>n.x+2)),rows:Math.max(6,program.layout?.rows??6,...program.nodes.map(n=>n.y+2))};}
const labels={
 "MJ_対象指定":"対象指定","MJ_状態入力":"状態入力","MJ_牌属性入力":"牌属性入力","MJ_枚数入力":"枚数入力","MJ_履歴入力":"履歴入力",
 "MJ_候補列挙":"候補列挙","MJ_候補移動":"候補移動","MJ_仮状態評価":"仮状態評価","MJ_シャンテン入力":"シャンテン入力",
 "MJ_面子分解列挙":"面子分解列挙","MJ_面子分解移動":"面子分解移動","MJ_面子情報入力":"面子情報入力",
 "MJ_カウンタ操作":"カウンタ操作","MJ_カウンタ判断":"カウンタ判断","MJ_点数算出":"点数算出","MJ_行動":"行動",
 "MJ_門前・鳴き状態判断":"門前・鳴き状態判断",
 "START":"START","JUMP":"ジャンプ","CALL":"呼出","RETURN":"復帰","END":"終了"};
const menzenTargets={self:"自家",kamicha:"上家",toimen:"対面",shimocha:"下家"};
const menzenConditions={has_open:"鳴きあり（公開面子1組以上）",menzen:"門前維持（公開面子0組）",count:"公開面子数をしきい値と比較"};
const menzenCompare={eq:"等しい =",ne:"等しくない ≠",gt:"より大きい >",ge:"以上 ≥",lt:"より小さい <",le:"以下 ≤"};
function chipNumber(t){const i=CHIP_TYPES.indexOf(t);return i>=0&&i<16?String(i+1).padStart(2,"0"):EXTENSION_CHIP_TYPES.includes(t)?"+1":"CTRL";}
const menus={
 suit:{man:"萬子 (36)",pin:"筒子 (36)",sou:"索子 (36)",honor:"字牌 (28)"},
 group:{suit:"色別",tile:"指定牌",attribute:"牌属性"},
 scope:{hand:"手牌",river:"河（捨牌履歴）",meld:"副露",visible:"見える牌全体",unseen:"未見（山残数ではない）"},
 attribute:{yaochu:"么九牌（1・9・字）",terminal:"1・9牌",middle:"2〜8数牌",honor:"字牌",wind:"風牌",dragon:"三元牌",red:"赤牌",green:"緑一色対象"},
 discardMethod:{all:"すべて",tedashi:"手出しのみ",tsumogiri:"ツモ切りのみ"},
 stateField:{turn_count:"巡目／手数",turn:"手番の席",dealer:"親の席",is_dealer:"対象が親",score:"持ち点",score_gap:"指定席との差",rank:"順位",riichi:"リーチ状態",honba:"本場",kyotaku:"供託",round_wind:"場風",meld_count:"副露面子数",menzen:"門前（暗槓可）",ron:"ロン状態",tsumo:"ツモ状態"},
 tileField:{id:"実牌ID",kind:"34種ID（赤統合）",suit:"牌色（0萬/1筒/2索/3字）",number:"数字",red:"赤牌",yaochu:"么九牌",honor:"字牌",wind:"風牌",dragon:"三元牌"},
 historyField:{tile:"捨牌ID",kind:"種類ID",suit:"牌色",tsumogiri:"ツモ切り=1／手出し=0",called:"鳴かれたか",turn:"捨牌の巡"},
 patternField:{pair_kind:"雀頭の牌種",pair_suit:"雀頭の色",meld_count:"面子総数",sequence_count:"順子数",triplet_count:"刻子数",quad_count:"槓子数",wait_type:"待ち形 1単騎/2双碰/3嵌張/4辺張/5両面",winning_meld_index:"和了牌の所属面子",meld_kind:"指定面子の種別",meld_start:"指定面子の開始牌",meld_suit:"指定面子の色",meld_open:"指定面子の明暗"},
 arithmetic:{assign:"代入 ←",add:"加算 +",sub:"減算 −",mul:"乗算 ×",div:"除算 ÷",mod:"剰余 mod",min:"小さい方 min",max:"大きい方 max",and:"ビットAND &",or:"ビットOR |",xor:"ビットXOR ^",not:"ビットNOT ~",shl:"左シフト <<",shr:"右シフト >>"},
 compare:{eq:"等しい =",ne:"等しくない ≠",gt:"より大きい >",ge:"以上 ≥",lt:"より小さい <",le:"以下 ≤",bit_all:"全ビットを持つ",bit_any:"一部ビットを持つ"},
 action:{discard:"打牌",riichi:"リーチ打牌",tsumo:"ツモ和了",ron:"ロン和了",chi:"チー",pon:"ポン",ankan:"暗槓",kakan:"加槓",daiminkan:"大明槓",pass:"パス",kyushu_kyuhai:"九種九牌"},
 source:{counter:"カウンタ",constant:"定数",input:"直前の入力値"},
 target:{self:"自家",seat:"指定席",candidate:"選択中の打牌候補",tile:"指定牌",decomposition:"選択中の面子分解"}
};
const tileOptions=Object.fromEntries(Array.from({length:37},(_,i)=>[String(i),`${String(i).padStart(2,'0')} · ${tileLabel(i)}`]));
const seatOptions={selected:"現在の対象席",0:"東家側の座席0",1:"座席1",2:"座席2",3:"座席3"};
let program=clone(SAMPLE_DATA.unseen.program), state=clone(SAMPLE_DATA.unseen.state);
let selected='count', activeType='MJ_枚数入力', machine=null, inspectedStep=null, linkFrom=null, interval=null, exampleMode='unseen', invalidTanyao=false;
let lastChanged=new Set(); let lastToastTimer=null;
function notify(message,err=false){const el=$('toast');el.textContent=message;el.style.borderColor=err?'#d47c83':'#56c8af';el.classList.add('show');clearTimeout(lastToastTimer);lastToastTimer=setTimeout(()=>el.classList.remove('show'),3200);}
function stopPlay(){if(interval){clearInterval(interval);interval=null;$('btn-play').textContent='連続再生';}}
function resetRuntime(){stopPlay();inspectedStep=null;lastChanged=new Set();try{machine=newMachine(program,state);}catch(e){machine=null;notify(String(e.message),true);}renderStatus();renderCounters();renderTrace();renderBoard();}
function loadExample(which){exampleMode=which;invalidTanyao=false;$('example-picker').value=which;program=clone(SAMPLE_DATA[which].program);state=clone(SAMPLE_DATA[which].state);selected=which==='menzen'?'naki':'count';activeType=which==='menzen'?'MJ_門前・鳴き状態判断':'MJ_枚数入力';linkFrom=null;renderAll();notify({unseen:'未見索子の例を読込',tanyao:'タンヤオの例を読込',menzen:'暗槓だけの手は門前維持：新チップの例を読込'}[which]);}
function setTanyaoFailure(){loadExample('tanyao');invalidTanyao=true;state.hands[0].splice(0,3,0,1,2);resetRuntime();renderBoard();notify('完成形の234mを123mへ変更。タンヤオはNOになります');}
function describeNode(n){const p=n.params;
 if(n.type==='MJ_枚数入力'){const v=p.group==='suit'?menus.suit[p.suit]:p.group==='attribute'?menus.attribute[p.attribute]:tileLabel(Number(p.tile??0));return `${p.output||'?'} ← ${menus.scope[p.scope]||p.scope} / ${v||''}`;}
 if(n.type==='MJ_カウンタ判断')return `${formatOp(p.left)} ${({'eq':'=','ne':'≠','ge':'≥','le':'≤','gt':'>','lt':'<','bit_all':'&=','bit_any':'&'}[p.op]||p.op)} ${formatOp(p.right)}`;
 if(n.type==='MJ_カウンタ操作')return `${p.output||'?'} ← ${formatOp(p.left)} ${menus.arithmetic[p.op]?.split(' ').at(-1)||p.op||''} ${p.op==='assign'||p.op==='not'?'':formatOp(p.right)}`;
 if(n.type==='MJ_門前・鳴き状態判断')return `${menzenTargets[p.target]||'?'} / ${p.condition==='count'?`公開 ${menzenCompare[p.op]?.split(' ').at(-1)||'?'} ${p.threshold}組`:p.condition==='menzen'?'門前維持':'鳴きあり'}`;
 if(n.type==='MJ_行動')return menus.action[p.action]||p.action;
 if(n.type==='END')return p.label||'終了';
 if(n.type==='MJ_状態入力'||n.type==='MJ_牌属性入力'||n.type==='MJ_履歴入力'||n.type==='MJ_面子情報入力'||n.type==='MJ_シャンテン入力')return `${p.output||'?'} ← ${p.field||p.shape||'状態'}`;
 return p.mode||p.target||p.label||'設定を開く';
}
function formatOp(o){if(!o)return '?';if(o.source==='counter')return o.name||'?';if(o.source==='input')return '入力';if(o.source==='constant')return String(o.value);return '?';}
function classification(t){if(['START','END','JUMP','CALL','RETURN'].includes(t))return 'control';if(['MJ_カウンタ判断','MJ_門前・鳴き状態判断'].includes(t))return 'branch';if(t==='MJ_カウンタ操作')return 'calc';return 'normal';}
function renderPalette(){const query=$('palette-search').value.trim().toLowerCase(),p=$('palette');p.replaceChildren();
 [['情報・構造',CHIP_TYPES.slice(0,12)],['演算・行動',CHIP_TYPES.slice(12,16)],['状態判断（追加）',EXTENSION_CHIP_TYPES],['共通制御',CHIP_TYPES.slice(16)]].forEach(([group,arr])=>{
  const filtered=arr.filter(t=>t.toLowerCase().includes(query) || labels[t].toLowerCase().includes(query));if(!filtered.length)return;
  const h=document.createElement('h4');h.textContent=group;p.append(h);
  filtered.forEach(t=>{const b=document.createElement('button');b.className='chip-choice'+(activeType===t?' active':'');b.type='button';const i=CHIP_TYPES.indexOf(t);b.innerHTML=`<span class="chip-number">${chipNumber(t)==='CTRL'?'•':chipNumber(t)}</span><span class="name">${escapeHtml(labels[t])}</span>`;b.title=t;b.addEventListener('click',()=>{activeType=t;renderPalette();notify(`${labels[t]}を選択。空マスをクリックで配置できます`);});p.append(b);});
 });
}
function drawLinks(){const svg=$('links');while(svg.firstChild)svg.removeChild(svg.firstChild);
 const svgEl=(tag,attrs)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,v] of Object.entries(attrs))e.setAttribute(key,String(v));return e;};
 const defs=svgEl('defs',{});for(const [id,color] of [['next','#76acd5'],['yes','#7de5ab'],['no','#e7938e'],['target','#d6b0ff']]){const marker=svgEl('marker',{id:`arrow-${id}`,markerWidth:8,markerHeight:8,refX:7,refY:4,orient:'auto',markerUnits:'userSpaceOnUse'});marker.append(svgEl('path',{d:'M0,0 L8,4 L0,8 z',fill:color}));defs.append(marker);}svg.append(defs);
 const byId=Object.fromEntries(program.nodes.map(n=>[n.id,n]));
 for(const from of program.nodes){for(const [port,id] of Object.entries(from.routes)){const to=byId[id];if(!to)continue;
 const x1=from.x*C+12+NODE_W-1,y1=from.y*R+54,x2=to.x*C+14,y2=to.y*R+54;
 const dx=x2-x1;let d;if(dx>25){const b=Math.min(100,Math.max(32,Math.abs(dx)*.42));d=`M${x1} ${y1} C${x1+b} ${y1} ${x2-b} ${y2} ${x2} ${y2}`;}
 else{const mid=Math.min(y1,y2)-33-((port==='no')?12:0);d=`M${x1} ${y1} C${x1+56} ${mid} ${x2-55} ${mid} ${x2} ${y2}`;}
 const kind=(port==='yes'||port==='no'||port==='target')?port:'next';const path=svgEl('path',{d,stroke:kind==='yes'?'#7de5ab':kind==='no'?'#e7938e':kind==='target'?'#d6b0ff':'#76acd5',fill:'none','stroke-width':port==='yes'||port==='no'?2.3:1.8,'stroke-opacity':.82,'marker-end':`url(#arrow-${kind})`});svg.append(path);
 const text=svgEl('text',{x:(x1+x2)/2,y:(y1+y2)/2-6,fill:kind==='yes'?'#8deec6':kind==='no'?'#ffb1a8':'#a5cadd','font-size':10,'text-anchor':'middle'});text.textContent=port==='yes'?'Y':port==='no'?'N':port==='target'?'CALL':'';svg.append(text);
 }}
}
function renderBoard(){const container=$('nodes');container.replaceChildren();
 const dims=boardSize();$('board').style.width=`${dims.columns*C}px`;$('board').style.height=`${dims.rows*R}px`;$('links').setAttribute('width',String(dims.columns*C));$('links').setAttribute('height',String(dims.rows*R));
 const last=machine?.trace.at(-1)?.nodeId;for(const n of program.nodes){const el=document.createElement('div');el.className=`board-node ${classification(n.type)}${selected===n.id?' selected':''}${machine?.pc===n.id?' active':''}${last===n.id?' pass':''}`;el.style.left=`${n.x*C+12}px`;el.style.top=`${n.y*R+12}px`;el.dataset.nodeId=n.id;el.setAttribute('role','button');el.tabIndex=0;
 const index=CHIP_TYPES.indexOf(n.type);el.innerHTML=`<div class="node-index">${chipNumber(n.type)} · ${escapeHtml(n.id)}</div><div class="node-title">${escapeHtml(labels[n.type])}</div><div class="node-sub">${escapeHtml(describeNode(n))}</div>`;
 let down=null;el.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY};el.setPointerCapture(e.pointerId);});
 el.addEventListener('pointerup',e=>{if(!down)return;const diff=Math.hypot(e.clientX-down.x,e.clientY-down.y);down=null;if(diff>10&&!linkFrom){const rect=$('board').getBoundingClientRect();const x=Math.max(0,Math.min(boardSize().columns-1,Math.floor((e.clientX-rect.left)/C))),y=Math.max(0,Math.min(boardSize().rows-1,Math.floor((e.clientY-rect.top)/R)));if(!program.nodes.some(q=>q.id!==n.id&&q.x===x&&q.y===y)){n.x=x;n.y=y;resetRuntime();renderBoard();}else notify('移動先には既にチップがあります',true);return;}});
 el.addEventListener('click',e=>{e.stopPropagation();if(linkFrom){const origin=program.nodes.find(q=>q.id===linkFrom.nodeId);if(origin){origin.routes[linkFrom.port]=n.id;notify(`${origin.id} / ${linkFrom.port} → ${n.id}`);}linkFrom=null;resetRuntime();renderInspector();renderBoard();return;}selectNode(n.id);});
 el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click();}});container.append(el);
 }
 drawLinks();const connect=$('connect-indicator');connect.textContent=linkFrom?`${linkFrom.nodeId} : ${linkFrom.port} → 接続先チップをクリック`:'';$('btn-cancel-link').hidden=!linkFrom;
 const hand=state.hands[state.observer_seat];$('board-title').textContent=program.name;$('board-desc').textContent=`配置JSON: ${program.id} / ${program.nodes.length}チップ / マウスドラッグで移動可能`;
 $('board-foot-left').textContent=`自家手牌 ${hand.length}枚: ${hand.map(tileLabel).join(' · ')}`;
 $('board-foot-right').textContent=`${dims.columns}列 × ${dims.rows}行 / 観測席 ${state.observer_seat} / 未見≠山の残り`;
}
function selectNode(id){selected=id;linkFrom=null;renderBoard();renderInspector();}
function defaultParams(type){
 const out={output:program.counters[0]?.name||'CNT-A'};const ct={source:'counter',name:out.output},num={source:'constant',value:0};
 switch(type){
 case 'MJ_対象指定':return {target:'self',seat:0,tile:0};case 'MJ_状態入力':return {...out,field:'turn_count',seat:'selected',targetSeat:0};
 case 'MJ_牌属性入力':return {...out,tile:0,field:'suit'};
 case 'MJ_枚数入力':return {...out,scope:'unseen',group:'suit',suit:'sou',tile:18,attribute:'yaochu',seat:'selected',discardMethod:'all',physicalRed:false};
 case 'MJ_履歴入力':return {...out,seat:'selected',offset:0,field:'tsumogiri'};
 case 'MJ_候補列挙':return {mode:'discard'};case 'MJ_候補移動':return {mode:'first',...out};
 case 'MJ_仮状態評価':return {mode:'discard'};case 'MJ_シャンテン入力':return {...out,shape:'min'};
 case 'MJ_面子分解列挙':return {...out};case 'MJ_面子分解移動':return {mode:'first',...out};
 case 'MJ_面子情報入力':return {...out,field:'sequence_count',index:0};
 case 'MJ_カウンタ操作':return {...out,op:'add',left:ct,right:{source:'constant',value:1}};
 case 'MJ_カウンタ判断':return {op:'ge',left:ct,right:num};
 case 'MJ_門前・鳴き状態判断':return {target:'self',condition:'has_open',op:'ge',threshold:1};
 case 'MJ_点数算出':return {...out,mode:'ron',han:{source:'constant',value:2},fu:{source:'constant',value:30}};
 case 'MJ_行動':return {action:'pass',tileSource:'candidate',tile:0};
 case 'END':return {label:'終了'};
 default:return {};
 }
}
$('board').addEventListener('click',e=>{
 if(e.target.closest('.board-node'))return;
 if(linkFrom){notify('接続先はチップをクリックして選択してください',true);return;}
 const rect=$('board').getBoundingClientRect();const x=Math.floor((e.clientX-rect.left)/C),y=Math.floor((e.clientY-rect.top)/R);
 const dims=boardSize();if(x<0||y<0||x>=dims.columns||y>=dims.rows)return;if(program.nodes.some(n=>n.x===x&&n.y===y)){notify('そのマスには既にチップがあります');return;}
 if(program.nodes.length>=8000) {notify('実行系の安全上限: 8000ノード',true);return;}
 let id=`node_${Date.now().toString(36)}`;while(program.nodes.some(n=>n.id===id))id+='_x';const node={id,type:activeType,x,y,params:defaultParams(activeType),routes:{}};program.nodes.push(node);selected=id;resetRuntime();renderInspector();notify(`${labels[activeType]}を配置しました。矢印を接続してください`);
});
const counterChoices=()=>Object.fromEntries(program.counters.map(c=>[c.name,c.name]));
function field(label,key,value,opts,handler,help=''){
 const wrap=document.createElement('div');wrap.className='field';const l=document.createElement('label');l.textContent=label;wrap.append(l);let ctl;
 if(opts){ctl=document.createElement('select');for(const [v,name] of Object.entries(opts)){const op=document.createElement('option');op.value=v;op.textContent=name;ctl.append(op);}ctl.value=String(value??'');if(!Array.from(ctl.options).some(opt=>opt.value===ctl.value))ctl.selectedIndex=0;}
 else{ctl=document.createElement('input');ctl.type=typeof value==='number'?'number':'text';ctl.value=value??'';if(ctl.type==='number')ctl.step='any';}
 ctl.id=`p-${key.replaceAll('.','_')}`;ctl.addEventListener('change',()=>{const next=opts?ctl.value:ctl.type==='number'?Number(ctl.value):ctl.value;handler(next);});wrap.append(ctl);
 if(help){const h=document.createElement('div');h.className='annot';h.textContent=help;wrap.append(h);}return wrap;
}
function addP(parent,n,label,key,opts=null,help=''){parent.append(field(label,key,n.params[key],opts,v=>{n.params[key]=v;resetRuntime();renderInspector();},help));}
function opEditor(parent,n,key,label){let o=n.params[key];if(!o||typeof o!=='object'){o={source:'constant',value:0};n.params[key]=o;}
 const wrap=document.createElement('div');wrap.className='operand';const head=document.createElement('p');head.className='operand-head';head.textContent=label;wrap.append(head);
 wrap.append(field('入力の種類',key+'.source',o.source,menus.source,v=>{o.source=v;if(v==='counter')o.name=program.counters[0]?.name||'CNT-A';if(v==='constant')o.value=0;resetRuntime();renderInspector();}));
 if(o.source==='counter')wrap.append(field('参照するカウンタ',key+'.name',o.name,counterChoices(),v=>{o.name=v;resetRuntime();renderInspector();}));
 if(o.source==='constant')wrap.append(field('定数値',key+'.value',o.value,null,v=>{o.value=Number(v);resetRuntime();renderInspector();}));
 if(o.source==='input'){const h=document.createElement('div');h.className='annot';h.textContent='直前の情報入力・演算チップが出した数値を使用します。';wrap.append(h);}
 parent.append(wrap);
}
function renderInspector(){const body=$('inspector-body');body.replaceChildren();const n=program.nodes.find(n=>n.id===selected);
 $('selection-title').textContent=n?n.id:'未選択';if(!n){const e=document.createElement('div');e.className='empty-message';e.textContent='基板のチップを選んでください。\n空マスを押すと、左で選択したチップを配置します。';body.append(e);return;}
 const name=document.createElement('div');name.className='field';name.innerHTML=`<div style="color:#70e3d5;font-weight:700;margin-bottom:9px">${escapeHtml(n.type)}</div><div class="annot">JSON上のID: ${escapeHtml(n.id)}</div>`;body.append(name);
 const p=n.params;
 switch(n.type){
 case 'MJ_対象指定':addP(body,n,'対象の種類','target',menus.target);if(p.target==='seat')addP(body,n,'対象座席 (0〜3)','seat');if(p.target==='tile')addP(body,n,'牌ID','tile',tileOptions);break;
 case 'MJ_状態入力':addP(body,n,'読み取る状態','field',menus.stateField);addP(body,n,'情報の対象席','seat',seatOptions);if(p.field==='score_gap')addP(body,n,'点差の比較相手','targetSeat',{'0':'席0','1':'席1','2':'席2','3':'席3'});addP(body,n,'出力先カウンタ','output',counterChoices());break;
 case 'MJ_牌属性入力':addP(body,n,'属性を調べる牌','tile',{selected:'対象指定チップで選択した牌',...tileOptions});addP(body,n,'取得する属性','field',menus.tileField);addP(body,n,'出力先','output',counterChoices());break;
 case 'MJ_枚数入力':
  addP(body,n,'参照する範囲','scope',menus.scope);
  addP(body,n,'数える条件','group',menus.group);
  if(p.group==='suit')addP(body,n,'牌の色','suit',menus.suit);
  if(p.group==='tile'){addP(body,n,'指定牌','tile',tileOptions);addP(body,n,'赤牌を別ID扱い (0/1)','physicalRed',{'false':'通常の5と赤5を合算','true':'実牌IDを完全一致'});}
  if(p.group==='attribute')addP(body,n,'牌属性','attribute',menus.attribute);
  if(p.scope==='river'||p.scope==='meld')addP(body,n,'参照する席','seat',seatOptions);
  if(p.scope==='river')addP(body,n,'河の出し方','discardMethod',menus.discardMethod);
  addP(body,n,'入力先カウンタ','output',counterChoices());
  if(p.scope==='unseen'){const info=document.createElement('div');info.className='truth-note';info.innerHTML='<strong>未見は山の残数ではありません。</strong> 自家手牌・河（鳴かれた牌除く）・副露・ドラ表示牌から見えている実牌枚数を引きます。他家の伏せ牌や王牌は未知に含みます。';body.append(info);}break;
 case 'MJ_履歴入力':addP(body,n,'捨牌の席','seat',seatOptions);addP(body,n,'何件前 (0=直近)','offset');addP(body,n,'履歴の属性','field',menus.historyField);addP(body,n,'出力先','output',counterChoices());break;
 case 'MJ_候補列挙':addP(body,n,'列挙対象','mode',{discard:'打牌候補（今回対応）',call:'鳴き候補（未実装・診断停止）'});break;
 case 'MJ_候補移動':addP(body,n,'候補操作','mode',{first:'最初を選ぶ',next:'次へ',end:'終了したかを見る'});addP(body,n,'終了フラグ出力','output',counterChoices());break;
 case 'MJ_仮状態評価':addP(body,n,'仮状態処理','mode',{discard:'候補を仮に切る',clear:'仮状態を解除',call:'鳴き後（未実装）'});break;
 case 'MJ_シャンテン入力':addP(body,n,'シャンテン形','shape',{min:'最小 (3形)',normal:'通常形',chiitoi:'七対子',kokushi:'国士無双'});addP(body,n,'出力先','output',counterChoices());break;
 case 'MJ_面子分解列挙':addP(body,n,'分解候補数の出力先','output',counterChoices());break;
 case 'MJ_面子分解移動':addP(body,n,'分解候補の移動','mode',{first:'最初',next:'次へ',end:'終了判定'});addP(body,n,'終了フラグ出力','output',counterChoices());break;
 case 'MJ_面子情報入力':addP(body,n,'取得項目','field',menus.patternField);if(String(p.field||'').startsWith('meld_'))addP(body,n,'何番目の面子 (0〜)','index');addP(body,n,'出力先','output',counterChoices());break;
 case 'MJ_カウンタ操作':addP(body,n,'計算結果の保存先','output',counterChoices());addP(body,n,'演算子','op',menus.arithmetic);opEditor(body,n,'left','第1オペランド（被演算子）');if(p.op!=='assign'&&p.op!=='not')opEditor(body,n,'right','第2オペランド（相手側）');break;
 case 'MJ_カウンタ判断':addP(body,n,'比較演算子','op',menus.compare);opEditor(body,n,'left','比較対象 A');opEditor(body,n,'right','比較対象 B');{const tip=document.createElement('div');tip.className='truth-note';tip.textContent='YES と NO は別々の矢印。下の接続先をそれぞれ指定してください。';body.append(tip);}break;
 case 'MJ_門前・鳴き状態判断':{
  addP(body,n,'対象（自家を基準にした相対席）','target',menzenTargets,'手番・親・対象指定チップではなく、局面の観測席を基準にします。');
  body.append(field('分岐条件','condition',p.condition,menzenConditions,v=>{p.condition=v;if(v==='count'){p.op??='ge';p.threshold??=1;}resetRuntime();renderInspector();}));
  if(p.condition==='count'){
   addP(body,n,'公開面子数の比較','op',menzenCompare);
   addP(body,n,'しきい値（0〜4組）','threshold',null,'牌の枚数ではなく面子の組数。大明槓・加槓は各1組です。');
   const input=body.querySelector('#p-threshold');input.min='0';input.max='4';input.step='1';
  }
  const note=document.createElement('div');note.className='truth-note';
  note.innerHTML='<strong>暗槓は鳴き扱いにしません。</strong><br>チー・ポン・大明槓・加槓の面子だけを数えます。暗槓だけなら門前維持です。<br>読み取り専用：カウンタ・直前入力値・局面を変更せず、YES/NOへ分岐します。';body.append(note);
  const preview=document.createElement('div');preview.className='truth-note';preview.id='menzen-preview';
  try {const result=evaluateMenzenNaki(state,p);
   preview.textContent=`現在の観測：${menzenTargets[result.target]}（席${result.targetSeat}）／公開面子 ${result.openMeldCount}組／暗槓 ${result.concealedKanCount}組は除外 → ${result.matched?'YES':'NO'}${result.openFlagConflicts.length?' ※ openフラグ不一致あり。面子typeを採用。':''}`;
  } catch(error){preview.textContent=`判定できません：${error.message}`;}
  body.append(preview);break;
 }
 case 'MJ_点数算出':opEditor(body,n,'han','翻数');opEditor(body,n,'fu','符数');addP(body,n,'和了方法','mode',{ron:'ロン',tsumo:'ツモ'});addP(body,n,'点数の入力先','output',counterChoices());{const h=document.createElement('div');h.className='truth-note';h.textContent='符・翻は入力値を使用し、役の成立判定はしません。本場・供託は別管理。';body.append(h);}break;
 case 'MJ_行動':addP(body,n,'行動の種類','action',menus.action);if(['discard','riichi','ankan','kakan','daiminkan'].includes(p.action)){addP(body,n,'打牌/槓の対象','tileSource',{candidate:'選択中の候補',constant:'牌IDを指定'});if(p.tileSource!=='candidate')addP(body,n,'牌ID','tile',tileOptions);}break;
 case 'END':addP(body,n,'完了時の表示','label');break;
 default:break;
 }
 const routes=document.createElement('div');const rt=document.createElement('div');rt.className='section-head';rt.style.margin='12px -12px 10px';rt.textContent='矢印・分岐の接続';routes.append(rt);
 const ports=['MJ_カウンタ判断','MJ_門前・鳴き状態判断'].includes(n.type)?['yes','no']:n.type==='JUMP'?['target']:n.type==='CALL'?['target','next']:['END','RETURN','MJ_行動'].includes(n.type)?[]:['next'];
 const options={'':'── 未接続 ──',...Object.fromEntries(program.nodes.filter(q=>q.id!==n.id).map(q=>[q.id,`${q.id}  · ${labels[q.type]}`]))};
 for(const port of ports){const row=document.createElement('div');row.className=`route-row ${port==='yes'?'route-yes':port==='no'?'route-no':''}`;const text=document.createElement('span');text.textContent=port.toUpperCase();row.append(text);
 const select=document.createElement('select');for(const [id,label] of Object.entries(options)){const opt=document.createElement('option');opt.value=id;opt.textContent=label;select.append(opt);}select.value=n.routes[port]||'';
 select.addEventListener('change',()=>{if(select.value)n.routes[port]=select.value;else delete n.routes[port];resetRuntime();renderInspector();});row.append(select);
 const button=document.createElement('button');button.textContent='接続指定';button.addEventListener('click',()=>{linkFrom={nodeId:n.id,port};renderBoard();notify('接続先のチップをクリックしてください');});row.append(button);routes.append(row);
 }
 if(!ports.length){const none=document.createElement('p');none.className='subcaption';none.textContent='このチップは先への矢印を持ちません。';routes.append(none);}body.append(routes);
 const tools=document.createElement('div');tools.className='node-tools';const a=document.createElement('button');a.className='btn sm warn';a.textContent='チップ削除';a.addEventListener('click',()=>deleteSelected());tools.append(a);
 const b=document.createElement('button');b.className='btn sm';b.textContent='パラメータJSON';b.addEventListener('click',()=>openNodeParams(n));tools.append(b);body.append(tools);
}
function openNodeParams(n){modalContext={mode:'params',nodeId:n.id};$('modal-title').textContent=`${n.id} のパラメータ JSON`;$('json-textarea').value=JSON.stringify(n.params,null,2);$('modal-msg').textContent='このチップの params だけを変更できます';$('json-overlay').classList.add('show');}
function deleteSelected(){const n=program.nodes.find(n=>n.id===selected);if(!n)return;if(n.id===program.entry){notify('STARTは削除できません。新規盤面で作り直してください',true);return;}
 program.nodes=program.nodes.filter(q=>q.id!==n.id);for(const q of program.nodes)for(const [key,to] of Object.entries(q.routes))if(to===n.id)delete q.routes[key];selected=program.entry;resetRuntime();renderInspector();notify(`${n.id}を削除しました`);}
function renderCounters(){const body=$('counter-list');body.replaceChildren();const visible=inspectedStep===null?null:machine?.trace[inspectedStep];
 for(const c of program.counters){const tr=document.createElement('tr');
 const name=document.createElement('td');const inp=document.createElement('input');inp.className='name-input';inp.value=c.name;inp.title='名前を変更するとチップの参照も更新します';inp.addEventListener('change',()=>renameCounter(c.name,inp.value));name.append(inp);
 const kind=document.createElement('td');const kindCtl=document.createElement('select');kindCtl.className='kind-select'+(c.kind==='estimate'?' estimate':'');for(const [v,t] of [['fact','事実'],['estimate','推定']]){const opt=document.createElement('option');opt.value=v;opt.textContent=t;kindCtl.append(opt);}kindCtl.value=c.kind;kindCtl.addEventListener('change',()=>{c.kind=kindCtl.value;resetRuntime();});kind.append(kindCtl);
 const initial=document.createElement('td');const init=document.createElement('input');init.className='init-input';init.type='number';init.step='any';init.value=c.initial;init.addEventListener('change',()=>{c.initial=Number(init.value);resetRuntime();});initial.append(init);
 const value=document.createElement('td');const num=document.createElement('div');num.className='val'+(lastChanged.has(c.name)&&visible===null?' changed':'');const v=visible?.counters?.[c.name]??machine?.counters[c.name]?.value??c.initial;num.textContent=String(v);value.append(num);
 const del=document.createElement('td');const btn=document.createElement('button');btn.className='btn sm flat';btn.textContent='×';btn.title='カウンタを削除';btn.addEventListener('click',()=>deleteCounter(c.name));del.append(btn);
 tr.append(name,kind,initial,value,del);body.append(tr);
 }
 $('counter-note').textContent=inspectedStep===null?'事実＝青 ／ 推定＝橙。ステップ後に値が光ります。':`トレース #${machine.trace[inspectedStep].step} 時点の値を表示中（実行値は変更しません）`;
}
function renameCounter(oldName,newName){newName=newName.trim();if(!/^[A-Za-z0-9_-]{1,40}$/.test(newName)||['__proto__','constructor','prototype'].includes(newName)||program.counters.some(c=>c.name===newName&&c.name!==oldName)){notify('名前は英数・_・-のみ（40文字以内）、重複不可',true);renderCounters();return;}
 for(const c of program.counters)if(c.name===oldName)c.name=newName;
 for(const n of program.nodes){if(n.params.output===oldName)n.params.output=newName;for(const k of ['left','right','han','fu'])if(n.params[k]?.source==='counter'&&n.params[k].name===oldName)n.params[k].name=newName;}
 resetRuntime();renderInspector();renderBoard();notify(`${oldName} → ${newName} に変更`);
}
function deleteCounter(name){const used=program.nodes.some(n=>n.params.output===name||['left','right','han','fu'].some(k=>n.params[k]?.source==='counter'&&n.params[k].name===name));if(used){notify('参照中のカウンタは削除できません',true);return;}
 if(program.counters.length<=1){notify('カウンタは最低1つ必要です',true);return;}program.counters=program.counters.filter(c=>c.name!==name);resetRuntime();renderInspector();}
function addCounter(){let i=0,name;do{name=`CNT-${String.fromCharCode(65+i%26)}${i>=26?Math.floor(i/26):''}`;i++;}while(program.counters.some(c=>c.name===name));program.counters.push({name,kind:'estimate',initial:0});resetRuntime();renderInspector();notify(`${name}を追加`);}
function renderStatus(){const s=$('status');const status=machine?.status||'error';const names={ready:'READY',running:'RUNNING',completed:'COMPLETE',action:'ACTION PROPOSED',error:'ERROR',step_limit:'LIMIT'};s.textContent=names[status]||status;s.className='status-pill'+(status==='completed'?' good':['error','step_limit'].includes(status)?' error':'');
 $('step-indicator').textContent=`${machine?.steps??0} steps / ${program.nodes.length} chips`;
 $('trace-summary').textContent=machine?.message??'局面不正';
}
function renderTrace(){const tbody=$('trace-body');tbody.replaceChildren();if(!machine)return;
 for(let i=0;i<machine.trace.length;i++){const event=machine.trace[i];const tr=document.createElement('tr');if(inspectedStep===i)tr.classList.add('inspect');
 const vals=[`#${String(event.step).padStart(3,'0')}`,event.nodeId,event.description,event.route.toUpperCase(),event.changes.length?event.changes.map(c=>`${c.name} ${c.before} → ${c.after}`).join(' ／ '):'—'];
 for(let j=0;j<vals.length;j++){const td=document.createElement('td');td.textContent=vals[j];if(j===0||j===1)td.classList.add('code');if(j===3&&event.route==='yes')td.classList.add('yes');if(j===3&&event.route==='no')td.classList.add('no');if(j===4&&event.changes.length)td.classList.add('diff');tr.append(td);}
 tr.addEventListener('click',()=>{inspectedStep=inspectedStep===i?null:i;renderTrace();renderCounters();renderBoard();});tbody.append(tr);
 }
 $('trace-count').textContent=`${machine.trace.length} events`;
}
function refreshAfterStep(event){inspectedStep=null;lastChanged=new Set((event?.changes||[]).map(c=>c.name));renderStatus();renderCounters();renderTrace();renderBoard();
 if(['completed','error','action','step_limit'].includes(machine.status)){stopPlay();notify(machine.message,!!machine.error);}
}
function stepOne(){if(!machine)resetRuntime();if(!machine)return;
 const entry=stepMachine(machine);refreshAfterStep(entry);
}
function runAll(){if(!machine)resetRuntime();if(!machine)return;stopPlay();let entry=null;
 while(machine.status==='ready'||machine.status==='running')entry=stepMachine(machine);
 refreshAfterStep(entry);
}
function play(){if(interval){stopPlay();return;}if(['completed','error','action','step_limit'].includes(machine?.status)){resetRuntime();}
 $('btn-play').textContent='❚❚ 一時停止';interval=setInterval(()=>{if(['completed','error','action','step_limit'].includes(machine?.status))return stopPlay();stepOne();},440);
}
let modalContext={mode:'program'};
function openJSON(mode){modalContext={mode};$('modal-title').textContent=mode==='program'?'配置 JSON（共通正本）':'局面 JSON（観測席のみ）';$('json-textarea').value=JSON.stringify(mode==='program'?program:state,null,2);$('modal-msg').textContent=mode==='program'?'この配置JSONはTypeScript実行器と完全に同じ形式です。':'局面はMuse形式へ寄せたデータ。非公開の他家手牌は破棄します。';$('json-overlay').classList.add('show');}
function closeJSON(){$('json-overlay').classList.remove('show');}
function applyJSON(){try{
 const obj=JSON.parse($('json-textarea').value);
 if(modalContext.mode==='params'){
  if(!obj || typeof obj!=='object'||Array.isArray(obj))throw new Error('paramsはJSONオブジェクト');const n=program.nodes.find(q=>q.id===modalContext.nodeId);if(!n)throw new Error('編集中のチップは削除済み');n.params=obj;
 }else if(modalContext.mode==='program'){validateProgram(obj);program=obj;selected=obj.entry;}
 else {const observerSeat=Number(obj.observer_seat??state.observer_seat??0);state=fromMuseState(obj,observerSeat);}
 closeJSON();resetRuntime();renderAll();notify('JSONを検証・適用しました');
 }catch(e){$('modal-msg').textContent=`不正なJSON: ${e.message}`;notify(e.message,true);}
}
function downloadJSON(data,filename){const blob=new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function importFile(file){file.text().then(t=>{const obj=JSON.parse(t);if(obj.schema===SCHEMA){validateProgram(obj);program=obj;selected=obj.entry;notify('配置JSONを読込');}else if(Array.isArray(obj.hands)){state=fromMuseState(obj,Number(obj.observer_seat??0));notify('局面JSONを読込');}else throw new Error('配置JSONまたは局面JSONの形式ではありません');renderAll();}).catch(e=>notify('読み込み失敗: '+e.message,true));}
function newBoard(){program={schema:SCHEMA,id:'new-program',name:'新規盤面',entry:'start',layout:{columns:7,rows:6},counters:[{name:'CNT-A',kind:'fact',initial:0},{name:'CNT-B',kind:'estimate',initial:0}],nodes:[{id:'start',type:'START',x:0,y:1,params:{},routes:{}}],limits:{maxSteps:500,maxCallDepth:32}};selected='start';linkFrom=null;renderAll();notify('新規盤面を作成。空マスからチップ配置してください');}
function renderAll(){resetRuntime();renderPalette();renderInspector();renderCounters();renderTrace();renderBoard();}
$('palette-search').addEventListener('input',renderPalette);
$('example-picker').addEventListener('change',e=>loadExample(e.target.value));
$('btn-false').addEventListener('click',setTanyaoFailure);
$('btn-run').addEventListener('click',runAll);$('btn-step').addEventListener('click',stepOne);$('btn-play').addEventListener('click',play);$('btn-reset').addEventListener('click',resetRuntime);
$('btn-add-counter').addEventListener('click',addCounter);$('btn-current').addEventListener('click',()=>{inspectedStep=null;renderTrace();renderCounters();});
$('btn-clear').addEventListener('click',newBoard);$('btn-grow').addEventListener('click',()=>{const d=boardSize();program.layout={columns:Math.min(512,d.columns+4),rows:Math.min(512,d.rows+2)};renderBoard();notify(`盤面を ${program.layout.columns}列 × ${program.layout.rows}行へ拡張`);});$('btn-cancel-link').addEventListener('click',()=>{linkFrom=null;renderBoard();});
$('btn-json').addEventListener('click',()=>openJSON('program'));$('btn-state').addEventListener('click',()=>openJSON('state'));
$('btn-modal-close').addEventListener('click',closeJSON);$('btn-json-apply').addEventListener('click',applyJSON);
$('json-overlay').addEventListener('click',e=>{if(e.target.id==='json-overlay')closeJSON();});
$('btn-json-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('json-textarea').value);notify('コピーしました');}catch{notify('クリップボード利用不可。テキストを選択してコピーしてください',true);}});
$('btn-export').addEventListener('click',()=>downloadJSON(program,`${program.id}.json`));
$('btn-import').addEventListener('click',()=>$('file-import').click());
$('file-import').addEventListener('change',e=>{if(e.target.files?.[0])importFile(e.target.files[0]);e.target.value='';});
$('btn-trace-export').addEventListener('click',()=>{if(!machine){notify('まだ実行していません');return;}downloadJSON({schema:SCHEMA,program_id:program.id,status:machine.status,error:machine.error,counters:machine.counters,trace:machine.trace,action:machine.action},`${program.id}_trace.json`);});
document.addEventListener('keydown',e=>{const tag=e.target?.tagName?.toLowerCase();if(['input','textarea','select'].includes(tag))return;
 if(e.key==='Escape'){if($('json-overlay').classList.contains('show'))closeJSON();else{linkFrom=null;renderBoard();}}
 if(e.key==='Delete'){e.preventDefault();deleteSelected();}
 if(e.ctrlKey&&e.key.toLowerCase()==='s'){e.preventDefault();downloadJSON(program,`${program.id}.json`);}
});
// Expose a read-only smoke-test handle. No server calls, storage writes, or network.
window.MuseChipPreview={getProgram:()=>clone(program),getState:()=>clone(state),getTrace:()=>clone(machine?.trace||[]),getStatus:()=>machine?.status};
renderAll();
