// 결과 파일(settings.json, samples.csv, reconnects.csv, restore.csv, docs.csv, summary.csv) 형식 확인, 임시 폴더에 저장해 봄
// 실행: npm test
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createProbeLog } from './probe'
import { createRandom } from './random'
import { docsCsv, reconnectsCsv, restoreCsv, samplesCsv, saveRun, summaryCsv, timestampForDir, toCsv } from './results'
import type { DocRecord, RestoreRecord, RunRecord } from './results'
import { percentile } from './stats'

// 문서 하나의 기록, 기본값은 PASS한 문서
function doc(overrides: Partial<DocRecord> = {}): DocRecord {
  return {
    docId: 'doc-1',
    bots: 2,
    converged: true,
    convergeMs: 120.4,
    hashGroups: 1,
    passed: true,
    actions: 20,
    updatesSent: 80,
    disconnects: 0,
    logs: [],
    reconnects: [],
    reconnectPending: 0,
    restore: null,
    ...overrides,
  }
}

// 실행 기록, 기본값은 문서 하나
function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    name: 'test',
    argv: ['--bots', '2'],
    options: { bots: 2, rate: 2, durationSec: 5, seed: 42 },
    startedAt: new Date(2026, 10, 23, 19, 5, 2),
    finishedAt: new Date(2026, 10, 23, 19, 5, 40),
    load: [],
    eventLoop: { utilization: 0.05, lagP50Ms: 0.1, lagP99Ms: 0.5, lagMaxMs: 2 },
    scenario: 'converge',
    docs: [doc()],
    ...overrides,
  }
}

// 문서 하나짜리 실행에서 그 문서의 기록만 바꿈
function oneDoc(overrides: Partial<DocRecord>, run: Partial<RunRecord> = {}): RunRecord {
  return record({ ...run, docs: [doc(overrides)] })
}

// 한 줄을 쉼표로 나눔 (테스트 값에는 따옴표가 없음)
function parseCsv(text: string): string[][] {
  return text.trimEnd().split('\n').map((line) => line.split(','))
}

// summary.csv(한 줄)에서 열 이름으로 값 찾기
function column(rows: string[][], name: string): string {
  return rows[1][rows[0].indexOf(name)]
}

describe('toCsv', () => {
  it('쉼표·따옴표가 든 값은 따옴표로 감싸고, null·NaN은 빈칸', () => {
    assert.equal(toCsv(['a', 'b', 'c', 'd'], [['x,y', 'say "hi"', null, Number.NaN]]), 'a,b,c,d\n"x,y","say ""hi""",,\n')
  })
})

describe('timestampForDir', () => {
  it('날짜-시각을 두 자리로 맞춤', () => {
    assert.equal(timestampForDir(new Date(2026, 0, 3, 4, 5, 6)), '20260103-040506')
  })
})

describe('summaryCsv', () => {
  it('측정을 켠 실행과 끈 실행의 열 순서가 같음 (여러 실행을 이어 붙일 수 있음)', () => {
    const update = createProbeLog('update')
    update.markSent(1, 0)
    update.markReceived(1, 4)
    const withProbe = parseCsv(summaryCsv(oneDoc({ logs: [update, createProbeLog('awareness')] })))
    const withoutProbe = parseCsv(summaryCsv(record()))

    assert.deepEqual(withProbe[0], withoutProbe[0])
    assert.equal(column(withProbe, 'update_p95_ms'), '4')
    assert.equal(column(withProbe, 'update_missing'), '0')
    // 보낸 것이 없는 경로는 0개, 백분위는 빈칸
    assert.equal(column(withProbe, 'awareness_received'), '0')
    assert.equal(column(withProbe, 'awareness_p95_ms'), '')
    // 측정을 끈 실행은 측정 칸이 모두 빈칸
    assert.equal(column(withoutProbe, 'update_sent'), '')
    assert.equal(column(withoutProbe, 'passed'), 'true')
    assert.equal(column(withoutProbe, 'seed'), '42')
    assert.equal(column(withoutProbe, 'converge_ms'), '120')
  })
})

