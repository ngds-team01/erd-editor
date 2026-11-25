import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import type { Bot } from './bot'
import { firstDifference, groupByHash, waitForConvergence } from './converge'
import type { HashGroup } from './converge'
import { createDocGroup } from './docGroup'
import type { DocGroup } from './docGroup'
import { startEventLoopMonitor } from './eventLoop'
import type { EventLoopSummary } from './eventLoop'
import { startLoadProcess } from './loadProcess'
import type { LoadProcess, LoadStats } from './loadProcess'
import { getColumns, getRelations, getTables } from './model'
import * as Y from 'yjs'
import type { ProbeLog } from './probe'
import type { ReconnectSample } from './reconnectTime'
import { captureState, compareStates } from './restore'
import type { DocState } from './restore'
import { saveRun } from './results'
import type { DocRecord, RestoreRecord } from './results'
import { assertSingleYjs } from './singleYjs'
import { summarize } from './stats'

// 문서 ID 형식 (contracts 4.1), 틀리면 서버가 4400으로 닫으므로 미리 막음
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
// 결과 폴더 이름 형식 (--name)
const RUN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/
// 실행 순서 (--scenario)
const SCENARIOS = ['converge', 'restore'] as const
type Scenario = (typeof SCENARIOS)[number]

// 실행 인자를 읽어 검사, 예: npm run bot -- --bots 20 --duration 60
// 모르는 인자(--bot 오타 등)나 잘못된 값이면 오류
function readOptions() {
  const { values } = parseArgs({
    options: {
      // 서버 주소 (HAProxy 입구, contracts 4.1)
      url: { type: 'string', default: 'ws://localhost:8088/ws' },
      // 편집할 문서, 지정하지 않으면 매번 새 문서
      // --docs가 2 이상이면 이 이름 뒤에 -1, -2 … 를 붙인 문서들 (예: loadtest-123-1 … loadtest-123-20)
      doc: { type: 'string', default: `loadtest-${Date.now()}` },
      // 동시에 편집할 문서 수 (실험 3), 문서마다 봇 --bots개
      docs: { type: 'string', default: '1' },
      // 문서 하나에 붙는 정식 봇 수 (--docs 20 --bots 5 = 문서 20개 × 5명)
      bots: { type: 'string', default: '10' },
      // 부하 봇 수: 받은 편집을 반영하지 않는 가벼운 봇을 별도 부하 프로세스에서 돌림 (loadWorker.ts)
      // 이 프로세스(측정·수렴 확인)와 스레드가 달라, 부하가 커져도 받는 봇의 측정이 부풀려지지 않음
      'load-bots': { type: 'string', default: '0' },
      // 부하 봇을 나눠 돌릴 프로세스 수, 프로세스 하나에 40개 안팎이 적당 (README)
      'load-processes': { type: 'string', default: '1' },
      // 편집하는 시간(초)
      duration: { type: 'string', default: '30' },
      // 봇 1개의 초당 편집 수
      // 기본값은 제안서 실험 조건(초당 1회 편집)
      rate: { type: 'string', default: '1' },
      // 난수 시드, 같은 값을 주면 같은 편집 순서를 다시 실행
      seed: { type: 'string', default: String(Date.now() % 1_000_000) },
      // 봇 접속 사이 간격(ms), HAProxy가 봇을 파드에 나눠 배정할 시간을 줌
      ramp: { type: 'string', default: '100' },
      // 편집을 멈춘 뒤 수렴을 기다리는 최대 시간(초)
      settle: { type: 'string', default: '30' },
      // 지연 측정을 켬: 보내는 봇·받는 봇을 하나씩 더 띄움
      probe: { type: 'boolean', default: false },
      // 보내는 봇이 측정용 변경을 보내는 간격(ms)
      'probe-interval': { type: 'string', default: '200' },
      // 받는 봇만 붙일 주소, 예: kubectl port-forward로 연 특정 파드 (지정하지 않으면 --url)
      'receiver-url': { type: 'string' },
      // 결과 폴더 이름 뒤에 붙는 이름, 예: --name exp1-100bots → results/20261123-191502-exp1-100bots/
      name: { type: 'string', default: 'run' },
      // 실행 순서: converge = 편집 → 수렴 확인 → 관찰자 확인 (기본)
      //           restore = 편집 → 수렴 확인 → 봇 전부 종료 → 대기 → 관찰자가 서버 데이터만으로 복원한 문서 확인 (실험 2-b)
      scenario: { type: 'string', default: 'converge' },
      // restore에서 봇이 모두 나간 뒤 관찰자가 접속하기까지 기다리는 시간(초)
      // 지정하지 않으면 Enter를 누를 때까지 기다림 (그동안 파드를 지우거나 스냅샷이 생기기를 기다림)
      'restore-wait': { type: 'string' },
    },
  })

  if (!SCENARIOS.includes(values.scenario as Scenario)) {
    throw new Error(`--scenario 값은 ${SCENARIOS.join(', ')} 중 하나여야 합니다: ${values.scenario}`)
  }
  const scenario = values.scenario as Scenario
  if (values['restore-wait'] !== undefined && scenario !== 'restore') {
    throw new Error('--restore-wait은 --scenario restore와 함께 써야 합니다')
  }
  // 0초도 허용: 파드를 지우지 않고 문서 언로드만 확인할 때, 관찰자 접속 전 짧게 기다리는 것은 RESTORE_MIN_WAIT_MS가 맡음
  const restoreWaitSec =
    values['restore-wait'] === undefined ? null : nonNegativeNumber('restore-wait', values['restore-wait'])

  // 폴더 이름에 쓰므로 Windows·Linux 모두에서 문제없는 글자만 허용
  if (!RUN_NAME_PATTERN.test(values.name)) {
    throw new Error(`--name 값은 영문, 숫자, _, - 로 1~40자여야 합니다: ${values.name}`)
  }

  if (values['receiver-url'] !== undefined && !values.probe) {
    throw new Error('--receiver-url은 --probe와 함께 써야 합니다')
  }

  const loadBots = nonNegativeInteger('load-bots', values['load-bots'])
  const loadProcesses = positiveInteger('load-processes', values['load-processes'])
  // 봇이 하나도 없는 부하 프로세스는 띄우지 않음
  if (loadBots > 0 && loadProcesses > loadBots) {
    throw new Error(`--load-processes(${loadProcesses})는 --load-bots(${loadBots})보다 클 수 없습니다`)
  }

  const docs = positiveInteger('docs', values.docs)
  // 부하 프로세스는 아직 문서 하나만 받음 (loadWorker.ts), 여러 문서에서는 정식 봇만 씀
  if (docs > 1 && loadBots > 0) {
    throw new Error('--load-bots는 아직 --docs 1에서만 쓸 수 있습니다 (여러 문서에서는 --bots로 문서당 봇 수를 정함)')
  }

  return {
    url: values.url,
    docId: values.doc,
    docs,
    bots: positiveInteger('bots', values.bots),
    loadBots,
    loadProcesses,
    durationSec: positiveNumber('duration', values.duration),
    rate: positiveNumber('rate', values.rate),
    seed: integer('seed', values.seed),
    rampMs: Math.max(0, Number(values.ramp) || 0),
    settleSec: positiveNumber('settle', values.settle),
    probe: values.probe,
    probeIntervalMs: positiveNumber('probe-interval', values['probe-interval']),
    receiverUrl: values['receiver-url'] ?? values.url,
    name: values.name,
    scenario,
    restoreWaitSec,
  }
}

