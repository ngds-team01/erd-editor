# server — 편집 서버

ERD 문서(Yjs `Y.Doc`)를 메모리에 들고, 같은 문서에 접속한 클라이언트끼리 편집과 편집 중 표시(awareness)를 실시간으로 주고받게 하는 WebSocket 서버다.

- 이름, 형식, 순서의 기준은 [docs/contracts.md](../docs/contracts.md)다. 이 문서와 contracts가 다르면 contracts가 맞다.
- Node.js 20.19 이상, TypeScript, `ws`, `yjs`, `y-protocols`, `ioredis`

## 실행

```bash
# Redis (없어도 서버는 뜨고 편집도 된다. 붙으면 로그에 "Redis 연결됨"이 찍힌다)
docker run -d --name redis -p 6379:6379 redis:7.4-alpine

cd server
npm install
npm run dev        # 파일 저장 시 자동 재시작, http://localhost:8080
```

| 명령 | 하는 일 |
| --- | --- |
| `npm run dev` | 개발 모드 실행 (tsx watch) |
| `npm run build` | `dist/`로 컴파일 (테스트 파일 제외) |
| `npm start` | 컴파일된 `dist/index.js` 실행 |
| `npm run typecheck` | 타입 검사 (테스트 포함) |
| `npm test` | 복원 로직 테스트 (Redis·MinIO 없이 메모리 구현으로) |

MinIO가 없어도 서버는 뜬다. 문서를 열 때 스냅샷을 읽지 못했다는 경고를 남기고 Streams 기록만으로 복원한다 (아래 "문서 복원").

Docker 이미지:

```bash
docker build -t erd-server ./server
docker run --rm -p 8080:8080 -e REDIS_URL=redis://host.docker.internal:6379 erd-server
```

## 엔드포인트 (포트 8080)

| 경로 | 응답 |
| --- | --- |
| `GET /healthz` | 프로세스가 살아 있으면 항상 `200 ok` |
| `GET /readyz` | 새 연결을 받을 수 있으면 `200 ready`, 시작 전이거나 종료 중이면 `503`. **Redis 연결 상태와는 무관** (contracts 7.1) |
| `GET /metrics` | Prometheus 지표 (contracts 7.3, 아래 "지표") |
| `WS /ws/{docId}` | 문서 편집 연결. 아래 "WebSocket" 참고 |
| 그 밖의 경로 | `404` |

## WebSocket

### 접속

- 주소: `ws://<host>:8080/ws/{docId}` (HAProxy를 거치면 `ws://localhost:8088/ws/{docId}`)
- `docId`: 영문·숫자·`_`·`-` 1~64자 (`^[A-Za-z0-9_-]{1,64}$`)
- 클라이언트는 y-websocket을 그대로 쓴다. provider가 주소 끝에 `/{docId}`를 붙인다.

```ts
new WebsocketProvider('ws://localhost:8088/ws', docId, doc)
```

### 메시지 형식

y-websocket 프로토콜을 그대로 쓴다. 바이너리 메시지의 첫 varUint가 종류다. 서버 전용 메시지는 없다.

| 첫 varUint | 종류 | 내용 | 서버 동작 |
| --- | --- | --- | --- |
| 0 | sync | SyncStep1 / SyncStep2 / Update (`y-protocols/sync`) | Step1을 받으면 Step2로 답한다. Update는 문서에 적용하고 같은 문서의 다른 연결에 전달한다 |
| 1 | awareness | awareness update (`y-protocols/awareness`) | 내용을 해석하지 않고 같은 문서의 모든 연결에 전달한다 |
| 3 | queryAwareness | 전체 awareness 요청 | 현재 접속자 전체 awareness를 보낸다 |

접속 직후 서버가 먼저 보내는 것:

1. 서버 문서의 SyncStep1 (클라이언트가 Step2로 서버에 없는 부분을 보낸다)
2. 이미 접속한 사람이 있으면 그 사람들의 awareness

### 연결 유지와 종료

