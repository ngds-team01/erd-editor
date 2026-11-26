// 실험 2 결과 정리 (exp2.ts가 씀): 하위 실행(index.ts)의 CSV와 서버 로그를 읽어 삭제·실행별로 묶고 보고서 표를 만듦
// 계산만 하고 파일·kubectl은 건드리지 않음 (exp2Report.test.ts)
import { summarize } from './stats'
import type { LatencySummary } from './stats'

// 성공 기준 (제안서): 장애 복구 p95 ≤ 5초, 편집 유실 0건
export const RECOVERY_P95_LIMIT_MS = 5_000

// CSV 문자열 → 열 이름별 객체 목록 (results.ts의 toCsv가 쓴 형식, 따옴표로 감싼 칸도 읽음)
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1
      }
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  const [header, ...body] = rows
  if (!header) {
    return []
  }
  return body.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])))
}

// 파드 삭제 한 번의 기록 (exp2.ts가 채움)
export type KillRecord = {
  rep: number
  kill: number
  pod: string
  // 지우기 직전 그 파드의 WebSocket 연결 수 (editor_ws_connections)
  connections: number
  // kubectl delete를 부르기 직전 시각 (epoch ms)
  killedAtMs: number
  // 대체 파드까지 모두 Ready가 된 시각 (epoch ms)
  readyAtMs: number
}

// reconnects.csv 한 줄
export type ReconnectRow = {
  bot: number
  closeCode: number
  disconnectedAtMs: number
  syncedAtMs: number
  durationMs: number
  failedAttempts: number
}

export function readReconnects(text: string): ReconnectRow[] {
  return parseCsv(text).map((row) => ({
    bot: Number(row.bot),
    closeCode: Number(row.close_code),
    disconnectedAtMs: Number(row.disconnected_at_ms),
    syncedAtMs: Number(row.synced_at_ms),
    durationMs: Number(row.duration_ms),
    failedAttempts: Number(row.failed_attempts),
  }))
}

// 끊김을 바로 앞의 삭제에 나눠 담음: 삭제 k의 시각 ≤ 끊긴 시각 < 삭제 k+1의 시각
// 첫 삭제보다 먼저 끊긴 줄은 삭제와 상관없는 끊김이라 unassigned로 따로 셈
// slackMs: kubectl을 부른 시각보다 봇이 조금 먼저 끊김을 알아챌 일은 없지만, 시계 반올림 등을 감안한 여유
export function assignToKills<T extends { disconnectedAtMs: number }>(
  rows: readonly T[],
  kills: readonly { killedAtMs: number }[],
  slackMs = 50,
): { byKill: T[][]; unassigned: T[] } {
  const starts = kills.map((kill) => kill.killedAtMs - slackMs)
  const byKill: T[][] = kills.map(() => [])
  const unassigned: T[] = []
  for (const row of rows) {
    let index = -1
    for (let k = 0; k < starts.length; k += 1) {
      if (row.disconnectedAtMs >= starts[k]) {
        index = k
      }
    }
    if (index === -1) {
      unassigned.push(row)
    } else {
      byKill[index].push(row)
    }
  }
  return { byKill, unassigned }
}

// 서버 로그의 복원 줄 (server/src/doc.ts): [doc:ID] 복원 완료 0.123초 (스냅샷 있음, 기록 0항목)
export type RestoreLog = {
  seconds: number
  snapshot: 'found' | 'none' | 'failed'
  entries: number
}

const SNAPSHOT_LABELS = { '스냅샷 있음': 'found', '스냅샷 없음': 'none', '스냅샷 읽기 실패': 'failed' } as const

// 로그에서 그 문서의 마지막 복원 줄을 찾음, 없으면 null
export function findRestoreLog(log: string, docId: string): RestoreLog | null {
  const escaped = docId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `\\[doc:${escaped}\\] 복원 완료 ([0-9.]+)초 \\((스냅샷 있음|스냅샷 없음|스냅샷 읽기 실패), 기록 (\\d+)항목`,
    'g',
  )
  let found: RestoreLog | null = null
  for (const match of log.matchAll(pattern)) {
    found = {
      seconds: Number(match[1]),
      snapshot: SNAPSHOT_LABELS[match[2] as keyof typeof SNAPSHOT_LABELS],
      entries: Number(match[3]),
    }
  }
  return found
}

// (b) 복원 한 번의 기록 (exp2.ts가 summary.csv와 서버 로그에서 채움)
export type RestoreRun = {
  rep: number
  run: number
  docId: string
  passed: boolean
  hashMatch: boolean
  missingInserts: number
  missingDeletes: number
  // 관찰자 접속부터 동기화까지 (서버 복원 시간 포함, summary.csv의 restore_sync_ms)
  observerSyncMs: number
  // 서버 로그의 복원 시간, 로그를 못 찾으면 null
  serverRestoreMs: number | null
  snapshot: RestoreLog['snapshot'] | null
  entries: number | null
  resultDir: string
}

const fmt = (value: number): string => (Number.isFinite(value) ? String(Math.round(value)) : '-')

