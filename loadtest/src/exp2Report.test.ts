// 실험 2 결과 정리 확인: CSV 읽기, 끊김을 삭제별로 나누기, 서버 복원 로그 읽기, 결과 표
// 실행: npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assignToKills, findRestoreLog, killReport, parseCsv, readReconnects, restoreReport } from './exp2Report'
import type { KillRecord, RestoreRun } from './exp2Report'
import { toCsv } from './results'

describe('parseCsv', () => {
  it('toCsv가 쓴 파일을 그대로 읽음 (따옴표·쉼표·빈칸)', () => {
    const text = toCsv(['a', 'b', 'c'], [[1, 'x,"y"', null], [2, '', true]])
    assert.deepEqual(parseCsv(text), [
      { a: '1', b: 'x,"y"', c: '' },
      { a: '2', b: '', c: 'true' },
    ])
  })

  it('헤더만 있으면 빈 목록', () => {
    assert.deepEqual(parseCsv('a,b\n'), [])
    assert.deepEqual(parseCsv(''), [])
  })

  it('reconnects.csv를 숫자로 읽음', () => {
    const text = toCsv(
      ['bot', 'close_code', 'disconnected_at_ms', 'synced_at_ms', 'duration_ms', 'failed_attempts', 'doc'],
      [[3, 1006, 1000, 1500, 500, 0, 'd']],
    )
    assert.deepEqual(readReconnects(text), [
      { bot: 3, closeCode: 1006, disconnectedAtMs: 1000, syncedAtMs: 1500, durationMs: 500, failedAttempts: 0 },
    ])
  })
})

describe('assignToKills', () => {
  const kills = [{ killedAtMs: 10_000 }, { killedAtMs: 40_000 }]

  it('끊긴 시각으로 바로 앞 삭제에 담고, 첫 삭제 전 끊김은 따로 셈', () => {
    const rows = [5_000, 10_020, 12_000, 39_990, 40_100, 70_000].map((disconnectedAtMs) => ({ disconnectedAtMs }))
    const { byKill, unassigned } = assignToKills(rows, kills)
    assert.deepEqual(
      byKill.map((group) => group.map((row) => row.disconnectedAtMs)),
      [
        [10_020, 12_000],
        [39_990, 40_100, 70_000],
      ],
    )
    assert.deepEqual(unassigned, [{ disconnectedAtMs: 5_000 }])
  })

  it('kubectl 부른 시각보다 조금 앞서 기록된 끊김도 그 삭제로 침 (slack)', () => {
    const { byKill } = assignToKills([{ disconnectedAtMs: 9_970 }], kills)
    assert.equal(byKill[0].length, 1)
  })
})

describe('findRestoreLog', () => {
  const log = [
    '[doc:exp2-a] 복원 완료 0.031초 (스냅샷 없음, 기록 318항목)',
    '[doc:exp2-b] 복원 완료 0.120초 (스냅샷 있음, 기록 0항목, 미기록 2개)',
    '[doc:exp2-b] 복원 완료 0.050초 (스냅샷 있음, 기록 4항목)',
  ].join('\n')

  it('그 문서의 마지막 복원 줄을 읽음', () => {
    assert.deepEqual(findRestoreLog(log, 'exp2-a'), { seconds: 0.031, snapshot: 'none', entries: 318 })
    assert.deepEqual(findRestoreLog(log, 'exp2-b'), { seconds: 0.05, snapshot: 'found', entries: 4 })
  })

  it('이름이 앞부분만 같은 문서는 고르지 않음', () => {
    assert.equal(findRestoreLog(log, 'exp2'), null)
    assert.equal(findRestoreLog('[doc:exp2-a-1] 복원 완료 0.1초 (스냅샷 없음, 기록 1항목)', 'exp2-a'), null)
  })
})

describe('결과 표', () => {
  const kill = (rep: number, killNo: number, connections: number): KillRecord => ({
    rep,
    kill: killNo,
    pod: `editor-${killNo}`,
    connections,
    killedAtMs: killNo * 30_000,
    readyAtMs: killNo * 30_000 + 8_000,
  })
  const reconnect = (durationMs: number) => ({
    bot: 0,
    closeCode: 1006,
    disconnectedAtMs: 0,
    syncedAtMs: durationMs,
    durationMs,
    failedAttempts: 0,
  })

  it('(a) 반복마다 한 줄 + 전체, 기준 충족 여부', () => {
    const report = killReport([
      { rep: 1, kills: [kill(1, 1, 2)], reconnects: [reconnect(400), reconnect(600)], unassigned: 0, pending: 0, passed: true },
      { rep: 2, kills: [kill(2, 1, 1)], reconnects: [reconnect(500)], unassigned: 1, pending: 0, passed: true },
    ])
    assert.match(report, /\| 1 \| 1 \| 2 \| 2 \| 500 \| 590 \| 600 \| 0 \| PASS \|/)
    assert.match(report, /\| 전체 \| 2 \| 3 \| 3 \| 500 \| 590 \| 600 \| 0 \| 2\/2 \|/)
    assert.match(report, /: 충족/)
    assert.match(report, /첫 삭제 전에 끊긴 연결 1개/)
  })

  it('(a) p95가 5초를 넘거나 못 붙은 봇이 있으면 미충족', () => {
    const slow = killReport([
      { rep: 1, kills: [kill(1, 1, 1)], reconnects: [reconnect(6_000)], unassigned: 0, pending: 0, passed: true },
    ])
    assert.match(slow, /미충족/)
    const pending = killReport([
      { rep: 1, kills: [kill(1, 1, 1)], reconnects: [reconnect(100)], unassigned: 0, pending: 1, passed: true },
    ])
    assert.match(pending, /미충족/)
  })

  const run = (overrides: Partial<RestoreRun>): RestoreRun => ({
    rep: 1,
    run: 1,
    docId: 'd',
    passed: true,
    hashMatch: true,
    missingInserts: 0,
    missingDeletes: 0,
    observerSyncMs: 100,
    serverRestoreMs: 30,
    snapshot: 'found',
    entries: 0,
    resultDir: 'results/x',
    ...overrides,
  })

  it('(b) 유실 합계와 복원 출처를 셈', () => {
    const report = restoreReport([
      run({}),
      run({ run: 2, snapshot: 'found', entries: 3 }),
      run({ rep: 2, snapshot: 'none', entries: 100, serverRestoreMs: null }),
    ])
    assert.match(report, /\| 1 \| 2 \| 2\/2 \| 0 \| 0 \|.*\| 스냅샷 1 · 스냅샷\+Streams 1 \|/)
    assert.match(report, /\| 전체 \| 3 \| 3\/3 \| 0 \| 0 \|/)
    assert.match(report, /: 충족/)
    assert.match(report, /복원 줄을 못 찾은 실행 1개/)
  })

  it('(b) 하나라도 빠지면 미충족', () => {
    assert.match(restoreReport([run({ passed: false, missingInserts: 2 })]), /미충족/)
  })
})
