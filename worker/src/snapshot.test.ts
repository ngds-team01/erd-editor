import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { Snapshotter, compareStreamIds, type LogEntry, type LogStore, type Snapshot, type SnapshotStore } from './snapshot.js'

/** 메모리 Streams. ID는 "1000-0", "1000-1", … 순서로 붙는다. */
class MemoryLog implements LogStore {
  readonly entries = new Map<string, LogEntry[]>()
  private seq = 0
  failTrim = false

  add(docId: string, update: Uint8Array): string {
    const id = `1000-${this.seq++}`
    const list = this.entries.get(docId) ?? []
    list.push({ id, update })
    this.entries.set(docId, list)
    return id
  }
  async listDocs() {
    return [...this.entries.keys()]
  }
  async latestId(docId: string) {
    return this.entries.get(docId)?.at(-1)?.id ?? null
  }
  async *readAfter(docId: string, afterId: string) {
    for (const entry of this.entries.get(docId) ?? []) {
      if (afterId === '0' || compareStreamIds(entry.id, afterId) > 0) yield entry
    }
  }
  async trim(docId: string, minId: string) {
    if (this.failTrim) throw new Error('trim failed')
    const list = this.entries.get(docId) ?? []
    const kept = list.filter((entry) => compareStreamIds(entry.id, minId) >= 0)
    this.entries.set(docId, kept)
    return list.length - kept.length
  }
}

/** 메모리 S3. 올릴 때마다 etag가 바뀌고, 조건부 업로드(IfMatch·IfNoneMatch)를 흉내 낸다. */
class MemorySnapshots implements SnapshotStore {
  readonly objects = new Map<string, Snapshot>()
  reads = 0
  failRead = false
  failWrite = false
  /** true면 조건을 무시하고 항상 덮어쓴다 (조건부 업로드가 없을 때와 비교용) */
  ignoreCondition = false
  /** 설정하면 write가 이 Promise가 끝날 때까지 멈춘다 (느린 워커 흉내) */
  writeGate: Promise<void> | undefined
  private version = 0

  async read(docId: string) {
    this.reads += 1
    if (this.failRead) throw new Error('read failed')
    return this.objects.get(docId) ?? null
  }
  async write(docId: string, state: Uint8Array, lastStreamId: string, expectedEtag: string | null) {
    if (this.writeGate) await this.writeGate
    if (this.failWrite) throw new Error('write failed')
    const current = this.objects.get(docId)
    const matches = expectedEtag === null ? current === undefined : current?.etag === expectedEtag
    if (!matches && !this.ignoreCondition) return false
    this.objects.set(docId, { state, lastStreamId, etag: `"v${++this.version}"` })
    return true
  }
}

/** 같은 S3를 보지만 write만 따로 멈출 수 있는 창구 (워커마다 하나) */
function view(store: MemorySnapshots): SnapshotStore & { gate?: Promise<void> } {
  const v: SnapshotStore & { gate?: Promise<void> } = {
    read: (docId) => store.read(docId),
    write: async (docId, state, id, etag) => {
      if (v.gate) await v.gate
      return store.write(docId, state, id, etag)
    },
  }
  return v
}

/** 편집 서버 역할: 문서를 고칠 때마다 업데이트를 로그에 기록한다. */
function editor(log: MemoryLog, docId: string) {
  const doc = new Y.Doc()
  doc.on('update', (update: Uint8Array) => log.add(docId, update))
  const tables = doc.getMap<string>('tables')
  return { doc, set: (key: string, value: string) => tables.set(key, value) }
}

/** contracts 6.4 복원: 스냅샷 + (lastStreamId, +] 로그 */
async function restore(log: MemoryLog, snapshot: Snapshot | undefined, docId: string) {
  const doc = new Y.Doc()
  if (snapshot) Y.applyUpdate(doc, snapshot.state)
  for await (const entry of log.readAfter(docId, snapshot?.lastStreamId ?? '0')) Y.applyUpdate(doc, entry.update)
  return doc.getMap('tables').toJSON()
}

describe('compareStreamIds', () => {
  it('밀리초, 순번 순서로 비교한다 (문자열 비교가 아니라 숫자 비교)', () => {
    assert.equal(compareStreamIds('999-0', '1000-0'), -1)
    assert.equal(compareStreamIds('1000-10', '1000-9'), 1)
    assert.equal(compareStreamIds('1000-1', '1000-1'), 0)
    assert.equal(compareStreamIds('1000', '1000-0'), 0)
  })
})

