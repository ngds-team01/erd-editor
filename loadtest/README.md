# loadtest — 부하 봇과 수렴 검증

문서 하나에 봇 여러 개를 붙여 무작위로 편집하고, 편집을 멈춘 뒤 모든 봇과 새로 접속한 관찰자의 문서가 같아지는지(수렴) 확인한다.
`--probe`를 켜면 그동안 문서 업데이트와 awareness(편집 중 표시)의 동기화 지연을 함께 잰다.

- 봇은 `client/`의 코드를 그대로 쓴다: 문서 모델(`model/`), 재접속 규칙(`sync/reconnect.ts`), awareness 형식(`sync/presence.ts`)
- 그래서 봇은 브라우저 클라이언트와 같은 모양의 편집·awareness를 보내고, 같은 간격으로 재접속한다 (contracts 4.3)

## 설치

`client/`를 먼저 설치해야 한다. loadtest는 `client/node_modules/yjs`를 같이 써서, yjs가 한 벌만 로드되게 한다.

```bash
cd client && npm install
cd ../loadtest && npm install
```

## 실행

클러스터가 떠 있고 `curl -i localhost:8088/readyz`가 200이면 실행할 수 있다 (클러스터 실행은 저장소 최상위 README).

```bash
cd loadtest
npm run bot                                   # 봇 10개 · 30초 · 수렴 확인만
npm run bot -- --bots 50 --duration 60 --probe --name try   # 지연 측정 + 결과 이름
```

`npm run bot -- ` 뒤에 옵션을 붙인다 (`--` 뒤부터 봇에 전달됨).

### 옵션

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--url` | `ws://localhost:8088/ws` | 서버 주소 (HAProxy 입구). 봇이 뒤에 `/{docId}`를 붙임 |
| `--doc` | `loadtest-{시각}` | 편집할 문서 ID. 지정하지 않으면 실행마다 새 문서 |
| `--bots` | `10` | 편집하는 봇 수. `--probe`의 보내는 봇·받는 봇은 여기에 더해짐 |
| `--duration` | `30` | 편집하는 시간(초) |
| `--rate` | `2` | 봇 1개의 초당 편집 수 (드래그 1번 = 1회, 드래그 중 좌표는 50ms마다 씀) |
| `--seed` | 시각에서 만듦 | 난수 시드. 같은 값이면 같은 편집 순서 (테이블 id는 매번 다름) |
| `--ramp` | `100` | 봇 접속 사이 간격(ms) |
| `--settle` | `30` | 편집을 멈춘 뒤 수렴을 기다리는 최대 시간(초) |
| `--probe` | 꺼짐 | 지연 측정. 보내는 봇 1개(`--url`)와 받는 봇 1개(`--receiver-url`)를 더 띄움 |
| `--probe-interval` | `200` | 측정용 변경을 보내는 간격(ms). 200이면 초당 5개 |
| `--receiver-url` | `--url`과 같음 | 받는 봇만 붙일 주소. 다른 파드의 port-forward 주소를 주면 파드 간(SHARED) 경로를 잼 |
| `--name` | `run` | 결과 폴더 이름 뒤에 붙는 이름 (영문, 숫자, `_`, `-`) |

종료 코드: 수렴하면 0, 수렴하지 않았거나 오류가 나면 1.

### 실행 순서

1. 봇이 `--ramp` 간격으로 접속하고 모두 첫 동기화를 마칠 때까지 기다림 (봇 1개당 최대 10초)
2. `--duration`초 동안 편집. `--probe`면 보내는 봇이 `--probe-interval`마다 측정용 변경을 보냄
3. 편집을 멈추고 편집 수 · 이벤트 루프 요약 출력
4. 봇끼리 해시가 같아질 때까지 최대 `--settle`초 기다림. 그동안 늦게 온 측정값까지 받은 뒤 지연 출력
5. 관찰자가 새로 접속해 서버가 가진 상태를 받고, 봇들과 해시 비교 → PASS / FAIL
6. 결과 파일 저장

### 출력 읽기

파드 2개, 받는 봇을 다른 파드에 붙인 실행의 출력 일부 (이벤트 루프·awareness 값은 모양만 보인 예시)

