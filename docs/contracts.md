# Contracts.md
- 본 문서는 각 팀원이 **CRDT 기반 고가용성 실시간 협업 ERD 편집기 프로젝트를 진행하는 데 있어 준수해야 하는 정책을 명시한다.**
- 제안서에 작성했던 내용을 바탕으로 구현하되, 명시된 이름, 형식, 순서는 바꾸지 않는다. 변경이 필요한 경우, 나머지 두 팀원이 해당 사항을 인지하고 승인해야 한다.

- [초안] 제안서에서 제시되지 않았던 구체적인 내용을 해당 문서에서 처음 제시한 내용으로, 이후 수정될 수 있음

---

## 1. 용어

| 용어 | 뜻 |
| --- | --- |
| docId | ERD 문서 하나의 ID. WebSocket 경로와 Redis·S3 키에 그대로 들어간다 |
| podId | 편집 파드의 ID. Kubernetes Pod 이름(`metadata.name`)을 그대로 쓴다 |
| 홈 파드 | HAProxy 일관 해싱으로 docId가 배정되는 파드 |
| LOCAL / SHARED | 문서별 전파 모드. LOCAL은 Pub/Sub 발행 안 함, SHARED는 발행함 |

---

## 2. ERD 데이터 모델 (`Y.Doc`)

- 복합 UNIQUE, AI, Default value를 erd element로 추가하고 내보내기 시 반영하는 기능은 제안서 외 범위이다. 캔버스 디자인 과정에서 추가하였다.
- SQL·PNG·JSON 내보내기와 복합 UNIQUE·AI·기본값은 제안서 외 범위, SQL·PNG·JSON 내보내기는 스케줄 조정에 따라 구현하지 않을 수 있다.

### 2.1 최상위 구조

```tsx
const doc = new Y.Doc()
const tables    = doc.getMap<Y.Map<any>>('tables')     // key = tableId
const relations = doc.getMap<Y.Map<any>>('relations')  // key = relationId
```

최상위 공유 타입은 우선 위 두 개뿐이다

### 2.2 테이블 (`tables`의 값, Y.Map)

| 키 | 타입 | 설명 |
| --- | --- | --- |
| `id` | string | = tableId |
| `logicalName` | string | 논리명 (예: `회원`). 최대 20자. SQL 내보내기 시 `COMMENT` 처리된다 |
| `physicalName` | string | 물리명 = SQL 테이블명 (예: `users`). 최대 64자(MySQL 식별자 한도) |
| `position` | `{ x: number, y: number }` | **x·y를 한 값으로 저장, 그렇지 않으면 동시 드래그 시 좌표 혼합 발생할 수 있음** |
| `color` | string | 헤더 색 `#rrggbb`. 편집 패널 팔레트 10색 중 하나 |
| `columns` | `Y.Map<Y.Map>` | 컬럼 목록(2.3). key = column의 Id. 순서는 각 컬럼의 `order` 필드로 정한다 |
| `uniques` | `Y.Map<Y.Map>` | 복합 UNIQUE 목록(2.4). key = 제약 id |
- **동시 편집 단위는 key 단위**
    1. 한 column의 type과 NN 변경은 둘 다 반영된다
    2. 두 명이 동시에 type을 거의 동시에 수정할 경우 둘 중 하나의 값으로 수렴
- 이름 값은 Y.text가 아닌 plain string

### 2.3 컬럼 (`columns`의 값, Y.Map)

| 키 | 타입 | 설명 |
| --- | --- | --- |
| `id` | string | = columnId |
| `logicalName` | string | 논리명. 최대 20자, SQL 내보내기 시 Comment에 반영된다 |
| `physicalName` | string | 물리명 = SQL 컬럼명. 최대 64자 |
| `type` | string | `BIGINT`, `INT`, `VARCHAR(255)`, `DECIMAL(10,2)`, `TEXT`, `DATETIME` 등 자유 문자열 |
| `pk` | boolean | 기본 키. 여러 컬럼이 `true`면 복합 PK |
| `notNull` | boolean | NOT NULL |
| `unique` | boolean | 단일 컬럼 UNIQUE |
| `autoIncrement` | boolean | AUTO_INCREMENT |
| `default` | string \| null | 기본값. **사용자가 입력한 문자열 그대로** 저장하고, 따옴표 처리는 SQL 내보내기에서만 한다 |
| `comment` | string \| null | 코멘트, 편집기 내에서만 표시되며 내보내기 시 반영되지 않는다 |
| `order` | number | `order` 의 오름차순대로 화면에 column 출력 |