describe('summaryCsv 백분위', () => {
  it('samples.csv의 latency_ms로 다시 계산한 p50·p95·p99가 summary.csv와 소수점까지 같음', () => {
    // 반올림 차이는 값에 따라 가끔만 생기므로, 실제 실행처럼 소수점 아래가 긴 지연을 여러 묶음 만들어 모두 확인
    // (시드 난수라 매번 같은 값, 반올림 전 값으로 계산하던 코드는 이 중 일부에서 0.001 차이가 남)
    for (let seed = 1; seed <= 20; seed += 1) {
      const log = createProbeLog('update')
      const random = createRandom(seed)
      for (let seq = 1; seq <= 200; seq += 1) {
        log.markSent(seq, 1000)
        log.markReceived(seq, 1000 + random.next() * 100)
      }
      const run = oneDoc({ logs: [log] })
      // 스프레드시트에서 하듯 samples.csv의 latency_ms 열만 가져와 다시 계산
      const latencies = parseCsv(samplesCsv(run.docs))
        .slice(1)
        .map((row) => Number(row[4]))
        .sort((a, b) => a - b)
      const rows = parseCsv(summaryCsv(run))
      for (const [p, name] of [
        [0.5, 'p50'],
        [0.95, 'p95'],
        [0.99, 'p99'],
      ] as const) {
        const recomputed = Math.round(percentile(latencies, p) * 1000) / 1000
        assert.equal(Number(column(rows, `update_${name}_ms`)), recomputed, `seed ${seed} ${name}`)
      }
    }
  })
})

describe('summaryCsv 부하 열', () => {
  it('부하 프로세스 합계를 더하고, 바쁜 시간은 가장 바빴던 프로세스 값을 남김', () => {
    const loop = (utilization: number, lagMaxMs: number) => ({ utilization, lagP50Ms: 0, lagP99Ms: 0, lagMaxMs })
    const stat = (bots: number, editCount: number, utilization: number, lagMaxMs: number) => ({
      bots,
      actions: { drag: editCount },
      updatesSent: editCount * 3,
      messagesReceived: 1000,
      bytesReceived: 100_000,
      disconnects: 0,
      eventLoop: loop(utilization, lagMaxMs),
    })
    const rows = parseCsv(summaryCsv(record({ load: [stat(31, 100, 0.2, 15), stat(31, 120, 0.35, 40)] })))

    assert.equal(column(rows, 'load_bots'), '62')
    assert.equal(column(rows, 'load_processes'), '2')
    assert.equal(column(rows, 'load_actions'), '220')
    assert.equal(column(rows, 'load_updates_sent'), '660')
    assert.equal(column(rows, 'load_event_loop_utilization_max'), '0.35')
    assert.equal(column(rows, 'load_event_loop_lag_max_ms'), '40')

    // 부하 봇이 없으면 개수는 0, 바쁜 시간은 빈칸 (열 순서는 같음)
    const empty = parseCsv(summaryCsv(record()))
    assert.deepEqual(empty[0], rows[0])
    assert.equal(column(empty, 'load_bots'), '0')
    assert.equal(column(empty, 'load_event_loop_utilization_max'), '')
  })
})

describe('재접속 기록', () => {
  const sample = (bot: number, disconnectedAt: number, durationMs: number) => ({
    bot,
    closeCode: 1006,
    disconnectedAt,
    syncedAt: disconnectedAt + durationMs,
    durationMs,
    failedAttempts: 0,
  })

  it('reconnects.csv는 여러 문서의 기록을 끊긴 시각 순으로 한 줄씩, 맨 뒤에 문서', () => {
    const docs = [
      doc({ docId: 'a', reconnects: [sample(3, 2000, 700.25)] }),
      doc({ docId: 'b', reconnects: [sample(1, 1000, 1200)] }),
    ]
    assert.deepEqual(parseCsv(reconnectsCsv(docs)), [
      ['bot', 'close_code', 'disconnected_at_ms', 'synced_at_ms', 'duration_ms', 'failed_attempts', 'doc'],
      ['1', '1006', '1000', '2200', '1200', '0', 'b'],
      ['3', '1006', '2000', '2700.25', '700.25', '0', 'a'],
    ])
  })

  it('summary.csv에 재접속 열, 끊김이 없으면 개수 0·백분위 빈칸', () => {
    const rows = parseCsv(summaryCsv(oneDoc({ reconnects: [sample(1, 0, 1000), sample(2, 0, 3000)], reconnectPending: 1 })))
    const empty = parseCsv(summaryCsv(record()))
    assert.deepEqual(rows[0], empty[0])
    // 재접속 열 다섯 칸 (그 뒤에 복원 열이 이어짐)
    const at = rows[0].indexOf('reconnects')
    const pick = (row: string[]) => row.slice(at, at + 5)
    assert.deepEqual(pick(rows[0]), ['reconnects', 'reconnect_pending', 'reconnect_p50_ms', 'reconnect_p95_ms', 'reconnect_max_ms'])
    assert.deepEqual(pick(rows[1]), ['2', '1', '2000', '2900', '3000'])
    assert.deepEqual(pick(empty[1]), ['0', '0', '', '', ''])
  })
})

