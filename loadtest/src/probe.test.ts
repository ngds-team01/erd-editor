// 서버 없이 Y.Doc 두 개로 지연 측정(probe)과 백분위 계산을 확인
// 실행: npm test
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { randomEdit } from './actions'
import { getTables } from './model'
import {
  createProbeLog,
  ensureProbeTable,
  isProbeTable,
  readAwarenessSeq,
  readProbeSeq,
  startAwarenessSender,
  startUpdateSender,
  watchAwareness,
  watchUpdates,
} from './probe'
import { createRandom } from './random'
import { percentile, summarize } from './stats'

// 보내는 문서의 변경을 받는 문서에 바로 전달 = 지연 없는 서버
function relay(from: Y.Doc, to: Y.Doc): void {
  from.on('update', (update: Uint8Array) => Y.applyUpdate(to, update))
}

describe('ProbeLog', () => {
  it('같은 순번은 한 번만 세고, 보내지 않은 순번은 무시하고, 못 받은 순번을 셈', () => {
    const log = createProbeLog('update')
    log.markSent(1, 100)
    log.markSent(2, 200)
    log.markSent(3, 300)
    log.markReceived(1, 110)
    log.markReceived(1, 150)
    log.markReceived(2, 230)
    log.markReceived(9, 999)

    assert.deepEqual(
      log.samples().map((sample) => [sample.seq, sample.latencyMs]),
      [
        [1, 10],
        [2, 30],
      ],
    )
    assert.equal(log.sentCount(), 3)
    assert.equal(log.missingCount(), 1)
  })
})

describe('update 경로 측정', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }))
  afterEach(() => mock.timers.reset())

  it('보낸 순번을 받는 문서에서 읽어 지연을 기록', () => {
    const sender = new Y.Doc()
    const receiver = new Y.Doc()
    relay(sender, receiver)
    const log = createProbeLog('update')
    // 가짜 시계: 보낼 때마다 1000씩, 받을 때는 보낸 시각 + 5
    let clock = 0
    const tableId = ensureProbeTable(sender)
    const stopWatching = watchUpdates(receiver, tableId, log, () => clock + 5)
    const stopSending = startUpdateSender(sender, tableId, log, 200, () => (clock += 1000))

    mock.timers.tick(200 * 3)
    stopSending()
    stopWatching()

    assert.equal(readProbeSeq(receiver, tableId), 3)
    assert.deepEqual(
      log.samples().map((sample) => [sample.seq, sample.latencyMs]),
      [
        [1, 5],
        [2, 5],
        [3, 5],
      ],
    )
    assert.equal(log.missingCount(), 0)
  })

  it('이미 측정용 테이블이 있으면 새로 만들지 않음', () => {
    const doc = new Y.Doc()
    const first = ensureProbeTable(doc)
    assert.equal(ensureProbeTable(doc), first)
    assert.equal([...getTables(doc).values()].filter(isProbeTable).length, 1)
  })
})

describe('awareness 경로 측정', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }))
  afterEach(() => mock.timers.reset())

  it('보내는 쪽 상태의 probe.seq를 받는 쪽에서 읽어 지연을 기록, user 필드는 그대로', () => {
    const sender = new Awareness(new Y.Doc())
    const receiver = new Awareness(new Y.Doc())
    sender.setLocalState({ user: { id: 'u1', name: '봇', color: '#0d74ce' }, editing: null, cursor: null })
    // 보내는 쪽 상태가 바뀔 때마다 받는 쪽에 바로 전달 = 지연 없는 서버
    sender.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      applyAwarenessUpdate(receiver, encodeAwarenessUpdate(sender, [...added, ...updated, ...removed]), 'server')
    })
    const log = createProbeLog('awareness')
    let clock = 0
    const stopWatching = watchAwareness(receiver, sender.clientID, log, () => clock + 3)
    const stopSending = startAwarenessSender(sender, log, 200, () => (clock += 1000))

    mock.timers.tick(200 * 3)
    stopSending()
    stopWatching()

    assert.deepEqual(
      log.samples().map((sample) => [sample.seq, sample.latencyMs]),
      [
        [1, 3],
        [2, 3],
        [3, 3],
      ],
    )
    assert.equal(log.missingCount(), 0)
    // probe 필드만 더하고 사용자 정보는 지우지 않음
    assert.equal(receiver.getStates().get(sender.clientID)?.user?.name, '봇')
    sender.destroy()
    receiver.destroy()
  })

  it('형식이 틀린 probe 필드는 무시', () => {
    assert.equal(readAwarenessSeq({ probe: { seq: 7 } }), 7)
    assert.equal(readAwarenessSeq({ probe: { seq: '7' } }), null)
    assert.equal(readAwarenessSeq({ probe: null }), null)
    assert.equal(readAwarenessSeq({ user: {} }), null)
    assert.equal(readAwarenessSeq(null), null)
  })
})

describe('측정용 테이블 제외', () => {
  it('무작위 편집이 측정용 테이블을 바꾸거나 지우지 않음', async () => {
    const doc = new Y.Doc()
    const tableId = ensureProbeTable(doc)
    const before = JSON.stringify(getTables(doc).get(tableId)?.toJSON())
    const random = createRandom(3)

    for (let step = 0; step < 1000; step += 1) {
      const { editing } = await randomEdit(doc, random)
      assert.ok(editing === null || !('tableId' in editing) || editing.tableId !== tableId)
    }
    assert.equal(JSON.stringify(getTables(doc).get(tableId)?.toJSON()), before)
    // 측정용 테이블이 있어도 다른 테이블을 만들어 편집을 이어 감
    assert.ok(getTables(doc).size > 1)
  })
})

describe('percentile', () => {
  it('스프레드시트 PERCENTILE과 같은 선형 보간', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    // PERCENTILE({1..10}, 0.95) = 9.55, 0.5 = 5.5
    assert.equal(percentile(values, 0.5), 5.5)
    assert.ok(Math.abs(percentile(values, 0.95) - 9.55) < 1e-9)
    assert.equal(percentile([7], 0.99), 7)
    assert.ok(Number.isNaN(percentile([], 0.5)))
  })

  it('summarize는 정렬하지 않은 값도 받음', () => {
    const summary = summarize([30, 10, 20])
    assert.deepEqual([summary.count, summary.p50, summary.max], [3, 20, 30])
  })
})