```
편집 종료 · 편집 462회 · 보낸 update 1449개 · 끊김 0회
이벤트 루프 · 바쁜 시간 3.1% · 타이머 지연 p50 5.4ms · p99 11.8ms · 최대 18.0ms
수렴 확인 중 (최대 30초)
지연 (update) · 보냄 145개 · 받음 145개 · 미도착 0개
  p50 7.3ms · p95 33.7ms · p99 45.0ms · 최대 45.9ms
지연 (awareness) · 보냄 145개 · 받음 145개 · 미도착 0개
  p50 … · p95 … · p99 … · 최대 …
PASS · 편집 멈춤 후 0.0초 만에 봇 12개 + 관찰자 수렴 · hash fa4d87f605b6
결과 저장 · results/20261123-191502-try
```

- **지연**: 보내는 봇이 보낸 순간부터 받는 봇이 받은 순간까지. 같은 프로세스의 같은 시계로 재므로 컴퓨터 간 시계 차이가 없음
- **미도착**: 보냈지만 수렴을 기다린 뒤에도 받지 못한 수. 0이 아니면 변경이 사라졌다는 뜻이라 원인을 봐야 함
- **이벤트 루프**: 봇 프로세스가 바빠 받은 메시지를 늦게 처리했는지 보는 값 (아래 "측정값을 믿어도 되는지")
- **끊김**: 일반 봇이 서버와 끊긴 횟수. 끊길 때마다 `봇 3: 끊김 (code 1006) → 512ms 뒤 재접속 (연속 실패 0회)` 줄이 나옴

## 결과 파일

실행마다 `loadtest/results/{날짜-시각}-{--name}/`에 저장한다. 같은 이름이 있으면 `-2`, `-3`을 붙여 덮어쓰지 않는다.
`results/`는 git에 올리지 않으므로, 보고서에 쓸 결과는 따로 복사해 보관한다.

| 파일 | 내용 |
| --- | --- |
| `settings.json` | 실행 인자(`argv`), 기본값까지 채운 옵션(실제로 쓴 seed 포함), 커밋 SHA와 `dirty`, Node 버전, 시작·종료 시각 |
| `samples.csv` | 측정값 원본 한 줄에 하나: `path`(update/awareness), `seq`, `sent_at_ms`, `received_at_ms`(epoch ms), `latency_ms` |
| `summary.csv` | 이 실행의 요약 한 줄: 봇 수·속도·seed, 수렴 결과, 이벤트 루프, 경로별 보냄·받음·미도착·p50·p95·p99·최대 |

- `summary.csv`는 `--probe`를 끈 실행도 열 순서가 같다 (측정 칸은 빈칸). 여러 실행을 모을 때 첫 파일의 헤더 아래에 다른 파일의 둘째 줄만 이어 붙이면 된다
- 백분위는 스프레드시트의 `PERCENTILE`(= `PERCENTILE.INC`)과 같은 방식이라, `samples.csv`의 `latency_ms`로 다시 계산해도 같은 값이 나온다
- `dirty: true`면 커밋하지 않은 코드로 돌린 실행이다. 보고서용 실행은 커밋한 뒤 돌린다
- 커밋 SHA는 봇 코드 기준이다. 서버 이미지(`crdt-server:dev`)는 태그만으로 버전을 알 수 없으므로, **실험은 같은 checkout에서 `make server`로 빌드한 클러스터로 돌린다**

## 받는 봇을 다른 파드에 붙이기

HAProxy는 문서 ID로 파드를 고르므로(`balance uri`, contracts 7.4) 같은 문서의 봇은 먼저 한 파드(홈 파드)에 붙는다.
다만 `hash-balance-factor 125` 때문에 한 파드의 연결 수가 전체 평균의 125%를 넘으면 다음 연결은 다른 파드로 넘어간다.
예를 들어 파드 2개에 봇 20개면 약 12개만 홈 파드에 붙고 나머지는 다른 파드에 붙어, `--receiver-url` 없이도 문서가 SHARED가 된다.
그래서 보내는 봇(`--url`)이 어느 파드에 붙을지는 정할 수 없다. 받는 봇을 port-forward로 한 파드에 고정하고, 그 파드가 SHARED인지 확인한다.

```bash
# 1. 편집 서버 파드 이름 확인 (기본 2개)
kubectl --context kind-erd get pods -l app=editor

# 2. 그중 하나를 9001로 열어 둠 (이 터미널은 켜 둠, 끝나면 Ctrl+C)
kubectl --context kind-erd port-forward pod/<파드 이름> 9001:8080

# 3. 다른 터미널에서 실행
npm run bot -- --probe --receiver-url ws://localhost:9001/ws
```