// 인자 오류는 main() 밖에서 나므로 여기서 잡아, 긴 오류 위치 정보 없이 메시지만 출력하고 종료 코드 1
let options: ReturnType<typeof readOptions>
try {
  options = readOptions()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
// 봇 1개가 서버와 첫 동기화를 끝내야 하는 시간
const SYNC_TIMEOUT_MS = 10_000
// restore에서 관찰자가 동기화를 끝내야 하는 시간: 파드를 전부 지웠으면 새 파드가 뜰 때까지 재접속을 반복함
const RESTORE_SYNC_TIMEOUT_MS = 60_000
// restore에서 봇이 모두 나간 뒤 관찰자가 접속하기 전 최소 대기, --restore-wait 0이어도 이만큼은 기다림
const RESTORE_MIN_WAIT_MS = 1_000
// 편집 중 진행 상황을 출력하는 간격
const PROGRESS_INTERVAL_MS = 5_000
// 해시 출력 길이, 64자 전부는 길어 앞부분만 표시
const SHORT_HASH = 12

// 모든 문서가 PASS면 true
async function main(): Promise<boolean> {
  const docIds = docIdsFor(options.docId, options.docs)
  for (const docId of docIds) {
    if (!DOC_ID_PATTERN.test(docId)) {
      throw new Error(`문서 ID 형식이 틀립니다: ${docId} (영문, 숫자, _, - 로 1~64자)`)
    }
  }
  // 봇을 띄우기 전에 yjs가 한 벌인지 먼저 확인, 두 벌이면 편집이 깨지므로 바로 멈춤
  assertSingleYjs()
  // settings.json·summary.csv에 남길 실행 시작 시각
  const runStartedAt = new Date()

  const loadLabel =
    options.loadBots > 0 ? ` + 부하 봇 ${options.loadBots}개(부하 프로세스 ${options.loadProcesses}개)` : ''
  const docLabel =
    docIds.length === 1
      ? `문서 ${docIds[0]} · 봇 ${options.bots}개`
      : `문서 ${docIds.length}개 (${docIds[0]} … ${docIds[docIds.length - 1]}) · 문서당 봇 ${options.bots}개`
  console.log(
    `${docLabel}${loadLabel} · ${options.durationSec}초 · 봇당 초당 ${options.rate}회 · seed ${options.seed}`,
  )
  console.log(`서버 ${options.url}`)

  // WebsocketProvider는 Node에서 provider마다 process 'exit' 리스너를 1개씩 등록함
  // 기본 한도 10개를 넘으면 메모리 누수 경고가 나므로 봇 수(+문서마다 보내는 봇·받는 봇·관찰자)만큼 한도를 늘림
  process.setMaxListeners((options.bots + 3) * docIds.length + 10)

  // 문서마다 봇 묶음 하나: 편집하는 봇 + 지연 측정 봇(--probe) + 나중에 붙는 관찰자 (docGroup.ts)
  const groups: DocGroup[] = []
  // 부하 프로세스: 부하 봇을 나눠 맡겨 띄움, 각 프로세스 안에서 봇이 ramp 간격으로 접속
  // (부하 봇은 다른 사람의 편집을 반영하지 않아 수렴 확인에서 뺌)
  let loads: LoadProcess[] = []
  try {
    // 1. 문서 순서대로 봇을 ramp 간격으로 하나씩 접속시키고, 모두 첫 동기화가 끝날 때까지 대기
    // 봇 번호는 앞 묶음의 다음 번호부터 이어 써서 문서끼리 시드·이름이 겹치지 않게 함
    let nextIndex = 0
    for (const docId of docIds) {
      const group = await createDocGroup({
        url: options.url,
        receiverUrl: options.receiverUrl,
        docId,
        firstIndex: nextIndex,
        bots: options.bots,
        seed: options.seed,
        rate: options.rate,
        rampMs: options.rampMs,
        probe: options.probe,
        probeIntervalMs: options.probeIntervalMs,
      })
      groups.push(group)
      nextIndex = group.nextIndex
    }
    printProbeTargets(groups)
    loads = startLoadProcesses(nextIndex)
    // 모든 문서의 편집하는 봇 / 편집하는 봇 + 측정 봇
    const bots = groups.flatMap((group) => group.bots)
    const everyBot = groups.flatMap((group) => group.everyBot)

    await Promise.all([
      ...groups.map((group) => group.waitSynced(SYNC_TIMEOUT_MS)),
      ...loads.map((load) => load.ready),
    ])
    console.log(`봇 ${everyBot.length}개${loadLabel} 동기화 완료, 편집 시작`)

    // 2. 정해진 시간 동안 편집 (지연 측정을 켰으면 측정용 변경도 함께 보냄)
    // 측정 표본이 모이는 편집 구간 동안 봇 프로세스가 얼마나 바빴는지 함께 기록
    const stopEventLoopMonitor = startEventLoopMonitor()
    groups.forEach((group) => group.start())
    loads.forEach((load) => load.start())
    const startedAt = Date.now()
    const progress = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(`  ${elapsed}초 · 편집 ${totalActions(bots)}회`)
    }, PROGRESS_INTERVAL_MS)
    await sleep(options.durationSec * 1000)
    clearInterval(progress)

    // 3. 편집 멈춤 (진행 중인 드래그는 끝까지), 부하 프로세스는 멈춘 뒤 통계를 보내고 스스로 끝남
    const [, loadStats] = await Promise.all([
      Promise.all(groups.map((group) => group.stop())),
      Promise.all(loads.map((load) => load.stop())),
    ])
    // 수렴 확인은 해시 계산으로 일부러 바쁜 구간이라 빼고, 편집 구간만 요약
    const eventLoop = stopEventLoopMonitor()
    printSummary(bots)
    printEventLoop(eventLoop)
    if (loadStats.length > 0) {
      printLoadSummary(loadStats)
    }

    // 4. 문서마다 봇끼리 수렴 확인: 아직 서버를 오가는 변경이 있으므로 같아질 때까지 기다림
    console.log(`수렴 확인 중 (최대 ${options.settleSec}초)`)
    const results = await Promise.all(
      groups.map((group) => waitForConvergence(group.docs, options.settleSec * 1000)),
    )

    // 수렴을 기다리는 동안 늦게 온 측정용 변경까지 받았으므로, 여기서 측정을 마치고 지연 출력 (모든 문서를 합친 값)
    groups.forEach((group) => group.stopWatching())
    const probes = groups.flatMap((group) => (group.probe ? [group.probe] : []))
    if (probes.length > 0) {
      printLatency(probes.map((probe) => probe.updateLog))
      printLatency(probes.map((probe) => probe.awarenessLog))
    }
    // 재접속 기록도 수렴을 기다리는 동안 다시 붙은 봇까지 모은 뒤 출력
    printReconnects(
      everyBot.flatMap((bot) => bot.reconnects.samples()),
      everyBot.reduce((sum, bot) => sum + bot.reconnects.pending(), 0),
    )

    // 5-1. (restore) 문서마다 봇이 가진 상태를 적어 두고, 모든 봇을 함께 내보낸 뒤 한 번 기다림
    // 수렴하지 않은 문서가 있으면 그 문서의 기대 상태를 하나로 정할 수 없으므로 건너뛰고 converge처럼 확인 (결과는 FAIL)
    let leave: LeaveResult | null = null
    if (options.scenario === 'restore') {
      if (results.every((result) => result.converged)) {
        leave = await leaveAll(groups)
      } else {
        console.log('봇끼리 수렴하지 않은 문서가 있어 전원 이탈 단계를 건너뜁니다')
      }
    }

    // 5-2. 관찰자 확인: 봇끼리만 같고 서버는 다를 수 있으므로, 문서마다 새로 접속한 클라이언트가 받는 상태도 비교
    // restore에서는 봇이 모두 나간 뒤라, 관찰자가 받는 문서는 서버가 스냅샷 + Streams로 복원한 것
    // restore에서 파드를 전부 지웠으면 새 파드가 뜰 때까지 재접속하므로 더 오래 기다림
    // syncMs: 접속부터 동기화까지, 서버가 문서를 복원하는 시간이 들어감 (서버는 복원을 마친 뒤 SyncStep1에 답함, contracts 6.4)
    const observed = await Promise.all(
      groups.map((group) => group.connectObserver(leave ? RESTORE_SYNC_TIMEOUT_MS : SYNC_TIMEOUT_MS)),
    )

    const docs: DocRecord[] = []
    const hashGroups: HashGroup[][] = []
    for (const [index, group] of groups.entries()) {
      const result = results[index]
      const { observer, syncMs } = observed[index]
      // restore에서도 봇 문서는 그대로 비교에 씀: 봇은 접속만 끊었고 Y.Doc은 나가기 전 상태로 메모리에 남아 있음
      const hashes = await groupByHash([...group.docs, { name: '관찰자', doc: observer.doc }])
      const expected = leave?.docs[index]
      const restore: RestoreRecord | null =
        leave && expected
          ? {
              waitMs: leave.waitMs,
              observerSyncMs: syncMs,
              hashMatch: hashes.length === 1,
              loss: compareStates(expected.state, captureState(observer.doc)),
              botByClient: expected.botByClient,
            }
          : null
      const lost = restore !== null && (restore.loss.missingInserts > 0 || restore.loss.missingDeletes > 0)
      // restore를 골랐는데 이탈 단계를 건너뛰었으면 복원을 확인하지 못했으므로 PASS가 아님 (수렴 실패라 이미 false)
      const passed = result.converged && hashes.length === 1 && !lost
      hashGroups.push(hashes)
      docs.push({
        docId: group.docId,
        bots: group.bots.length,
        converged: result.converged,
        convergeMs: result.elapsedMs,
        hashGroups: hashes.length,
        passed,
        actions: totalActions(group.bots),
        updatesSent: group.bots.reduce((sum, bot) => sum + bot.stats.updatesSent, 0),
        disconnects: group.bots.reduce((sum, bot) => sum + bot.stats.disconnects, 0),
        logs: group.probe ? [group.probe.updateLog, group.probe.awarenessLog] : [],
        reconnects: group.everyBot.flatMap((bot) => bot.reconnects.samples()),
        reconnectPending: group.everyBot.reduce((sum, bot) => sum + bot.reconnects.pending(), 0),
        restore,
      })
    }

    const passed = docs.every((doc) => doc.passed)
    printResults(docs, hashGroups)

    // 6. 결과 저장: PASS든 FAIL이든 남김 (FAIL 원인을 나중에 볼 수 있게)
    // 동기화 시간 초과처럼 중간에 오류가 나면 측정값이 없으므로 저장하지 않음
    const dir = saveRun({
      name: options.name,
      argv: process.argv.slice(2),
      options: { ...options },
      startedAt: runStartedAt,
      finishedAt: new Date(),
      load: loadStats,
      eventLoop,
      scenario: options.scenario,
      docs,
    })
    console.log(`결과 저장 · ${path.relative(process.cwd(), dir)}`)
    return passed
  } finally {
    // 측정을 멈추고 관찰자까지 접속을 끊음 (restore에서 이미 내보낸 봇은 그대로 둠)
    groups.forEach((group) => group.destroy())
    // 정상 흐름이면 이미 끝났으므로 아무 일도 없음, 오류로 중간에 끝날 때 남은 부하 프로세스를 정리
    loads.forEach((load) => load.kill())
  }
}

