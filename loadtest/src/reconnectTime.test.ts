// 재접속 시간 기록 확인: 가짜 provider로 규칙을 보고, 테스트 서버로 실제 봇이 끊겼다 다시 붙는 경우를 봄
// 실행: npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBot } from './bot'
import { CLOSE_SERVICE_RESTART } from './reconnect'
import type { ReconnectTarget } from './reconnect'
import { trackReconnects } from './reconnectTime'
import { startServer, waitFor } from './testServer'

const CLOSE_ABNORMAL = 1006

// 'closed'·'sync' 이벤트를 테스트에서 직접 일으키는 가짜 provider와, 테스트가 정하는 시계
function fakeProvider() {
  const closedListeners: ((event: { code: number; reason: string }) => void)[] = []
  const syncListeners: ((synced: boolean) => void)[] = []
  const target: Pick<ReconnectTarget, 'on'> = {
    on(name: 'closed' | 'sync', listener: never) {
      if (name === 'closed') {
        closedListeners.push(listener)
      } else {
        syncListeners.push(listener)
      }
    },
  }
  let clock = 0
  return {
    target,
    now: () => clock,
    setClock: (ms: number) => {
      clock = ms
    },
    close: (code: number) => closedListeners.forEach((listener) => listener({ code, reason: '' })),
    sync: (synced = true) => syncListeners.forEach((listener) => listener(synced)),
  }
}

describe('trackReconnects', () => {
  it('끊긴 시각부터 다시 동기화된 시각까지를 한 줄로 기록', () => {
    const fake = fakeProvider()
    const log = trackReconnects(fake.target, 7, undefined, fake.now)

    fake.sync()
    fake.setClock(1000)
    fake.close(CLOSE_ABNORMAL)
    assert.equal(log.pending(), 1)
    // 끊길 때 y-websocket이 sync false를 보내도 기록은 이어짐
    fake.sync(false)
    fake.setClock(2500)
    fake.sync()

    assert.equal(log.pending(), 0)
    assert.deepEqual(log.samples(), [
      { bot: 7, closeCode: CLOSE_ABNORMAL, disconnectedAt: 1000, syncedAt: 2500, durationMs: 1500, failedAttempts: 0 },
    ])
  })

  it('재접속이 실패해도 처음 끊긴 시각·code를 유지하고 실패 수를 셈', () => {
    const fake = fakeProvider()
    const log = trackReconnects(fake.target, 1, undefined, fake.now)

    fake.sync()
    fake.setClock(100)
    fake.close(CLOSE_SERVICE_RESTART)
    // 붙을 파드가 없어 두 번 더 실패
    fake.setClock(700)
    fake.close(CLOSE_ABNORMAL)
    fake.setClock(1800)
    fake.close(CLOSE_ABNORMAL)
    fake.setClock(4000)
    fake.sync()

    const [sample] = log.samples()
    assert.equal(sample.closeCode, CLOSE_SERVICE_RESTART)
    assert.equal(sample.durationMs, 3900)
    assert.equal(sample.failedAttempts, 2)
  })

  it('첫 동기화 전의 접속 실패는 끊김으로 세지 않음', () => {
    const fake = fakeProvider()
    const log = trackReconnects(fake.target, 1, undefined, fake.now)

    fake.close(CLOSE_ABNORMAL)
    fake.sync()
    assert.deepEqual(log.samples(), [])
    assert.equal(log.pending(), 0)
  })

  it('끊김마다 한 줄씩, 다시 동기화될 때 onRecovered를 부름', () => {
    const fake = fakeProvider()
    const recovered: number[] = []
    const log = trackReconnects(fake.target, 1, (sample) => recovered.push(sample.durationMs), fake.now)

    fake.sync()
    for (const [closeAt, syncAt] of [
      [1000, 1200],
      [5000, 5600],
    ]) {
      fake.setClock(closeAt)
      fake.close(CLOSE_ABNORMAL)
      fake.setClock(syncAt)
      fake.sync()
    }
    assert.equal(log.samples().length, 2)
    assert.deepEqual(recovered, [200, 600])
  })
})

describe('봇의 재접속 시간 기록', () => {
  it('서버가 1012로 닫으면 다시 붙어 동기화를 마친 뒤 기록이 한 줄 남음', async () => {
    const server = await startServer()
    const bot = createBot({ url: server.url, docId: 'reconnect-test', index: 0, seed: 1, rate: 1 })
    try {
      await bot.waitSynced(2000)
      server.closeAll(CLOSE_SERVICE_RESTART)
      // 1012는 0~500ms 안에 재접속
      await waitFor(() => bot.reconnects.samples().length === 1, 3000)

      const [sample] = bot.reconnects.samples()
      assert.equal(sample.bot, 0)
      assert.equal(sample.closeCode, CLOSE_SERVICE_RESTART)
      assert.equal(sample.failedAttempts, 0)
      assert.ok(sample.durationMs > 0 && sample.durationMs < 3000, `걸린 시간 ${sample.durationMs}ms`)
      assert.equal(bot.reconnects.pending(), 0)
      assert.equal(bot.stats.disconnects, 1)
    } finally {
      bot.destroy()
      await server.stop()
    }
  })
})
