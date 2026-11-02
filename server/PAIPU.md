# 牌譜（paipu）フォーマット仕様 v1

Muse雀荘の対局記録ファイル「牌譜」の形式と、サーバーからの取得方法を定義する。

## 目的

- 終了した半荘を、後からそのまま再生・検証できる形で残す。
- 従来の `events` は差分配信用で、保持上限（`RETAIN_EVENTS`）を超えると
  古いイベントから削除されるため、半荘の完走記録には使えなかった。
  牌譜はイベント列を対局（match）単位で別に蓄積し、終了後に一括で
  書き出せるようにしたもの。

## 取得方法

```
GET /rooms/{roomId}/paipu[?match=<match_key>]
Authorization: Bearer <token>   （Master / Player / Spectator いずれも可）
```

- `match` 省略時は、その卓で最も新しく終了した半荘を返す。
- 応答は `application/x-ndjson`、`Content-Disposition: attachment` で
  ファイルとして返す。Helper では `jansou_helper.py paipu` で保存できる。

### エラー

| 状態 | error | 意味 |
| --- | --- | --- |
| 404 | `no_finished_match` | 終了した半荘がまだない |
| 404 | `match_not_found` | 指定の match_key が存在しない |
| 409 | `match_not_finished` | 指定の半荘はまだ対局中 |
| 410 | `paipu_expired` | 半荘は終了したが、牌譜の保持期間（直近5半荘）を過ぎて削除済み |

### 情報の取り扱い

牌譜に含まれる局面スナップショットは **全員の手牌を含む master 視点**の
記録である。そのため書き出しは **終了した半荘に限る**（対局中の半荘は
絶対に書き出さない）。終了後の牌譜は、通常の麻雀の牌譜と同様に
参加者・観戦者が検証・再生に使ってよい記録として扱う。

## ファイル形式（NDJSON）

1行1JSONオブジェクト。行の種類は `type` で区別する。

### 1行目：ヘッダー

```json
{"type":"paipu_header","schema_version":1,"room_id":"...","match_key":"g0:initial","exported_at":1762000000000,"event_count":1514,"first_seq":12,"last_seq":1525,"complete":true,"requested_by":"player"}
```

- `schema_version`：この仕様の版。現在は `1`。
- `match_key`：半荘の識別子（ランキング記録と同じキー）。
- `event_count` / `first_seq` / `last_seq`：イベント行の件数と範囲。
- `complete`：イベント列が半荘の開始イベント（`kind` = `init`）から
  始まっているとき `true`。サーバーの更新前に開始した半荘など、
  途中からしか記録がない場合は `false` になる。

### 中間行：イベント

```json
{"type":"event","seq":12,"revision":0,"kind":"init","state":{ ... }}
```

- `seq`：卓内のイベント通し番号（`events` と同じ）。
- `revision`：局面のリビジョン。イベント順に単調増加する。
- `kind`：状態遷移の種別（`init` / `alarm_settle` など、`events` の
  `cause` と同じ値）。
- `state`：その時点の master 視点スナップショット。形式は `events` に
  保存される archival スナップショットと同一（`publicState` を master
  視点で射影したもの）。

### 最終行：フッター

```json
{"type":"paipu_footer","match_key":"g0:initial","finished_at":1762000000000,"results":[{"seat":0,"participant_id":"...","display_name":"...","icon":null,"score":34200,"rank":1}]}
```

- `results`：ランキング記録（`ranking_results`）と同じ最終結果。
  席順に4件。

## 再生（ビューア）について

牌譜の再生は読み手側の仕事とする（この仕様の範囲外）。

- イベント行を `seq` 順に読み、各 `state` をそのまま表示すれば
  全席オープンでの再生になる。
- 特定の席の視点で再生する場合は、`events` 取得時と同じ
  allowlist 射影（自席の手牌だけを見せる等）をビューア側で適用する。
- 点数・順位の検証はフッターの `results` と、各イベントの
  `state` の点数遷移を突き合わせればよい。