- 서버는 30초마다 ping을 보내고, 다음 ping 때까지 pong이 없으면 연결을 닫는다.
- 문서에 마지막 연결이 끊기면 Streams 버퍼를 flush하고 LEAVE를 보낸 뒤 서버 메모리에서 문서를 내린다 (contracts 5.3-6). 다시 열면 스냅샷과 Streams 기록으로 복원한다 (아래 "문서 복원").

### Streams 기록 (contracts 6.1, 6.2)

- 이 파드 사용자의 편집만 `FLUSH_INTERVAL_MS`(200ms) 동안 모아 `Y.mergeUpdates`로 합친 뒤 `XADD doc:{docId}:log * u <bin> pod <podId>` 1회로 기록한다. 다른 파드에서 받은 편집은 그 파드가 기록하므로 기록하지 않는다.
- Redis가 끊긴 동안에는 메모리 버퍼에 합쳐 두었다가 다시 붙으면 바로 기록한다. 그사이 문서를 내려도 버퍼는 남는다.

| close code | 의미 | 클라이언트가 할 일 |
| --- | --- | --- |
| 1012 | 서버 종료·재시작 중 | 재접속 (다른 파드로 연결된다) |
| 4400 | `docId` 형식이 틀림 | 재접속하지 않고 오류 표시 |

### 문서 복원 (contracts 6.4)

문서를 처음 열 때(이 파드에 그 문서의 첫 연결이 붙을 때) 아래 순서로 복원한 뒤 채널을 구독하고 JOIN한다 (5.3-1).

1. MinIO에서 `snapshots/{docId}/latest.bin`과 메타데이터 `last-stream-id`를 읽는다. 없으면 빈 문서, `lastStreamId = 0`
2. `XRANGE doc:{docId}:log (<lastStreamId> +`를 500개씩 읽어 적용한다
3. 이 파드가 아직 Streams에 기록하지 못한 버퍼(Redis가 끊긴 동안 문서를 내렸다 다시 연 경우)도 적용한다
4. 걸린 시간(1~2단계)을 `editor_doc_restore_seconds`에 기록한다

- **복원이 끝나기 전에는 클라이언트에게 답하지 않는다.** 그사이 붙은 연결에는 서버 SyncStep1도 보내지 않고, 받은 메시지(SyncStep1, 편집, 커서)는 연결별로 쌓아 두었다가 복원이 끝나면 받은 순서대로 처리한다. 빈 문서로 SyncStep2를 보내면 클라이언트가 빈 문서를 동기화 완료로 보기 때문이다.
- 복원으로 넣은 내용은 이미 저장돼 있으므로 Pub/Sub로 발행하지도, Streams에 다시 기록하지도 않는다.
- 로그 한 줄: `[doc:x] 복원 완료 0.024초 (스냅샷 있음, 기록 98항목)`

| 상황 | 처리 |
| --- | --- |
| 스냅샷 읽기 실패 (MinIO 꺼짐, 응답 없음), Streams 앞부분이 이미 잘림 | **복원하지 않고 기다린다.** 클라이언트에게 답하지 않은 채 2초마다 스냅샷을 다시 읽는다. 잘린 앞부분(예: 테이블 생성)에 의존하는 뒤 기록(예: 컬럼 추가)은 Yjs가 대기 상태로만 들고 있어 빈 문서로 보이고, 사용자가 다시 만들면 두 벌이 되기 때문이다. 잘렸는지는 `XINFO STREAM`의 `entries-added`(지금까지 추가한 수)가 `length`(남은 수)보다 크면 잘린 것으로 보고, 확인하지 못하면(Redis 끊김) 잘린 것으로 본다. `max-deleted-entry-id`는 XTRIM을 반영하지 않아 쓰지 않는다 |
| 스냅샷 읽기 실패, Streams가 한 번도 잘리지 않음 | Streams에 처음부터 다 있으므로 Streams만으로 복원한다. 그사이 워커가 자를 수 있어 문서가 열려 있는 동안 5초마다 스냅샷을 다시 읽어 합친다 |
| Streams 읽기 실패 (Redis 끊김) | 읽은 데까지로 복원하고, Redis가 다시 붙으면 나머지를 이어 읽어 적용한다 (접속한 클라이언트에게도 전달) |
| 복원 중에 마지막 연결이 떠남 | 복원 결과를 버리고 문서를 내린다 |

