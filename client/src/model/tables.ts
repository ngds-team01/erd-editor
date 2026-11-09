import * as Y from 'yjs'
import { addColumn, sortColumns } from './columns'
import { DEFAULT_TABLE_COLOR, getTables } from './schema'
import type { ColumnData, Position, TableData, TableMap } from './schema'

// Table을 생성할 때 받는 입력값, id, color, columns, uniques는 createTable에서 설정
export type NewTable = {
  logicalName: string
  physicalName: string
  position: Position
}

// Table 이동 1건
export type TableMove = {
  id: string
  position: Position
}

// doc 내 새 Table 생성, column과 동일한 ID 생성 규칙(2.7), 첫 column은 pk(id) 자동 생성
// 첫 column은 pk이므로 unique는 기본값 false (2.3)
export function createTable(doc: Y.Doc, input: NewTable): string {
  const id = crypto.randomUUID()

  doc.transact(() => {
    const table: TableMap = new Y.Map()
    table.set('id', id)
    table.set('logicalName', input.logicalName)
    table.set('physicalName', input.physicalName)
    table.set('position', input.position)
    table.set('color', DEFAULT_TABLE_COLOR)
    table.set('columns', new Y.Map())
    table.set('uniques', new Y.Map())
    getTables(doc).set(id, table)

    addColumn(doc, id, {
      physicalName: 'id',
      type: 'BIGINT',
      pk: true,
      notNull: true,
      autoIncrement: true,
    })
  })

  return id
}

// position: {x, y}를 한 transaction에  이동, 이동 대상 table 삭제 시 동작 수행 X
export function moveTables(doc: Y.Doc, moves: TableMove[]): void {
  const tables = getTables(doc)

  doc.transact(() => {
    for (const move of moves) {
      tables.get(move.id)?.set('position', move.position)
    }
  })
}

// Y.Map인 Table을 toJSON으로 일반 객체(TableData)로 변환
// columns는 순서 없는 객체로 나오므로 order → id로 정렬한 배열로 교체 (모든 클라이언트에서 같은 순서)
export function readTable(table: TableMap): TableData {
  const json = table.toJSON() as Omit<TableData, 'columns'> & {
    columns: Record<string, ColumnData>
  }

  return {
    ...json,
    columns: sortColumns(Object.values(json.columns)),
  }
}

// doc 내 모든 Table Read
export function readTables(doc: Y.Doc): TableData[] {
  return [...getTables(doc).values()].map(readTable)
}
