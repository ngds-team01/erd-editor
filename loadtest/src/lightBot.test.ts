// 가벼운 봇 연결부 확인: 테스트 안에 server/src/doc.ts와 같은 방식으로 답하는 작은 WebSocket 서버를 띄워 실제로 주고받음
// 실행: npm test
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, it } from 'node:test'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { botUser } from './bot'
import { createLightBot, LIGHT_LIMITS } from './lightBot'
import type { LightBot } from './lightBot'
import { createTable, getTables } from './model'
import type { ReconnectEvent } from './reconnect'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const SEED = 7

// 서버 문서 하나만 가진 최소 서버: 접속하면 SyncStep1, 받은 sync·awareness는 서버 문서에 적용 (server/src/doc.ts와 같음)
async function startServer() {
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
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > until) {
      throw new Error('시간 안에 조건을 만족하지 않음')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('createLightBot', () => {
  const cleanups: (() => unknown)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup()
    }
  })

  async function setup(onReconnect?: (event: ReconnectEvent) => void) {
    const server = await startServer()
    cleanups.push(server.stop)
    // 지터 0: 1012면 바로 재접속, 편집 테스트가 짧게 끝나도록 초당 50회
    const bot: LightBot = createLightBot({
      url: server.url,
      docId: 'doc',
      index: 0,
      seed: SEED,
      rate: 50,
      onReconnect,
      reconnectRandom: () => 0,
    })
    cleanups.push(() => bot.destroy())
    await bot.waitSynced(2000)
    return { server, bot }
  }

  it('접속하면 사용자 정보를 올리고, 내 편집을 서버 문서에 보냄', async () => {
    const { server, bot } = await setup()
    await waitFor(() => server.awareness.getStates().has(bot.doc.clientID))
    // 정식 봇과 같은 방식으로 만든 이름
    assert.equal(server.awareness.getStates().get(bot.doc.clientID)?.user?.name, botUser(SEED, 0).name)

    const tableId = createTable(bot.doc, { logicalName: '주문', physicalName: 'orders', position: { x: 0, y: 0 } })
    await waitFor(() => getTables(server.doc).has(tableId))
    assert.equal(getTables(server.doc).get(tableId)?.get('physicalName'), 'orders')
  })

  it('서버가 보낸 다른 사람의 편집은 세기만 하고 내 문서에 반영하지 않음', async () => {
    const { server, bot } = await setup()
    const other = new Y.Doc()
    const otherTable = createTable(other, { logicalName: '남의 테이블', physicalName: 'other', position: { x: 0, y: 0 } })
    const before = bot.stats.messagesReceived
    server.broadcastUpdate(Y.encodeStateAsUpdate(other))

    await waitFor(() => bot.stats.messagesReceived > before)
    assert.equal(getTables(bot.doc).has(otherTable), false)
  })

  it('서버가 1012로 닫으면 다시 붙고, 끊긴 동안 한 편집을 SyncStep2로 올림', async () => {
    const events: ReconnectEvent[] = []
    const { server, bot } = await setup((event) => events.push(event))
    server.closeAll(1012)
    await waitFor(() => bot.stats.disconnects === 1)
    // 다시 붙기 전에 편집 (보낼 연결이 없으므로 다시 붙을 때 SyncStep2로 올라가야 함)
    const tableId = createTable(bot.doc, { logicalName: '끊긴 동안', physicalName: 'offline', position: { x: 0, y: 0 } })

    await bot.waitSynced(2000)
    await waitFor(() => getTables(server.doc).has(tableId))
    assert.deepEqual(events, [{ kind: 'retry', code: 1012, delayMs: 0, attempt: 0 }])
  })

  it('편집 반복: 한도 안에서 자기 테이블만 만들어 편집하고, 편집 대상을 awareness에 올림', async () => {
    const { server, bot } = await setup()
    bot.start()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await bot.stop()

    const total = Object.values(bot.stats.actions).reduce((sum, count) => sum + count, 0)
    assert.ok(total >= 5, `편집 ${total}회`)
    // 서버 문서의 테이블은 모두 이 봇이 만든 것이고, 한도(2개)를 넘지 않음
    await waitFor(() => getTables(server.doc).size === getTables(bot.doc).size)
    const tables = getTables(server.doc).size
    assert.ok(tables >= LIGHT_LIMITS.minTables && tables <= LIGHT_LIMITS.maxTables, `테이블 ${tables}개`)
    assert.ok(bot.stats.updatesSent > 0)
    // 마지막 편집 대상이 서버의 awareness 상태에 있음 (테이블을 지운 직후면 null일 수 있어 키만 확인)
    await waitFor(() => 'editing' in (server.awareness.getStates().get(bot.doc.clientID) ?? {}))
  })

  it('끝내면 서버에서 내 awareness 상태가 바로 지워짐', async () => {
    const { server, bot } = await setup()
    await waitFor(() => server.awareness.getStates().has(bot.doc.clientID))
    const clientId = bot.doc.clientID
    bot.destroy()
    await waitFor(() => !server.awareness.getStates().has(clientId))
  })
})