#### **column 순서 규칙**

- **정렬 기준**
    1.  `order` 오름차순
    2.  `id` 오름차순
    - 화면 그리기, SQL 내보내기, 수렴 검증이 모두 이 규칙 하나를 공유
- **맨 끝에 추가:** 현재 가장 큰 order + 1. 테이블이 비어 있으면 1.
- **↑↓ 이동이나 중간 삽입:** 해당 column의 order 값을 들어갈 자리의 앞뒤 컬럼 order의 중간값으로 설정. 맨 위로 갈 때는 첫 order - 1. **컬럼 Y.Map은 지우거나 새로 만들지 않는다.**
- **중간값이 너무 잘게 쪼개져 앞뒤 값이 같아지면:** 테이블의 모든 column order를 한 트랜잭션에서 rerank

> 제안서는 컬럼 목록을 Y.Array로 적었지만 Y.Array에는 이동 연산이 없어 column 순서 변경을 (해당 column 삭제 + 복사본 삽입)을 진행해야 한다. 이 경우 1) 이동 시 다른 사용자가 해당 column에 한 수정이 유실될 수 있고 2) 두 사용자가 동시에 column의 순서를 이동시킬 경우 복제될 수 있으므로 Y.Map 구조를 바탕으로 order를 통한 index 관리 방법을 채택했다.
> 

#### **옵션 간 규칙**

- UI level block, 동시 편집으로 어긋난 값은 **데이터를 고치지 않고 내보내기에서 추가 검증**

| 규칙 | UI | 어긋났을 때 내보내기 |
| --- | --- | --- |
| PK면 UQ 불가 | PK 체크 시 UQ 비활성화 + `unique=false`, PK 해제 시 UQ 다시 선택 가능 | `pk && unique`이면 `unique` 무시 |
| AI는 PK일 때만 | PK가 아니면 AI 비활성화 | `!pk && autoIncrement`이면 `autoIncrement` 무시 |
| 테이블당 AI 1개 | 이미 AI 컬럼이 있으면 경고 | 첫 번째 AI 컬럼만 반영 |

> 데이터를 자동으로 고치지 않는 이유: 클라이언트마다 동시에 수정을 쓰면 서로 다른 값으로 덮어써 수렴이 흔들린다. 해석은 읽는 쪽(Render, 내보내기)에서.
> 

### 2.4 복합 UNIQUE (`uniques`의 값, Y.Map)

| 키 | 타입 | 설명 |
| --- | --- | --- |
| `id` | string | 제약 id |
| `name` | string \| null | 제약 이름. 비우면 내보내기 시 자동 생성 (예: `uq_{table}_{col1}_{col2}`) |
| `columnIds` | string[] | 묶을 컬럼의 **id**(이름 아님 → 컬럼 이름이 바뀌어도 유지). 배열 통째로 LWW |
- 존재하지 않는 컬럼 id는 렌더·내보내기에서 무시한다.
- 유효 컬럼이 **2개 이상**일 때만 SQL에 `UNIQUE KEY`로 내보낸다

### 2.5 관계 (`relations`의 값, Y.Map)

| 키 | 타입 | 설명 |
| --- | --- | --- |
| `id` | string | = relationId |
| `fromTable` | string | 부모(참조되는) tableId |
| `toTable` | string | 자식(참조하는) tableId. `fromTable`과 같으면 자기 참조 (예: categories.parent_id) |
| `toColumn` | string? | 자식 쪽 FK 컬럼 id (없으면 테이블 단위 관계) |
| `cardinality` | `'1:1' \| '1:N'` | 관계 차수 |
| `identifying` | boolean | 식별 관계(실선) / 비식별 관계(점선) |

