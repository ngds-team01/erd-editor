// Y.Doc의 table을 React Flow node로 바꾸는 함수 (Canvas.tsx가 씀)
// 화면 없이 계산만 하므로 따로 테스트함 (tableNodes.test.ts)
import type * as Y from 'yjs'
import { getTables, readTable, readTables } from '../model'
import type { TableData } from '../model'
import type { TableNodeType } from './TableNode'

// position이 비어 있으면 node를 만들지 않고 위치가 도착한 뒤 그림
function hasPosition(table: TableData): boolean {
  return (table.position as TableData['position'] | undefined) !== undefined
}

// TableData를 React Flow - Node 형식으로 변환
function toNode(table: TableData, doc: Y.Doc, onOpen: (tableId: string) => void): TableNodeType {
  return {
    id: table.id,
    type: 'table',
    position: table.position,
    data: { table, doc, onOpen },
  }
}

// 첫 렌더링 때 문서 전체를 읽어 node 배열을 만듦, 위치가 비어 있는 table은 위치가 도착한 뒤 mergeTables가 추가함
export function readNodes(doc: Y.Doc, onOpen: (tableId: string) => void): TableNodeType[] {
  return readTables(doc)
    .filter(hasPosition)
    .map((table) => toNode(table, doc, onOpen))
}

// 바뀐 table만 Y.Doc에서 다시 읽어 node 배열에 반영
// table이 갱신 단위이며, column 변경도 소속 table id로 들어와 table 전체를 다시 읽음
export function mergeTables(
  nodes: TableNodeType[],
  doc: Y.Doc,
  onOpen: (tableId: string) => void,
  changedIds: Set<string>,
): TableNodeType[] {
  const tables = getTables(doc)
  // 이미 화면에 있는 node의 id, 새 table을 구분하는 데 사용
  const knownIds = new Set(nodes.map((node) => node.id))

  // flatMap: 배열을 반환해 이어 붙임, [node] = 유지, [] = 제거
  const updated = nodes.flatMap((node) => {
    // 안 바뀐 node는 같은 객체를 유지해 memo가 다시 그리지 않게 함
    if (!changedIds.has(node.id)) {
      return [node]
    }

    // Y.Doc에 없으면 삭제된 table이므로 node 제거
    const tableMap = tables.get(node.id)
    if (!tableMap) {
      return []
    }

    const table = readTable(tableMap)
    //table update를 위해 이전 위치 삭제한 직후 접속한 경우 position이 비어 있는 현상 해결
    // 화면 이전 위치 유지, update 도착 시 이동 함수 호출
    const position = (table.position as TableData['position'] | undefined) ?? node.position
    return [
      {
        // selected, measured 등 React Flow가 관리하는 값 유지
        ...node,
        // 드래그 중이면 화면 위치 유지, Y.Doc 값은 최대 50ms 과거라 쓰면 node가 뒤로 튐
        position: node.dragging ? node.position : position,
        data: { table, doc, onOpen },
      },
    ]
  })

  // Y.Doc에는 있지만 화면에 없는 id = 새로 추가된 table
  // 위치가 비어 있으면 이번에는 건너뜀, 위치가 도착하면 다시 호출돼 그때 추가
  const added = [...changedIds].flatMap((id) => {
    const tableMap = tables.get(id)
    if (!tableMap || knownIds.has(id)) {
      return []
    }
    const table = readTable(tableMap)
    return hasPosition(table) ? [toNode(table, doc, onOpen)] : []
  })

  return [...updated, ...added]
}
