import path from 'node:path'
import { parseArgs } from 'node:util'
import { createBot } from './bot'
import type { Bot } from './bot'
import { firstDifference, groupByHash, waitForConvergence } from './converge'
import type { HashGroup, NamedDoc } from './converge'
import { startEventLoopMonitor } from './eventLoop'
import type { EventLoopSummary } from './eventLoop'
import { startLoadProcess } from './loadProcess'
import type { LoadProcess, LoadStats } from './loadProcess'
import { getColumns, getRelations, getTables } from './model'
import type * as Y from 'yjs'
import {
  createProbeLog,
  ensureProbeTable,
  startAwarenessSender,
  startUpdateSender,
  watchAwareness,
  watchUpdates,
} from './probe'
import type { ProbeLog } from './probe'
import { saveRun } from './results'
import { assertSingleYjs } from './singleYjs'
import { summarize } from './stats'

// 문서 ID 형식 (contracts 4.1), 틀리면 서버가 4400으로 닫으므로 미리 막음
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
// 결과 폴더 이름 형식 (--name)
const RUN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

// 실행 인자를 읽어 검사, 예: npm run bot -- --bots 20 --duration 60
// 모르는 인자(--bot 오타 등)나 잘못된 값이면 오류
function readOptions() {
  const { values } = parseArgs({
    options: {
      // 서버 주소 (HAProxy 입구, contracts 4.1)
      url: { type: 'string', default: 'ws://localhost:8088/ws' },
      // 편집할 문서, 지정하지 않으면 매번 새 문서
      doc: { type: 'string', default: `loadtest-${Date.now()}` },
      bots: { type: 'string', default: '10' },
      // 부하 봇 수: 받은 편집을 반영하지 않는 가벼운 봇을 별도 부하 프로세스에서 돌림 (loadWorker.ts)
      // 이 프로세스(측정·수렴 확인)와 스레드가 달라, 부하가 커져도 받는 봇의 측정이 부풀려지지 않음
      'load-bots': { type: 'string', default: '0' },
      // 부하 봇을 나눠 돌릴 프로세스 수, 프로세스 하나에 40개 안팎이 적당 (README)
      'load-processes': { type: 'string', default: '1' },
      // 편집하는 시간(초)
      duration: { type: 'string', default: '30' },
      // 봇 1개의 초당 편집 수
      rate: { type: 'string', default: '2' },
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
    },
  })

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

  return {
    url: values.url,
    docId: values.doc,
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
// 편집 중 진행 상황을 출력하는 간격
const PROGRESS_INTERVAL_MS = 5_000
// 해시 출력 길이, 64자 전부는 길어 앞부분만 표시
const SHORT_HASH = 12

// 수렴했으면 true
async function main(): Promise<boolean> {
  if (!DOC_ID_PATTERN.test(options.docId)) {
    throw new Error(`문서 ID 형식이 틀립니다: ${options.docId} (영문, 숫자, _, - 로 1~64자)`)
  }
  // 봇을 띄우기 전에 yjs가 한 벌인지 먼저 확인, 두 벌이면 편집이 깨지므로 바로 멈춤
  assertSingleYjs()
  // settings.json·summary.csv에 남길 실행 시작 시각
  const runStartedAt = new Date()

  const loadLabel =
    options.loadBots > 0 ? ` + 부하 봇 ${options.loadBots}개(부하 프로세스 ${options.loadProcesses}개)` : ''
  console.log(
    `문서 ${options.docId} · 봇 ${options.bots}개${loadLabel} · ${options.durationSec}초 · 봇당 초당 ${options.rate}회 · seed ${options.seed}`,
  )
  console.log(`서버 ${options.url}`)

  // WebsocketProvider는 Node에서 provider마다 process 'exit' 리스너를 1개씩 등록함
  // 기본 한도 10개를 넘으면 메모리 누수 경고가 나므로 봇 수(+보내는 봇·받는 봇·관찰자)만큼 한도를 늘림
  process.setMaxListeners(options.bots + 13)

  // 1. 봇을 ramp 간격으로 하나씩 접속시키고, 모두 첫 동기화가 끝날 때까지 대기
  const bots: Bot[] = []
  // 편집이 끝난 뒤 새로 접속해 서버가 가진 상태를 받아오는 봇, 편집은 하지 않음
  let observer: Bot | null = null
  // 지연 측정용 봇 (--probe), 무작위 편집은 하지 않고 수렴 확인에는 포함
  let probe: ProbeBots | null = null
  for (let index = 0; index < options.bots; index += 1) {
    bots.push(createBot({ url: options.url, docId: options.docId, index, seed: options.seed, rate: options.rate }))
    await sleep(options.rampMs)
  }
  if (options.probe) {
    probe = createProbeBots()
  }
  // 부하 프로세스: 부하 봇을 나눠 맡겨 띄움, 각 프로세스 안에서 봇이 ramp 간격으로 접속
  const loads = startLoadProcesses()
  // 수렴 확인·종료를 함께 할 봇 전부 (부하 봇은 다른 사람의 편집을 반영하지 않아 수렴 확인에서 뺌)
  const everyBot = probe ? [...bots, probe.sender, probe.receiver] : bots
  try {
    await Promise.all([
      ...everyBot.map((bot) => bot.waitSynced(SYNC_TIMEOUT_MS)),
      ...loads.map((load) => load.ready),
    ])
    console.log(`봇 ${everyBot.length}개${loadLabel} 동기화 완료, 편집 시작`)

    // 2. 정해진 시간 동안 편집 (지연 측정을 켰으면 측정용 변경도 함께 보냄)
    // 측정 표본이 모이는 편집 구간 동안 봇 프로세스가 얼마나 바빴는지 함께 기록
    const stopEventLoopMonitor = startEventLoopMonitor()
    probe?.start()
    bots.forEach((bot) => bot.start())
    loads.forEach((load) => load.start())
    const startedAt = Date.now()
    const progress = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(`  ${elapsed}초 · 편집 ${totalActions(bots)}회`)
    }, PROGRESS_INTERVAL_MS)
    await sleep(options.durationSec * 1000)
    clearInterval(progress)

    // 3. 편집 멈춤 (진행 중인 드래그는 끝까지), 부하 프로세스는 멈춘 뒤 통계를 보내고 스스로 끝남
    probe?.stopSending()
    const [loadStats] = await Promise.all([
      Promise.all(loads.map((load) => load.stop())),
      Promise.all(bots.map((bot) => bot.stop())),
    ])
    // 수렴 확인은 해시 계산으로 일부러 바쁜 구간이라 빼고, 편집 구간만 요약
    const eventLoop = stopEventLoopMonitor()
    printSummary(bots)
    printEventLoop(eventLoop)
    if (loadStats.length > 0) {
      printLoadSummary(loadStats)
    }

    // 4. 봇끼리 수렴 확인: 아직 서버를 오가는 변경이 있으므로 같아질 때까지 기다림
    console.log(`수렴 확인 중 (최대 ${options.settleSec}초)`)
    const botDocs: NamedDoc[] = bots.map((bot) => ({ name: `봇 ${bot.index}`, doc: bot.doc }))
    if (probe) {
      botDocs.push({ name: '보내는 봇', doc: probe.sender.doc }, { name: '받는 봇', doc: probe.receiver.doc })
    }
    const result = await waitForConvergence(botDocs, options.settleSec * 1000)

    // 수렴을 기다리는 동안 늦게 온 측정용 변경까지 받았으므로, 여기서 측정을 마치고 지연 출력
    if (probe) {
      probe.stopWatching()
      printLatency(probe.updateLog)
      printLatency(probe.awarenessLog)
    }

    // 5. 관찰자 확인: 봇끼리만 같고 서버는 다를 수 있으므로, 새로 접속한 클라이언트가 받는 상태도 비교
    observer = createBot({
      url: options.url,
      docId: options.docId,
      index: options.bots + 2,
      seed: options.seed,
      rate: options.rate,
    })
    await observer.waitSynced(SYNC_TIMEOUT_MS)
    const groups = await groupByHash([...botDocs, { name: '관찰자', doc: observer.doc }])

    const passed = result.converged && groups.length === 1
    printResult(passed, result.elapsedMs, groups)

    // 6. 결과 저장: PASS든 FAIL이든 남김 (FAIL 원인을 나중에 볼 수 있게)
    // 동기화 시간 초과처럼 중간에 오류가 나면 측정값이 없으므로 저장하지 않음
    const dir = saveRun({
      name: options.name,
      argv: process.argv.slice(2),
      options: { ...options },
      startedAt: runStartedAt,
      finishedAt: new Date(),
      passed,
      convergeMs: result.elapsedMs,
      hashGroups: groups.length,
      actions: totalActions(bots),
      updatesSent: bots.reduce((sum, bot) => sum + bot.stats.updatesSent, 0),
      disconnects: bots.reduce((sum, bot) => sum + bot.stats.disconnects, 0),
      load: loadStats,
      eventLoop,
      logs: probe ? [probe.updateLog, probe.awarenessLog] : [],
    })
    console.log(`결과 저장 · ${path.relative(process.cwd(), dir)}`)
    return passed
  } finally {
    probe?.stopSending()
    probe?.stopWatching()
    everyBot.forEach((bot) => bot.destroy())
    // 정상 흐름이면 이미 끝났으므로 아무 일도 없음, 오류로 중간에 끝날 때 남은 부하 프로세스를 정리
    loads.forEach((load) => load.kill())
    observer?.destroy()
  }
}