툴바의 관계 버튼 4개 = `cardinality` 2종 × `identifying` 2종.

### 2.6 [확장안] 메모

ERD table 외 일반 메모를 넣기로 하면 최상위에 아래를 추가한다.

```tsx
const memos = doc.getMap<Y.Map<any>>('memos')  // { id, text: string, position: {x,y}, size: {w,h} }
```

### 2.7 편집 규칙

- **ID 생성**: `crypto.randomUUID()`. 클라이언트가 만든다. 서버는 ID를 만들지 않는다.
- **한 동작 = 한 트랜잭션**: 여러 키를 바꾸는 동작은 `doc.transact(() => { ... })` 안에서 한다 (예: 테이블 생성 시 logicalName·physicalName·position·columns를 한 번에).
- **테이블 삭제**: 같은 트랜잭션에서 그 테이블을 `fromTable`/`toTable`로 가진 관계도 함께 삭제한다.
- **고아 관계 처리**: 동시 편집으로 존재하지 않는 테이블·컬럼을 가리키는 관계가 남을 수 있다. 클라이언트는 이런 관계를 **그리지 않는다**(데이터는 지우지 않음). 수렴 검증에는 영향 없음.
- **삭제된 테이블에 동시에 추가된 컬럼**은 테이블과 함께 사라진다(표 2의 "삭제로 수렴"). 의도된 동작이다.
- **드래그**: 드래그 중에는 `position`을 최대 50ms에 한 번만 쓰고, 드래그가 끝날 때 마지막 값을 한 번 더 쓴다.

### 2.8 수렴 검증용 문서 해시

```tsx
// 키를 정렬한 JSON으로 직렬화한 뒤 SHA-256
hash = sha256(canonicalJSON(doc.toJSON()))
```

Y.Doc 스키마 타입, 생성·이동·삭제 헬퍼, `canonicalJSON`은 `client/src/model/` 한 곳에만 두고,
`loadtest/`(부하 봇·수렴 검증기)는 이를 import해서 쓴다. 같은 규칙을 두 번 구현하지 않는다.

---

## 3. Awareness 상태

```tsx
awareness.setLocalState({
  user:    { id: string, name: string, color: string },  // color = '#rrggbb'
  editing: { tableId: string, columnId: string | null } | null,  // 편집 중인 엔티티
  cursor:  { x: number, y: number } | null,  // 캔버스 좌표(화면 좌표 아님), Should 항목
})
```

- 서버는 awareness 내용을 해석하지 않고 그대로 중계만 한다. 다른 파드에 붙은 사용자에게는 `AWARENESS` 메시지(5.2)로 전달한다.
- `cursor`는 최대 50ms에 한 번만 갱신한다.

---

## 4. 클라이언트 ↔ 서버 (WebSocket)

### 4.1 경로

| 환경 | URL |
| --- | --- |
| 로컬 (HAProxy 입구) | `ws://localhost:8088/ws/{docId}` |
| 확장 (AWS) | `wss://<ALB>/ws/{docId}` |
- `docId` 형식 [초안]: `^[A-Za-z0-9_-]{1,64}$`. 형식이 틀리면 서버는 close code `4400`으로 닫는다.
- y-websocket `WebsocketProvider`를 쓸 때: `new WebsocketProvider('ws://localhost:8088/ws', docId, doc)` (provider가 `/{docId}`를 붙임).
- 쿼리 파라미터·인증 없음 (범위 제외).

### 4.2 메시지 형식

y-websocket 프로토콜을 **그대로** 쓴다. 서버 전용 메시지 타입을 추가하지 않는다.

| 첫 varUint | 타입 | 내용 |
| --- | --- | --- |
| 0 | messageSync | SyncStep1 / SyncStep2 / Update (y-protocols/sync) |
| 1 | messageAwareness | awareness update (y-protocols/awareness) |
| 3 | messageQueryAwareness | 전체 awareness 요청 |

### 4.3 연결 유지·재접속

