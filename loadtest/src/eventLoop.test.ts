// 이벤트 루프 기록이 루프가 멈춘 순간과 바쁜 시간을 잡는지 확인 (실제 시계를 씀, 약 0.5초)
// 실행: npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { startEventLoopMonitor } from './eventLoop'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ms 동안 다른 일을 못 하게 루프를 붙잡음 = 봇 수백 개의 메시지를 한꺼번에 처리하는 상황
function block(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // 아무것도 하지 않고 시간만 씀
  }
}

describe('startEventLoopMonitor', () => {
  it('루프를 100ms 붙잡으면 최대 타이머 지연과 바쁜 시간 비율에 나타남', async () => {
    const stop = startEventLoopMonitor()
    await sleep(100)
    block(100)
    await sleep(100)
    const summary = stop()

    // 붙잡은 100ms 중 예정 간격(10ms)과 OS 타이머 오차를 넉넉히 빼도 70ms 이상 늦어짐
    assert.ok(summary.lagMaxMs >= 70, `최대 지연 ${summary.lagMaxMs}ms`)
    // 약 300ms 중 100ms를 일했으므로 바쁜 시간이 20%를 넘음
    assert.ok(summary.utilization > 0.2, `바쁜 시간 ${summary.utilization}`)
    assert.ok(summary.lagP50Ms <= summary.lagP99Ms && summary.lagP99Ms <= summary.lagMaxMs)
  })
})
