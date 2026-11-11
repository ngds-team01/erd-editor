import * as Y from 'yjs'
import { getTables } from './schema'
import type { ColumnData, ColumnMap } from './schema'

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
