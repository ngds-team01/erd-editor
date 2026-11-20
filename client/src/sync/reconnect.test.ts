import { describe, expect, it } from 'vitest'
import { CLOSE_INVALID_DOC_ID, CLOSE_SERVICE_RESTART, reconnectDelay } from './reconnect'

// 항상 같은 값을 돌려주는 가짜 random
const fixed = (value: number) => () => value
// 지터가 없는 가운데 값 (0.8 + 0.4 × 0.5 = 1배)
const middle = fixed(0.5)
// 비정상 끊김의 close code
const ABNORMAL = 1006

describe('reconnectDelay', () => {
  it('4400이면 재접속하지 않음', () => {
    expect(reconnectDelay(CLOSE_INVALID_DOC_ID, 0, middle)).toBeNull()
    expect(reconnectDelay(CLOSE_INVALID_DOC_ID, 5, middle)).toBeNull()
  })

  it('1012면 0~500ms 무작위 지연', () => {
    expect(reconnectDelay(CLOSE_SERVICE_RESTART, 0, fixed(0))).toBe(0)
    expect(reconnectDelay(CLOSE_SERVICE_RESTART, 0, fixed(0.999))).toBeCloseTo(499.5)
  })

  it('1012는 실패 횟수와 상관없이 500ms 이내', () => {
    expect(reconnectDelay(CLOSE_SERVICE_RESTART, 10, fixed(0.999))).toBeLessThan(500)
  })

  it('그 외에는 0.5s → 1s → 2s로 두 배씩 늘어남', () => {
    expect(reconnectDelay(ABNORMAL, 0, middle)).toBe(500)
    expect(reconnectDelay(ABNORMAL, 1, middle)).toBe(1000)
    expect(reconnectDelay(ABNORMAL, 2, middle)).toBe(2000)
    expect(reconnectDelay(ABNORMAL, 4, middle)).toBe(8000)
  })

  it('최대 10s에서 멈춤', () => {
    expect(reconnectDelay(ABNORMAL, 5, middle)).toBe(10_000)
    expect(reconnectDelay(ABNORMAL, 50, middle)).toBe(10_000)
  })

  it('지터는 ±20%', () => {
    expect(reconnectDelay(ABNORMAL, 1, fixed(0))).toBeCloseTo(800)
    expect(reconnectDelay(ABNORMAL, 1, fixed(0.999))).toBeCloseTo(1199.6)
    expect(reconnectDelay(ABNORMAL, 50, fixed(0.999))).toBeLessThan(12_000)
  })

  it('정상 종료(1000)도 백오프로 재접속', () => {
    expect(reconnectDelay(1000, 0, middle)).toBe(500)
  })
})
