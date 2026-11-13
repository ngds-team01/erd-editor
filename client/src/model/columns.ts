import * as Y from 'yjs'
import { getColumns, getRelations, getTables, getUniques, writeChanged } from './schema'
import type { ColumnData, ColumnMap, TableMap } from './schema'

// sortColumns가 정렬에 사용하는 ColumnData 최소 필드
type SortableColumn = Pick<ColumnData, 'id' | 'order'>

// ColumnData를 생성할 때 physicalName과 type은 필수, id와 order는 addColumn에서 설정
export type NewColumn = Pick<ColumnData, 'physicalName' | 'type'> &
  Partial<Omit<ColumnData, 'id' | 'physicalName' | 'type' | 'order'>>

// Column 정렬 기준은 1. order값 기준 판정
// 2. 같을 경우 id 기준 판정(동시에 같은 order에 column을 생성한 경우)
export function sortColumns<T extends SortableColumn>(columns: T[]): T[] {
  return [...columns].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order
    }
    if (a.id === b.id) {
      return 0
    }
    return a.id < b.id ? -1 : 1
  })
}

// Table에 column 최초 생성 시 order = 1, 
// 아니라면 column 중 가장 큰 order를 부여(priority는 최하)
function nextOrder(columns: Y.Map<ColumnMap>): number {
  if (columns.size === 0) {
    return 1
  }

  const orders = [...columns.values()].map((column) => column.get('order') as number)
  return Math.max(...orders) + 1
}

// doc의 tableId에 해당하는 table을 가져와 새로운 column 삽입(transaction 단위 처리), id 부여
// (table이 없다면 null 반환)
export function addColumn(doc: Y.Doc, tableId: string, input: NewColumn): string | null {
  const table = getTables(doc).get(tableId)
  if (!table) {
    return null
  }

  const columns = table.get('columns') as Y.Map<ColumnMap>
  // contracts 2.7에 의한 ID 생성 방식
  const id = crypto.randomUUID()

  doc.transact(() => {
    const column: ColumnMap = new Y.Map()
    column.set('id', id)
    column.set('logicalName', input.logicalName ?? '')
    column.set('physicalName', input.physicalName)
    column.set('type', input.type)
    column.set('pk', input.pk ?? false)
    column.set('notNull', input.notNull ?? false)
    column.set('unique', input.unique ?? false)
    column.set('autoIncrement', input.autoIncrement ?? false)
    column.set('default', input.default ?? null)
    column.set('comment', input.comment ?? null)
    column.set('order', nextOrder(columns))
    columns.set(id, column)
  })

  return id
}

// 기본 이름(column_{개수+1})과 타입(VARCHAR(255))으로 column 추가, Table Node와 편집 패널의 + 컬럼 버튼이 공유
export function addNextColumn(doc: Y.Doc, tableId: string): string | null {
  const table = getTables(doc).get(tableId)
  if (!table) {
    return null
  }

  return addColumn(doc, tableId, {
    physicalName: `column_${getColumns(table).size + 1}`,
    type: 'VARCHAR(255)',
  })
}

// updateColumn에 넘기는 변경 값 묶음. id / order는 제외
export type ColumnPatch = Partial<Omit<ColumnData, 'id' | 'order'>>

// TableId와 ColumnId를 기반으로 Y.Doc 내 Y.Map(ColumnData) 탐색
function findColumn(doc: Y.Doc, tableId: string, columnId: string): ColumnMap | undefined {
  const table = getTables(doc).get(tableId)
  return table && getColumns(table).get(columnId)
}

// Table 내 Column을 화면 출력 순으로 정렬
export function sortedColumnMaps(table: TableMap): ColumnMap[] {
  const entries = [...getColumns(table).values()].map((column) => ({
    id: column.get('id') as string,
    order: column.get('order') as number,
    column,
  }))
  return sortColumns(entries).map((entry) => entry.column)
}

// write 수행을 위한 Column을 탐색 후 변경 내역만 transaction 단위 기록
export function updateColumn(
  doc: Y.Doc,
  tableId: string,
  columnId: string,
  patch: ColumnPatch,
): boolean {
  const column = findColumn(doc, tableId, columnId)
  if (!column) {
    return false
  }

  doc.transact(() => {
    writeChanged(column, patch)
    if (patch.pk === true) {
      writeChanged(column, { unique: false })
    }
  })

  return true
}

// transcation 단위 내에서 column 삭제 및 UQ, fk 관련 삭제 처리도 진행
export function deleteColumn(doc: Y.Doc, tableId: string, columnId: string): boolean {
  const table = getTables(doc).get(tableId)
  if (!table || !getColumns(table).has(columnId)) {
    return false
  }

  const relations = getRelations(doc)

  doc.transact(() => {
    for (const [relationId, relation] of [...relations.entries()]) {
      if (relation.get('toTable') === tableId && relation.get('toColumn') === columnId) {
        relations.delete(relationId)
      }
    }

    for (const unique of getUniques(table).values()) {
      const columnIds = unique.get('columnIds') as string[]
      if (columnIds.includes(columnId)) {
        unique.set(
          'columnIds',
          columnIds.filter((id) => id !== columnId),
        )
      }
    }

    getColumns(table).delete(columnId)
  })

  return true
}

// Column의 Table 내 순서 변경 → order 값을 변경시킴으로써 화면 출력 순서 변경
// 옮기는 column의 order를 앞뒤 column order의 중간값으로 변경
export function moveColumn(
  doc: Y.Doc,
  tableId: string,
  columnId: string,
  toIndex: number,
): boolean {
  const table = getTables(doc).get(tableId)
  const column = table && getColumns(table).get(columnId)
  if (!table || !column) {
    return false
  }

  const sorted = sortedColumnMaps(table)
  const others = sorted.filter((other) => other !== column)
  const index = Math.min(Math.max(toIndex, 0), others.length)
  if (sorted.indexOf(column) === index) {
    return false
  }

  const prev = others[index - 1]?.get('order') as number | undefined
  const next = others[index]?.get('order') as number | undefined
  const order = orderBetween(prev, next)

  doc.transact(() => {
    if (order !== null) {
      column.set('order', order)
      return
    }

    const reordered = [...others.slice(0, index), column, ...others.slice(index)]
    reordered.forEach((target, position) => {
      writeChanged(target, { order: position + 1 })
    })
  })

  return true
}

// moveColumn에서 Column 이동 작업을 수행하기 위해 Column에 부여할 새로운 order를 계산하는 function
// 앞뒤 사이에 넣을 값이 없으면 null
function orderBetween(prev: number | undefined, next: number | undefined): number | null {
  if (prev === undefined) {
    return (next as number) - 1
  }
  if (next === undefined) {
    return prev + 1
  }

  const middle = (prev + next) / 2
  return prev < middle && middle < next ? middle : null
}
