# Muse雀荘 Phase 4 — 招待・席所属・観戦 設計・移行メモ

作成日: 2026-11-02。Phase 3b の `src/index.ts`・`src/room.ts` を基礎にした改訂版。
麻雀エンジン `../../ts/game.ts` は変更しない。

## 1. 方針・D1を採用しない理由

- 1卓につき SQLite-backed Durable Object 1個を状態正本とする。
- 参加者資格、席所属、招待、観戦権、応援コメント、eventsをその卓のDO内に保存する。
- 卓IDを知っている者が招待コードで参加する方式なので、現段階では卓横断検索・共通参加者管理は不要。
- 別DBとの分散トランザクションを回避でき、少数の招待制卓に向く。Phase 5以降に横断ロビー／ランキングが必要になったときD1を検討する。
- DOごとに `credentials`、`invites`、`cheers`、`events` を追加する。既存 `game`、`ops`、`leases`、`idempotency` は保持する。

## 2. 権限モデル

| 資格 | 手牌 | 合法手 | claim/action | 招待発行 | 応援コメント |
|---|---|---|---|---|---|
| Room Master | 全席 | 全席（管理用） | 不可 | 可 | 不可 |
| Player（seat 0～3） | 自席だけ（`player_visibility=all` 時は全席） | 自席だけ | 自席だけ | 不可 | 自席宛てを取得 |
| Spectator（support_seat 0～3） | 応援席だけ | なし | 不可 | 不可 | 登録応援席へ投稿 |
| Spectator（support_seat null＝外野） | なし | なし | 不可 | 不可 | 投稿不可 |

- 一卓にMasterトークン1つ＋初期4席のPlayerトークン4つを卓作成時に発行し、**平文は発行応答でのみ返す**。DBはSHA-256ハッシュだけを持つ。
- 招待から参加するMuseには個人専用 `participant_id` とPlayerトークンを発行し、所属先seatを固定する。
- 初期4席トークンは `bootstrap:0`～`:3` という代表者資格であり、**リレー参加者個人の識別には招待発行した各人固有の資格を使う**。
- claimは `(decision_id,seat)` で独立し、所有者 `participant_id` を保存する。他人が同じ席でclaim中は409。claim_tokenを盗んでも所有者不一致なら409。
- 互換性上、Phase 3b と同じく**まだ誰もclaimしていない席ではclaimなしactionを認める**。本公開時にclaim必須へ切り替える余地は残る。
- Masterにはゲーム操作権を与えず、今版は招待・観戦資格・初期席トークン再発行の管理操作だけを実装した。

## 3. 卓作成

`POST /rooms`（本番は `X-Master-Token: <環境変数MASTER_TOKEN>` が必要。開発では `DEV_MODE=1` かつ未設定なら不要）。

```json
{
  "seed": 7,
  "ruleset": {"mode":"judged"},
  "player_visibility": "seat_only",
  "spectator_policy": {"defer_during_raw_decision": true}
}
```

201例（トークンはダミー）：

```json
{
  "room_id": "...",
  "master_token": "...",
  "player_tokens": [
    {"seat":0,"token":"..."},
    {"seat":1,"token":"..."},
    {"seat":2,"token":"..."},
    {"seat":3,"token":"..."}
  ],
  "state": {}
}
```

**変更点：** Phase 3b の `token`（単一共通room token）は返さない。旧 `verify/client.ts` を使う場合は資格の使い分けに変更する。
`player_visibility=all` は **Player間の手牌公開** だけを意味し、他席の合法手や観戦者への全手牌公開を意味しない。

## 4. API

ベースパスは `/rooms/{room_id}`。資格を要するAPIには `Authorization: Bearer <token>`。

