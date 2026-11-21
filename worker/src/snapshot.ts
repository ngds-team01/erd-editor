// 스냅샷 만들기 (docs/contracts.md 6.3).
// 문서마다: 기존 스냅샷 + 그 뒤 Streams 로그 → 새 스냅샷 업로드 → 업로드 성공 후 직전 lastStreamId 기준 XTRIM.
// Redis·S3는 LogStore·SnapshotStore로 받아서, 테스트에서는 메모리 구현을 넣는다.
import * as Y from 'yjs'

export type LogEntry = { id: string; update: Uint8Array }

export interface LogStore {
  /** doc:*:log 가 있는 문서 ID 목록 */
  listDocs(): Promise<string[]>
  /** 가장 마지막 항목 ID. 로그가 비었거나 없으면 null */
  latestId(docId: string): Promise<string | null>
  /** afterId 다음 항목부터 끝까지 (afterId가 '0'이면 처음부터) */
  readAfter(docId: string, afterId: string): AsyncIterable<LogEntry>
  /** minId보다 작은 ID를 지우고 지운 개수를 돌려준다 (XTRIM MINID) */
  trim(docId: string, minId: string): Promise<number>
}

/** etag: 읽은 스냅샷의 버전. 올릴 때 "그사이 아무도 안 바꿨을 때만" 조건에 쓴다 */
export type Snapshot = { state: Uint8Array; lastStreamId: string; etag: string }

export interface SnapshotStore {
  /** 스냅샷이 없으면 null. 그 밖의 오류는 던진다 (그 문서는 이번 주기에 건너뛴다) */
  read(docId: string): Promise<Snapshot | null>
  /**
   * expectedEtag가 지금 저장된 스냅샷의 etag와 같을 때만 올린다 (null이면 스냅샷이 아직 없을 때만).
   * 그사이 다른 워커가 바꿔서 조건이 안 맞으면 올리지 않고 false를 돌려준다.
   */
  write(docId: string, state: Uint8Array, lastStreamId: string, expectedEtag: string | null): Promise<boolean>
}

export type DocResult =
  | { status: 'unchanged' }
  | { status: 'conflict' }
  | { status: 'saved'; entries: number; bytes: number; lastStreamId: string; trimmed: number }

export type CycleResult = {
  docs: number
  saved: number
  /** 다른 워커가 먼저 스냅샷을 바꿔서 올리지 않은 문서 (다음 주기에 다시 함) */
  conflicts: number
  failed: number
  entries: number
  trimmed: number
}

/** Stream ID("밀리초-순번")를 비교한다. a가 작으면 음수. */
export function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq = '0'] = a.split('-')
  const [bMs, bSeq = '0'] = b.split('-')
  const ms = BigInt(aMs) - BigInt(bMs)
  if (ms !== 0n) return ms < 0n ? -1 : 1
  const seq = BigInt(aSeq) - BigInt(bSeq)
  return seq === 0n ? 0 : seq < 0n ? -1 : 1
}

export class Snapshotter {
  /**
   * docId → 지금 저장돼 있는 스냅샷의 lastStreamId (contracts 6.3 "워커는 문서별로 직전 lastStreamId를 기억").
   * 새 항목이 없는 문서는 S3를 읽지 않고 넘어가기 위해 쓴다.
   * 워커가 재시작해 비어 있으면 S3 메타데이터에서 다시 읽는다.
   */
  private readonly known = new Map<string, string>()

  constructor(
    private readonly log: LogStore,
    private readonly snapshots: SnapshotStore,
    private readonly onError: (docId: string, err: unknown) => void = () => {},
  ) {}

  /** 한 문서의 스냅샷을 만든다. 실패하면 던진다. */
  async snapshotDoc(docId: string): Promise<DocResult> {
    const latest = await this.log.latestId(docId)
    if (latest === null) return { status: 'unchanged' }
    const known = this.known.get(docId)
    if (known !== undefined && compareStreamIds(latest, known) <= 0) return { status: 'unchanged' }

    // 기존 스냅샷을 못 읽으면(접속 실패 등) 여기서 던진다.
    // 로그는 이미 잘려 있을 수 있어서, 기존 스냅샷 없이 로그만으로 덮어쓰면 편집이 사라진다.
    const previous = await this.snapshots.read(docId)
    const previousId = previous?.lastStreamId ?? '0'
    if (previousId !== '0' && compareStreamIds(latest, previousId) <= 0) {
      this.known.set(docId, previousId)
      return { status: 'unchanged' }
    }

    const doc = new Y.Doc()
    try {
      if (previous) Y.applyUpdate(doc, previous.state)
      let entries = 0
      let lastStreamId = previousId
      for await (const entry of this.log.readAfter(docId, previousId)) {
        Y.applyUpdate(doc, entry.update)
        lastStreamId = entry.id
        entries += 1
      }
      if (entries === 0) {
        this.known.set(docId, previousId)
        return { status: 'unchanged' }
      }

      const state = Y.encodeStateAsUpdate(doc)
      // 읽은 뒤 다른 워커가 스냅샷을 바꿨으면(워커가 2개 이상 돈 경우) 올리지 않는다.
      // 늦은 워커가 옛 스냅샷 기준으로 덮어쓰면, 다른 워커가 그사이 잘라 낸 로그 구간이 어디에도 남지 않는다.
      const written = await this.snapshots.write(docId, state, lastStreamId, previous?.etag ?? null)
      if (!written) {
        // 기억도 갱신하지 않고 자르지도 않는다. 다음 주기에 새 스냅샷을 읽어 다시 한다.
        this.known.delete(docId)
        return { status: 'conflict' }
      }
      this.known.set(docId, lastStreamId)

      // 업로드에 성공한 뒤에만, 직전 스냅샷의 lastStreamId 기준으로 자른다 (한 세대 늦게).
      // 직전 스냅샷으로 복원 중인 파드가 (직전 lastStreamId, +] 로그를 읽을 수 있게 남겨 둔다.
      let trimmed = 0
      if (previousId !== '0') {
        try {
          trimmed = await this.log.trim(docId, previousId)
        } catch (err) {
          // 스냅샷은 저장됐으니 성공으로 친다. 다음 주기에 더 뒤 ID 기준으로 다시 자른다.
          this.onError(docId, err)
        }
      }
      return { status: 'saved', entries, bytes: state.byteLength, lastStreamId, trimmed }
    } finally {
      doc.destroy()
    }
  }

  /** 모든 문서를 한 번씩 처리한다. 한 문서가 실패해도 나머지는 계속한다. */
  async runCycle(): Promise<CycleResult> {
    const docs = await this.log.listDocs()
    const result: CycleResult = { docs: docs.length, saved: 0, conflicts: 0, failed: 0, entries: 0, trimmed: 0 }
    for (const docId of docs) {
      try {
        const doc = await this.snapshotDoc(docId)
        if (doc.status === 'saved') {
          result.saved += 1
          result.entries += doc.entries
          result.trimmed += doc.trimmed
        } else if (doc.status === 'conflict') {
          result.conflicts += 1
        }
      } catch (err) {
        result.failed += 1
        this.onError(docId, err)
      }
    }
    // 로그가 사라진 문서는 기억에서 지운다 (오래 돌아도 Map이 커지지 않게)
    const seen = new Set(docs)
    for (const docId of this.known.keys()) if (!seen.has(docId)) this.known.delete(docId)
    return result
  }
}
