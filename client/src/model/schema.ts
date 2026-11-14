import * as Y from 'yjs'

// ERD Table의 x, y 좌표 - 동시 편집 시 atomic
export type Position = {
  x: number
  y: number
}

// ERD Table을 구성하는 각 Column에 들어가는 값
export type ColumnData = {
  id: string
  logicalName: string
  physicalName: string
  type: string
  pk: boolean
  notNull: boolean
  unique: boolean
  autoIncrement: boolean
  default: string | null
  comment: string | null
  order: number
}

// 복합 UQ의 type 명시
export type UniqueData = {
  id: string
  name: string | null
  columnIds: string[]
}

// ERD Table에 대한 정보
export type TableData = {
  id: string
  logicalName: string
  physicalName: string
  position: Position
  color: string
  columns: ColumnData[]
  // Table 내에서 복합 UQ를 관리(복합 UQ는 여러 개 설정 가능)
  uniques: UniqueData[]
}

// 관계선을 위한 Entity 간의 Relation
export type Cardinality = '1:1' | '1:N'

// Table 간의 관계선을 나타냄
export type RelationData = {
  id: string
  fromTable: string // 부모 Table
  toTable: string // 자식 Table
  toColumn?: string
  cardinality: Cardinality
  identifying: boolean
}

// ColumnMap, TableMap은 ColumnData와 TableData를 화면에서 동시 편집이
// 가능하도록 각 element를 Map 구조로 표현한 type(position은 {x, y} 가 하나의 단위)
export type ColumnMap = Y.Map<unknown>
export type TableMap = Y.Map<unknown>
export type UniqueMap = Y.Map<unknown>
export type RelationMap = Y.Map<unknown>

// table 기본 색상은 #3b6fe0
export const DEFAULT_TABLE_COLOR = '#3b6fe0'

// Table 팔레트
export const TABLE_COLORS = [
  { name: '빨간색', value: '#d64545' },
  { name: '주황색', value: '#d9730d' },
  { name: '노란색', value: '#d4a72c' },
  { name: '초록색', value: '#2f9a5b' },
  { name: '파란색', value: '#3b6fe0' },
  { name: '보라색', value: '#8a63d2' },
  { name: '분홍색', value: '#d6589a' },
  { name: '갈색', value: '#9a6b4f' },
  { name: '회색', value: '#5b6472' },
  { name: '검정색', value: '#37352f' },
] as const

//물리명 - 64자 : MySQL 식별자 한도, 논리명 최대 20자 (2.2, 2.3)
export const MAX_LOGICAL_NAME = 20
export const MAX_PHYSICAL_NAME = 64

// 생성된 Y.Doc 내 모든 Table을 최상위 Y.Map으로 반환 → 중첩 Y.Map 구조, key = table id
export function getTables(doc: Y.Doc): Y.Map<TableMap> {
  return doc.getMap<TableMap>('tables')
}

// getTables와 동일 → Y.Doc 내 Table 간의 모든 Relation 반환
export function getRelations(doc: Y.Doc): Y.Map<RelationMap> {
  return doc.getMap<RelationMap>('relations')
}

// Table 내 columns Y.Map 반환
export function getColumns(table: TableMap): Y.Map<ColumnMap> {
  return table.get('columns') as Y.Map<ColumnMap>
}

// 복합 UQ List 반환
export function getUniques(table: TableMap): Y.Map<UniqueMap> {
  return table.get('uniques') as Y.Map<UniqueMap>
}

// Table, Column, Relation, 복합 UQ 모두 해당 function을 통해 값을 write
// 모두 Y.Map 기반이므로 이 함수로 변화를 일괄 처리할 수 있다. 실제 변화한 요소만 update를 진행
export function writeChanged(map: Y.Map<unknown>, patch: object): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && map.get(key) !== value) {
      map.set(key, value)
    }
  }
}