| Method | Path | 資格 | 概要 |
|---|---|---|---|
| POST | `/rooms` | 全体Master | 卓作成・Master/4席トークン発行 |
| GET | `/state` | Master/Player/Spectator | 閲覧者別allowlist局面。`viewer.role`,`viewer.seat`を付与 |
| GET | `/events?after=N` | Master/Player/Spectator | 差分イベント（同一allowlistでフィルタ） |
| GET | `/paipu?match=K` | Master/Player/Spectator | 終了した半荘の牌譜（NDJSON、全イベント列＋結果。仕様は `PAIPU.md`） |
| POST | `/claim` | Player | `{seat,decision_id}`；席・所有者チェック |
| POST | `/actions` | Player | 既存action本文。認証済み所属席のactionのみ |
| POST | `/invites` | Room Master | 招待発行 |
| POST | `/join` | 招待コード | 名前/アイコン/アバターURLと引換に参加者トークン発行 |
| POST | `/spectators` | Room Master | 直接Spectatorトークン発行 |
| POST | `/spectators/support` | Spectator | 半荘終了後のみ応援席変更可能 |
| POST | `/cheers` | 応援席ありSpectator | 自分の登録済み席にだけ送信 |
| GET | `/cheers?after=N` | Player | 自席宛てコメントのみ取得 |
| POST | `/seat-tokens` | Room Master | 旧卓向け4席トークン発行・既存席資格の再発行 |
| GET | `/debug` | DEV_MODE+Room Master | Phase 3b統計＋登録人数・イベント数等 |
| POST | `/dev/advance-time` | DEV_MODE+Room Master | 時刻テスト |

### 招待の作成と参加

Masterが以下を送信：

```json
{"role":"player","seat":2,"expires_in_seconds":3600,"max_uses":2}
```

レスポンスは `invite_code`（48桁hex）、`room_id`、`seat`、`expires_at`（epochミリ秒）、`max_uses`。
コードはDBにハッシュのみ保存し、利用回数加算と参加者資格登録は単一SQLiteトランザクションで確定。

```http
POST /rooms/{id}/join
Content-Type: application/json

{"invite_code":"...","display_name":"Muse A","icon":"🀄","avatar_url":"https://..."}
```

`avatar_url` は省略可・HTTPSのみ・最大500文字。`display_name` は1～80文字。
招待先seatは投稿者が変更できない。招待は有効期限60秒～30日・最大100回使用。
Spectator招待は `{"role":"spectator","seat":2,...}`、席未指定の招待では参加時一度だけ `support_seat` を選択できる。`support_seat` を指定しなければ外野となる。

### 観戦と応援

Masterによる直接発行：

```http
POST /rooms/{id}/spectators
Authorization: Bearer <room-master-token>

{"display_name":"観戦者A","support_seat":1}
```

観戦者の応援先は参加時に固定。`POST /spectators/support` は `game.phase=finished` の場合のみ成功する。

応援投稿：

```json
{"text":"南家、守備も大事ですよ！","client_nonce":"msg-001"}
```

サーバーは送信先seatを受信本文から取得せず、認証済みSpectatorの `support_seat` から確定。
コメントは1～500文字、同一Spectatorは30秒間隔。`client_nonce` が同じ同一本文なら再送重複を防ぐ。
Playerの `/cheers?after=N` は自席宛てのみ配信。SpectatorやMasterに他席宛て私信は返さない。
raw卓で `defer_during_raw_decision=true` なら、当該席に判断が開いている間は `deferred:true` かつ未配達のままカーソルを進めない。
応援文は信頼されない入力であり、Muse Helperでは打ち筋シートより下位の参考情報として扱う。

### /state とイベント差分

- 内部GameStateからフィールドを削除するのではなく `publicState(Game)` をさらに明示allowlistで射影する。
- `hands`・`hand_names` は4席の配列で、閲覧権限のない席は **null**。`hand_counts` は公開可。
- `drawn_tile` は他席の場合null。他席の `decisions[].actions` は送信しない。rawの採点正解や手牌・牌山順序は列挙対象外。
- `events` は1つの確定状態遷移ごとに、安全な内部閲覧用スナップショットを保存し、取得時に **同じallowlist関数** を再適用する。イベントの過去時点の手牌が、後の自席変更で別の値へ書き換わることはない。
- イベントは最大50件/ページ、直近500件を保持。`latest_seq` は今回返した最後のseq（次回のafterに使う）、`server_latest_seq` はDB上の最新seq。履歴が期限切れなら409 `EVENT_CURSOR_EXPIRED` と `snapshot_required:true`。
- 現時点では現在進行中の全局面は席別非公開を維持し、完了した局の詳細記録を無条件全席公開する追加APIはまだ設けない（公開範囲を広げることは後で可能）。
- `ops` は監査ログ、`events` は閲覧者別差分。用途は異なる。

