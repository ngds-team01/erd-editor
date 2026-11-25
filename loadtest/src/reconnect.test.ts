// 서버 없이 가짜 provider로 봇의 재접속 규칙(contracts 4.3)이 client와 같게 동작하는지 확인
// 실행: npm test
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { attachReconnect, CLOSE_INVALID_DOC_ID, CLOSE_SERVICE_RESTART } from './reconnect'
import type { ReconnectEvent, ReconnectTarget } from './reconnect'

// 파드가 강제로 죽었을 때처럼 정상 종료 절차 없이 끊긴 연결
const CLOSE_ABNORMAL = 1006

// 'closed'·'sync' 이벤트를 테스트에서 직접 일으킬 수 있는 가짜 provider
function fakeProvider() {
  const closedListeners: ((event: { code: number; reason: string }) => void)[] = []
  const syncListeners: ((synced: boolean) => void)[] = []
  let connects = 0
  const provider: ReconnectTarget = {
    on(name: 'closed' | 'sync', listener: never) {
      if (name === 'closed') {
        closedListeners.push(listener)
      } else {
        syncListeners.push(listener)
      }
    },
    connect: () => {
      connects += 1
    },
  }
  return {
    provider,
    close: (code: number) => closedListeners.forEach((listener) => listener({ code, reason: '' })),
    sync: () => syncListeners.forEach((listener) => listener(true)),
    connects: () => connects,
  }
}

// 지터 없이 기준 대기 시간 그대로 나오는 난수 (0.5 → 1배)
const noJitter = () => 0.5

describe('attachReconnect', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
  afterEach(() => mock.timers.reset())

  it('끊길 때마다 0.5s → 1s → 2s로 늘어난 뒤 다시 접속', () => {
    const fake = fakeProvider()
    const events: ReconnectEvent[] = []
    attachReconnect(fake.provider, (event) => events.push(event), noJitter)

    for (const expected of [500, 1000, 2000]) {
      fake.close(CLOSE_ABNORMAL)
      const connectsBefore = fake.connects()
      mock.timers.tick(expected - 1)
      assert.equal(fake.connects(), connectsBefore, `${expected}ms가 되기 전에는 접속하지 않음`)
      mock.timers.tick(1)
      assert.equal(fake.connects(), connectsBefore + 1)
    }
    assert.deepEqual(
      events.map((event) => (event.kind === 'retry' ? [event.delayMs, event.attempt] : event.kind)),
      [
        [500, 0],
        [1000, 1],
        [2000, 2],
      ],
    )
  })

  it('동기화에 성공하면 다시 0.5s부터 셈', () => {
    const fake = fakeProvider()
    const delays: number[] = []
    attachReconnect(fake.provider, (event) => event.kind === 'retry' && delays.push(event.delayMs), noJitter)

    fake.close(CLOSE_ABNORMAL)
    fake.close(CLOSE_ABNORMAL)
    fake.sync()
    fake.close(CLOSE_ABNORMAL)
    assert.deepEqual(delays, [500, 1000, 500])
  })

  it('1012는 0~500ms 안에 재접속하고 실패로 세지 않음', () => {
    const fake = fakeProvider()
    const delays: number[] = []
    attachReconnect(fake.provider, (event) => event.kind === 'retry' && delays.push(event.delayMs), () => 0.9)

    fake.close(CLOSE_SERVICE_RESTART)
    fake.close(CLOSE_ABNORMAL)
    // 1012: 0.9 × 500ms, 그다음 1006: 실패 0회 기준 0.5s × (0.8 + 0.4 × 0.9)
    assert.deepEqual(
      delays.map((delay) => Math.round(delay)),
      [450, 580],
    )
  })

  it('한 번도 동기화하지 못한 채 닫히면 beforeFirstSync, 동기화한 뒤의 끊김은 아님', () => {
    const fake = fakeProvider()
    const flags: boolean[] = []
    attachReconnect(fake.provider, (event) => event.kind === 'retry' && flags.push(event.beforeFirstSync), noJitter)

    // 서버가 꺼져 있어 접속 실패 두 번 → 붙어서 동기화 → 끊김
    fake.close(CLOSE_ABNORMAL)
    fake.close(CLOSE_ABNORMAL)
    fake.sync()
    fake.close(CLOSE_ABNORMAL)
    assert.deepEqual(flags, [true, true, false])
  })

  it('4400이면 재접속하지 않고 stop을 알림', () => {
    const fake = fakeProvider()
    const events: ReconnectEvent[] = []
    attachReconnect(fake.provider, (event) => events.push(event), noJitter)

    fake.close(CLOSE_INVALID_DOC_ID)
    mock.timers.tick(10_000)
    assert.equal(fake.connects(), 0)
    assert.deepEqual(events, [{ kind: 'stop', code: CLOSE_INVALID_DOC_ID }])
  })

  it('cancel 뒤에는 걸어 둔 재접속도, 이후 끊김에 대한 재접속도 하지 않음', () => {
    const fake = fakeProvider()
    const reconnector = attachReconnect(fake.provider, () => {}, noJitter)

    fake.close(CLOSE_ABNORMAL)
    reconnector.cancel()
    fake.close(CLOSE_ABNORMAL)
    mock.timers.tick(10_000)
    assert.equal(fake.connects(), 0)
  })
})
