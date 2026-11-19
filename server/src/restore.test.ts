import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { loadDocState, type LogReader, type Snapshot, type SnapshotReader } from './restore.js'

type Entry = { id: string; update: Uint8Array }

/** 편집할 때마다 업데이트를 모으는 문서 (편집 서버가 Streams에 기록하는 것을 흉내) */
function editor() {
  const doc = new Y.Doc()
  const updates: Uint8Array[] = []
  doc.on('update', (update: Uint8Array) => updates.push(update))
  const tables = doc.getMap<string>('tables')
  return { doc, updates, set: (key: string, value: string) => tables.set(key, value) }
}

/** 업데이트 목록 → Streams 항목 (ID 1000-0, 1000-1, …) */
function entries(updates: Uint8Array[], from = 0): Entry[] {
  return updates.map((update, i) => ({ id: `1000-${from + i}`, update }))
}

function memoryLog(list: Entry[], failAfter?: number): LogReader & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async *readAfter(_docId, afterId) {
      calls.push(afterId)
      let read = 0
      for (const entry of list) {
        if (afterId !== '0' && Number(entry.id.split('-')[1]) <= Number(afterId.split('-')[1])) continue
        if (failAfter !== undefined && read === failAfter) throw new Error('redis down')
        read += 1
        yield entry
      }
    },
  }
}

function snapshots(snapshot: Snapshot | null | Error): SnapshotReader {
  return {
    async read() {
      if (snapshot instanceof Error) throw snapshot
      return snapshot
    },
  }
}

function snapshotOf(updates: Uint8Array[], lastStreamId: string): Snapshot {
  const doc = new Y.Doc()
  for (const update of updates) Y.applyUpdate(doc, update)
  return { state: Y.encodeStateAsUpdate(doc), lastStreamId }
}

/** 복원 결과를 문서로 풀어 tables 내용을 돌려준다 */
function tablesOf(update: Uint8Array) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  return doc.getMap('tables').toJSON()
}

describe('loadDocState (contracts 6.4)', () => {
  it('스냅샷이 없으면 빈 문서에서 Streams 기록을 처음부터 적용한다', async () => {
    const a = editor()
    a.set('t1', 'users')
    a.set('t2', 'posts')
    const log = memoryLog(entries(a.updates))

    const result = await loadDocState('d1', snapshots(null), log)

    assert.deepEqual(log.calls, ['0'])
    assert.equal(result.snapshot, 'none')
    assert.equal(result.entries, 2)
    assert.equal(result.lastStreamId, '1000-1')
    assert.equal(result.logComplete, true)
    assert.deepEqual(tablesOf(result.update), { t1: 'users', t2: 'posts' })
  })

  it('스냅샷이 있으면 lastStreamId 다음 기록부터만 읽는다', async () => {
    const a = editor()
    a.set('t1', 'users')
    a.set('t2', 'posts')
    const snapshot = snapshotOf(a.updates, '1000-1')
    a.set('t3', 'tags')
    const log = memoryLog(entries(a.updates))

    const result = await loadDocState('d1', snapshots(snapshot), log)

    assert.deepEqual(log.calls, ['1000-1'])
    assert.equal(result.snapshot, 'found')
    assert.equal(result.entries, 1)
    assert.equal(result.lastStreamId, '1000-2')
    assert.deepEqual(tablesOf(result.update), { t1: 'users', t2: 'posts', t3: 'tags' })
  })

  it('워커가 잘라 낸 앞부분 없이도 스냅샷 + 남은 기록으로 끝까지 복원한다', async () => {
    const a = editor()
    a.set('t1', 'users')
    a.set('t2', 'posts')
    const snapshot = snapshotOf(a.updates, '1000-1')
    a.set('t3', 'tags')
    // XTRIM MINID 1000-1: 1000-0이 지워진 상태
    const log = memoryLog(entries(a.updates).slice(1))

    const result = await loadDocState('d1', snapshots(snapshot), log)

    assert.deepEqual(tablesOf(result.update), { t1: 'users', t2: 'posts', t3: 'tags' })
  })

  it('스냅샷이 있고 새 기록이 없으면 스냅샷 그대로', async () => {
    const a = editor()
    a.set('t1', 'users')
    const result = await loadDocState('d1', snapshots(snapshotOf(a.updates, '1000-0')), memoryLog(entries(a.updates)))

    assert.equal(result.entries, 0)
    assert.equal(result.lastStreamId, '1000-0')
    assert.deepEqual(tablesOf(result.update), { t1: 'users' })
  })

  it('스냅샷을 못 읽으면 Streams 처음부터 읽고 실패를 알린다', async () => {
    const a = editor()
    a.set('t1', 'users')
    const log = memoryLog(entries(a.updates))

    const result = await loadDocState('d1', snapshots(new Error('minio down')), log)

    assert.deepEqual(log.calls, ['0'])
    assert.equal(result.snapshot, 'failed')
    assert.match(String(result.snapshotError), /minio down/)
    assert.deepEqual(tablesOf(result.update), { t1: 'users' })
  })

  it('Streams를 읽다 실패하면 읽은 데까지 복원하고, 이어 읽을 위치를 알려 준다', async () => {
    const a = editor()
    a.set('t1', 'users')
    a.set('t2', 'posts')
    a.set('t3', 'tags')

    const result = await loadDocState('d1', snapshots(null), memoryLog(entries(a.updates), 2))

    assert.equal(result.logComplete, false)
    assert.match(String(result.logError), /redis down/)
    assert.equal(result.entries, 2)
    assert.equal(result.lastStreamId, '1000-1')
    assert.deepEqual(tablesOf(result.update), { t1: 'users', t2: 'posts' })
  })

  it('아직 Streams에 기록하지 못한 업데이트도 같이 적용한다', async () => {
    const a = editor()
    a.set('t1', 'users')
    const logged = [...a.updates]
    a.set('t2', 'posts')
    const pending = a.updates.slice(logged.length)

    const result = await loadDocState('d1', snapshots(null), memoryLog(entries(logged)), pending)

    assert.deepEqual(tablesOf(result.update), { t1: 'users', t2: 'posts' })
  })

  it('아무것도 없으면 빈 문서', async () => {
    const result = await loadDocState('d1', snapshots(null), memoryLog([]))

    assert.equal(result.snapshot, 'none')
    assert.equal(result.entries, 0)
    assert.equal(result.lastStreamId, '0')
    assert.deepEqual(tablesOf(result.update), {})
  })
})