// 지연 측정 봇이 어디에서 어디로 재는지 한 번 출력 (--probe를 껐으면 출력하지 않음)
// 문서가 하나면 봇 번호까지, 여럿이면 문서마다 같은 구성이라 한 줄로 줄임
function printProbeTargets(groups: readonly DocGroup[]): void {
  const probes = groups.flatMap((group) => (group.probe ? [group.probe] : []))
  if (probes.length === 0) {
    return
  }
  const route = `${options.url} → ${options.receiverUrl}`
  if (probes.length === 1) {
    const [{ sender, receiver }] = probes
    console.log(
      `지연 측정 · ${options.probeIntervalMs}ms마다 · 보내는 봇(봇 ${sender.index}) ${options.url} → 받는 봇(봇 ${receiver.index}) ${options.receiverUrl}`,
    )
    return
  }
  console.log(`지연 측정 · ${options.probeIntervalMs}ms마다 · 문서마다 보내는 봇 1개 → 받는 봇 1개 (문서 ${probes.length}개) · ${route}`)
}

// 편집할 문서 ID 목록: 하나면 --doc 그대로, 여럿이면 --doc 뒤에 -1, -2 … 를 붙임
function docIdsFor(base: string, count: number): string[] {
  if (count === 1) {
    return [base]
  }
  return Array.from({ length: count }, (_, index) => `${base}-${index + 1}`)
}

