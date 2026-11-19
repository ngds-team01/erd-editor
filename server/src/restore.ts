// 문서 복원 (docs/contracts.md 6.4 2~3단계).
// MinIO 스냅샷 + 그 뒤 Streams 기록 + 아직 기록하지 못한 버퍼를 합쳐 하나의 Yjs update로 만든다.
// Redis·S3는 LogReader·SnapshotReader로 받아서, 테스트에서는 메모리 구현을 넣는다.
import * as Y from 'yjs'

export type Snapshot = { state: Uint8Array; lastStreamId: string }

export interface SnapshotReader {
  /** 스냅샷이 없으면 null. 그 밖의 오류는 던진다 */
  read(docId: string): Promise<Snapshot | null>
}

export interface LogReader {
  /** afterId 다음 항목부터 끝까지 (afterId가 '0'이면 처음부터) */
  readAfter(docId: string, afterId: string): AsyncIterable<{ id: string; update: Uint8Array }>
}

export type RestoreResult = {
  /** 복원한 문서 전체 (빈 문서면 빈 update) */
  update: Uint8Array
  /** found: 스냅샷 있음, none: 아직 없음, failed: 읽기 실패 (Streams 기록만으로 복원) */
  snapshot: 'found' | 'none' | 'failed'
  /** 적용한 Streams 항목 수 */
  entries: number
  /** 적용한 마지막 Stream ID. Redis가 다시 붙으면 이 다음부터 이어 읽는다 */
  lastStreamId: string
  /** Streams를 끝까지 읽었으면 true. 읽다 실패하면 false (그때까지 읽은 것은 들어 있음) */
  logComplete: boolean
  /** 스냅샷 읽기 실패 원인 (snapshot이 failed일 때) */
  snapshotError?: unknown
  /** Streams 읽기 실패 원인 (logComplete가 false일 때) */
  logError?: unknown
}

/**
 * 6.4: 스냅샷을 읽고(없으면 빈 문서, lastStreamId = 0), XRANGE (lastStreamId + 로 이후 기록을 적용한다.
 * pending은 이 파드가 아직 Streams에 기록하지 못한 업데이트다 (Redis가 끊긴 동안 문서를 내렸다 다시 연 경우).
 * 어느 단계가 실패해도 던지지 않고, 읽은 데까지로 복원한다. 클라이언트가 가진 내용은 접속 후 SyncStep2로 다시 올라온다.
 */
export async function loadDocState(
  docId: string,
  snapshots: SnapshotReader,
  log: LogReader,
  pending: Uint8Array[] = [],
): Promise<RestoreResult> {
  const doc = new Y.Doc()
  let snapshotError: unknown
  let logError: unknown
  try {
    let snapshot: RestoreResult['snapshot'] = 'none'
    let lastStreamId = '0'
    try {
      const found = await snapshots.read(docId)
      if (found) {
        Y.applyUpdate(doc, found.state)
        lastStreamId = found.lastStreamId
        snapshot = 'found'
      }
    } catch (err) {
      // 스냅샷을 못 읽으면 Streams 처음부터 읽는다. 워커가 이미 잘라 낸 앞부분은 빠질 수 있다.
      snapshot = 'failed'
      snapshotError = err
    }

    let entries = 0
    let logComplete = true
    try {
      for await (const entry of log.readAfter(docId, lastStreamId)) {
        Y.applyUpdate(doc, entry.update)
        lastStreamId = entry.id
        entries += 1
      }
    } catch (err) {
      logComplete = false
      logError = err
    }

    for (const update of pending) Y.applyUpdate(doc, update)

    return { update: Y.encodeStateAsUpdate(doc), snapshot, entries, lastStreamId, logComplete, snapshotError, logError }
  } finally {
    doc.destroy()
  }
}