- 서버는 30초마다 WebSocket ping을 보낸다. HAProxy `timeout tunnel`은 이보다 길게(1h) 잡는다.
- 클라이언트 close code별 동작:

| close code | 의미 | 클라이언트 동작 |
| --- | --- | --- |
| 1012 | 서버 재시작/종료 중 (graceful shutdown) | 0~500ms 무작위 지연 후 **즉시** 재접속 |
| 4400 | 잘못된 docId | 재접속하지 않고 오류 표시 |
| 그 외 / 비정상 끊김 | 장애 | 지수 백오프 0.5s → 1s → 2s … 최대 10s, ±20% 지터 |
- 재접속 후 SyncStep1·2로 끊긴 동안의 편집을 자동 병합한다(Yjs 기본 동작). 클라이언트는 별도 재전송 큐를 두지 않는다.

---

## 5. 서버 ↔ 서버 (Redis Pub/Sub, 적응형 전파)

### 5.1 채널

`doc:{docId}:updates` — 문서마다 채널 하나. 업데이트, awareness, 제어 메시지를 같은 채널로 보낸다.

### 5.2 메시지 봉투

바이너리(lib0 encoding)로 아래 순서대로 쓴다.

| 순서 | 필드 | 인코딩 | 설명 |
| --- | --- | --- | --- |
| 1 | `type` | varUint | 0 UPDATE · 1 JOIN · 2 LEAVE · 3 HEARTBEAT · 4 SYNC1 · 5 SYNC2· 6 AWARENESS |
| 2 | `from` | varString | 보낸 podId. **자기가 보낸 메시지는 수신 시 무시** |
| 3 | `to` | varString | 받을 podId. 빈 문자열이면 전체 |
| 4 | `sentAt` | float64 (ms) | 보낸 시각. 동기화 지연 지표 계산용 |
| 5 | `payload` | varUint8Array | UPDATE: Yjs update · SYNC1: state vector · SYNC2: 차분 update · AWARENESS: awareness update (y-protocols/awareness) · 나머지: 빈 배열 |

### 5.3 모드 전환 규칙

1. 파드에 문서의 첫 클라이언트가 붙으면: 문서를 복원(6.4)하고 채널을 **구독**한 뒤 `JOIN`을 발행한다. 피어가 없으면 **LOCAL**. → 제안서는 처음 연 파드는 발행하지 않는다고 명시했지만, 넘친 파드가 먼저 열었는지 확인하기 위해 1회 `JOIN` 만 예외로 설정.
2. `JOIN`을 받은 파드: 보낸 파드를 피어 목록에 넣고 **SHARED**로 바꾼 뒤, 그 파드에게 `HEARTBEAT`(to=보낸 파드)와 `SYNC1`을 보낸다. JOIN을 보낸 파드도 피어에게서 HEARTBEAT·SYNC1 등 어떤 메시지든 받으면, 보낸 파드를 피어 목록에 넣고 SHARED로 바꾼다.
3. `SYNC1`을 받으면 `SYNC2`(to=보낸 파드)로 상대에게 없는 부분을 돌려준다. 처음 보는 피어면 자기 `SYNC1`(to=보낸 파드)도 보내서 양방향으로 맞춘다.
4. **SHARED인 동안에만** 로컬 클라이언트의 업데이트를 `UPDATE`로 발행한다. LOCAL이면 발행하지 않는다. SHARED인 동안에만 로컬 클라이언트의 awareness 변경을 AWARENESS로 발행한다. 받은 파드는 자기 클라이언트들에게 그대로 전달한다.
5. SHARED 파드는 `HEARTBEAT`를 **5초**마다 보낸다. 피어에게서 **15초** 동안 아무 메시지도 없으면 피어 목록에서 뺀다.
6. 파드의 그 문서 마지막 클라이언트가 떠나면: Streams flush(6.2) → `LEAVE` 발행 → 구독 해제 → 메모리에서 문서 제거.
7. 피어 목록이 비면 **LOCAL**로 돌아간다.

### 5.4 실험용 전환 플래그

