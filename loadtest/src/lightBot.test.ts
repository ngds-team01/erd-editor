// 가벼운 봇 연결부 확인: 테스트 안에 server/src/doc.ts와 같은 방식으로 답하는 작은 WebSocket 서버를 띄워 실제로 주고받음
// 실행: npm test
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import * as Y from 'yjs'
import { botUser } from './bot'
import { createLightBot, LIGHT_LIMITS } from './lightBot'
import type { LightBot } from './lightBot'
import { createTable, getTables } from './model'
import type { ReconnectEvent } from './reconnect'
import { startServer, waitFor } from './testServer'

const SEED = 7

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
    // 동기화한 뒤에 닫혔으므로 접속 실패가 아닌 끊김
    assert.deepEqual(events, [{ kind: 'retry', code: 1012, delayMs: 0, attempt: 0, beforeFirstSync: false }])
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
