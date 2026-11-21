# worker — 스냅샷 워커

편집 서버가 Redis Streams(`doc:{docId}:log`)에 남긴 편집 기록을 주기적으로 MinIO 스냅샷으로 저장하고, 스냅샷에 들어간 오래된 기록을 정리한다.

- 이름, 형식, 순서의 기준은 [docs/contracts.md](../docs/contracts.md) 6.3이다. 이 문서와 contracts가 다르면 contracts가 맞다.
- Node.js 20.19 이상, TypeScript, `ioredis`, `yjs`, `@aws-sdk/client-s3`
  - AWS SDK는 2027년 1월 이후 버전부터 Node 22 이상만 지원한다는 경고를 띄운다. Docker 이미지는 Node 24라 해당 없다.

## 실행

```bash
# Redis, MinIO (키는 deploy/k8s/minio.yaml의 로컬 실험용 값)
docker run -d --name redis -p 6379:6379 redis:7.4-alpine
docker run -d --name minio -p 9000:9000 -e MINIO_ROOT_USER=<S3_ACCESS_KEY> -e MINIO_ROOT_PASSWORD=<S3_SECRET_KEY> \
  pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
# 버킷 erd-snapshots는 미리 만들어 둔다 (클러스터에서는 minio-create-bucket Job이 만든다)

cd worker
npm install
S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=... S3_SECRET_KEY=... SNAPSHOT_INTERVAL_MS=3000 npm run dev
```

| 명령 | 하는 일 |
| --- | --- |
| `npm run dev` | 개발 모드 실행 (tsx watch) |
| `npm run build` | `dist/`로 컴파일 (테스트 파일 제외) |
| `npm start` | 컴파일된 `dist/index.js` 실행 |
| `npm run typecheck` | 타입 검사 (테스트 포함) |
| `npm test` | 스냅샷 로직 테스트 (Redis·MinIO 없이 메모리 구현으로) |

Docker 이미지:

```bash
docker build -t crdt-worker ./worker
docker run --rm -p 8081:8081 -e REDIS_URL=redis://host.docker.internal:6379 \
  -e S3_ENDPOINT=http://host.docker.internal:9000 -e S3_ACCESS_KEY=... -e S3_SECRET_KEY=... crdt-worker
```

## 환경 변수 (contracts 7.5)

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `PORT` | `8081` | `/healthz`, `/metrics` |
| `REDIS_URL` | `redis://localhost:6379` | |
| `S3_ENDPOINT` | (없음) | MinIO 주소. 비우면 AWS S3 |
| `S3_BUCKET` | `erd-snapshots` | |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | (없음) | Secret `s3-credentials`에서 주입. SDK가 이 이름을 읽지 않아 `S3Client`에 `credentials`로 직접 넘긴다. 둘 다 없으면 SDK 기본 방식(AWS 환경 변수, IAM 역할) |
| `AWS_REGION` | `us-east-1` | MinIO도 값이 있어야 한다 |
| `SNAPSHOT_INTERVAL_MS` | `30000` | 스냅샷 주기 |

## 동작 (contracts 6.3)

`SNAPSHOT_INTERVAL_MS`마다 `SCAN`으로 `doc:*:log`를 찾아 문서마다 아래를 한다. 한 주기가 끝난 뒤 다음 주기를 예약하므로 주기가 겹쳐 돌지 않는다.

1. 마지막 항목 ID가 기억해 둔 `lastStreamId`보다 크지 않으면 **건너뛴다** (S3를 읽지 않음)
2. `snapshots/{docId}/latest.bin`과 메타데이터 `last-stream-id`를 읽는다. 없으면 빈 문서, `lastStreamId = 0`
3. `XRANGE doc:{docId}:log (<lastStreamId> +`를 500개씩 읽어 적용한다
4. `encodeStateAsUpdate` 결과를 같은 키로 업로드한다. 메타데이터에 새 `lastStreamId`. **조건부 업로드**: 2단계에서 읽은 스냅샷의 ETag가 그대로일 때만(`If-Match`), 스냅샷이 없었으면 지금도 없을 때만(`If-None-Match: *`) 올린다
5. 업로드에 성공한 뒤에만 `XTRIM doc:{docId}:log MINID <직전 lastStreamId>` (한 세대 늦게)

### 워커는 1개만 돌린다

- Deployment는 `replicas: 1`, `strategy: Recreate`로 둔다. 롤링 업데이트(RollingUpdate)는 새 파드가 뜬 뒤 옛 파드를 내리므로 잠깐 2개가 같이 돈다.
- 워커가 2개 돌면 편집이 사라질 수 있다. 느린 워커가 스냅샷을 읽고 업로드 전에 멈춘 사이 다른 워커가 2세대 이상 진행하며 XTRIM하면, 느린 워커가 옛 스냅샷 기준으로 덮어쓴 뒤의 로그 구간이 이미 지워져 있다. 그 구간이 빠지면 같은 사용자의 뒤 기록도 Yjs가 대기 상태로만 들고 있어 함께 안 보인다.
- 그래서 코드에서도 막는다: 4단계의 조건이 안 맞으면(412) 올리지 않고 자르지도 않는다(`conflict`). 그 문서는 다음 주기에 새 스냅샷을 읽어 다시 한다. 1개만 돌면 이 경우는 생기지 않는다.

| 상황 | 처리 |
| --- | --- |
| 기존 스냅샷을 못 읽음 (없음이 아닌 오류) | 그 문서는 이번 주기에 건너뛴다. 로그가 이미 잘려 있을 수 있어 로그만으로 덮어쓰면 편집이 사라진다 |
| 업로드 실패 | 로그를 자르지 않는다. 다음 주기에 다시 시도 |
| 업로드 조건 불일치 (다른 워커가 먼저 바꿈) | 올리지 않고 로그도 자르지 않는다 (`conflict`). 다음 주기에 새 스냅샷을 읽어 다시 한다 |
| XTRIM 실패 | 스냅샷은 저장된 것으로 친다. 다음 스냅샷 때 더 뒤 ID 기준으로 자르면서 같이 정리된다 |
| Redis 끊김 | 그 주기를 건너뛰고 로그를 한 번만 남긴다. 다시 붙으면 다음 주기부터 이어서 한다 |
| 워커 재시작 | 기억이 비어 있으므로 S3 메타데이터의 `lastStreamId`부터 이어서 만든다 |
| SIGTERM | 다음 주기를 예약하지 않고, 진행 중인 주기가 끝나면(최대 20초) 종료 |

## 엔드포인트 (포트 8081)

| 경로 | 응답 |
| --- | --- |
| `GET /healthz` | 프로세스가 살아 있으면 항상 `200 ok` |
| `GET /metrics` | Prometheus 지표 (아래) |

## 지표

| 이름 | 종류 | 의미 |
| --- | --- | --- |
| `worker_snapshots_total{result}` | counter | 문서별 결과. `saved` 업로드 성공, `conflict` 다른 워커가 먼저 바꿔서 안 올림, `failed` 그 문서 처리 실패 |
| `worker_snapshot_entries_total` | counter | 스냅샷에 반영한 Streams 항목 수 |
| `worker_stream_trimmed_total` | counter | XTRIM으로 지운 항목 수 |
| `worker_cycle_seconds` | histogram | 주기 한 번(모든 문서)에 걸린 시간 |
| `worker_last_cycle_timestamp_seconds` | gauge | 마지막으로 끝난 주기 시각. 멈춰 있으면 워커가 일을 못 하고 있는 것 |

프로세스 기본 지표(CPU, 메모리)도 같이 나간다.
