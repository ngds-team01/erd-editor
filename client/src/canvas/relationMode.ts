import type { RelationData } from '../model'

// 툴바 관계 버튼 1개가 정하는 값: 카디널리티 × 식별 여부 (2.5)
export type RelationKind = Pick<RelationData, 'cardinality' | 'identifying'>

// 관계 모드 상태, parentId: 첫 번째로 클릭한 부모 table id (아직 고르지 않았으면 null)
// 내 화면에만 있는 값, Y.Doc에 저장하지 않음
export type RelationMode = {
  kind: RelationKind
  parentId: string | null
}

// 두 버튼이 같은 종류인지 비교
export function sameKind(a: RelationKind, b: RelationKind): boolean {
  return a.cardinality === b.cardinality && a.identifying === b.identifying
}
