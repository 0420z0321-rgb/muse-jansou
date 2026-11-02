# Muse雀荘 Worker（Phase 3a）

TypeScript エンジン（`../ts/`）を Cloudflare Workers + Durable Objects
（SQLite-backed、1卓＝1 DO）に載せた検証用プロジェクト。
**デプロイはまだしていない**（ローカル検証のみ）。

## 構成

| ファイル | 役割 |
| --- | --- |
| `wrangler.toml` | Worker 設定。DO バインディング `ROOMS`、SQLite 用 migration（`new_sqlite_classes = ["RoomDO"]`）。Free プランで動く構成 |
| `src/index.ts` | Worker エントリ。ルーティングと卓作成（開発用簡易トークンの発行） |
| `src/room.ts` | `RoomDO`。状態の永続化・冪等・claim lease・遅延 settle＋Alarm |
| `verify/client.ts` | 検証用 HTTP クライアント |
| `verify/play_http.ts` | `ts/play_bots.ts` の HTTP 版。ボット4席で半荘を完走させる |
| `verify/anomalies.ts` | 異常系 1（冪等）・3（時計：遅延 settle／Alarm）・4（同時 claim） |
| `verify/restart_check.ts` / `verify/restart_test.sh` | 異常系 2（dev 再起動＝DO 再生成後の復元） |
| `verify/run_all.sh` | 半荘2試合＋異常系 1・3・4 を一括実行 |

エンジン本体（`../ts/`）と Python 参照実装は変更していない。接続コードは
すべてこのディレクトリ側にある。

## 永続化（DO Storage / SQLite）

- `meta` テーブル：`game`（状態スナップショット JSON）、`token_hash`、
  `lease`（claim lease JSON）、`time_offset_ms`、Alarm 統計
- `idempotency` テーブル：idempotency_key → 処理結果 JSON
- `ops` テーブル：受け付けた操作の監査ログ

DO がメモリから落ちても、コンストラクタでスナップショットを読み直して
続きが打てる。保存は revision が変わった操作のたび。

## API

認証：`Authorization: Bearer <token>`（卓作成時に発行される開発用簡易
トークン。サーバー側は SHA-256 ハッシュのみ保存）。本格的な招待・席所属・
権限は Phase 4。

| メソッド・パス | 内容 |
| --- | --- |
| `GET /` | ヘルスチェック |
| `POST /rooms` | 卓を作成。body：`{ seed?, ruleset?, time_offset_ms? }` → `201 { room_id, token, state }` |
| `GET /rooms/{id}/state` | public_state。入口で期限切れを遅延 settle する |
| `POST /rooms/{id}/actions` | apply_action。body に `idempotency_key`（任意）と `claim_token`（lease がある場合）を含められる |
| `POST /rooms/{id}/claim` | 現在の decision への lease 発行。body：`{ seat? }` → `{ claim_token, decision_id, seat, expires_at, reused }` |
| `GET /rooms/{id}/debug` | 開発検証用（settle しない）：revision / lease / alarm_count など |
| `POST /rooms/{id}/dev/advance-time` | 開発検証用：エンジン時刻オフセットの変更 `{ advance_ms }` または `{ offset_ms }` |

操作の検証順（移行設計 v1.0）：認証 → 冪等キーの既存結果（あれば再返却、
`X-Idempotent-Replay: 1` ヘッダつき）→ 期限切れ settle → decision_id →
expected_revision → claim_token → 合法性（エンジン）。
claim 仕様：同一 decision で有効な lease は1つ、再 claim は既存を返す、
TTL 180秒（decision の deadline を超えない）、行動成功で消費、
claim 自体は revision を上げない。lease がある間、他者の行動は
`{ "error": "decision claimed" }` で拒否される（この競合エラーは
冪等結果として保存しない）。

時計：入口の遅延 settle に加え、次の deadline に DO Alarm を設定する。
Alarm でも settle し（冪等）、次の Alarm を張り直す。

