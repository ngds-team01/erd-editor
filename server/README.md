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
| `npm run build` | `dist/`로 컴파일 |
| `npm start` | 컴파일된 `dist/index.js` 실행 |
| `npm run typecheck` | 타입 검사만 |

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
| `GET /metrics` | (2주차) Prometheus 지표 |
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
- 문서에 마지막 연결이 끊기면 서버 메모리에서 문서를 내린다. (1주차에는 영속화가 없어 내용이 사라진다. 2주차에 Streams·스냅샷으로 복원)

| close code | 의미 | 클라이언트가 할 일 |
| --- | --- | --- |
| 1012 | 서버 종료·재시작 중 | 재접속 (다른 파드로 연결된다) |
| 4400 | `docId` 형식이 틀림 | 재접속하지 않고 오류 표시 |

### 종료 순서 (SIGTERM)

contracts 7.2를 따른다.

1. `/readyz`를 503으로 바꾸고 새 WebSocket 연결을 거절한다.
2. 5초 기다린다 (HAProxy가 이 파드로 새 연결을 그만 보내도록).
3. (2주차) 모든 문서의 Streams 버퍼를 flush하고 LEAVE를 발행한다.
4. 모든 연결을 close code 1012로 닫는다.
5. Redis 연결을 닫고 종료한다. 25초 안에 끝나지 않으면 강제 종료한다 (`terminationGracePeriodSeconds: 30`보다 짧게).

로컬에서 Ctrl+C(SIGINT)는 2번의 대기 없이 바로 종료한다.

## 환경 변수

| 변수 | 기본값 | 설명 | 상태 |
| --- | --- | --- | --- |
| `PORT` | `8080` | HTTP·WebSocket 포트 | 사용 중 |
| `POD_ID` | 호스트 이름 | 로그와 Pub/Sub에서 자기 파드를 구분하는 ID. Kubernetes에서는 Downward API `metadata.name` | 사용 중 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 주소 | 사용 중 |
| `PROPAGATION_MODE` | `adaptive` | `adaptive` 또는 `broadcast` (실험 3) | 2주차 |
| `FLUSH_INTERVAL_MS` | `200` | Streams 기록 병합 주기 | 2주차 |
| `HEARTBEAT_INTERVAL_MS` | `5000` | SHARED 문서의 HEARTBEAT 주기 | 2주차 |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `AWS_REGION` | — | MinIO 스냅샷 복원 | 3주차 |

## Redis 연결

- 서버 시작 시 `REDIS_URL`로 접속한다. Redis가 없어도 서버는 뜨고, 같은 파드 안의 편집은 계속된다.
- 끊기면 0.2초, 0.4초, … 최대 5초 간격으로 계속 재접속한다.
- 끊긴 동안 보낸 Redis 명령은 쌓아 두지 않고 바로 실패한다. 기록할 업데이트는 서버가 따로 버퍼에 모아 두었다가 다시 붙으면 flush한다 (2주차, contracts 6.2).
- 로그는 상태가 바뀔 때만 남는다: `Redis 연결됨` → `Redis 연결 끊김, 재접속 시도 중` → `Redis 다시 연결됨 (N번 재시도)`

## 파일 구조

| 파일 | 내용 |
| --- | --- |
| `src/index.ts` | HTTP 서버, `/healthz`·`/readyz`, WebSocket 업그레이드와 docId 검사, 종료 순서 |
| `src/doc.ts` | 문서별 `Y.Doc`·awareness 관리, y-websocket 메시지 처리, ping |
| `src/redis.ts` | Redis 연결, 재접속, 상태 로그 |
| `src/config.ts` | 환경 변수 읽기 |

## 진행 상황

| 주차 | 내용 | 상태 |
| --- | --- | --- |
| 1주차 | WebSocket 서버(#4), Redis 연결(#5), 이 명세서(#6) | 완료 |
| 2주차 | 적응형 전파(LOCAL·SHARED, Pub/Sub), Streams 기록, `/metrics` | 예정 |
| 3주차 | 스냅샷 복원(MinIO), 종료 시 flush | 예정 |