어느 경우든 클라이언트가 가진 내용은 접속 후 SyncStep2로 서버에 다시 올라오므로 지워지지 않는다.

### 다른 파드와 전파 (contracts 5장)

- 문서를 처음 열면 복원을 마친 뒤 `doc:{docId}:updates` 채널을 구독하고 JOIN을 보낸다. 다른 파드가 응답하지 않으면 **LOCAL**(Pub/Sub 발행 안 함).
- 다른 파드도 같은 문서를 열고 있으면 **SHARED**: 이 파드 사용자의 편집(UPDATE)과 커서(AWARENESS)를 발행하고, 받은 것은 이 파드 사용자에게 전달한다. 받은 것은 다시 발행하지 않는다.
- 처음 만난 파드끼리는 SYNC1·SYNC2로 서로 없는 부분을 주고받는다.
- SHARED 동안 `HEARTBEAT_INTERVAL_MS`(5초)마다 HEARTBEAT를 보내고, 3배(15초) 동안 소식 없는 파드는 피어에서 뺀다. 피어가 없으면 LOCAL로 돌아간다.
- 마지막 사용자가 나가면 LEAVE를 보내고 구독을 해제한 뒤 문서를 내린다.
- Redis가 다시 붙으면 열린 문서마다 JOIN을 다시 보내 끊긴 동안의 변경을 SYNC로 맞춘다.
- contracts와 다르게 해석한 곳: 5.3-3 "처음 보는 피어면 SYNC1"은 "아직 SYNC1을 보내지 않은 피어면"으로 구현했다. JOIN을 보낸 쪽은 상대의 HEARTBEAT(규칙 2로 피어 등록)를 SYNC1보다 먼저 받아서, 문구 그대로면 자기 SYNC1을 보내지 않아 양방향 동기화가 깨진다.

### 종료 순서 (SIGTERM)

contracts 7.2를 따른다.

1. `/readyz`를 503으로 바꾸고 새 WebSocket 연결을 거절한다.
2. 5초 기다린다 (HAProxy가 이 파드로 새 연결을 그만 보내도록).
3. 모든 문서의 Streams 버퍼를 flush한다. Redis가 끊겨 있으면 기록하지 못한 채 넘어간다.
4. 모든 연결을 close code 1012로 닫는다.
5. 문서별로 이 파드 사용자들의 커서 삭제와 LEAVE를 발행한다. 연결을 닫은 뒤에 보내야 다른 파드가 이 파드를 너무 일찍 빼지 않는다. 상대 파드는 15초 타임아웃을 기다리지 않고 바로 LOCAL로 돌아간다.
6. Redis 연결을 닫고 종료한다. 25초 안에 끝나지 않으면 강제 종료한다 (`terminationGracePeriodSeconds: 30`보다 짧게).

로컬에서 Ctrl+C(SIGINT)는 2번의 대기 없이 바로 종료한다.

## 환경 변수

| 변수 | 기본값 | 설명 | 상태 |
| --- | --- | --- | --- |
| `PORT` | `8080` | HTTP·WebSocket 포트 | 사용 중 |
| `POD_ID` | 호스트 이름 | 로그와 Pub/Sub에서 자기 파드를 구분하는 ID. Kubernetes에서는 Downward API `metadata.name` | 사용 중 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 주소 | 사용 중 |
| `PROPAGATION_MODE` | `adaptive` | `adaptive` 또는 `broadcast` (실험 3, 피어가 없어도 항상 발행) | 사용 중 |
| `FLUSH_INTERVAL_MS` | `200` | Streams 기록 병합 주기 | 사용 중 |
| `HEARTBEAT_INTERVAL_MS` | `5000` | SHARED 문서의 HEARTBEAT 주기. 피어 타임아웃은 3배 | 사용 중 |
| `S3_ENDPOINT` | (없음) | MinIO 주소 (`http://minio:9000`). 비우면 AWS S3 | 사용 중 |
| `S3_BUCKET` | `erd-snapshots` | 스냅샷 버킷 | 사용 중 |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | (없음) | Secret `s3-credentials`에서 주입. SDK가 이 이름을 읽지 않아 `S3Client`에 `credentials`로 넘긴다 (contracts 7.5). 둘 다 없으면 SDK 기본 방식 | 사용 중 |
| `AWS_REGION` | `us-east-1` | MinIO도 값이 있어야 한다 | 사용 중 |