// 부하 봇을 프로세스 수만큼 고르게 나눠 띄움 (예: 93개 · 3개 → 31개씩)
// 봇 번호는 startIndex(묶음의 관찰자 다음)부터 이어서 써서 정식 봇·측정 봇과 시드·이름이 겹치지 않게 함
function startLoadProcesses(startIndex: number): LoadProcess[] {
  const loads: LoadProcess[] = []
  if (options.loadBots === 0) {
    return loads
  }
  let firstIndex = startIndex
  for (let slot = 0; slot < options.loadProcesses; slot += 1) {
    // 나머지는 앞 프로세스부터 하나씩 더 맡김 (예: 10개 · 3개 → 4, 3, 3)
    const count =
      Math.floor(options.loadBots / options.loadProcesses) + (slot < options.loadBots % options.loadProcesses ? 1 : 0)
    loads.push(
      startLoadProcess({
        url: options.url,
        docId: options.docId,
        seed: options.seed,
        rate: options.rate,
        firstIndex,
        count,
        rampMs: options.rampMs,
        syncTimeoutMs: SYNC_TIMEOUT_MS,
      }),
    )
    firstIndex += count
  }
  return loads
}

// 부하 프로세스별 합계와 바쁜 시간, 프로세스마다 스레드가 따로라 바쁜 시간도 따로 봄
function printLoadSummary(stats: LoadStats[]): void {
  const total = (pick: (stat: LoadStats) => number) => stats.reduce((sum, stat) => sum + pick(stat), 0)
  const actions = (stat: LoadStats) => Object.values(stat.actions).reduce((sum, count) => sum + count, 0)
  const megabytes = (total((stat) => stat.bytesReceived) / 1024 / 1024).toFixed(1)
  console.log(
    `부하 봇 ${total((stat) => stat.bots)}개 · 편집 ${total(actions)}회 · 보낸 update ${total((stat) => stat.updatesSent)}개 · ` +
      `받고 버린 메시지 ${total((stat) => stat.messagesReceived)}개 (${megabytes}MB) · 끊김 ${total((stat) => stat.disconnects)}회`,
  )
  stats.forEach((stat, index) => {
    const loop = stat.eventLoop
    const busy = loop ? `바쁜 시간 ${(loop.utilization * 100).toFixed(1)}% · 타이머 지연 최대 ${loop.lagMaxMs.toFixed(1)}ms` : '기록 없음'
    console.log(`  부하 프로세스 ${index + 1} · 봇 ${stat.bots}개 · 편집 ${actions(stat)}회 · ${busy}`)
  })
}