開発用時刻オフセットについて：エンジンの時計プリセットは分単位のため、
期限切れ検証を短時間で行う目的で `time_offset_ms` を導入した。既定 0
（実時刻）。エンジンの `setNowMs` はモジュール global なので DO は
ハンドラ先頭で自室のオフセットを再設定している。複数卓を同一 isolate で
本格運用する場合は、オフセットを使わない実時刻運用に限るか、エンジンへ
時刻を引数で渡す改修が必要（Phase 4 以降の課題）。

## ローカル実行

```bash
cd ~/workspace/muse-jansou/worker
npm install
npx wrangler dev --port 8787 --ip 127.0.0.1   # http://127.0.0.1:8787
```

## 検証の実行

```bash
bash verify/run_all.sh        # 半荘2試合（seed 7 / 11）＋異常系 1・3・4
bash verify/restart_test.sh   # 異常系 2（再起動→復元→完走）
```

個別実行（サーバー起動中）：

```bash
node verify/play_http.ts http://127.0.0.1:8787 7
node verify/anomalies.ts http://127.0.0.1:8787
```

## 検証結果（2026-11-01、ローカル・wrangler dev）

- 型チェック：`npx tsc --noEmit`（strict）エラーなし
- HTTP 越し半荘 2 試合（`verify/run_all.sh`）：
  - seed 7 → 最終点数 [19500, 34200, 15000, 31300]、南4終了、合計100000。
    in-process 版（Phase 2）の結果・revision 1514 まで完全一致
  - seed 11 → 最終点数 [23800, 47400, 31700, -2900]、飛び終了、合計100000。
    こちらも in-process 版と完全一致（revision 2284）
- 異常系（`verify/anomalies.ts`）：
  1. 冪等：同じ idempotency_key の二重 POST（逐次・並行とも）で局面は
     1回だけ進み、2回目は保存済み結果を再返却（`X-Idempotent-Replay: 1`）… OK
  3. 時計：期限切れが GET /state の遅延 settle で自動ツモ切り処理され、
     別卓では DO Alarm がリクエストなしで settle した
     （debug の revision が先行して進むことで確認）… OK
  4. 同時 claim：10並行 claim で有効な lease は1つだけ（新規発行1件、
     残りは既存を再返却）。claim は revision を変えず、lease 中は
     claim_token なし／誤りの行動を `decision claimed` で拒否、
     正しい token の行動成功で lease 消費… OK
  - ついでに認証なし・誤トークンの state 取得が 401 になることも確認
- 異常系 2（`verify/restart_test.sh`）：40手打ったところで wrangler dev を
  再起動（＝DO 再生成）→ state のダイジェスト（revision・手牌・河・点数等）が
  完全一致で復元され、そのまま打ち切って南4終了
  [19300, 33700, 11100, 35900]、合計100000 … OK

所要時間の目安：wrangler dev の1リクエストあたり数百ms のため、
run_all.sh 一式で約19分（この VM での実測。実環境の参考にはならない）。
なお初回の run_all 実行は、途中で fetch のソケット切断
（UND_ERR_SOCKET）が起きて異常系の途中で止まったため、終了コードを
直接拾う形で再実行し、上記の全項目合格を確認した（再実行は一発合格）。
dev 環境の接続が不安定な場合はスクリプトをそのまま再実行すればよい。

## デプロイ時に必要になるもの（未実施）

- Cloudflare への認証：`npx wrangler login`（ブラウザ OAuth）または
  API トークン（環境変数 `CLOUDFLARE_API_TOKEN`）。親側で別途行う。
- `npx wrangler deploy` で `wrangler.toml` の構成（DO バインディング＋
  SQLite migration v1）がそのまま使える。Free プランで SQLite-backed DO が
  利用可能。
- 公開前に外すべき開発面：`/debug` と `/dev/advance-time` エンドポイント、
  簡易トークン認証（Phase 4 の招待・席所属に置き換え）。

## 未実装・未検証の範囲

- テーブル画面（Phase 5）、招待・席所属・観戦の出し分け（Phase 4）
- 卓一覧・参加者登録の中央レジストリ（D1、Phase 4 以降）
- raw モードの通し半荘の HTTP 検証（エンジン側は fixture で担保済み）
- スナップショットの肥大化対策（events / match_log の間引きは Phase 6 課題）