## Redis 연결

- 서버 시작 시 `REDIS_URL`로 접속한다. Redis가 없어도 서버는 뜨고, 같은 파드 안의 편집은 계속된다.
- 명령용 연결과 구독 전용 연결 두 개를 쓴다 (구독 중인 연결로는 PUBLISH·XADD를 못 쓴다). 구독 연결 로그는 `Redis(구독)`으로 표시한다.
- 끊기면 0.2초, 0.4초, … 최대 5초 간격으로 계속 재접속한다.
- 끊긴 동안 보낸 Redis 명령은 쌓아 두지 않고 바로 실패한다. 기록할 업데이트는 서버가 따로 버퍼에 모아 두었다가 다시 붙으면 flush한다 (contracts 6.2).
- 로그는 상태가 바뀔 때만 남는다: `Redis 연결됨` → `Redis 연결 끊김, 재접속 시도 중` → `Redis 다시 연결됨 (N번 재시도)`

## 지표 (`GET /metrics`, contracts 7.3)

| 이름 | 종류 | 값 |
| --- | --- | --- |
| `editor_ws_connections` | gauge | 현재 WebSocket 연결 수 (HPA 기준) |
| `editor_messages_total{type}` | counter | `sync`·`awareness`: 클라이언트에게 받은 메시지 / `pubsub_out`: 발행 / `pubsub_in`: 구독으로 배달받은 메시지(자기 것 포함) / `xadd`: Streams 기록 |
| `editor_sync_latency_seconds` | histogram | 다른 파드 UPDATE를 받았을 때 `now - sentAt` (buckets 0.001~2초) |
| `editor_doc_restore_seconds` | histogram | 문서 복원 시간 (스냅샷 읽기 + Streams 기록 적용). 문서를 처음 열 때마다 1번 |
| `editor_docs{mode}` | gauge | 열린 문서 수 (`local`, `shared`) |

- Redis 작업량은 전체 파드의 `pubsub_out + pubsub_in + xadd` 합으로 본다. 프로세스 CPU·메모리 등 Node 기본 지표도 같이 나온다.

## 파일 구조

| 파일 | 내용 |
| --- | --- |
| `src/index.ts` | HTTP 서버, `/healthz`·`/readyz`, WebSocket 업그레이드와 docId 검사, 종료 순서 |
| `src/doc.ts` | 문서별 `Y.Doc`·awareness 관리, y-websocket 메시지 처리, ping, 복원 순서와 복원 중 메시지 대기 |
| `src/restore.ts` | 스냅샷 + Streams 기록 + 미기록 버퍼를 합쳐 복원 상태 만들기 (`restore.test.ts`에 테스트) |
| `src/s3.ts` | MinIO 스냅샷 읽기 |
| `src/redis.ts` | Redis 연결, 재접속, 상태 로그 |
| `src/config.ts` | 환경 변수 읽기 |

## 진행 상황

| 주차 | 내용 | 상태 |
| --- | --- | --- |
| 1주차 | WebSocket 서버(#4), Redis 연결(#5), 이 명세서(#6) | 완료 |
| 2주차 | 적응형 전파(#18), `/metrics`(#19), Streams 기록(#20), 종료 시 flush·LEAVE(#21) | 완료 |
| 3주차 | 스냅샷 복원(#43) | 진행 중 |