// 이벤트 루프 요약 출력: 바쁜 시간 비율과 타이머 지연
function printEventLoop(summary: EventLoopSummary): void {
  const ms = (value: number) => `${value.toFixed(1)}ms`
  console.log(
    `이벤트 루프 · 바쁜 시간 ${(summary.utilization * 100).toFixed(1)}% · 타이머 지연 p50 ${ms(summary.lagP50Ms)} · p99 ${ms(summary.lagP99Ms)} · 최대 ${ms(summary.lagMaxMs)}`,
  )
}

// 경로별 지연 요약 출력: 표본 수, 미도착 수, p50·p95·p99·최대
// 여러 문서면 문서마다의 기록(같은 경로)을 모두 합쳐 한 번에 출력 (문서별 값은 docs.csv)
function printLatency(logs: readonly ProbeLog[]): void {
  const summary = summarize(logs.flatMap((log) => log.samples().map((sample) => sample.latencyMs)))
  const sent = logs.reduce((sum, log) => sum + log.sentCount(), 0)
  const missing = logs.reduce((sum, log) => sum + log.missingCount(), 0)
  console.log(`지연 (${logs[0].path}) · 보냄 ${sent}개 · 받음 ${summary.count}개 · 미도착 ${missing}개`)
  if (summary.count === 0) {
    return
  }
  const ms = (value: number) => `${value.toFixed(1)}ms`
  console.log(`  p50 ${ms(summary.p50)} · p95 ${ms(summary.p95)} · p99 ${ms(summary.p99)} · 최대 ${ms(summary.max)}`)
}

