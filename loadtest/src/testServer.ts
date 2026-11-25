// 테스트용 최소 서버와 기다리기 도우미 (lightBot.test.ts, loadProcess.test.ts가 같이 씀)
// 서버 문서 하나만 가진 최소 서버: 접속하면 SyncStep1, 받은 sync·awareness는 서버 문서에 적용 (server/src/doc.ts와 같음)
// 다른 클라이언트에게 퍼뜨리지는 않음 (봇이 보낸 것이 서버에 들어가는지만 확인)
import type { AddressInfo } from 'node:net'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

export async function startServer() {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  const conns = new Set<WebSocket>()
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', (conn) => {
    conns.add(conn)
    conn.on('close', () => conns.delete(conn))
    conn.on('message', (data: Buffer) => {
      const decoder = decoding.createDecoder(new Uint8Array(data))
      const encoder = encoding.createEncoder()
      const type = decoding.readVarUint(decoder)
      if (type === MESSAGE_SYNC) {
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
        if (encoding.length(encoder) > 1) {
          conn.send(encoding.toUint8Array(encoder))
        }
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), conn)
      }
    })
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, doc)
    conn.send(encoding.toUint8Array(encoder))
  })
  await new Promise((resolve) => wss.once('listening', resolve))
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  return {
    url,
    doc,
    awareness,
    // 지금 접속 수
    connections: () => conns.size,
    // 다른 사용자의 편집을 접속한 모두에게 보냄 (서버가 퍼뜨리는 것과 같은 메시지)
    broadcastUpdate: (update: Uint8Array) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      conns.forEach((conn) => conn.send(encoding.toUint8Array(encoder)))
    },
    closeAll: (code: number) => conns.forEach((conn) => conn.close(code)),
    stop: () =>
      new Promise<void>((resolve) => {
        conns.forEach((conn) => conn.terminate())
        awareness.destroy()
        wss.close(() => resolve())
      }),
  }
}

// 조건이 참이 될 때까지 기다림 (실제 네트워크라 즉시 반영되지 않음)
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > until) {
      throw new Error('시간 안에 조건을 만족하지 않음')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