// 부하 봇을 프로세스 수만큼 고르게 나눠 띄움 (예: 93개 · 3개 → 31개씩)
// 봇 번호는 관찰자(bots + 2) 다음부터 이어서 써서 정식 봇·측정 봇과 시드·이름이 겹치지 않게 함
function startLoadProcesses(): LoadProcess[] {
  const loads: LoadProcess[] = []
  if (options.loadBots === 0) {
    return loads
  }
  let firstIndex = options.bots + 3
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

// 지연 측정용 봇 두 개와 그 기록
type ProbeBots = {
  // --url(HAProxy)로 붙어 측정용 변경을 보내는 봇
  sender: Bot
  // --receiver-url로 붙어 받은 시각을 기록하는 봇, 다른 파드에 붙이면 Redis를 거치는 SHARED 경로를 잼
  receiver: Bot
  updateLog: ProbeLog
  awarenessLog: ProbeLog
  // 측정용 테이블을 준비하고 두 경로(update·awareness)의 보내기·받기를 시작
  start: () => void
  stopSending: () => void
  stopWatching: () => void
}

// 봇 번호는 일반 봇 다음 번호를 씀 (보내는 봇 = bots, 받는 봇 = bots + 1, 관찰자 = bots + 2)
function createProbeBots(): ProbeBots {
  const common = { docId: options.docId, seed: options.seed, rate: options.rate }
  const sender = createBot({ ...common, url: options.url, index: options.bots })
  const receiver = createBot({ ...common, url: options.receiverUrl, index: options.bots + 1 })
  // 경로마다 기록장을 따로 둠, 순번도 경로마다 1부터 셈
  const updateLog = createProbeLog('update')
  const awarenessLog = createProbeLog('awareness')
  console.log(
    `지연 측정 · ${options.probeIntervalMs}ms마다 · 보내는 봇(봇 ${sender.index}) ${options.url} → 받는 봇(봇 ${receiver.index}) ${options.receiverUrl}`,
  )
  // 멈추는 함수 모음, 시작 전이면 비어 있어 멈춰도 아무 일도 없음
  let senderStops: (() => void)[] = []
  let watcherStops: (() => void)[] = []

  return {
    sender,
    receiver,
    updateLog,
    awarenessLog,
    start: () => {
      // 보내는 봇 문서에 측정용 테이블을 만듦, 받는 봇에는 이 생성이 먼저 도착한 뒤 이름 변경이 도착함
      const tableId = ensureProbeTable(sender.doc)
      // 받는 쪽을 먼저 붙여 첫 순번부터 기록
      watcherStops = [
        watchUpdates(receiver.doc, tableId, updateLog),
        // awareness의 clientID = 그 봇 Y.Doc의 clientID, 받는 봇은 이 번호로 보내는 봇의 상태를 찾음
        watchAwareness(receiver.awareness, sender.awareness.clientID, awarenessLog),
      ]
      senderStops = [
        startUpdateSender(sender.doc, tableId, updateLog, options.probeIntervalMs),
        startAwarenessSender(sender.awareness, awarenessLog, options.probeIntervalMs),
      ]
    },
    stopSending: () => senderStops.forEach((stop) => stop()),
    stopWatching: () => watcherStops.forEach((stop) => stop()),
  }
}

// 이벤트 루프 요약 출력: 바쁜 시간 비율과 타이머 지연
function printEventLoop(summary: EventLoopSummary): void {
  const ms = (value: number) => `${value.toFixed(1)}ms`
  console.log(
    `이벤트 루프 · 바쁜 시간 ${(summary.utilization * 100).toFixed(1)}% · 타이머 지연 p50 ${ms(summary.lagP50Ms)} · p99 ${ms(summary.lagP99Ms)} · 최대 ${ms(summary.lagMaxMs)}`,
  )
}

// 경로별 지연 요약 출력: 표본 수, 미도착 수, p50·p95·p99·최대
function printLatency(log: ProbeLog): void {
  const summary = summarize(log.samples().map((sample) => sample.latencyMs))
  console.log(`지연 (${log.path}) · 보냄 ${log.sentCount()}개 · 받음 ${summary.count}개 · 미도착 ${log.missingCount()}개`)
  if (summary.count === 0) {
    return
  }
  const ms = (value: number) => `${value.toFixed(1)}ms`
  console.log(`  p50 ${ms(summary.p50)} · p95 ${ms(summary.p95)} · p99 ${ms(summary.p99)} · 최대 ${ms(summary.max)}`)
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