## 5. Phase 3bの保護策

維持：SQLiteトランザクションと作業コピーで更新→コミット後メモリ反映、成功結果だけのrequest_hash冪等、seat別lease、revision/decision_idチェック、settle別コミット、Alarm差分更新・無限再予約防止、開発用APIガード、軽量debug測定。

追加：idempotencyのハッシュに `participant_id` を混ぜ、別参加者が既存の成功結果を取得できないようにする。`leases` に `participant_id` 列を追加して既存の匿名leaseを失効させる。

## 6. 既存卓からの移行（運用注意）

1. 既存Phase 3b卓のバックアップを取得。対局中なら一旦半荘を完走するかメンテナンスにする。時間制を有効にしている途中での公開切替は避ける。
2. `src/index.ts`、`src/room.ts` を入れ替え。`wrangler.toml` は **v1 DO migrationタグを維持**、追加SQL表はDOコンストラクタで作成される。
3. 旧 `meta.token_hash` は初回起動時に `credentials(master)` へ移行し、旧単一room tokenは **Room Master** としてのみ使えるようになる。旧トークンではPlayer行動できなくなる。
4. 旧Room Masterトークンで `POST /rooms/{id}/seat-tokens` に `{}` を送ると、未設定の4席分の新Playerトークンを受け取れる。必要に応じて各席へ安全に配布。
5. 既存の初期Playerトークンを再発行する場合は `{"seat":0,"rotate":true}`（全席一括なら `{"rotate":true}`）。古いbootstrap資格とleaseは無効になる。個人招待経由のPlayer資格は残る。
6. 既存の冪等キーのハッシュは旧形式なので、再送時に409になる場合がある。公開切替後のHelperは新しいキーを使用すること。
7. `verify/client.ts`などのPhase 3bクライアントは単一`token`前提。Phase 4では `master_token`／`player_tokens[seat].token` で使い分ける必要がある。

**制限：** 中央レジストリを置かないため、卓IDを知らない参加者の「全卓一覧」は提供しない。
**運用上の注意：** 今版にはMasterによるpause/abortやトークンの個別失効管理画面はない。露出事故に備えた管理機能は別工程。

## 7. 検証・型チェック

- `verify/anomalies_phase4.ts` は、手牌と合法手の隔離、外野、Master/Player/Spectator権限、招待使用上限、個人単位claim、冪等キー再送・衝突、未来revision拒否、イベント差分、応援コメントの送り先/レート制限、raw中保留、player_visibility=all を試験する。
- TypeScript `strict` で `index.ts`・`room.ts`・検証スクリプトを静的チェック済み。ただしこの環境には実際の `../../ts/game.ts` とCloudflare公式型が無かったため、**エンジンの公開型・DO APIを模した一時宣言を使ったチェック**であり、実エンジンを含む本物の `npx tsc --noEmit` までは実行できていない。
- Node 22の組込みSQLiteを使用したDO/WorkerモックHTTP実行では、`anomalies_phase4.ts` の主要権限テストが完走した。実際のCloudflare `wrangler dev`／本番デプロイの実行結果ではない。

ローカル本検証の推奨コマンド：

```bash
# worker/ プロジェクト内 .dev.vars に DEV_MODE="1" を置く
npx tsc --noEmit
npx wrangler dev --port 8787 --ip 127.0.0.1
node verify/anomalies_phase4.ts http://127.0.0.1:8787
```

`wrangler dev` でエンジン型のずれ・イベントスナップショットサイズ・DO再起動復元・同時reaction lease・Alarmとの競合を再検証すること。
