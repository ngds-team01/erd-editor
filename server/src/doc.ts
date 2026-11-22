// y-websocket 프로토콜을 그대로 따르는 문서·연결 관리.
// 클라이언트의 y-websocket(WebsocketProvider)과 메시지 형식이 같아야 하므로 바꿀 때는 docs/contracts.md 를 먼저 고친다.
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { countMessage, docRestoreSeconds, setStatsSource } from './metrics.js'
import { DocPropagation, REMOTE_ORIGIN } from './propagation.js'
import { isRedisReady, onRedisReady } from './redis.js'
import { loadDocState } from './restore.js'
import { s3Snapshots } from './s3.js'
import { flush as flushStream, pendingUpdates, record as recordStream, streamLog } from './streams.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3

const PING_INTERVAL_MS = 30_000

/** 복원(6.4)으로 넣은 변경에 붙이는 origin. 이미 저장된 내용이므로 발행·기록하지 않는다. */
const RESTORE_ORIGIN = Symbol('restore')
/** 복원 때 스냅샷을 못 읽었으면 문서가 열려 있는 동안 이 간격으로 다시 읽어 합친다. */
const SNAPSHOT_RETRY_MS = 5_000
/** Streams만으로 복원할 수 없어 스냅샷을 기다리는 동안 다시 시도하는 간격 (클라이언트가 기다리므로 짧게) */
const SNAPSHOT_WAIT_RETRY_MS = 2_000

type AwarenessChanges = { added: number[]; updated: number[]; removed: number[] }

class SharedDoc extends Y.Doc {
  readonly name: string
  readonly awareness = new awarenessProtocol.Awareness(this)
  /** 연결 → 그 연결이 올린 awareness clientID 목록 (연결이 끊기면 커서를 지우는 데 씀) */
  readonly conns = new Map<WebSocket, Set<number>>()
  /** 다른 파드와의 Pub/Sub 전파 (contracts 5.3) */
  readonly propagation: DocPropagation
  /**
   * 복원(6.4)이 끝났는지. 끝나기 전에는 클라이언트 메시지를 queued에 쌓아 두고 답하지 않는다
   * (빈 문서로 SyncStep2를 보내면 클라이언트가 빈 문서를 동기화 완료로 본다).
   */
  restored = false
  /** 복원 중에 붙은 연결이 보낸 메시지. 복원이 끝나면 받은 순서대로 처리한다. */
  readonly queued = new Map<WebSocket, Uint8Array[]>()
  /** 문서에 적용한 마지막 Stream ID. Streams를 끝까지 못 읽었으면 Redis 재연결 후 이 다음부터 이어 읽는다. */
  streamId = '0'
  logComplete = true
  /** 마지막 연결이 떠나 메모리에서 내린 문서 (복원 중에 내려간 경우 복원 결과를 버린다) */
  closed = false

  constructor(name: string) {
    super({ gc: true })
    this.name = name
    this.awareness.setLocalState(null)

    this.awareness.on('update', ({ added, updated, removed }: AwarenessChanges, origin: unknown) => {
      const controlled = this.conns.get(origin as WebSocket)
      if (controlled) {
        added.forEach((id) => controlled.add(id))
        removed.forEach((id) => controlled.delete(id))
      }
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed))
      // 다른 파드에 먼저 발행한다. 아래 send()가 닫히는 중인 연결을 정리하다 마지막 연결이면
      // 문서를 내리고(LEAVE) 이후 발행을 막기 때문이다. 다른 파드에서 받은 awareness는 다시 발행하지 않는다.
      if (origin !== REMOTE_ORIGIN) this.propagation.onLocalAwareness(update)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, update)
      const message = encoding.toUint8Array(encoder)
      for (const conn of this.conns.keys()) send(this, conn, message)
    })

    this.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === RESTORE_ORIGIN) {
        // 스냅샷·Streams에서 읽은 내용은 이미 저장돼 있으므로 다시 발행·기록하지 않는다.
        // 복원 중이면 클라이언트에게도 보내지 않는다. 복원이 끝난 뒤 SyncStep1·2로 받는다.
        if (!this.restored) return
      } else {
        // awareness와 같은 이유로 다른 파드에 먼저 발행한다. 다른 파드에서 받은 변경은 다시 발행하지 않는다.
        // (SHARED일 때만 발행할지는 propagation이 판단)
        if (origin !== REMOTE_ORIGIN) this.propagation.onLocalUpdate(update)
        // contracts 6.2: 이 파드 클라이언트(WebSocket)가 보낸 변경만 기록한다. 다른 파드에서 받은 변경은 그 파드가 기록한다.
        if (origin instanceof WebSocket) recordStream(this.name, update)
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      // 보낸 연결에는 되돌려 보내지 않는다.
      for (const conn of this.conns.keys()) if (conn !== origin) send(this, conn, message)
    })

    this.propagation = new DocPropagation(this)
  }

  localAwarenessIds(): number[] {
    return [...this.conns.values()].flatMap((ids) => [...ids])
  }
}

export const docs = new Map<string, SharedDoc>()

