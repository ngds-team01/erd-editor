import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { applyNodeChanges, Background, BackgroundVariant, ReactFlow, useReactFlow } from '@xyflow/react'
import type { NodeChange, NodeTypes, ReactFlowProps, SnapGrid } from '@xyflow/react'
import type * as Y from 'yjs'
import { deleteTables, getTables, moveTables, observeTables, readTable, readTables } from '../model'
import type { TableData } from '../model'
import { TableNode } from './TableNode'
import type { TableNodeType } from './TableNode'

// key: node의 type, value: node Component(TableNode)
const nodeTypes: NodeTypes = { table: TableNode }
//가로, 세로 간격
const SNAP_GRID: SnapGrid = [10, 10]
//처음 화면 배율 : 1, 캔버스 좌표 (0, 0) = 화면 (40, 40)
const DEFAULT_VIEWPORT = { x: 40, y: 40, zoom: 1 }
// 드래그 중 Y.Doc에 position을 쓰는 최소 간격 (2.7)
const DRAG_WRITE_INTERVAL_MS = 50

// Canvas가 읽고 쓰는 문서, onOpenTable: table node를 더블클릭하거나 ⋯ 버튼을 눌렀을 때 편집 패널을 열 함수
type CanvasProps = {
  doc: Y.Doc
  onOpenTable: (tableId: string) => void
  onSelectTable: (tableId: string) => void
  onClosePanel: () => void
}

// ReactFlow가 호출하는 드래그 이벤트 4개만 고른 type
// onNodeDrag: node를 끄는 동안 반복 호출, onNodeDragStop: node를 놓을 때 1번 호출
// onSelectionDrag, onSelectionDragStop: Shift 박스로 묶은 선택 영역을 끌 때의 같은 이벤트
type DragHandlers = Pick<
  ReactFlowProps<TableNodeType>,
  'onNodeDrag' | 'onNodeDragStop' | 'onSelectionDrag' | 'onSelectionDragStop'
>

// TableData를 React Flow - Node 형식으로 변환
function toNode(table: TableData, doc: Y.Doc, onOpen: (tableId: string) => void): TableNodeType {
  return {
    id: table.id,
    type: 'table',
    position: table.position,
    data: { table, doc, onOpen },
  }
}

// 바뀐 table만 Y.Doc에서 다시 읽어 node 배열에 반영
// table이 갱신 단위이며, column 변경도 소속 table id로 들어와 table 전체를 다시 읽음
function mergeTables(
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
    return [
      {
        // selected, measured 등 React Flow가 관리하는 값 유지
        ...node,
        // 드래그 중이면 화면 위치 유지, Y.Doc 값은 최대 50ms 과거라 쓰면 node가 뒤로 튐
        position: node.dragging ? node.position : table.position,
        data: { table, doc, onOpen },
      },
    ]
  })

  // Y.Doc에는 있지만 화면에 없는 id = 새로 추가된 table
  const added = [...changedIds].flatMap((id) => {
    const tableMap = tables.get(id)
    return tableMap && !knownIds.has(id) ? [toNode(readTable(tableMap), doc, onOpen)] : []
  })

  return [...updated, ...added]
}

function isCanvasTarget(target: EventTarget | null): boolean {
  return (
    target === document.body ||
    (target instanceof Element && target.closest('.canvas-wrap') !== null)
  )
}

// 드래그 이벤트를 Y.Doc 쓰기로 연결하는 함수 묶음을 생성
function createDragHandlers(doc: Y.Doc): DragHandlers {
  // 마지막 쓰기 시각, 아래 함수들이 클로저로 계속 기억함
  let lastWrite = 0

  // node에서 id, position만 꺼내 한 transaction으로 저장
  function writePositions(moved: TableNodeType[]) {
    moveTables(
      doc,
      moved.map(({ id, position }) => ({ id, position })),
    )
  }

  // 마지막 쓰기 후 50ms가 지나지 않았으면 건너뜀 (2.7)
  function writeThrottled(moved: TableNodeType[]) {
    const now = performance.now()
    if (now - lastWrite < DRAG_WRITE_INTERVAL_MS) {
      return
    }

    lastWrite = now
    writePositions(moved)
  }

  // Drag: 드래그 중 50ms 제한으로 쓰기, DragStop: 놓을 때 제한 없이 마지막 위치 쓰기
  // moved: 함께 움직인 node 전체, _로 시작하는 인자는 사용하지 않음
  return {
    onNodeDrag: (_event, _node, moved) => writeThrottled(moved),
    onNodeDragStop: (_event, _node, moved) => writePositions(moved),
    onSelectionDrag: (_event, moved) => writeThrottled(moved),
    onSelectionDragStop: (_event, moved) => writePositions(moved),
  }
}

// 최소 20%, 최대 250% 줌 적용 가능
export function Canvas({ doc, onOpenTable, onSelectTable, onClosePanel }: CanvasProps) {
  // 함수를 넘겨 첫 렌더링 때만 문서 전체를 읽음
  const [nodes, setNodes] = useState(() =>
    readTables(doc).map((table) => toNode(table, doc, onOpenTable)),
  )
  // lastWrite가 유지되도록 처음 한 번만 생성
  const [dragHandlers] = useState(() => createDragHandlers(doc))
  const { getNodes } = useReactFlow<TableNodeType>()

  // 드래그 중 위치, 선택, 크기 측정 등 화면 쪽 변경을 nodes에 반영
  const onNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  // Y.Doc 변경을 구독해 nodes에 반영, 반환된 해제 함수는 컴포넌트가 사라질 때 React가 호출
  // useEffect가 아닌 이유: 첫 읽기와 구독 시작 사이에 도착한 변경을 놓치지 않기 위함
  useLayoutEffect(
    () =>
      observeTables(doc, (tableIds) => {
        setNodes((current) => mergeTables(current, doc, onOpenTable, tableIds))
      }),
    [doc, onOpenTable],
  )

  //키보드 처리 로직 - 캔버스 차원에서의 EventListener를 수행하도록 함
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.repeat || !isCanvasTarget(event.target)) {
        return
      }
      if (event.key === 'Escape') {
        onClosePanel()
        return
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return
      }

      const ids = getNodes()
        .filter((node) => node.selected)
        .map((node) => node.id)
      if (ids.length === 0) {
        return
      }

      event.preventDefault()
      const message = `선택한 테이블 ${ids.length}개를 삭제할까요? 연결된 관계와 자동 생성된 FK 컬럼도 함께 삭제됩니다.`
      if (window.confirm(message)) {
        deleteTables(doc, ids)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [doc, getNodes, onClosePanel])

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        snapToGrid
        snapGrid={SNAP_GRID}
        minZoom={0.2}
        maxZoom={2.5}
        defaultViewport={DEFAULT_VIEWPORT}
        // 기본 삭제키와 방향키 이동은 Y.Doc에 저장되지 않고 내 화면에만 적용되므로 끔
        deleteKeyCode={null}
        disableKeyboardA11y
        // 더블클릭은 확대 대신 편집 패널 열기에 사용, node.id = table id
        zoomOnDoubleClick={false}
        onNodeDoubleClick={(_event, node) => onOpenTable(node.id)}
        onNodeClick={(_event, node) => onSelectTable(node.id)}
        onPaneClick={onClosePanel}
        // 객체의 필드 4개를 각각 prop으로 펼쳐서 전달
        {...dragHandlers}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d7dde8" />
      </ReactFlow>
    </div>
  )
}
