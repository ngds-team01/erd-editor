import { describe, expect, it } from 'vitest'
import { manyMarker, nearestAnchor, oneMarker, relationGeometry } from './relationGeometry'
import type { Rect } from './relationGeometry'

const box = (x: number, y: number): Rect => ({ x, y, width: 200, height: 100 })

describe('nearestAnchor', () => {
  it('상대가 오른쪽에 있으면 오른쪽 변 가운데', () => {
    expect(nearestAnchor(box(0, 0), box(400, 20))).toEqual({ x: 200, y: 50, dx: 1, dy: 0 })
  })

  it('상대가 왼쪽에 있으면 왼쪽 변 가운데', () => {
    expect(nearestAnchor(box(400, 0), box(0, 0))).toEqual({ x: 400, y: 50, dx: -1, dy: 0 })
  })

  it('세로 차이가 더 크면 아래·위 변을 고름', () => {
    expect(nearestAnchor(box(0, 0), box(50, 400))).toEqual({ x: 100, y: 100, dx: 0, dy: 1 })
    expect(nearestAnchor(box(50, 400), box(0, 0))).toEqual({ x: 150, y: 400, dx: 0, dy: -1 })
  })
})

describe('relationGeometry', () => {
  it('두 table의 마주 보는 변을 STUB만큼 꺾어 연결', () => {
    const g = relationGeometry(box(0, 0), box(400, 0), false)
    expect(g.parent).toEqual({ x: 200, y: 50, dx: 1, dy: 0 })
    expect(g.child).toEqual({ x: 400, y: 50, dx: -1, dy: 0 })
    expect(g.path).toBe('M200 50 L224 50 L376 50 L400 50')
  })

  it('자기 참조는 오른쪽 변에 고리를 그림', () => {
    const g = relationGeometry(box(0, 0), box(0, 0), true)
    expect(g.parent).toEqual({ x: 200, y: 30, dx: 1, dy: 0 })
    expect(g.child).toEqual({ x: 200, y: 70, dx: 1, dy: 0 })
    expect(g.path).toBe('M200 30 L240 30 L240 70 L200 70')
  })
})

describe('label', () => {
  it('두 table 사이 직선 구간의 가운데', () => {
    // 꺾이는 점 (224, 50)과 (376, 50)의 중점
    expect(relationGeometry(box(0, 0), box(400, 0), false).label).toEqual({ x: 300, y: 50 })
  })

  it('비스듬한 직선이면 가로·세로 모두 가운데', () => {
    // 부모 아래 변 (100, 100) → (100, 124), 자식 위 변 (350, 400) → (350, 376)
    expect(relationGeometry(box(0, 0), box(250, 400), false).label).toEqual({ x: 225, y: 250 })
  })

  it('자기 참조는 고리 바깥쪽 세로선의 가운데', () => {
    // 세로선 (240, 30) → (240, 70)
    expect(relationGeometry(box(0, 0), box(0, 0), true).label).toEqual({ x: 240, y: 50 })
  })

  it('소수 첫째 자리까지 반올림', () => {
    // 꺾이는 점 (224, 50)과 (376.25, 50.15)의 중점 = (300.125, 50.075)
    const child = { x: 400.25, y: 0.15, width: 200, height: 100 }
    expect(relationGeometry(box(0, 0), child, false).label).toEqual({ x: 300.1, y: 50.1 })
  })
})

describe('markers', () => {
  const anchor = { x: 100, y: 50, dx: 1, dy: 0 }

  it('1 마커는 선과 수직인 막대 1개', () => {
    expect(oneMarker(anchor)).toBe('M111 56 L111 44')
  })

  it('N 마커는 한 점에서 퍼지는 선 3개', () => {
    expect(manyMarker(anchor)).toBe('M113 50 L100 57 M113 50 L100 50 M113 50 L100 43')
  })
})
