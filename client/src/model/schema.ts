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

// ERD Table에 대한 정보
export type TableData = {
  id: string
  logicalName: string
  physicalName: string
  position: Position
  color: string
  columns: ColumnData[]
}

// ColumnMap, TableMap은 ColumnData와 TableData를 화면에서 동시 편집이
// 가능하도록 각 element를 Map 구조로 표현한 type(position은 {x, y} 가 하나의 단위)
export type ColumnMap = Y.Map<unknown>
export type TableMap = Y.Map<unknown>

// table 기본 색상은 #3b6fe0
export const DEFAULT_TABLE_COLOR = '#3b6fe0'

// 생성된 Y.Doc 내 모든 Table을 최상위 Y.Map으로 반환 → 중첩 Y.Map 구조, key = table id
export function getTables(doc: Y.Doc): Y.Map<TableMap> {
  return doc.getMap<TableMap>('tables')
}
