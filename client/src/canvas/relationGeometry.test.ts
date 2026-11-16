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

describe('markers', () => {
  const anchor = { x: 100, y: 50, dx: 1, dy: 0 }

  it('1 마커는 선과 수직인 막대 1개', () => {
    expect(oneMarker(anchor)).toBe('M111 56 L111 44')
  })

  it('N 마커는 한 점에서 퍼지는 선 3개', () => {
    expect(manyMarker(anchor)).toBe('M113 50 L100 57 M113 50 L100 50 M113 50 L100 43')
  })
})