**받는 봇이 홈 파드가 아닌지 확인**: 실행 중에(편집 단계) 열어 둔 파드의 지표를 본다.

```bash
curl -s localhost:9001/metrics | grep '^editor_docs'
# editor_docs{mode="shared"} 1  → 다른 파드에 붙음, 파드 간 경로를 재는 중
# editor_docs{mode="local"} 1   → 홈 파드에 붙음, port-forward를 다른 파드로 바꿔 다시 실행
```

- 문서 ID가 바뀌면 홈 파드도 바뀔 수 있으므로 실행마다 확인한다 (Grafana의 `editor_docs{mode="shared"}`로 봐도 됨)
- 실행이 끝나 봇이 모두 나가면 서버가 문서를 메모리에서 내려 `editor_docs`는 0으로 돌아간다
- port-forward는 대상 파드가 죽으면 같이 끊긴다. 파드를 지우는 실험(실험 2)에서는 받는 봇이 다시 붙을 곳이 없으므로 `--receiver-url`을 쓰지 않는다

## 측정값을 믿어도 되는지

봇 전부가 프로세스 하나, 스레드 하나에서 차례로 돈다. 프로세스가 바쁘면 받은 메시지를 늦게 처리해 측정 지연이 부풀려진다.
측정값은 보정하지 않고 그대로 두며, 아래 값으로 믿어도 되는지 판단한다.

- **바쁜 시간**(Event Loop Utilization): 편집 구간 중 코드를 실행하던 시간의 비율. OS와 관계없이 정확하므로 이 값으로 판단한다. 50%보다 한참 낮으면 봇 프로세스에 여유가 있었던 것으로 본다 (기준은 경험값)
- **타이머 지연**: 10ms마다 깨어나기로 한 타이머가 늦게 깨어난 시간. 루프가 길게 멈춘 순간을 잡는다
  - Windows는 OS 타이머 단위(약 15.6ms) 때문에 쉬고 있어도 p50 약 5ms, p99 약 12ms가 나온다. Windows에서는 최대값이 이보다 훨씬 큰지만 본다
- 바쁜 시간이 높으면 그 실행의 지연은 봇 쪽 대기가 섞인 값이다. `--bots`나 `--rate`를 낮춰 다시 잰다
  - 지금은 봇 프로세스 하나 기준으로만 동작한다. 프로세스 두 개를 같은 문서에 돌리면 먼저 끝난 쪽이 다른 쪽의 편집 중에 수렴을 확인해 FAIL이 나므로, 나눠 돌리지 않는다

**표본 수**: 측정값은 `--probe-interval`마다 1개(기본 초당 5개)라 30초 실행이면 약 150개다.
p50·p95는 충분하지만 p99는 맨 위 1~2개 값으로 정해져 실행마다 흔들린다. p99를 보고하려면 `--duration 120`(약 600개) 이상으로 돌린다.

## 실험별 실행