환경 변수 `PROPAGATION_MODE`:

- `adaptive` (기본): 위 규칙대로 동작
- `broadcast`: 항상 SHARED처럼 모든 업데이트를 발행 (실험 3의 기존 방식 A)

---

## 6. 영속화 (Redis Streams + MinIO)

### 6.1 Streams 키

`doc:{docId}:log` — 필드 `u` (병합된 Yjs update, 바이너리), `pod` (podId)

### 6.2 기록 규칙

- 파드는 **자기 로컬 클라이언트가 만든 업데이트만** 기록한다. Pub/Sub로 받은 다른 파드의 업데이트는 기록하지 않는다(중복 기록 방지).
- 200ms(`FLUSH_INTERVAL_MS`) 동안 모은 업데이트를 `Y.mergeUpdates`로 합쳐 `XADD doc:{docId}:log * u <bin> pod <podId>` 1회.
- 종료 직전(7.2)과 문서 언로드 직전(5.3-6)에는 남은 버퍼를 즉시 flush한다.
- Redis가 끊긴 동안 XADD할 업데이트는 메모리 버퍼에 계속 병합해 두고, 재연결 즉시 flush한다.
- 재연결 후 SHARED 문서는 피어 파드와 SYNC1·SYNC2를 다시 교환한다 (Pub/Sub는 끊긴 동안의 메시지를 다시 주지 않으므로).

### 6.3 스냅샷

- 객체 키: `snapshots/{docId}/latest.bin` (Yjs `encodeStateAsUpdate` 결과)
- 메타데이터: `lastStreamId` = 스냅샷에 반영된 마지막 Stream 항목 ID
-  버킷: `erd-snapshots`. `lastStreamId`는 S3 사용자 메타데이터(`x-amz-meta-last-stream-id`)로 저장
- 스냅샷 워커는 30초마다 `SCAN`으로 `doc:*:log`를 찾아, 새 항목이 있는 문서만 스냅샷을 만든다.
- 스냅샷 업로드에 **성공한 뒤에만**, 직전 스냅샷의 `lastStreamId` 기준으로 `XTRIM doc:{docId}:log MINID <직전 lastStreamId>` 한다. 한 세대 늦게 잘라서, 옛 스냅샷으로 복원 중인 파드도 필요한 로그를 읽을 수 있게 한다.
- 워커는 문서별로 직전 `lastStreamId`를 기억해 둔다.

### 6.4 복원 순서

1. 클라이언트가 해시 링의 다음 파드로 재접속
2. 새 홈 파드가 MinIO에서 `latest.bin`과 `lastStreamId`를 읽음 (없으면 빈 문서, `lastStreamId = 0`)
3. `XRANGE doc:{docId}:log (<lastStreamId> +`로 이후 로그를 읽어 적용
4. 클라이언트와 SyncStep1·2로 빠진 부분 교환

**복원이 끝나기 전에는 클라이언트의 SyncStep1에 응답하지 않는다** (빈 문서를 내려보내지 않도록).

---

## 7. 운영

### 7.1 헬스 체크

| 경로 | 200 | 503 |
| --- | --- | --- |
| `GET /healthz` | 프로세스 살아 있음 | — |
| `GET /readyz` | 새 연결 받을 수 있음 | 종료 중 |

`/readyz`는 Redis 연결 상태와 무관하다. Redis가 끊겨도 LOCAL 문서는 파드 메모리에서 계속 편집된다.

### 7.2 종료 순서

1. SIGTERM 수신 → `/readyz`를 503으로 바꿈
2. 5초 대기 (readiness probe 주기만큼, HAProxy가 새 연결을 그만 보내도록)
3. 모든 문서의 Streams 버퍼 flush
4. 모든 연결을 close code **1012**로 닫음
5. 문서별 `LEAVE` 발행 후 종료. `terminationGracePeriodSeconds: 30`

### 7.3 지표 (`GET /metrics`, Prometheus 형식)