function summaryCells(summary: LatencySummary): string {
  return `${fmt(summary.p50)} | ${fmt(summary.p95)} | ${fmt(summary.max)}`
}

// (a) 결과 표: 반복마다 한 줄 + 전체
export type KillRep = {
  rep: number
  kills: KillRecord[]
  reconnects: ReconnectRow[]
  unassigned: number
  pending: number
  passed: boolean
}

export function killReport(reps: readonly KillRep[]): string {
  const lines = [
    '| 반복 | 삭제 | 끊긴 연결 | 재동기화 | p50 (ms) | p95 (ms) | 최대 (ms) | 못 붙은 봇 | 수렴 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const rep of reps) {
    const connections = rep.kills.reduce((total, kill) => total + kill.connections, 0)
    const summary = summarize(rep.reconnects.map((row) => row.durationMs))
    lines.push(
      `| ${rep.rep} | ${rep.kills.length} | ${connections} | ${summary.count} | ${summaryCells(summary)} | ${rep.pending} | ${rep.passed ? 'PASS' : 'FAIL'} |`,
    )
  }
  const all = summarize(reps.flatMap((rep) => rep.reconnects.map((row) => row.durationMs)))
  const kills = reps.reduce((total, rep) => total + rep.kills.length, 0)
  const connections = reps.reduce((total, rep) => total + rep.kills.reduce((sum, kill) => sum + kill.connections, 0), 0)
  const pending = reps.reduce((total, rep) => total + rep.pending, 0)
  const passed = reps.filter((rep) => rep.passed).length
  lines.push(
    `| 전체 | ${kills} | ${connections} | ${all.count} | ${summaryCells(all)} | ${pending} | ${passed}/${reps.length} |`,
  )
  const unassigned = reps.reduce((total, rep) => total + rep.unassigned, 0)
  const met = Number.isFinite(all.p95) && all.p95 <= RECOVERY_P95_LIMIT_MS && pending === 0 && passed === reps.length
  lines.push(
    '',
    `- 성공 기준 (재동기화 p95 ≤ ${RECOVERY_P95_LIMIT_MS / 1000}초, 못 붙은 봇 0, 모든 반복 수렴): ${met ? '충족' : '미충족'}`,
  )
  if (unassigned > 0) {
    lines.push(`- 첫 삭제 전에 끊긴 연결 ${unassigned}개는 표에서 뺐음 (삭제와 상관없는 끊김)`)
  }
  return lines.join('\n') + '\n'
}

// (b) 결과 표: 반복마다 한 줄 + 전체
export function restoreReport(runs: readonly RestoreRun[]): string {
  const lines = [
    '| 반복 | 실행 | PASS | 빠진 추가 | 빠진 삭제 | 서버 복원 p50 / p95 / 최대 (ms) | 관찰자 동기화 p50 / p95 / 최대 (ms) | 복원 출처 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  const row = (label: string, group: readonly RestoreRun[]) => {
    const server = summarize(group.flatMap((run) => (run.serverRestoreMs === null ? [] : [run.serverRestoreMs])))
    const observer = summarize(group.map((run) => run.observerSyncMs))
    const inserts = group.reduce((total, run) => total + run.missingInserts, 0)
    const deletes = group.reduce((total, run) => total + run.missingDeletes, 0)
    const passed = group.filter((run) => run.passed).length
    lines.push(
      `| ${label} | ${group.length} | ${passed}/${group.length} | ${inserts} | ${deletes} | ` +
        `${summaryCells(server).replaceAll(' | ', ' / ')} | ${summaryCells(observer).replaceAll(' | ', ' / ')} | ${sourceLabel(group)} |`,
    )
  }
  const reps = [...new Set(runs.map((run) => run.rep))].sort((a, b) => a - b)
  for (const rep of reps) {
    row(String(rep), runs.filter((run) => run.rep === rep))
  }
  row('전체', runs)
  const lost = runs.reduce((total, run) => total + run.missingInserts + run.missingDeletes, 0)
  const passed = runs.every((run) => run.passed)
  lines.push('', `- 성공 기준 (편집 유실 0건, 모든 실행 PASS): ${lost === 0 && passed && runs.length > 0 ? '충족' : '미충족'}`)
  const missingLog = runs.filter((run) => run.serverRestoreMs === null).length
  if (missingLog > 0) {
    lines.push(`- 서버 로그에서 복원 줄을 못 찾은 실행 ${missingLog}개 (서버 복원 시간에서 빠짐)`)
  }
  return lines.join('\n') + '\n'
}

// 복원 출처 개수, 예: "스냅샷 10" 또는 "Streams만 9 · 스냅샷+Streams 1"
function sourceLabel(runs: readonly RestoreRun[]): string {
  const counts = new Map<string, number>()
  for (const run of runs) {
    const label =
      run.snapshot === null
        ? '로그 없음'
        : run.snapshot === 'found'
          ? run.entries === 0
            ? '스냅샷'
            : '스냅샷+Streams'
          : run.snapshot === 'none'
            ? 'Streams만'
            : '스냅샷 읽기 실패'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join(' · ')
}
