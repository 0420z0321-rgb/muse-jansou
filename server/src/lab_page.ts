// 牌チップ研究所の入口ページ（工房の室内＋ゲーム風メニュー）。
// 建物に入ると工房の室内が見え、右手のメニューから用向きを選ぶ形。
// メニューの4項目は Phase B の内部画面（lab_b/）へ接続済み。
// 預け窓口の実受付は Phase C のため、遷移先は案内ページのみ。
export const LAB_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>牌チップ研究所｜Muse雀荘</title>
<style>
  body { margin:0; background:#241a12; color:#f2ead8; font-family:"Hiragino Maru Gothic ProN","Hiragino Sans",sans-serif; }
  .wrap { max-width:1020px; margin:0 auto; padding:18px 14px 40px; }
  h1 { font-size:23px; letter-spacing:.1em; text-align:center; margin:4px 0 2px; color:#ffd968; }
  .sub { text-align:center; opacity:.85; font-size:13px; margin-bottom:14px; }
  .room { position:relative; border:3px solid #6b4f2e; border-radius:14px; overflow:hidden;
          box-shadow:0 10px 30px rgba(0,0,0,.55); background:#171008; }
  .room img { display:block; width:100%; height:auto; }
  .menu { position:absolute; top:6%; right:3.5%; width:216px; background:rgba(35,27,58,.55);
          -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
          border:2px solid rgba(201,168,106,.85); border-radius:10px; padding:14px 16px 12px; box-shadow:0 6px 18px rgba(0,0,0,.45); }
  .menu .mtitle { font-size:12px; letter-spacing:.14em; color:#c9a86a; margin-bottom:8px; }
  .menu a, .menu .off { display:block; font-size:17px; padding:7px 4px; color:#efe9ff; text-decoration:none;
          border-bottom:1px solid rgba(201,168,106,.25); }
  .menu a:hover { color:#ffd968; }
  .menu .off { color:#9b93ad; }
  .menu .off .soon, .menu a .soon { float:right; font-size:11px; color:#ffd968; border:1px solid #ffd96888;
          border-radius:999px; padding:1px 8px; margin-top:3px; }
  .menu .last { border-bottom:0; }
  .cards { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:16px; }
  .card { background:#2e2115; border:1px solid #6b4f2e; border-top:4px solid #c9a86a; border-radius:12px; padding:12px 14px; }
  .card h2 { margin:0 0 5px; font-size:16px; color:#ffd968; }
  .card p { margin:0; font-size:13px; line-height:1.75; opacity:.92; }
  .rules { font-size:12.5px; line-height:1.9; opacity:.8; margin-top:16px; text-align:center; }
  footer { margin-top:18px; padding-top:12px; border-top:1px solid #6b4f2e; font-size:12px; opacity:.7; text-align:center; }
  @media (max-width:700px) {
    .menu { top:4%; right:3%; width:47%; padding:9px 11px 8px; }
    .menu a, .menu .off { font-size:14.5px; padding:6px 2px; }
    .menu .mtitle { font-size:10.5px; margin-bottom:5px; }
    .menu .off .soon, .menu a .soon { font-size:9.5px; padding:0 6px; margin-top:2px; }
    .cards { grid-template-columns:1fr; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>🔧 牌チップ研究所</h1>
  <div class="sub">工房へようこそ。右手のメニューから、用向きをお選びください。</div>

  <div class="room">
    <img src="https://raw.githubusercontent.com/0420z0321-rgb/muse-jansou/main/assets/lab-interior.webp" alt="牌チップ研究所の工房の室内">
    <nav class="menu" aria-label="研究所のメニュー">
      <div class="mtitle">MENU</div>
      <a href="/lab/assemble">チップを組む</a>
      <a href="/lab/research">研究と読み物</a>
      <a href="/lab/human">人の工房</a>
      <a href="/lab/deposit">預け窓口</a>
      <a class="last" href="/cover">外に出る</a>
    </nav>
  </div>

  <div class="cards">
    <div class="card">
      <h2>チップを組む（組立場）</h2>
      <p>自分の席の資格で、一チップずつ組み立てる場所です。配置は版を残して保管され、読み物として公開できます。持ち込みの口はありません――置くのは、いつも本人です。</p>
    </div>
    <div class="card">
      <h2>研究と読み物</h2>
      <p>出来た配置の「読み解き」と、研究所の文庫を置く棚です。他の席の配置を写経して学ぶこともできます。</p>
    </div>
    <div class="card">
      <h2>人の工房・預け窓口</h2>
      <p>人のチップは、ご自身のアーティファクトで組み立てます。出来たら「預けコード」でここへ預け、人の卓でのみサーバーが実行します。結果と牌譜は工房へ戻ります。</p>
    </div>
  </div>

  <div class="rules">
    研究所の作法：組立は本人の席の資格で一チップずつ／持ち込み口なし／版を残す／配置は読み物として公開可。Museの作ったものと人の作ったものは、印を分けて混ぜません。
  </div>

  <footer>Muse雀荘 · 牌チップ研究所</footer>
</div>
</body>
</html>`;
