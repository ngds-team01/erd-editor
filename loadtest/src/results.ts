// 실행 결과를 파일로 저장 (제안서: 원본 CSV · 커밋 SHA · 설정을 함께 보관)
// 실행마다 results/{날짜-시각}-{이름}/ 폴더에 네 파일(restore 실행은 다섯 파일)을 만듦
//   settings.json:  무엇으로 돌렸나 (인자, seed, 서버 주소, 커밋 SHA, 시작·종료 시각)
//   samples.csv:    지연 측정값 원본, 한 줄에 하나
//   reconnects.csv: 재접속 기록 원본, 끊김 한 번에 한 줄
//   restore.csv:    (--scenario restore만) 연산이 빠진 클라이언트, 한 줄에 하나, 빠진 것이 없으면 헤더만
//   summary.csv:    이 실행의 요약 한 줄, 열 순서가 항상 같아 여러 실행의 줄을 이어 붙여 비교할 수 있음
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EventLoopSummary } from './eventLoop'
import type { LoadStats } from './loadProcess'
import type { ProbeLog, ProbePath, ProbeSample } from './probe'
import type { ReconnectSample } from './reconnectTime'
import type { LossReport } from './restore'
import { summarize } from './stats'

// 기본 저장 위치: loadtest/results (이 파일 기준 ../results), .gitignore로 git에는 올리지 않음
export const DEFAULT_RESULTS_ROOT = fileURLToPath(new URL('../results', import.meta.url))
// 커밋 SHA를 읽을 폴더 = 이 파일이 있는 폴더, 저장 위치를 저장소 밖으로 바꿔도 SHA는 이 코드 기준
const SOURCE_DIR = fileURLToPath(new URL('.', import.meta.url))

// summary.csv에 늘 같은 순서로 나오는 측정 경로, 측정을 끈 실행은 이 칸들이 빈칸
const PROBE_PATHS: readonly ProbePath[] = ['update', 'awareness']

// CSV 한 칸에 들어갈 수 있는 값, null·NaN은 빈칸
type Cell = string | number | boolean | null

// 실행 한 번의 기록, index.ts가 실행을 마친 뒤 채워서 saveRun에 넘김
export type RunRecord = {
  name: string
  // 명령줄에 실제로 적은 인자 (예: ['--bots', '100', '--probe'])
  argv: string[]
  // 기본값까지 채운 최종 옵션, seed를 지정하지 않았어도 실제로 쓴 값이 남음
  options: Record<string, unknown>
  startedAt: Date
  finishedAt: Date
  passed: boolean
  convergeMs: number
  // 해시 묶음 수, 1이면 모두 같음
  hashGroups: number
  actions: number
  updatesSent: number
  disconnects: number
  // 부하 프로세스마다의 통계 (위 actions·updatesSent·disconnects는 이 프로세스의 정식 봇만), 부하 봇이 없으면 빈 배열
  load: LoadStats[]
  // 이 프로세스(측정·수렴 확인)의 이벤트 루프
  eventLoop: EventLoopSummary
  // 측정을 끈 실행은 빈 배열
  logs: ProbeLog[]
  // 다시 동기화를 마친 끊김들 (정식 봇 + 측정 봇), 끊김이 없었으면 빈 배열
  reconnects: ReconnectSample[]
  // 실행이 끝날 때까지 다시 동기화되지 않은 봇 수
  reconnectPending: number
  // 실행 순서 (--scenario), converge 또는 restore
  scenario: string
  // 전원 이탈 후 복원 결과, converge이거나 봇끼리 수렴하지 않아 이탈 단계를 건너뛰었으면 null
  restore: RestoreRecord | null
}

// 전원 이탈 후 복원 결과 (실험 2-b)
export type RestoreRecord = {
  // 봇이 모두 나간 뒤 관찰자가 접속하기까지 실제로 기다린 시간
  waitMs: number
  // 관찰자 접속부터 동기화까지, 서버가 문서를 복원한 시간이 들어감
  observerSyncMs: number
  // 나가기 전 봇 문서들과 관찰자 문서의 해시가 같은지
  hashMatch: boolean
  loss: LossReport
  // Y.Doc clientID → 봇 번호 (이 프로세스의 봇만)
  botByClient: Map<number, number>
}

