// y-websocket 프로토콜을 그대로 따르는 문서·연결 관리.
// 클라이언트의 y-websocket(WebsocketProvider)과 메시지 형식이 같아야 하므로 바꿀 때는 docs/contracts.md 를 먼저 고친다.
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { countMessage, setStatsSource } from './metrics.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3

const PING_INTERVAL_MS = 30_000

type AwarenessChanges = { added: number[]; updated: number[]; removed: number[] }

class SharedDoc extends Y.Doc {
  readonly name: string
  readonly awareness = new awarenessProtocol.Awareness(this)
  /** 연결 → 그 연결이 올린 awareness clientID 목록 (연결이 끊기면 커서를 지우는 데 씀) */
  readonly conns = new Map<WebSocket, Set<number>>()

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
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed)),
      )
      const message = encoding.toUint8Array(encoder)
      for (const conn of this.conns.keys()) send(this, conn, message)
    })

    this.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      // 보낸 연결에는 되돌려 보내지 않는다.
      for (const conn of this.conns.keys()) if (conn !== origin) send(this, conn, message)
      // TODO(백엔드, 2주차): SHARED일 때만 Pub/Sub doc:{docId}:updates 발행, Streams doc:{docId}:log 기록(200ms 병합)
    })
  }
}

export const docs = new Map<string, SharedDoc>()

// /metrics의 editor_ws_connections, editor_docs{mode} 값 (contracts 7.3)
// 적응형 전파(#18)가 들어오기 전에는 모든 문서가 LOCAL이다.
setStatsSource(() => {
  let connections = 0
  for (const doc of docs.values()) connections += doc.conns.size
  return { connections, local: docs.size, shared: 0 }
})

function getDoc(name: string): SharedDoc {
  let doc = docs.get(name)
  if (!doc) {
    doc = new SharedDoc(name)
    docs.set(name, doc)
  }
  return doc
}

function closeConn(doc: SharedDoc, conn: WebSocket) {
  const controlled = doc.conns.get(conn)
  if (controlled) {
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, [...controlled], null)
    console.log(`[doc:${doc.name}] 연결 종료, 남은 연결 ${doc.conns.size}`)
    if (doc.conns.size === 0) {
      // 아직 영속화가 없으므로 마지막 연결이 끊기면 문서가 사라진다.
      // TODO(백엔드, 2주차): contracts 5.3-6 순서대로 Streams flush → LEAVE 발행 → 구독 해제 후 내린다.
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

  conn.on('message', (data: ArrayBuffer) => handleMessage(doc, conn, new Uint8Array(data)))

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

  // 접속 직후: 서버 상태 벡터(sync step 1)와 현재 접속자 커서를 보낸다.
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