// 전원 이탈 단계의 결과: 문서마다 나가기 전 상태와, 실제로 기다린 시간 (모든 문서가 함께 기다림)
type LeaveResult = {
  // 묶음 순서와 같은 순서
  docs: {
    state: DocState
    // Y.Doc clientID → 봇 번호, 빠진 연산이 어느 봇의 편집인지 restore.csv에 남기기 위함 (부하 봇은 이 프로세스에 없어 빠짐)
    botByClient: Map<number, number>
  }[]
  waitMs: number
}

// 문서마다 봇 문서를 합쳐 기대 상태를 적고, 모든 문서의 봇을 함께 내보낸 뒤 --restore-wait만큼(또는 Enter까지) 기다림
async function leaveAll(groups: readonly DocGroup[]): Promise<LeaveResult> {
  const docs = groups.map((group) => {
    // 봇 문서를 모두 합친 상태 = 나가기 전 클라이언트 쪽에 있던 편집 전부 (수렴했으므로 어느 봇 하나와도 같음)
    // 부하 봇의 편집도 정식 봇이 받아 두었으므로 여기에 들어감
    const merged = new Y.Doc()
    for (const { doc } of group.docs) {
      Y.applyUpdate(merged, Y.encodeStateAsUpdate(doc))
    }
    const state = captureState(merged)
    merged.destroy()
    return { state, botByClient: new Map(group.everyBot.map((bot) => [bot.doc.clientID, bot.index])) }
  })

  // 접속만 끊음, 각 봇의 Y.Doc은 남아 관찰자와 해시를 비교할 때 씀
  const bots = groups.flatMap((group) => group.everyBot)
  bots.forEach((bot) => bot.destroy())
  const leftAt = Date.now()
  const clients = docs.reduce((sum, doc) => sum + doc.state.clocks.size, 0)
  console.log(`봇 ${bots.length}개 모두 종료 · 기대 상태 저장 (편집한 클라이언트 ${clients}개)`)
  if (options.restoreWaitSec === null) {
    await waitForEnter('파드를 지우거나 스냅샷이 생기기를 기다린 뒤 Enter를 누르면 관찰자가 접속합니다')
  } else {
    console.log(`${options.restoreWaitSec}초 기다린 뒤 관찰자가 접속합니다`)
    await sleep(options.restoreWaitSec * 1000)
  }
  // 서버가 마지막 연결 종료를 처리해 Streams flush → 메모리에서 문서 제거(contracts 5.3-6)를 마칠 시간
  // 이보다 빨리 붙으면 문서가 아직 메모리에 있어 복원을 거치지 않음
  const remaining = RESTORE_MIN_WAIT_MS - (Date.now() - leftAt)
  if (remaining > 0) {
    await sleep(remaining)
  }
  return { docs, waitMs: Date.now() - leftAt }
}