// 폴더 이름용 날짜-시각, 이 컴퓨터 시간대 기준 (예: 20261123-191502)
export function timestampForDir(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

// 행 목록을 CSV 문자열로, 쉼표·따옴표·줄바꿈이 든 값은 따옴표로 감쌈 (RFC 4180)
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const cell = (value: Cell): string => {
    if (value === null || (typeof value === 'number' && Number.isNaN(value))) {
      return ''
    }
    const text = String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\n') + '\n'
}

// ms 값을 소수점 아래 3자리로 (0.001ms = 1µs), 파일 크기와 읽기 쉬움을 맞춤
function ms(value: number): number {
  return Math.round(value * 1000) / 1000
}

// samples.csv: 경로, 순번, 보낸 시각, 받은 시각(epoch ms), 지연(ms)
export function samplesCsv(samples: readonly ProbeSample[]): string {
  return toCsv(
    ['path', 'seq', 'sent_at_ms', 'received_at_ms', 'latency_ms'],
    samples.map((sample) => [sample.path, sample.seq, ms(sample.sentAt), ms(sample.receivedAt), ms(sample.latencyMs)]),
  )
}

// reconnects.csv: 봇 번호, close code, 끊긴 시각, 다시 동기화된 시각(epoch ms), 걸린 시간(ms), 실패한 재접속 수
// 끊긴 시각 순으로 정렬해, 파드를 여러 번 지운 실행에서 몇 번째 삭제의 기록인지 시각으로 나눠 볼 수 있게 함
export function reconnectsCsv(samples: readonly ReconnectSample[]): string {
  const sorted = [...samples].sort((a, b) => a.disconnectedAt - b.disconnectedAt)
  return toCsv(
    ['bot', 'close_code', 'disconnected_at_ms', 'synced_at_ms', 'duration_ms', 'failed_attempts'],
    sorted.map((sample) => [
      sample.bot,
      sample.closeCode,
      ms(sample.disconnectedAt),
      ms(sample.syncedAt),
      ms(sample.durationMs),
      sample.failedAttempts,
    ]),
  )
}

// restore.csv: 연산이 빠진 클라이언트마다 한 줄, 기대 값(나가기 전)과 복원 값(관찰자)을 나란히 둠
// bot은 이 프로세스의 봇일 때만 채움 (부하 봇의 클라이언트는 빈칸)
export function restoreCsv(restore: RestoreRecord): string {
  return toCsv(
    ['client', 'bot', 'expected_clock', 'restored_clock', 'expected_deleted', 'restored_deleted'],
    restore.loss.clients.map((client) => [
      client.client,
      restore.botByClient.get(client.client) ?? null,
      client.expectedClock,
      client.restoredClock,
      client.expectedDeleted,
      client.restoredDeleted,
    ]),
  )
}

// summary.csv: 헤더 한 줄 + 이 실행의 값 한 줄
export function summaryCsv(record: RunRecord): string {
  const columns: [string, Cell][] = [
    ['name', record.name],
    ['started_at', record.startedAt.toISOString()],
    ['bots', numberOption(record, 'bots')],
    ['rate', numberOption(record, 'rate')],
    ['duration_s', numberOption(record, 'durationSec')],
    ['seed', numberOption(record, 'seed')],
    ['passed', record.passed],
    ['converge_ms', Math.round(record.convergeMs)],
    ['hash_groups', record.hashGroups],
    ['actions', record.actions],
    ['updates_sent', record.updatesSent],
    ['disconnects', record.disconnects],
    ['event_loop_utilization', ms(record.eventLoop.utilization)],
    ['event_loop_lag_p50_ms', ms(record.eventLoop.lagP50Ms)],
    ['event_loop_lag_p99_ms', ms(record.eventLoop.lagP99Ms)],
    ['event_loop_lag_max_ms', ms(record.eventLoop.lagMaxMs)],
    ...loadColumns(record.load),
  ]
  // 경로마다 같은 7칸, 기록이 없는 경로(측정을 끔)는 빈칸으로 채워 열 순서를 유지
  for (const probePath of PROBE_PATHS) {
    const log = record.logs.find((candidate) => candidate.path === probePath)
    // samples.csv에 쓴 값(소수점 셋째 자리로 반올림)으로 계산해, 스프레드시트로 다시 계산한 값과 소수점까지 같게 함
    // (반올림 전 값으로 계산하면 셋째 자리에서 0.001 차이가 날 수 있음)
    const summary = log ? summarize(log.samples().map((sample) => ms(sample.latencyMs))) : null
    columns.push(
      [`${probePath}_sent`, log ? log.sentCount() : null],
      [`${probePath}_received`, summary ? summary.count : null],
      [`${probePath}_missing`, log ? log.missingCount() : null],
      [`${probePath}_p50_ms`, summary ? ms(summary.p50) : null],
      [`${probePath}_p95_ms`, summary ? ms(summary.p95) : null],
      [`${probePath}_p99_ms`, summary ? ms(summary.p99) : null],
      [`${probePath}_max_ms`, summary ? ms(summary.max) : null],
    )
  }
  // 재접속 열은 맨 뒤에 둠: 이전 실행의 summary.csv와 앞쪽 열 순서가 같게 유지
  // 지연과 같이 reconnects.csv에 쓴 값(반올림 후)으로 계산, 끊김이 없으면 개수 0, 백분위는 빈칸
  const reconnect = summarize(record.reconnects.map((sample) => ms(sample.durationMs)))
  columns.push(
    ['reconnects', reconnect.count],
    ['reconnect_pending', record.reconnectPending],
    ['reconnect_p50_ms', ms(reconnect.p50)],
    ['reconnect_p95_ms', ms(reconnect.p95)],
    ['reconnect_max_ms', ms(reconnect.max)],
  )
  // 복원 열도 맨 뒤에, converge 실행은 빈칸
  const restore = record.restore
  columns.push(
    ['scenario', record.scenario],
    ['restore_wait_ms', restore ? Math.round(restore.waitMs) : null],
    ['restore_sync_ms', restore ? ms(restore.observerSyncMs) : null],
    ['restore_hash_match', restore ? restore.hashMatch : null],
    ['restore_missing_inserts', restore ? restore.loss.missingInserts : null],
    ['restore_missing_deletes', restore ? restore.loss.missingDeletes : null],
    ['restore_missing_clients', restore ? restore.loss.clients.length : null],
  )
  return toCsv(
    columns.map(([header]) => header),
    [columns.map(([, value]) => value)],
  )
}

// 부하 프로세스 합계 열, 부하 봇이 없으면 개수는 0, 바쁜 시간은 빈칸
// 바쁜 시간은 프로세스마다 따로이므로 가장 바빴던 프로세스 값을 남김 (부하를 요청대로 만들었는지 판단용)
function loadColumns(load: readonly LoadStats[]): [string, Cell][] {
  const total = (pick: (stat: LoadStats) => number) => load.reduce((sum, stat) => sum + pick(stat), 0)
  const loops = load.flatMap((stat) => (stat.eventLoop ? [stat.eventLoop] : []))
  const max = (pick: (loop: EventLoopSummary) => number) => (loops.length > 0 ? ms(Math.max(...loops.map(pick))) : null)
  return [
    ['load_bots', total((stat) => stat.bots)],
    ['load_processes', load.length],
    ['load_actions', total((stat) => Object.values(stat.actions).reduce((sum, count) => sum + count, 0))],
    ['load_updates_sent', total((stat) => stat.updatesSent)],
    ['load_messages_received', total((stat) => stat.messagesReceived)],
    ['load_disconnects', total((stat) => stat.disconnects)],
    ['load_event_loop_utilization_max', max((loop) => loop.utilization)],
    ['load_event_loop_lag_max_ms', max((loop) => loop.lagMaxMs)],
  ]
}

function numberOption(record: RunRecord, key: string): number | null {
  const value = record.options[key]
  return typeof value === 'number' ? value : null
}

// 지금 코드의 커밋 SHA와, 커밋하지 않은 변경이 있는지
// dirty가 true면 SHA만으로는 실행한 코드를 다시 만들 수 없다는 뜻
// git이 없거나 저장소 밖이면 null
export function gitInfo(cwd: string): { commit: string | null; dirty: boolean | null } {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  const commit = run(['rev-parse', 'HEAD'])
  const status = run(['status', '--porcelain'])
  return { commit, dirty: status === null ? null : status !== '' }
}

// 결과 폴더를 새로 만듦, 같은 이름이 있으면 -2, -3 … 을 붙여 이전 결과를 덮어쓰지 않음
function createRunDir(root: string, base: string): string {
  mkdirSync(root, { recursive: true })
  for (let attempt = 1; ; attempt += 1) {
    const dir = path.join(root, attempt === 1 ? base : `${base}-${attempt}`)
    try {
      // recursive 없이 만들면 이미 있을 때 EEXIST 오류가 나서 덮어쓰지 않음
      mkdirSync(dir)
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }
}

// 파일을 저장하고 폴더 경로를 돌려줌
export function saveRun(record: RunRecord, root: string = DEFAULT_RESULTS_ROOT): string {
  const dir = createRunDir(root, `${timestampForDir(record.startedAt)}-${record.name}`)
  const settings = {
    name: record.name,
    argv: record.argv,
    options: record.options,
    git: gitInfo(SOURCE_DIR),
    node: process.version,
    platform: process.platform,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt.toISOString(),
  }
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n')
  writeFileSync(path.join(dir, 'samples.csv'), samplesCsv(record.logs.flatMap((log) => log.samples())))
  writeFileSync(path.join(dir, 'reconnects.csv'), reconnectsCsv(record.reconnects))
  if (record.restore) {
    writeFileSync(path.join(dir, 'restore.csv'), restoreCsv(record.restore))
  }
  writeFileSync(path.join(dir, 'summary.csv'), summaryCsv(record))
  return dir
}
