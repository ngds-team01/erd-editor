// 결과 파일(settings.json, samples.csv, summary.csv) 형식 확인, 임시 폴더에 저장해 봄
// 실행: npm test
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createProbeLog } from './probe'
import { saveRun, summaryCsv, timestampForDir, toCsv } from './results'
import type { RunRecord } from './results'

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