// /metrics의 editor_ws_connections, editor_docs{mode} 값 (contracts 7.3)
setStatsSource(() => {
  let connections = 0
  let shared = 0
  for (const doc of docs.values()) {
    connections += doc.conns.size
    if (doc.propagation.shared) shared += 1
  }
  return { connections, local: docs.size - shared, shared }
})

function getDoc(name: string): SharedDoc {
  let doc = docs.get(name)
  if (!doc) {
    doc = new SharedDoc(name)
    docs.set(name, doc)
    void restore(doc)
  }
  return doc
}

/**
 * contracts 5.3-1, 6.4: 문서를 처음 열 때 MinIO 스냅샷 + Streams 기록으로 복원한 뒤 채널을 구독하고 JOIN한다.
 * 복원 중에 붙은 연결에는 복원이 끝난 뒤 SyncStep1을 보내고, 쌓인 메시지를 순서대로 처리한다.
 */
async function restore(doc: SharedDoc) {
  const end = docRestoreSeconds.startTimer()
  try {
    let pending = pendingUpdates(doc.name)
    let result = await loadDocState(doc.name, s3Snapshots, streamLog, pending)
    // contracts 6.4: 스냅샷 없이는 문서를 만들 수 없으면(Streams 앞부분이 잘림) 읽을 수 있을 때까지 답하지 않는다
    while (result.waitForSnapshot) {
      if (doc.closed) {
        end()
        return
      }
      console.warn(
        `[doc:${doc.name}] 스냅샷을 읽지 못했고 Streams 앞부분이 이미 잘려 있어 ${SNAPSHOT_WAIT_RETRY_MS / 1000}초 뒤 다시 시도, ` +
          `그동안 클라이언트에게 답하지 않음: ${errorMessage(result.snapshotError)}`,
      )
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_RETRY_MS))
      if (doc.closed) {
        end()
        return
      }
      pending = pendingUpdates(doc.name)
      result = await loadDocState(doc.name, s3Snapshots, streamLog, pending)
    }
    const seconds = end()
    if (doc.closed) return
    Y.applyUpdate(doc, result.update, RESTORE_ORIGIN)
    doc.streamId = result.lastStreamId
    doc.logComplete = result.logComplete

    const snapshot = { found: '스냅샷 있음', none: '스냅샷 없음', failed: '스냅샷 읽기 실패' }[result.snapshot]
    const extra = pending.length > 0 ? `, 미기록 ${pending.length}개` : ''
    console.log(`[doc:${doc.name}] 복원 완료 ${seconds.toFixed(3)}초 (${snapshot}, 기록 ${result.entries}항목${extra})`)
    if (result.snapshotError !== undefined) {
      // Streams가 한 번도 잘리지 않아 Streams만으로 전체를 복원한 경우. 그사이 워커가 자를 수 있으니 스냅샷도 다시 읽어 합친다.
      console.warn(
        `[doc:${doc.name}] 스냅샷을 읽지 못했지만 Streams가 잘린 적 없어 Streams 기록만으로 복원, ` +
          `${SNAPSHOT_RETRY_MS / 1000}초마다 스냅샷을 다시 읽음: ${errorMessage(result.snapshotError)}`,
      )
      retrySnapshot(doc)
    }
    if (result.logError !== undefined) {
      console.warn(`[doc:${doc.name}] Streams 기록을 끝까지 읽지 못함, Redis가 다시 붙으면 이어서 읽음: ${errorMessage(result.logError)}`)
    }
  } catch (err) {
    // 예상하지 못한 오류여도 클라이언트를 계속 기다리게 두지 않는다. 클라이언트가 가진 내용은 SyncStep2로 올라온다.
    end()
    if (doc.closed) return
    console.error(`[doc:${doc.name}] 복원 실패, 빈 문서로 시작`, err)
  }

  doc.restored = true
  void doc.propagation.start()
  for (const conn of [...doc.conns.keys()]) greet(doc, conn)
  for (const [conn, messages] of [...doc.queued]) {
    for (const message of messages) {
      if (doc.closed || !doc.conns.has(conn)) break
      handleMessage(doc, conn, message)
    }
  }
  doc.queued.clear()
  // 복원 도중 Redis가 다시 붙었으면 재연결 이벤트를 놓쳤을 수 있다
  if (!doc.logComplete && isRedisReady()) void catchUpLog(doc)
}

/** 복원 때 Streams를 끝까지 못 읽은 문서는 Redis가 다시 붙으면 나머지를 읽어 적용한다. */
async function catchUpLog(doc: SharedDoc) {
  if (doc.logComplete || doc.closed) return
  doc.logComplete = true
  const updates: Uint8Array[] = []
  let streamId = doc.streamId
  try {
    for await (const entry of streamLog.readAfter(doc.name, streamId)) {
      updates.push(entry.update)
      streamId = entry.id
    }
  } catch (err) {
    doc.logComplete = false
    console.warn(`[doc:${doc.name}] Streams 기록 이어 읽기 실패: ${errorMessage(err)}`)
  }
  if (doc.closed || updates.length === 0) return
  Y.applyUpdate(doc, Y.mergeUpdates(updates), RESTORE_ORIGIN)
  doc.streamId = streamId
  console.log(`[doc:${doc.name}] Streams 기록 ${updates.length}항목 이어서 적용`)
}