// Enter를 누를 때까지 대기
async function waitForEnter(message: string): Promise<void> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await prompt.question(`${message} `)
  } finally {
    prompt.close()
  }
}

// 복원 결과 출력: 대기 시간, 관찰자 동기화 시간, 해시, 빠진 연산 수와 빠진 클라이언트 (앞 10개)
// prefix: 여러 문서일 때 줄 앞에 붙이는 문서 이름 (예: '문서 loadtest-1-3 · ')
function printRestore(restore: RestoreRecord, prefix = ''): void {
  const { loss } = restore
  console.log(
    `${prefix}복원 · 대기 ${(restore.waitMs / 1000).toFixed(1)}초 · 관찰자 동기화 ${Math.round(restore.observerSyncMs)}ms · ` +
      `해시 ${restore.hashMatch ? '같음' : '다름'} · 빠진 추가 ${loss.missingInserts}개 · 빠진 삭제 ${loss.missingDeletes}개`,
  )
  for (const client of loss.clients.slice(0, 10)) {
    const bot = restore.botByClient.get(client.client)
    console.log(
      `  클라이언트 ${client.client}${bot === undefined ? '' : ` (봇 ${bot})`} · ` +
        `항목 ${client.expectedClock} → ${client.restoredClock} · 삭제 ${client.expectedDeleted} → ${client.restoredDeleted}`,
    )
  }
  if (!restore.hashMatch && loss.clients.length === 0) {
    // 복원 쪽에만 있는 편집이 있다는 뜻 (이탈 뒤 다른 클라이언트가 같은 문서를 편집했는지 확인)
    console.log('  해시는 다르지만 빠진 연산은 없음: 봇이 나간 뒤 같은 문서를 편집한 클라이언트가 있는지 확인')
  }
}

// 재접속 시간 요약 출력: 끊김이 없었으면 출력하지 않음
// 아직 동기화되지 않은 봇이 있으면 그 수도 출력 (끝까지 복구하지 못한 봇이라 시간 기록에는 빠짐)
function printReconnects(samples: readonly ReconnectSample[], pending: number): void {
  if (samples.length === 0 && pending === 0) {
    return
  }
  const summary = summarize(samples.map((sample) => sample.durationMs))
  const ms = (value: number) => `${Math.round(value)}ms`
  const times = summary.count > 0 ? ` · p50 ${ms(summary.p50)} · p95 ${ms(summary.p95)} · 최대 ${ms(summary.max)}` : ''
  console.log(`재접속 · 다시 동기화 ${summary.count}회${times} · 아직 동기화 안 됨 ${pending}개`)
}