실험 조건(접속자 수, 반복 횟수, 목표 값)은 제안서를 따른다. 아래는 지금 봇 기능(#55 )으로 할 수 있는 범위다.

### 실험 1. 접속자 수별 동기화 지연

접속자 수마다 3회씩, 받는 봇을 다른 파드에 붙여 잰다.

```bash
# 파드 1개 기준값 (LOCAL): 파드를 1개로 줄이고 --receiver-url 없이
# (파드 2개에서는 봇이 많으면 다른 파드로도 나뉘어 LOCAL이 되지 않음, 위 "받는 봇을 다른 파드에 붙이기")
kubectl --context kind-erd scale deployment/editor --replicas=1
npm run bot -- --bots 10 --duration 120 --probe --name exp1-local-10
kubectl --context kind-erd scale deployment/editor --replicas=2

# 파드 2개, 받는 봇은 다른 파드 (SHARED): 10 · 50 · 100 · 200명 × 3회
npm run bot -- --bots 10  --duration 120 --probe --receiver-url ws://localhost:9001/ws --name exp1-shared-10
npm run bot -- --bots 50  --duration 120 --probe --receiver-url ws://localhost:9001/ws --name exp1-shared-50
npm run bot -- --bots 100 --duration 120 --probe --receiver-url ws://localhost:9001/ws --name exp1-shared-100
npm run bot -- --bots 200 --duration 120 --probe --receiver-url ws://localhost:9001/ws --name exp1-shared-200
```

- 실행마다 `editor_docs{mode="shared"}`가 1인지 확인하고 (위 "받는 봇을 다른 파드에 붙이기"), 아니면 그 실행은 버린다
- `summary.csv`의 `update_p95_ms`, `awareness_p95_ms`와 `event_loop_utilization`을 함께 본다
- 서버 지표 `editor_sync_latency_seconds`는 파드 간 구간만 재므로 봇이 잰 update 지연보다 작거나 같아야 한다

### 실험 2. 파드 강제 종료 복구

봇이 편집하는 동안 다른 터미널에서 파드를 지운다. 봇은 클라이언트와 같은 규칙(1012면 0~500ms, 그 외 0.5s → 1s → 2s … 최대 10s, ±20%)으로 다른 파드에 다시 붙는다.

```bash
# 터미널 1: 길게 편집 (지우는 동안 계속 편집하도록)
npm run bot -- --bots 20 --duration 300 --settle 60 --name exp2-kill

# 터미널 2: 봇이 붙은 파드를 강제 종료 (파드마다 editor_docs를 보고 1인 파드)
for p in $(kubectl --context kind-erd get pods -l app=editor -o name); do echo $p; kubectl --context kind-erd exec $p -- wget -qO- localhost:8080/metrics | grep '^editor_docs'; done
kubectl --context kind-erd delete pod <파드 이름> --force --grace-period=0
```

- 봇이 두 파드에 나뉘어 붙어 있으므로(위 `hash-balance-factor`), 지운 파드에 붙어 있던 봇만 끊긴다
- 붙을 파드가 남아 있으면 첫 재접속에 바로 성공해 간격이 늘어나는 것이 보이지 않는다. 백오프까지 보려면 `kubectl --context kind-erd scale deployment/editor --replicas=0`으로 15초쯤 줄였다가 `--replicas=2`로 되돌린다 (0.5s → 1s → 2s → 4s → 8s → 최대 10s)

- 봇 로그의 `끊김 (code 1006) → …ms 뒤 재접속` 줄과 마지막 PASS(끊긴 동안 한 편집도 병합됨)를 확인한다
- `--force` 없이 지우면(`kubectl --context kind-erd delete pod <파드 이름>`) 서버가 SIGTERM을 받아 1012로 닫으므로(contracts 7.2), code 1012와 0~500ms 대기가 나와야 한다
- 재접속 시간(끊김 → 다시 동기화)과 전원 이탈 후 유실 수는 아직 재지 않는다 (#56 에서 추가)

### 실험 3. 라우팅 전략 비교 · 스케일아웃

전파 방식은 서버 환경 변수 `PROPAGATION_MODE`로 바꾼다 (contracts 5.4).

```bash
# 기존 방식 A: 항상 발행
kubectl --context kind-erd set env deployment/editor PROPAGATION_MODE=broadcast
# 제안 방식 B: 피어가 있을 때만 발행 (기본)
kubectl --context kind-erd set env deployment/editor PROPAGATION_MODE=adaptive
```

- 바꾼 뒤 파드가 다시 뜨면(`make status`) 같은 봇 명령으로 지연을 잰다
- 여러 문서 동시 부하(예: 문서 20개 × 5명)와 접속자 수를 단계적으로 늘리는 부하는 아직 없다 (#56 , #57 에서 추가)
- Redis 명령 수(`INFO commandstats`), Redis CPU, HAProxy 임의 분산 설정은 loadtest 밖(인프라)에서 준비한다

## 개발

```bash
npm test           # 서버 없이 도는 테스트 (편집·수렴, 재접속, 지연 측정, 이벤트 루프, 결과 파일)
npm run typecheck  # 타입 검사 (client 코드 포함)
```

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | 옵션 읽기, 실행 순서, 출력 |
| `src/bot.ts` | 봇 1개: 접속, 무작위 편집, awareness, 재접속 |
| `src/actions.ts` | 무작위 편집 고르기·실행 (측정용 테이블 제외) |
| `src/converge.ts` | 해시 비교로 수렴 판정 |
| `src/probe.ts` | 지연 측정: 측정용 테이블, 보내는 쪽·받는 쪽, 기록 |
| `src/stats.ts` | 백분위 계산 |
| `src/eventLoop.ts` | 봇 프로세스의 바쁜 시간 · 타이머 지연 |
| `src/results.ts` | 결과 파일 저장 |
| `src/reconnect.ts` | client의 재접속 규칙을 봇 provider에 연결 |
| `src/model.ts`, `src/presence.ts` | client 코드를 그대로 다시 내보냄 |
