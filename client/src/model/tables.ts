import * as Y from 'yjs'
import { addColumn, sortColumns } from './columns'
import { deleteRelation } from './relations'
import { DEFAULT_TABLE_COLOR, getRelations, getTables, writeChanged } from './schema'
import type { ColumnData, Position, TableData, TableMap, UniqueData } from './schema'

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
// 편집 패널에서 변경 가능한 Table 요소 type
export type TablePatch = Partial<Pick<TableData, 'logicalName' | 'physicalName' | 'color'>>
// table의 이름과 색상을 변경하는 함수
export function updateTable(doc: Y.Doc, id: string, patch: TablePatch): boolean {
  const table = getTables(doc).get(id)
  if (!table) {
    return false
  }

  doc.transact(() => writeChanged(table, patch))
  return true
}

// Table 삭제를 위한 함수, 연결된 관계가 있다면 해당 관계도 같이 끊어지게 된다
export function deleteTable(doc: Y.Doc, id: string): boolean {
  const tables = getTables(doc)
  if (!tables.has(id)) {
    return false
  }

  const relations = getRelations(doc)

  doc.transact(() => {
    for (const [relationId, relation] of [...relations.entries()]) {
      if (relation.get('fromTable') === id || relation.get('toTable') === id) {
        deleteRelation(doc, relationId)
      }
    }
    tables.delete(id)
  })

  return true
}

// Y.Map인 Table을 toJSON으로 일반 객체(TableData)로 변환
// columns는 순서 없는 객체로 나오므로 order → id로 정렬한 배열로 교체 (모든 클라이언트에서 같은 순서)
export function readTable(table: TableMap): TableData {
  const json = table.toJSON() as Omit<TableData, 'columns' | 'uniques'> & {
    columns: Record<string, ColumnData>
    uniques: Record<string, UniqueData>
  }

  return {
    ...json,
    columns: sortColumns(Object.values(json.columns)),
    uniques: Object.values(json.uniques).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

// doc 내 모든 Table Read
export function readTables(doc: Y.Doc): TableData[] {
  return [...getTables(doc).values()].map(readTable)
}

//Y.Doc의 변경사항을 감시, 어떤 Table이 바뀌었는지 명시하는 함수
// onChange: 바뀐 table id들을 받아 처리할 함수, 반환값: 구독 해제 함수
export function observeTables(
  doc: Y.Doc,
  onChange: (tableIds: Set<string>) => void,
): () => void {
  const tables = getTables(doc)

  // transaction이 끝날 때 변경 목록(events)을 받아 1번 호출됨, 로컬·원격 변경 모두 해당
  const observer: Parameters<typeof tables.observeDeep>[0] = (events) => {
    // 한 transaction에서 같은 table이 여러 번 바뀌어도 id는 1개만 남음
    const tableIds = new Set<string>()

    for (const event of events) {
      // path: tables에서 변경된 Y.Map까지의 경로, path[0] = table id
      if (event.path.length > 0) {
        tableIds.add(String(event.path[0]))
      } else {
        // path가 비어 있으면 tables 자체의 변경(table 추가·삭제), 변경된 key = table id
        for (const key of event.changes.keys.keys()) {
          tableIds.add(key)
        }
      }
    }

    onChange(tableIds)
  }

  // 중첩된 Y.Map(table, columns, column)의 변경까지 감시
  tables.observeDeep(observer)
  return () => tables.unobserveDeep(observer)
}