/**
 * 스냅샷을 못 읽고 Streams 기록만으로 복원한 문서는, 워커가 이미 잘라 낸 앞부분이 빠져 있을 수 있다.
 * 문서가 열려 있는 동안 스냅샷을 다시 읽어 합친다 (Yjs 업데이트라 이미 있는 내용과 겹쳐도 결과가 같다).
 * Streams 쪽은 처음부터 읽었으므로 스냅샷 뒤 기록은 이미 들어 있다.
 */
function retrySnapshot(doc: SharedDoc) {
  setTimeout(async () => {
    if (doc.closed) return
    try {
      const found = await s3Snapshots.read(doc.name)
      if (doc.closed) return
      if (found) Y.applyUpdate(doc, found.state, RESTORE_ORIGIN)
      console.log(`[doc:${doc.name}] 스냅샷 다시 읽음 (${found ? '합침' : '스냅샷 없음'})`)
    } catch {
      retrySnapshot(doc)
    }
  }, SNAPSHOT_RETRY_MS).unref()
}

onRedisReady(() => {
  for (const doc of docs.values()) if (doc.restored && !doc.logComplete) void catchUpLog(doc)
})

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

function closeConn(doc: SharedDoc, conn: WebSocket) {
  const controlled = doc.conns.get(conn)
  if (controlled) {
    doc.conns.delete(conn)
    doc.queued.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, [...controlled], null)
    console.log(`[doc:${doc.name}] 연결 종료, 남은 연결 ${doc.conns.size}`)
    if (doc.conns.size === 0) {
      // contracts 5.3-6: Streams flush → LEAVE 발행 → 구독 해제 → 메모리에서 제거
      // XADD와 PUBLISH(LEAVE)는 같은 Redis 연결로 나가므로 flush를 기다리지 않아도 이 순서가 지켜진다.
      // Redis가 끊겨 있으면 버퍼는 streams.ts에 남았다가 재연결 후 기록된다.
      void flushStream(doc.name)
      doc.propagation.leave()
      doc.closed = true
      doc.destroy()
      docs.delete(doc.name)
    }
  }
  conn.close()
}

function send(doc: SharedDoc, conn: WebSocket, message: Uint8Array) {
  if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
    closeConn(doc, conn)
    return
  }
  conn.send(message, (err) => {
    if (err) closeConn(doc, conn)
  })
}

function handleMessage(doc: SharedDoc, conn: WebSocket, message: Uint8Array) {
  try {
    const decoder = decoding.createDecoder(message)
    const encoder = encoding.createEncoder()
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC:
        countMessage('sync')
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
        // sync step 1을 받았을 때만 답(step 2)이 생긴다.
        if (encoding.length(encoder) > 1) send(doc, conn, encoding.toUint8Array(encoder))
        break
      case MESSAGE_AWARENESS:
        countMessage('awareness')
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
        break
      case MESSAGE_QUERY_AWARENESS:
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...doc.awareness.getStates().keys()]),
        )
        send(doc, conn, encoding.toUint8Array(encoder))
        break
    }
  } catch (err) {
    console.error(`[doc:${doc.name}] 메시지 처리 실패`, err)
  }
}

export function setupConnection(conn: WebSocket, docName: string) {
  conn.binaryType = 'arraybuffer'
  const doc = getDoc(docName)
  doc.conns.set(conn, new Set())
  console.log(`[doc:${docName}] 연결 열림, 현재 연결 ${doc.conns.size}`)

  conn.on('message', (data: ArrayBuffer) => {
    const message = new Uint8Array(data)
    if (doc.restored) {
      handleMessage(doc, conn, message)
      return
    }
    // contracts 6.4: 복원이 끝나기 전에는 SyncStep1에 답하지 않는다. 받은 순서대로 쌓아 두었다가 복원 후 처리한다.
    let queue = doc.queued.get(conn)
    if (!queue) {
      queue = []
      doc.queued.set(conn, queue)
    }
    queue.push(message)
  })

  // 응답 없는 연결 정리 (브라우저가 조용히 사라진 경우)
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived || !doc.conns.has(conn)) {
      closeConn(doc, conn)
      clearInterval(pingInterval)
      return
    }
    pongReceived = false
    conn.ping()
  }, PING_INTERVAL_MS)
  conn.on('pong', () => {
    pongReceived = true
  })
  conn.on('close', () => {
    closeConn(doc, conn)
    clearInterval(pingInterval)
  })

  // 복원 중이면 복원이 끝난 뒤 보낸다 (restore)
  if (doc.restored) greet(doc, conn)
}

/** 접속 직후: 서버 상태 벡터(sync step 1)와 현재 접속자 커서를 보낸다. */
function greet(doc: SharedDoc, conn: WebSocket) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(doc, conn, encoding.toUint8Array(encoder))

  const states = doc.awareness.getStates()
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...states.keys()]),
    )
    send(doc, conn, encoding.toUint8Array(awarenessEncoder))
  }
}
