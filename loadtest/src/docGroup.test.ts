// 문서 묶음의 봇 번호와 접속·종료 확인, 테스트 서버에 실제로 붙어 봄
// 실행: npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDocGroup } from './docGroup'
import type { DocGroupOptions } from './docGroup'
import { startServer, waitFor } from './testServer'

function groupOptions(url: string, overrides: Partial<DocGroupOptions> = {}): DocGroupOptions {
  return {
    url,
    receiverUrl: url,
    docId: 'group-test',
    firstIndex: 0,
    bots: 2,
    seed: 1,
    rate: 1,
    rampMs: 0,
    probe: false,
    probeIntervalMs: 200,
    ...overrides,
  }
}

describe('createDocGroup', () => {
  it('측정 봇이 없어도 번호를 비워 둬서 관찰자·다음 묶음 번호가 같음', async () => {
    const server = await startServer()
    const withoutProbe = await createDocGroup(groupOptions(server.url, { firstIndex: 10 }))
    const withProbe = await createDocGroup(groupOptions(server.url, { firstIndex: 10, probe: true }))
    try {
      assert.deepEqual(
        withoutProbe.bots.map((bot) => bot.index),
        [10, 11],
      )
      assert.equal(withoutProbe.everyBot.length, 2)
      assert.deepEqual(
        withoutProbe.docs.map((doc) => doc.name),
        ['봇 10', '봇 11'],
      )

      assert.ok(withProbe.probe)
      assert.equal(withProbe.probe.sender.index, 12)
      assert.equal(withProbe.probe.receiver.index, 13)
      assert.deepEqual(
        withProbe.docs.map((doc) => doc.name),
        ['봇 10', '봇 11', '보내는 봇', '받는 봇'],
      )

      // 관찰자 = 14, 다음 묶음 = 15 (측정 여부와 무관)
      assert.equal(withoutProbe.nextIndex, 15)
      assert.equal(withProbe.nextIndex, 15)
    } finally {
      withoutProbe.destroy()
      withProbe.destroy()
      await server.stop()
    }
  })

  it('모든 봇이 동기화되고, 관찰자를 붙였다가 destroy로 관찰자까지 끊음', async () => {
    const server = await startServer()
    const group = await createDocGroup(groupOptions(server.url, { probe: true }))
    try {
      await group.waitSynced(2000)
      await waitFor(() => server.connections() === 4)

      const { observer, syncMs } = await group.connectObserver(2000)
      assert.equal(observer.index, 4)
      assert.ok(syncMs > 0)
      await waitFor(() => server.connections() === 5)

      group.destroy()
      // 두 번 불러도 됨 (restore에서 봇을 먼저 내보낸 뒤 finally에서 다시 부름)
      group.destroy()
      await waitFor(() => server.connections() === 0)
    } finally {
      group.destroy()
      await server.stop()
    }
  })
})