| 이름 | 종류 | 라벨 | 상태 |
| --- | --- | --- | --- |
| `editor_ws_connections` | gauge | — |  HPA 기준 |
| `editor_messages_total` | counter | `type`: `sync`, `awareness`, `pubsub_in`, `pubsub_out`, `xadd` | 라벨 값 |
| `editor_sync_latency_seconds` | histogram | — |  Pub/Sub 수신 시 `now - sentAt`. buckets: 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2 |
| `editor_doc_restore_seconds` | histogram | — | 6.4의 2~3단계 소요 시간 |
| `editor_docs` | gauge | `mode`: `local`, `shared` | SHARED 문서 비율 대시보드용 |

- Redis 작업량은 전체 파드의 `pubsub_out + pubsub_in + xadd` 합으로 계산하며, 실제 부하는 `redis_exporter`로 수집한다.
    
    → `redis_exporter`는 Redis가 받은 명령만 세므로 구독 파드로의 배달 횟수가 빠진다. 따라서 작업량은 서버 지표를 기반으로, `redis_exporter`는 CPU, 네트워크 부하 수집용으로 활용한다.

### 7.4 라우팅 (HAProxy)

```
backend editors
    balance uri
    hash-type consistent
    hash-balance-factor 125
    timeout tunnel 1h
    option httpchk GET /readyz
    server-template editor 16 editor-headless.default.svc.cluster.local:8080 check resolvers k8s init-addr none
```

- `balance uri`가 경로 전체(`/ws/{docId}`)를 해싱하므로 **경로에 docId 외의 값을 넣지 않는다**.
- [초안] `server-template` 슬롯 16개 ≥ HPA `maxReplicas` 8 (제안서 실험 최대 파드 수). 파드가 없는 빈 슬롯은 HAProxy가 MAINT로 두어 해시 링에서 빠진다

### 7.5 포트·환경 변수

| 컨테이너 | 포트 | 용도 |
| --- | --- | --- |
| editor (server/) | 8080 | WebSocket `/ws/*`, `/healthz`, `/readyz`, `/metrics` |
| snapshot-worker (worker/) | 8081 | `/healthz`, `/metrics` |
| client | 5173 (dev) | Vite dev server |

| 변수 | 예시 | 사용처 |
| --- | --- | --- |
| `PORT` | `8080` | server, worker |
| `POD_ID` | Downward API `metadata.name` | server |
| `REDIS_URL` | `redis://redis-0.redis:6379` | server, worker |
| `S3_ENDPOINT` | `http://minio:9000` | server, worker |
| `S3_BUCKET` | `erd-snapshots` | server, worker |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Secret에서 주입 | server, worker |
| `PROPAGATION_MODE` | `adaptive` | server |
| `FLUSH_INTERVAL_MS` | `200` | server |
| `HEARTBEAT_INTERVAL_MS` | `5000` | server |
| `SNAPSHOT_INTERVAL_MS` | `30000` | worker |
| `VITE_WS_URL` | `ws://localhost:8088/ws` | client |
| `AWS_REGION` | `us-east-1` | server, worker |

AWS SDK v3로 MinIO에 붙으려면 region 값과 path-style 설정이 필요하다. `S3Client`는 아래처럼 만든다.

```tsx
new S3Client({ endpoint: S3_ENDPOINT, region: AWS_REGION, forcePathStyle: true })
```

- MinIO는 path-style 주소(`http://minio:9000/버킷/키`)만 지원하므로 `forcePathStyle`이 필요하다.
- AWS S3로 확장할 때는 `S3_ENDPOINT`만 비우면 된다.

---

## 8. 변경 절차

- 이 문서를 바꾸는 PR은 **다른 두 명 모두 승인**해야 merge한다.
- 버전을 올리고 아래 변경 이력에 한 줄 남긴다.
- [초안] 항목은 담당자가 확인하면 제거.

| 버전 | 날짜 | 변경 | 작성 |
| --- | --- | --- | --- |
| v0.1 | 2026-11-05 | 초안 작성 (제안서 표 9 + 데이터 모델·프로토콜 세부) | 김령준 |
| v0.1.1 | 2026-11-06 | 백엔드 확정 | 이지민 |