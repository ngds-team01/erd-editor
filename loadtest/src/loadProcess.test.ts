// 부하 프로세스 확인: 실제로 자식 프로세스를 띄워 테스트용 서버에 접속시키고, 시작·멈춤·통계 보고를 주고받음
// 실행: npm test
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { getTables } from './model'
import { LIGHT_LIMITS } from './lightBot'
import { startLoadProcess } from './loadProcess'
import type { LoadProcess } from './loadProcess'
import { startServer, waitFor } from './testServer'

describe('startLoadProcess', () => {
  const cleanups: (() => unknown)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup()
    }
  })

  function launch(url: string, overrides: { count?: number; syncTimeoutMs?: number } = {}): LoadProcess {
    const load = startLoadProcess({
      url,
      docId: 'doc',
      seed: 7,
      // 테스트가 짧게 끝나도록 초당 50회
      rate: 50,
      firstIndex: 100,
      count: overrides.count ?? 3,
      rampMs: 0,
      syncTimeoutMs: overrides.syncTimeoutMs ?? 5000,
    })
    cleanups.push(() => load.kill())
    return load
  }

  it('봇이 모두 접속하면 ready, start·stop 사이에 편집하고 통계를 보고한 뒤 접속을 닫음', async () => {
    const server = await startServer()
    cleanups.push(server.stop)
    const load = launch(server.url)

    await load.ready
    assert.equal(server.connections(), 3)
    load.start()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const stats = await load.stop()

    assert.equal(stats.bots, 3)
    const actions = Object.values(stats.actions).reduce((sum, count) => sum + count, 0)
    assert.ok(actions >= 5, `편집 ${actions}회`)
    assert.ok(stats.updatesSent > 0)
    // 부하 프로세스의 이벤트 루프도 편집 구간 동안 잼
    assert.ok(stats.eventLoop !== null && stats.eventLoop.utilization >= 0)
    // 봇 3개의 편집이 서버 문서에 들어가 있고, 봇마다 한도(테이블 2개)를 넘지 않음
    const tables = getTables(server.doc).size
    assert.ok(tables >= 3 && tables <= 3 * LIGHT_LIMITS.maxTables, `테이블 ${tables}개`)
    // 통계를 보낸 뒤 접속을 모두 닫음
    await waitFor(() => server.connections() === 0)
  })

  it('서버에 붙지 못하면 ready가 실패함', async () => {
    // 아무도 듣지 않는 포트
    const load = launch('ws://127.0.0.1:9', { count: 1, syncTimeoutMs: 300 })
    await assert.rejects(load.ready, /동기화하지 못했습니다/)
  })
})