// 편집 종류별 합계, 보낸 update 수, 끊김 수 출력
function printSummary(bots: Bot[]): void {
  const actions: Record<string, number> = {}
  let updates = 0
  let disconnects = 0
  for (const bot of bots) {
    for (const [action, count] of Object.entries(bot.stats.actions)) {
      actions[action] = (actions[action] ?? 0) + count
    }
    updates += bot.stats.updatesSent
    disconnects += bot.stats.disconnects
  }
  console.log(`편집 종료 · 편집 ${totalActions(bots)}회 · 보낸 update ${updates}개 · 끊김 ${disconnects}회`)
  for (const [action, count] of Object.entries(actions).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action.padEnd(15)} ${count}`)
  }
}

// PASS: 수렴 시간, 해시, 문서 크기 / FAIL: 해시 묶음별 문서 이름과, 가장 큰 두 묶음의 첫 차이
function printResult(passed: boolean, elapsedMs: number, groups: HashGroup[]): void {
  const [largest, second] = groups
  if (passed) {
    console.log(
      // 묶음이 하나뿐이므로 그 묶음의 문서 수 - 관찰자 1 = 비교한 봇 수 (측정용 봇 포함)
      `PASS · 편집 멈춤 후 ${(elapsedMs / 1000).toFixed(1)}초 만에 봇 ${largest.names.length - 1}개 + 관찰자 수렴 · hash ${largest.hash.slice(0, SHORT_HASH)}`,
    )
    console.log(`  최종 문서: ${describeDoc(largest.sample)}`)
    return
  }

  console.log(`FAIL · 해시 ${groups.length}종류`)
  for (const group of groups) {
    console.log(`  hash ${group.hash.slice(0, SHORT_HASH)} · ${group.names.length}개: ${group.names.join(', ')}`)
  }
  const difference = second && firstDifference(largest.sample, second.sample)
  if (difference) {
    console.log(`  첫 차이 (위치 ${difference.index})`)
    console.log(`    ${largest.hash.slice(0, SHORT_HASH)}: …${difference.a}…`)
    console.log(`    ${second.hash.slice(0, SHORT_HASH)}: …${difference.b}…`)
  }
}

// 문서마다의 복원·수렴 결과 출력
// 문서가 하나면 지금까지와 같은 출력, 여러 개면 문서마다 한 줄 + 실패한 문서의 자세한 내용 + 전체 결과 한 줄
function printResults(docs: readonly DocRecord[], hashGroups: readonly HashGroup[][]): void {
  if (docs.length === 1) {
    const [doc] = docs
    if (doc.restore) {
      printRestore(doc.restore)
    }
    printResult(doc.passed, doc.convergeMs, hashGroups[0])
    return
  }

  for (const [index, doc] of docs.entries()) {
    const prefix = `문서 ${doc.docId} · `
    if (doc.restore) {
      printRestore(doc.restore, prefix)
    }
    const hash = hashGroups[index][0].hash.slice(0, SHORT_HASH)
    console.log(
      `${prefix}${doc.passed ? 'PASS' : 'FAIL'} · 봇 ${doc.bots}개 · 편집 ${doc.actions}회 · ` +
        `수렴 ${(doc.convergeMs / 1000).toFixed(1)}초 · hash ${hash}${doc.hashGroups > 1 ? ` 외 ${doc.hashGroups - 1}종류` : ''}`,
    )
  }
  const failed = docs.filter((doc) => !doc.passed)
  // 실패한 문서는 해시 묶음과 첫 차이를 자세히 출력 (많으면 앞 3개만)
  for (const doc of failed.slice(0, 3)) {
    console.log(`문서 ${doc.docId}`)
    printResult(false, doc.convergeMs, hashGroups[docs.indexOf(doc)])
  }
  const slowest = Math.max(...docs.map((doc) => doc.convergeMs))
  if (failed.length === 0) {
    console.log(`PASS · 문서 ${docs.length}개 모두 수렴 · 가장 늦은 문서 ${(slowest / 1000).toFixed(1)}초`)
  } else {
    console.log(`FAIL · 문서 ${docs.length}개 중 ${failed.length}개 실패: ${failed.map((doc) => doc.docId).join(', ')}`)
  }
}

// 테이블·컬럼·관계 수
function describeDoc(doc: Y.Doc): string {
  const tables = [...getTables(doc).values()]
  const columns = tables.reduce((sum, table) => sum + getColumns(table).size, 0)
  return `테이블 ${tables.length}개 · 컬럼 ${columns}개 · 관계 ${getRelations(doc).size}개`
}

function totalActions(bots: Bot[]): number {
  return bots.reduce(
    (sum, bot) => sum + Object.values(bot.stats.actions).reduce((acc, count) => acc + count, 0),
    0,
  )
}

function positiveNumber(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} 값은 0보다 큰 숫자여야 합니다: ${raw}`)
  }
  return value
}

// 대기 시간처럼 0도 되는 값
function nonNegativeNumber(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} 값은 0 이상의 숫자여야 합니다: ${raw}`)
  }
  return value
}

// 봇 수처럼 개수를 세는 값, 2.5 같은 소수는 거절
function positiveInteger(name: string, raw: string): number {
  const value = positiveNumber(name, raw)
  if (!Number.isInteger(value)) {
    throw new Error(`--${name} 값은 정수여야 합니다: ${raw}`)
  }
  return value
}

// 부하 봇 수처럼 0도 되는 개수, 음수·소수는 거절
function nonNegativeInteger(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} 값은 0 이상의 정수여야 합니다: ${raw}`)
  }
  return value
}

// 시드는 0과 음수도 쓸 수 있고 정수이기만 하면 됨, 'abc'처럼 숫자가 아니면 조용히 0이 되지 않게 거절
function integer(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    throw new Error(`--${name} 값은 정수여야 합니다: ${raw}`)
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 수렴하면 종료 코드 0, 수렴하지 않았거나 오류가 나면 1
main().then(
  (passed) => process.exit(passed ? 0 : 1),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
