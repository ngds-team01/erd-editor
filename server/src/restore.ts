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
  /** 워커가 앞부분을 잘라 낸 적이 있는지 (확인하지 못하면 던진다) */
  wasTrimmed(docId: string): Promise<boolean>
}

export type RestoreResult = {
  /** 복원한 문서 전체 (빈 문서면 빈 update) */
  update: Uint8Array
  /** found: 스냅샷 있음, none: 아직 없음, failed: 읽기 실패 */
  snapshot: 'found' | 'none' | 'failed'
  /**
   * true면 복원하지 않았다. 스냅샷을 못 읽었는데 Streams 앞부분이 이미 잘려 있어(또는 잘렸는지 확인 못 함),
   * Streams만으로는 문서를 만들 수 없다. 스냅샷을 읽을 수 있을 때까지 클라이언트에게 답하지 말고 다시 시도해야 한다.
   */
  waitForSnapshot: boolean
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
 *
 * 스냅샷을 못 읽었을 때:
 * - Streams가 한 번도 잘리지 않았으면 처음부터 전부 있으므로 Streams만으로 복원한다.
 * - 잘렸으면(또는 확인 못 하면) waitForSnapshot을 돌려준다. 잘린 앞부분(예: 테이블 생성)에 의존하는 뒤 기록
 *   (예: 그 테이블에 컬럼 추가)은 Yjs가 대기 상태로만 들고 있어 빈 문서로 보이고, 사용자가 같은 내용을 다시 만들면
 *   스냅샷이 돌아온 뒤 두 벌이 된다.
 * 그 밖의 실패(Streams 읽기 실패)는 던지지 않고 읽은 데까지로 복원한다.
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
      snapshot = 'failed'
      snapshotError = err
      let trimmed: boolean
      try {
        trimmed = await log.wasTrimmed(docId)
      } catch {
        trimmed = true
      }
      if (trimmed) {
        return {
          update: new Uint8Array(),
          snapshot,
          waitForSnapshot: true,
          entries: 0,
          lastStreamId,
          logComplete: false,
          snapshotError,
        }
      }
      // 한 번도 잘리지 않은 Streams: 처음부터 읽으면 문서 전체가 나온다
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

    return {
      update: Y.encodeStateAsUpdate(doc),
      snapshot,
      waitForSnapshot: false,
      entries,
      lastStreamId,
      logComplete,
      snapshotError,
      logError,
    }
  } finally {
    doc.destroy()
  }
}
