// 관계선의 모양을 계산하는 순수 함수 모음

// 캔버스 좌표의 table 사각형, x·y = 왼쪽 위
export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

// 관계선이 table에 닿는 점과 table 바깥을 향하는 방향 (dx, dy는 -1, 0, 1 중 하나)
export type Anchor = {
  x: number
  y: number
  dx: number
  dy: number
}

// path: SVG path의 d 값, parent·child: 부모 쪽 끝, 자식 쪽 끝 (마커를 그릴 위치)
export type RelationGeometry = {
  path: string
  parent: Anchor
  child: Anchor
}

// 관계선이 table 변에서 수직으로 빠져나오는 길이
const STUB = 24
// 자기 참조 고리가 table 오른쪽으로 튀어나오는 길이
const LOOP_OUT = 40

// 소수 첫째 자리까지 반올림, path 문자열을 짧게 유지
function round(value: number): number {
  return Math.round(value * 10) / 10
}

// 점 배열을 'M x y L x y ...' 형식의 SVG path로 변환
function toPath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join(' ')
}

// rect의 4변 중 other 쪽을 향한 변의 가운데 점을 선택
// 두 중심의 가로 차이가 세로 차이 이상이면 왼쪽·오른쪽 변, 아니면 위·아래 변
export function nearestAnchor(rect: Rect, other: Rect): Anchor {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const dx = other.x + other.width / 2 - cx
  const dy = other.y + other.height / 2 - cy

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { x: rect.x + rect.width, y: cy, dx: 1, dy: 0 }
      : { x: rect.x, y: cy, dx: -1, dy: 0 }
  }
  return dy >= 0
    ? { x: cx, y: rect.y + rect.height, dx: 0, dy: 1 }
    : { x: cx, y: rect.y, dx: 0, dy: -1 }
}

// 부모와 자식 table을 잇는 관계선, 같은 table이면 오른쪽 변에 고리를 그림
export function relationGeometry(parentRect: Rect, childRect: Rect, selfLoop: boolean): RelationGeometry {
  if (selfLoop) {
    // 오른쪽 변의 30% 높이에서 나가 70% 높이로 돌아오는 ㄷ자 고리
    const right = parentRect.x + parentRect.width
    const parent = { x: right, y: parentRect.y + parentRect.height * 0.3, dx: 1, dy: 0 }
    const child = { x: right, y: parentRect.y + parentRect.height * 0.7, dx: 1, dy: 0 }
    const outX = right + LOOP_OUT
    return {
      path: toPath([parent, { x: outX, y: parent.y }, { x: outX, y: child.y }, child]),
      parent,
      child,
    }
  }

  const parent = nearestAnchor(parentRect, childRect)
  const child = nearestAnchor(childRect, parentRect)
  return {
    // 각 변에서 STUB만큼 수직으로 나온 뒤 두 점을 직선으로 연결
    path: toPath([
      parent,
      { x: parent.x + parent.dx * STUB, y: parent.y + parent.dy * STUB },
      { x: child.x + child.dx * STUB, y: child.y + child.dy * STUB },
      child,
    ]),
    parent,
    child,
  }
}

// '1' 마커: 끝점에서 11px 떨어진 곳에 선과 수직인 짧은 막대
export function oneMarker(anchor: Anchor): string {
  // (px, py): 선 방향(dx, dy)을 90도 돌린 방향
  const px = -anchor.dy
  const py = anchor.dx
  const t = 11
  const s = 6
  const cx = anchor.x + anchor.dx * t
  const cy = anchor.y + anchor.dy * t
  return `M${round(cx + px * s)} ${round(cy + py * s)} L${round(cx - px * s)} ${round(cy - py * s)}`
}

// 'N' 마커: 끝점에서 13px 떨어진 한 점에서 table 변으로 퍼지는 3개의 선
export function manyMarker(anchor: Anchor): string {
  const px = -anchor.dy
  const py = anchor.dx
  const t = 13
  const s = 7
  const qx = round(anchor.x + anchor.dx * t)
  const qy = round(anchor.y + anchor.dy * t)
  const ends = [
    { x: anchor.x + px * s, y: anchor.y + py * s },
    { x: anchor.x, y: anchor.y },
    { x: anchor.x - px * s, y: anchor.y - py * s },
  ]
  return ends.map((end) => `M${qx} ${qy} L${round(end.x)} ${round(end.y)}`).join(' ')
}