describe('Snapshotter', () => {
  it('첫 스냅샷은 로그 전체를 담고, 자를 기준(직전 스냅샷)이 없으니 XTRIM하지 않는다', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    const a = editor(log, 'd1')
    a.set('t1', 'users')
    a.set('t2', 'posts')
    const last = log.add('d1', Y.encodeStateAsUpdate(new Y.Doc())) // 빈 업데이트도 항목으로 친다

    const result = await new Snapshotter(log, snapshots).snapshotDoc('d1')

    assert.deepEqual(result, { status: 'saved', entries: 3, bytes: snapshots.objects.get('d1')!.state.byteLength, lastStreamId: last, trimmed: 0 })
    assert.equal(log.entries.get('d1')!.length, 3)
    assert.deepEqual(await restore(log, snapshots.objects.get('d1'), 'd1'), { t1: 'users', t2: 'posts' })
  })

  it('새 항목이 없으면 S3를 읽지도 쓰지도 않는다', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    editor(log, 'd1').set('t1', 'users')
    const worker = new Snapshotter(log, snapshots)
    await worker.snapshotDoc('d1')
    const reads = snapshots.reads

    assert.deepEqual(await worker.snapshotDoc('d1'), { status: 'unchanged' })
    assert.equal(snapshots.reads, reads)
  })

  it('두 번째 스냅샷부터 직전 lastStreamId 기준으로 자른다 (한 세대 늦게)', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    const a = editor(log, 'd1')
    const worker = new Snapshotter(log, snapshots)

    a.set('t1', 'users')
    a.set('t2', 'posts')
    await worker.snapshotDoc('d1')
    const first = snapshots.objects.get('d1')!

    a.set('t3', 'tags')
    const second = await worker.snapshotDoc('d1')

    assert.equal(second.status, 'saved')
    assert.equal(second.status === 'saved' && second.entries, 1) // 새 항목만 읽는다
    assert.equal(second.status === 'saved' && second.trimmed, 1) // 첫 스냅샷 lastStreamId보다 앞(1000-0)만 지움
    // 첫 스냅샷 lastStreamId 항목과 그 뒤는 남아 있다
    assert.deepEqual(log.entries.get('d1')!.map((e) => e.id), [first.lastStreamId, second.status === 'saved' && second.lastStreamId])
    assert.deepEqual(await restore(log, snapshots.objects.get('d1'), 'd1'), { t1: 'users', t2: 'posts', t3: 'tags' })
  })

  it('옛 스냅샷을 읽은 파드도 자른 뒤의 로그로 끝까지 복원할 수 있다', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    const a = editor(log, 'd1')
    const worker = new Snapshotter(log, snapshots)

    a.set('t1', 'users')
    await worker.snapshotDoc('d1')
    a.set('t2', 'posts')
    await worker.snapshotDoc('d1')
    // 파드가 2세대 스냅샷을 읽은 직후 워커가 3세대를 올리고 로그를 자른다
    const readByPod = snapshots.objects.get('d1')!
    a.set('t3', 'tags')
    await worker.snapshotDoc('d1')

    assert.deepEqual(await restore(log, readByPod, 'd1'), { t1: 'users', t2: 'posts', t3: 'tags' })
  })

  it('업로드에 실패하면 로그를 자르지 않고, 다음 주기에 다시 시도한다', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    const a = editor(log, 'd1')
    const worker = new Snapshotter(log, snapshots)
    a.set('t1', 'users')
    await worker.snapshotDoc('d1')
    a.set('t2', 'posts')

    snapshots.failWrite = true
    await assert.rejects(worker.snapshotDoc('d1'), /write failed/)
    assert.equal(log.entries.get('d1')!.length, 2)

    snapshots.failWrite = false
    const retry = await worker.snapshotDoc('d1')
    assert.equal(retry.status, 'saved')
    assert.deepEqual(await restore(log, snapshots.objects.get('d1'), 'd1'), { t1: 'users', t2: 'posts' })
  })

  it('기존 스냅샷을 못 읽으면 로그만으로 덮어쓰지 않는다', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    const a = editor(log, 'd1')
    const worker = new Snapshotter(log, snapshots)
    a.set('t1', 'users')
    await worker.snapshotDoc('d1')
    a.set('t2', 'posts')
    await worker.snapshotDoc('d1') // 1000-0이 잘린 상태
    a.set('t3', 'tags')
    const before = snapshots.objects.get('d1')

    snapshots.failRead = true
    await assert.rejects(worker.snapshotDoc('d1'), /read failed/)
    assert.equal(snapshots.objects.get('d1'), before)
  })

  it('XTRIM이 실패해도 스냅샷은 저장된 것으로 치고, 다음 스냅샷 때 더 뒤 기준으로 자른다', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    const errors: string[] = []
    const a = editor(log, 'd1')
    const worker = new Snapshotter(log, snapshots, (docId) => errors.push(docId))
    a.set('t1', 'users')
    await worker.snapshotDoc('d1')
    a.set('t2', 'posts')

    log.failTrim = true
    const saved = await worker.snapshotDoc('d1')
    assert.equal(saved.status, 'saved')
    assert.deepEqual(errors, ['d1'])

    log.failTrim = false
    a.set('t3', 'tags')
    const next = await worker.snapshotDoc('d1')
    assert.equal(next.status === 'saved' && next.trimmed, 1) // 둘째 스냅샷 lastStreamId 앞(1000-0)을 지움
    assert.deepEqual(await restore(log, snapshots.objects.get('d1'), 'd1'), { t1: 'users', t2: 'posts', t3: 'tags' })
  })

  it('워커가 재시작해도 S3 메타데이터의 lastStreamId부터 이어서 만든다', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    const a = editor(log, 'd1')
    a.set('t1', 'users')
    await new Snapshotter(log, snapshots).snapshotDoc('d1')

    const restarted = new Snapshotter(log, snapshots)
    assert.deepEqual(await restarted.snapshotDoc('d1'), { status: 'unchanged' })
    a.set('t2', 'posts')
    const result = await restarted.snapshotDoc('d1')
    assert.equal(result.status === 'saved' && result.entries, 1)
    assert.equal(result.status === 'saved' && result.trimmed, 0) // 첫 스냅샷 기준 앞에 지울 항목이 없다
    assert.deepEqual(await restore(log, snapshots.objects.get('d1'), 'd1'), { t1: 'users', t2: 'posts' })
  })

  it('워커가 2개 돌아도, 늦은 워커는 옛 스냅샷 기준으로 덮어쓰지 않는다 (조건부 업로드)', async () => {
    const run = async (ignoreCondition: boolean) => {
      const log = new MemoryLog()
      const store = new MemorySnapshots()
      store.ignoreCondition = ignoreCondition
      const a = editor(log, 'd1')
      const slowView = view(store)
      const slow = new Snapshotter(log, slowView)
      const fast = new Snapshotter(log, view(store))

      a.set('t1', 'users')
      await fast.snapshotDoc('d1') // 1세대
      a.set('t2', 'posts')
      // 느린 워커: 1세대를 읽고 업로드 직전에 멈춤
      let release!: () => void
      slowView.gate = new Promise((resolve) => (release = resolve))
      const slowRun = slow.snapshotDoc('d1')
      await new Promise((resolve) => setTimeout(resolve, 10))
      // 그사이 빠른 워커가 2·3·4세대를 올리며 로그를 자른다 (한 세대 늦게 자르므로 t3 기록은 4세대 때 잘림)
      a.set('t3', 'tags')
      await fast.snapshotDoc('d1')
      a.set('t4', 'likes')
      await fast.snapshotDoc('d1')
      a.set('t5', 'follows')
      await fast.snapshotDoc('d1')
      release()
      const slowResult = await slowRun
      return { slowResult, restored: await restore(log, store.objects.get('d1'), 'd1') }
    }

    const all = { t1: 'users', t2: 'posts', t3: 'tags', t4: 'likes', t5: 'follows' }

    // 조건 없이 덮어쓰면: 느린 워커의 옛 스냅샷(t1·t2까지) 뒤 구간(t3)이 이미 잘려서 사라진다 (리뷰에서 지적한 경우).
    // t3가 빠지면 같은 사용자의 뒤 기록(t4·t5)도 Yjs가 대기 상태로만 들고 있어 함께 안 보인다.
    const unsafe = await run(true)
    assert.equal(unsafe.slowResult.status, 'saved')
    assert.deepEqual(unsafe.restored, { t1: 'users', t2: 'posts' })

    // 조건부 업로드면: 느린 워커는 올리지 않고(conflict), 편집은 하나도 사라지지 않는다
    const safe = await run(false)
    assert.deepEqual(safe.slowResult, { status: 'conflict' })
    assert.deepEqual(safe.restored, all)
  })

  it('conflict가 난 문서는 다음 주기에 새 스냅샷을 읽어 이어서 한다', async () => {
    const log = new MemoryLog()
    const store = new MemorySnapshots()
    const a = editor(log, 'd1')
    const worker = new Snapshotter(log, store)
    a.set('t1', 'users')
    await worker.snapshotDoc('d1')
    a.set('t2', 'posts')
    // 다른 워커가 먼저 바꾼 것처럼 etag만 바꿔 둔다
    const current = store.objects.get('d1')!
    store.objects.set('d1', { ...current, etag: '"other"' })

    // 이 워커는 아직 옛 etag를 모르니 이번엔 읽은 걸로 올린다. 대신 미리 읽은 etag로 경합을 만든다
    const racing = new Snapshotter(log, {
      read: async (docId) => ({ ...(await store.read(docId))!, etag: '"stale"' }),
      write: (docId, state, id, etag) => store.write(docId, state, id, etag),
    })
    assert.deepEqual(await racing.snapshotDoc('d1'), { status: 'conflict' })

    const next = await worker.snapshotDoc('d1')
    assert.equal(next.status, 'saved')
    assert.deepEqual(await restore(log, store.objects.get('d1'), 'd1'), { t1: 'users', t2: 'posts' })
  })

  it('한 주기에서 한 문서가 실패해도 나머지 문서는 처리한다', async () => {
    const log = new MemoryLog()
    const snapshots = new MemorySnapshots()
    editor(log, 'd1').set('t1', 'users')
    editor(log, 'd2').set('t1', 'orders')
    const broken = new Snapshotter(log, {
      read: async (docId) => {
        if (docId === 'd1') throw new Error('read failed')
        return snapshots.read(docId)
      },
      write: (docId, state, id, etag) => snapshots.write(docId, state, id, etag),
    })

    const result = await broken.runCycle()
    assert.deepEqual(result, { docs: 2, saved: 1, conflicts: 0, failed: 1, entries: 1, trimmed: 0 })
    assert.ok(snapshots.objects.has('d2'))
  })
})
