// 결과 파일(settings.json, samples.csv, summary.csv) 형식 확인, 임시 폴더에 저장해 봄
// 실행: npm test
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createProbeLog } from './probe'
import { createRandom } from './random'
import { samplesCsv, saveRun, summaryCsv, timestampForDir, toCsv } from './results'
import type { RunRecord } from './results'
import { percentile } from './stats'

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    name: 'test',
    argv: ['--bots', '2'],
    options: { bots: 2, rate: 2, durationSec: 5, seed: 42 },
    startedAt: new Date(2026, 10, 23, 19, 5, 2),
    finishedAt: new Date(2026, 10, 23, 19, 5, 40),
    passed: true,
    convergeMs: 120.4,
    hashGroups: 1,
    actions: 20,
    updatesSent: 80,
    disconnects: 0,
    load: [],
    eventLoop: { utilization: 0.05, lagP50Ms: 0.1, lagP99Ms: 0.5, lagMaxMs: 2 },
    logs: [],
    ...overrides,
  }
}

// 한 줄을 쉼표로 나눔 (테스트 값에는 따옴표가 없음)
function parseCsv(text: string): string[][] {
  return text.trimEnd().split('\n').map((line) => line.split(','))
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
    const withProbe = parseCsv(summaryCsv(record({ logs: [update, createProbeLog('awareness')] })))
    const withoutProbe = parseCsv(summaryCsv(record()))

    assert.deepEqual(withProbe[0], withoutProbe[0])
    const column = (rows: string[][], name: string) => rows[1][rows[0].indexOf(name)]
    assert.equal(column(withProbe, 'update_p95_ms'), '4')
    assert.equal(column(withProbe, 'update_missing'), '0')
    // 보낸 것이 없는 경로는 0개, 백분위는 빈칸
    assert.equal(column(withProbe, 'awareness_received'), '0')
    assert.equal(column(withProbe, 'awareness_p95_ms'), '')
    // 측정을 끈 실행은 측정 칸이 모두 빈칸
    assert.equal(column(withoutProbe, 'update_sent'), '')
    assert.equal(column(withoutProbe, 'passed'), 'true')
    assert.equal(column(withoutProbe, 'seed'), '42')
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
      // 스프레드시트에서 하듯 samples.csv의 latency_ms 열만 가져와 다시 계산
      const latencies = parseCsv(samplesCsv(log.samples()))
        .slice(1)
        .map((row) => Number(row[4]))
        .sort((a, b) => a - b)
      const rows = parseCsv(summaryCsv(record({ logs: [log] })))
      for (const [p, name] of [
        [0.5, 'p50'],
        [0.95, 'p95'],
        [0.99, 'p99'],
      ] as const) {
        const recomputed = Math.round(percentile(latencies, p) * 1000) / 1000
        assert.equal(Number(rows[1][rows[0].indexOf(`update_${name}_ms`)]), recomputed, `seed ${seed} ${name}`)
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
    const column = (name: string) => rows[1][rows[0].indexOf(name)]

    assert.equal(column('load_bots'), '62')
    assert.equal(column('load_processes'), '2')
    assert.equal(column('load_actions'), '220')
    assert.equal(column('load_updates_sent'), '660')
    assert.equal(column('load_event_loop_utilization_max'), '0.35')
    assert.equal(column('load_event_loop_lag_max_ms'), '40')

    // 부하 봇이 없으면 개수는 0, 바쁜 시간은 빈칸 (열 순서는 같음)
    const empty = parseCsv(summaryCsv(record()))
    assert.deepEqual(empty[0], rows[0])
    assert.equal(empty[1][empty[0].indexOf('load_bots')], '0')
    assert.equal(empty[1][empty[0].indexOf('load_event_loop_utilization_max')], '')
  })
})

describe('saveRun', () => {
  it('폴더에 세 파일을 만들고, 같은 이름으로 다시 저장하면 덮어쓰지 않고 -2를 붙임', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'loadtest-results-'))
    try {
      const update = createProbeLog('update')
      update.markSent(1, 1000.5)
      update.markReceived(1, 1003.25)
      const first = saveRun(record({ logs: [update] }), root)
      const second = saveRun(record(), root)

      assert.equal(path.basename(first), '20261123-190502-test')
      assert.equal(path.basename(second), '20261123-190502-test-2')
      assert.deepEqual(readdirSync(first).sort(), ['samples.csv', 'settings.json', 'summary.csv'])

      const settings = JSON.parse(readFileSync(path.join(first, 'settings.json'), 'utf8'))
      assert.equal(settings.options.seed, 42)
      assert.deepEqual(settings.argv, ['--bots', '2'])
      // 이 테스트는 git 저장소 안에서 돌므로 커밋 SHA(40자)가 남음
      assert.match(settings.git.commit, /^[0-9a-f]{40}$/)

      assert.deepEqual(parseCsv(readFileSync(path.join(first, 'samples.csv'), 'utf8')), [
        ['path', 'seq', 'sent_at_ms', 'received_at_ms', 'latency_ms'],
        ['update', '1', '1000.5', '1003.25', '2.75'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