describe('복원 기록', () => {
  // 클라이언트 11(봇 2)의 추가 3개와 클라이언트 99(부하 봇)의 삭제 1개가 빠진 복원
  const restore: RestoreRecord = {
    waitMs: 1500.4,
    observerSyncMs: 812.3456,
    hashMatch: false,
    loss: {
      missingInserts: 3,
      missingDeletes: 1,
      clients: [
        { client: 11, expectedClock: 20, restoredClock: 17, expectedDeleted: 2, restoredDeleted: 2 },
        { client: 99, expectedClock: 5, restoredClock: 5, expectedDeleted: 1, restoredDeleted: 0 },
      ],
    },
    botByClient: new Map([[11, 2]]),
  }
  const restoreColumns = [
    'scenario',
    'restore_wait_ms',
    'restore_sync_ms',
    'restore_hash_match',
    'restore_missing_inserts',
    'restore_missing_deletes',
    'restore_missing_clients',
  ]
  // 복원 열 일곱 칸 (그 뒤에 문서 열이 이어짐)
  const pickRestore = (rows: string[][], row: number) => {
    const at = rows[0].indexOf('scenario')
    return rows[row].slice(at, at + restoreColumns.length)
  }

  it('restore.csv는 빠진 클라이언트마다 한 줄, 이 프로세스의 봇이 아니면 bot 빈칸', () => {
    assert.deepEqual(parseCsv(restoreCsv([doc({ restore })])), [
      ['client', 'bot', 'expected_clock', 'restored_clock', 'expected_deleted', 'restored_deleted', 'doc'],
      ['11', '2', '20', '17', '2', '2', 'doc-1'],
      ['99', '', '5', '5', '1', '0', 'doc-1'],
    ])
  })

  it('summary.csv에 복원 열, converge 실행은 빈칸 (열 순서는 같음)', () => {
    const rows = parseCsv(summaryCsv(oneDoc({ restore }, { scenario: 'restore' })))
    const converge = parseCsv(summaryCsv(record()))
    assert.deepEqual(rows[0], converge[0])
    assert.deepEqual(pickRestore(rows, 0), restoreColumns)
    assert.deepEqual(pickRestore(rows, 1), ['restore', '1500', '812.346', 'false', '3', '1', '2'])
    assert.deepEqual(pickRestore(converge, 1), ['converge', '', '', '', '', '', ''])
  })

  it('여러 문서면 빠진 수는 더하고, 시간은 가장 늦은 문서, 해시는 모두 같을 때만 true', () => {
    const clean: RestoreRecord = {
      ...restore,
      observerSyncMs: 2000,
      hashMatch: true,
      loss: { missingInserts: 0, missingDeletes: 0, clients: [] },
    }
    const rows = parseCsv(
      summaryCsv(record({ scenario: 'restore', docs: [doc({ docId: 'a', restore }), doc({ docId: 'b', restore: clean })] })),
    )
    assert.deepEqual(pickRestore(rows, 1), ['restore', '1500', '2000', 'false', '3', '1', '2'])
  })

  it('restore 실행만 restore.csv를 만듦', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'loadtest-results-'))
    try {
      const dir = saveRun(oneDoc({ restore }, { scenario: 'restore' }), root)
      assert.ok(readdirSync(dir).includes('restore.csv'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('여러 문서', () => {
  // 문서 a: PASS, 문서 b: 해시 2종류로 FAIL
  const latencyLog = (latencies: number[]) => {
    const log = createProbeLog('update')
    latencies.forEach((latency, index) => {
      log.markSent(index + 1, 0)
      log.markReceived(index + 1, latency)
    })
    return log
  }
  const docs = [
    doc({ docId: 'a', convergeMs: 500, actions: 10, logs: [latencyLog([1, 2])] }),
    doc({ docId: 'b', convergeMs: 3000, actions: 30, hashGroups: 2, passed: false, logs: [latencyLog([3, 4])] }),
  ]

  it('summary.csv: 하나라도 FAIL이면 FAIL, 편집 수는 더하고 수렴 시간·해시 묶음은 가장 큰 값, 지연은 표본을 모아 계산', () => {
    const rows = parseCsv(summaryCsv(record({ docs })))
    assert.equal(column(rows, 'passed'), 'false')
    assert.equal(column(rows, 'actions'), '40')
    assert.equal(column(rows, 'converge_ms'), '3000')
    assert.equal(column(rows, 'hash_groups'), '2')
    assert.equal(column(rows, 'update_sent'), '4')
    assert.equal(column(rows, 'update_received'), '4')
    // 표본 1, 2, 3, 4의 p50
    assert.equal(column(rows, 'update_p50_ms'), '2.5')
    assert.deepEqual(rows[0].slice(-2), ['docs', 'docs_passed'])
    assert.deepEqual(rows[1].slice(-2), ['2', '1'])
    // 문서가 하나인 실행과 열 순서가 같음
    assert.deepEqual(rows[0], parseCsv(summaryCsv(record()))[0])
  })

  it('docs.csv: 문서마다 한 줄', () => {
    const rows = parseCsv(docsCsv(docs))
    assert.equal(rows.length, 3)
    const value = (row: number, name: string) => rows[row][rows[0].indexOf(name)]
    assert.equal(value(1, 'doc'), 'a')
    assert.equal(value(1, 'passed'), 'true')
    assert.equal(value(1, 'update_p95_ms'), '1.95')
    assert.equal(value(2, 'doc'), 'b')
    assert.equal(value(2, 'passed'), 'false')
    assert.equal(value(2, 'hash_groups'), '2')
    // 측정을 끈 경로와 restore가 아닌 실행은 빈칸
    assert.equal(value(1, 'awareness_p95_ms'), '')
    assert.equal(value(1, 'restore_hash_match'), '')
  })

  it('samples.csv: 맨 뒤 doc 열에 문서', () => {
    const rows = parseCsv(samplesCsv(docs))
    assert.deepEqual(
      rows.slice(1).map((row) => row[row.length - 1]),
      ['a', 'a', 'b', 'b'],
    )
  })
})

describe('saveRun', () => {
  it('폴더에 다섯 파일을 만들고, 같은 이름으로 다시 저장하면 덮어쓰지 않고 -2를 붙임', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'loadtest-results-'))
    try {
      const update = createProbeLog('update')
      update.markSent(1, 1000.5)
      update.markReceived(1, 1003.25)
      const first = saveRun(oneDoc({ logs: [update] }), root)
      const second = saveRun(record(), root)

      assert.equal(path.basename(first), '20261123-190502-test')
      assert.equal(path.basename(second), '20261123-190502-test-2')
      assert.deepEqual(readdirSync(first).sort(), [
        'docs.csv',
        'reconnects.csv',
        'samples.csv',
        'settings.json',
        'summary.csv',
      ])

      const settings = JSON.parse(readFileSync(path.join(first, 'settings.json'), 'utf8'))
      assert.equal(settings.options.seed, 42)
      assert.deepEqual(settings.argv, ['--bots', '2'])
      // 이 테스트는 git 저장소 안에서 돌므로 커밋 SHA(40자)가 남음
      assert.match(settings.git.commit, /^[0-9a-f]{40}$/)

      assert.deepEqual(parseCsv(readFileSync(path.join(first, 'samples.csv'), 'utf8')), [
        ['path', 'seq', 'sent_at_ms', 'received_at_ms', 'latency_ms', 'doc'],
        ['update', '1', '1000.5', '1003.25', '2.75', 'doc-1'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
