import * as Y from 'yjs'
import { sortedColumnMaps } from './columns'
import { getTables, getUniques, writeChanged } from './schema'
import type { UniqueData, UniqueMap } from './schema'

// 복합 UQ의 name 추출
export type UniquePatch = Partial<Pick<UniqueData, 'name'>>

// columns.ts의 findColumn와 유사
function findUnique(doc: Y.Doc, tableId: string, uniqueId: string): UniqueMap | undefined {
  const table = getTables(doc).get(tableId)
  return table && getUniques(table).get(uniqueId)
}

// 복합 UQ를 추가하기 위한 function
export function addUnique(doc: Y.Doc, tableId: string): string | null {
  const table = getTables(doc).get(tableId)
  if (!table) {
    return null
  }

  const id = crypto.randomUUID()

  doc.transact(() => {
    const unique: UniqueMap = new Y.Map()
    unique.set('id', id)
    unique.set('name', null)
    unique.set('columnIds', [])
    getUniques(table).set(id, unique)
  })

  return id
}

//복합 UQ 이름 수정
export function updateUnique(
  doc: Y.Doc,
  tableId: string,
  uniqueId: string,
  patch: UniquePatch,
): boolean {
  const unique = findUnique(doc, tableId, uniqueId)
  if (!unique) {
    return false
  }

  doc.transact(() => writeChanged(unique, patch))
  return true
}

// 편집 패널에서 복합 UQ 작업을 수행. columnsId 목록을 통해 새로운 Set을 생성
// 복합 UQ 화면 표시 시 Table의 Column 정렬 기준으로 복합 UQ element도 정렬
export function toggleUniqueColumn(
  doc: Y.Doc,
  tableId: string,
  uniqueId: string,
  columnId: string,
): boolean {
  const table = getTables(doc).get(tableId)
  const unique = findUnique(doc, tableId, uniqueId)
  if (!table || !unique) {
    return false
  }

  const selected = new Set(unique.get('columnIds') as string[])
  if (selected.has(columnId)) {
    selected.delete(columnId)
  } else {
    selected.add(columnId)
  }

  const columnIds = sortedColumnMaps(table)
    .map((column) => column.get('id') as string)
    .filter((id) => selected.has(id))

  doc.transact(() => unique.set('columnIds', columnIds))
  return true
}

// 복합 UQ 삭제
export function deleteUnique(doc: Y.Doc, tableId: string, uniqueId: string): boolean {
  const table = getTables(doc).get(tableId)
  if (!table || !getUniques(table).has(uniqueId)) {
    return false
  }

  doc.transact(() => getUniques(table).delete(uniqueId))
  return true
}
