import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import type {
  EdgeChange,
  EdgeTypes,
  NodeChange,
  NodeTypes,
  OnSelectionChangeFunc,
  ReactFlowProps,
  SnapGrid,
} from '@xyflow/react'
import type * as Y from 'yjs'
import {
  deleteTables,
  getTables,
  isRelationDrawable,
  moveTables,
  observeRelations,
  observeTables,
  readRelations,
  readTable,
  readTables,
} from '../model'
import type { RelationData, TableData } from '../model'
import { collectEditors, collectRelationEditors } from '../sync/presence'
import type { Peer, PeerStore } from '../sync/presence'
import { RelationEdge } from './RelationEdge'
import type { RelationEdgeType } from './RelationEdge'
import type { RelationMode } from './relationMode'
import { TableNode } from './TableNode'
import type { TableNodeType } from './TableNode'

// key: node의 type, value: node Component(TableNode)
const nodeTypes: NodeTypes = { table: TableNode }
// key: edge의 type, value: edge Component(RelationEdge)
const edgeTypes: EdgeTypes = { relation: RelationEdge }
//가로, 세로 간격
const SNAP_GRID: SnapGrid = [10, 10]
//처음 화면 배율 : 1, 캔버스 좌표 (0, 0) = 화면 (40, 40)
const DEFAULT_VIEWPORT = { x: 40, y: 40, zoom: 1 }
// 드래그 중 Y.Doc에 position을 쓰는 최소 간격 (2.7)
const DRAG_WRITE_INTERVAL_MS = 50

// Canvas가 읽고 쓰는 문서, onOpenTable: table node를 더블클릭하거나 ⋯ 버튼을 눌렀을 때 편집 패널을 열 함수
// onClickTable: table node를 클릭했을 때 호출 (관계 모드면 부모·자식 선택, 아니면 패널 전환)
// onOpenRelation: 관계선을 클릭했을 때 관계 편집 패널을 열 함수
// relationMode: 관계 모드 상태 (아니면 null), onCancelRelation: Esc로 관계 모드를 끝낼 함수
// onSelect: 선택한 table·관계선이 바뀔 때 id 목록을 알림, peers: 다른 사용자의 편집 중 표시에 쓸 목록 (3)
type CanvasProps = {
  doc: Y.Doc
  onOpenTable: (tableId: string) => void
  onClickTable: (tableId: string) => void
  onOpenRelation: (relationId: string) => void
  onClosePanel: () => void
  relationMode: RelationMode | null
  onCancelRelation: () => void
  onSelect: (selection: CanvasSelection) => void
  peers: PeerStore
}

// 캔버스에서 선택한 table id 목록과 관계선(relation) id 목록
export type CanvasSelection = {
  tableIds: string[]
  relationIds: string[]
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

// RelationData를 React Flow - Edge 형식으로 변환, source = 부모, target = 자식
function toEdge(relation: RelationData): RelationEdgeType {
  return {
    id: relation.id,
    type: 'relation',
    source: relation.fromTable,
    target: relation.toTable,
    data: { relation },
  }
}

// 화면에 그리는 값이 모두 같은지 비교
function sameRelation(a: RelationData, b: RelationData): boolean {
  return (
    a.fromTable === b.fromTable &&
    a.toTable === b.toTable &&
    a.toColumn === b.toColumn &&
    a.cardinality === b.cardinality &&
    a.identifying === b.identifying
  )
}

// Y.Doc의 relation 전체를 다시 읽고 고아 관계를 걸러 edge 배열을 만듦 (2.7)
// relation 수가 적어 전체를 다시 읽고, 안 바뀐 edge는 같은 객체를 유지해 memo가 다시 그리지 않게 함
function syncEdges(edges: RelationEdgeType[], doc: Y.Doc): RelationEdgeType[] {
  // 이미 화면에 있는 edge, key = relation id
  const known = new Map(edges.map((edge) => [edge.id, edge]))
  const next = readRelations(doc)
    .filter((relation) => isRelationDrawable(doc, relation))
    .map((relation) => {
      const edge = known.get(relation.id)
      if (edge?.data && sameRelation(edge.data.relation, relation)) {
        return edge
      }
      // 바뀐 relation은 새 객체로 만들되, React Flow가 관리하는 선택 여부는 유지
      return { ...toEdge(relation), selected: edge?.selected }
    })

  // 개수와 객체가 모두 같으면 이전 배열을 그대로 돌려줘 다시 그리지 않음 (드래그 중 table 변경마다 호출됨)
  const unchanged = next.length === edges.length && next.every((edge, i) => edge === edges[i])
  return unchanged ? edges : next
}

function isCanvasTarget(target: EventTarget | null): boolean {
  return (
    target === document.body ||
    (target instanceof Element && target.closest('.canvas-wrap') !== null)
  )
}

// 글자를 입력하는 칸인지 확인, 패널 입력칸의 Esc는 입력 취소에 쓰이므로 관계 모드 취소에서 제외
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type === 'text')
  )
}

// 화면에 넘길 node에 관계 모드 부모 표시와 다른 사용자의 편집 중 표시를 덧붙임
// nodes 상태와 Y.Doc에는 남지 않고, 덧붙일 것이 없는 node는 같은 객체를 유지해 memo가 다시 그리지 않게 함
function decorateNodes(
  nodes: TableNodeType[],
  parentId: string | null,
  editors: Map<string, Peer[]>,
): TableNodeType[] {
  if (parentId === null && editors.size === 0) {
    return nodes
  }
  return nodes.map((node) => {
    const nodeEditors = editors.get(node.id)
    if (node.id !== parentId && !nodeEditors) {
      return node
    }
    return {
      ...node,
      className: node.id === parentId ? 'rel-parent' : node.className,
      data: nodeEditors ? { ...node.data, editors: nodeEditors } : node.data,
    }
  })
}

// 화면에 넘길 edge에 다른 사용자의 편집 중 표시를 덧붙임 (decorateNodes와 같은 방식)
// edges 상태와 Y.Doc에는 남지 않고, 편집자가 없는 edge는 같은 객체를 유지해 memo가 다시 그리지 않게 함
// 고아 관계는 syncEdges가 이미 걸러 edges에 없으므로 표시도 붙지 않음
function decorateEdges(edges: RelationEdgeType[], editors: Map<string, Peer[]>): RelationEdgeType[] {
  if (editors.size === 0) {
    return edges
  }
  return edges.map((edge) => {
    const edgeEditors = editors.get(edge.id)
    return edgeEditors && edge.data ? { ...edge, data: { ...edge.data, editors: edgeEditors } } : edge
  })
}

// 관계 모드 안내 문구, 부모를 고르기 전과 후
function relationHint(mode: RelationMode): string {
  return mode.parentId === null
    ? '① 부모 테이블을 클릭하세요 (Esc 취소)'
    : '② 자식 테이블을 클릭하세요 (같은 테이블이면 자기 참조, Esc 취소)'
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
export function Canvas({
  doc,
  onOpenTable,
  onClickTable,
  onOpenRelation,
  onClosePanel,
  relationMode,
  onCancelRelation,
  onSelect,
  peers,
}: CanvasProps) {
  // 함수를 넘겨 첫 렌더링 때만 문서 전체를 읽음
  const [nodes, setNodes] = useState(() =>
    readTables(doc).map((table) => toNode(table, doc, onOpenTable)),
  )
  // 관계선, 첫 렌더링 때만 문서 전체를 읽음
  const [edges, setEdges] = useState(() => syncEdges([], doc))
  // lastWrite가 유지되도록 처음 한 번만 생성
  const [dragHandlers] = useState(() => createDragHandlers(doc))
  const { getNodes } = useReactFlow<TableNodeType>()

  // 드래그 중 위치, 선택, 크기 측정 등 화면 쪽 변경을 nodes에 반영
  const onNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  // edge 선택 등 화면 쪽 변경을 edges에 반영
  const onEdgesChange = useCallback((changes: EdgeChange<RelationEdgeType>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current))
  }, [])

  // Y.Doc 변경을 구독해 nodes에 반영, 반환된 해제 함수는 컴포넌트가 사라질 때 React가 호출
  // useEffect가 아닌 이유: 첫 읽기와 구독 시작 사이에 도착한 변경을 놓치지 않기 위함
  // table이 바뀌면 고아 필터도 다시 적용 (table·FK column이 지워지면 그 관계선을 숨김)
  useLayoutEffect(
    () =>
      observeTables(doc, (tableIds) => {
        setNodes((current) => mergeTables(current, doc, onOpenTable, tableIds))
        setEdges((current) => syncEdges(current, doc))
      }),
    [doc, onOpenTable],
  )

  // relation 추가·수정·삭제를 구독해 edges에 반영
  useLayoutEffect(
    () => observeRelations(doc, () => setEdges((current) => syncEdges(current, doc))),
    [doc],
  )

  // 관계 모드에서 고른 부모 table id, 없으면 null
  const parentId = relationMode?.parentId ?? null
  // 다른 사용자 목록을 구독해 table별 편집 중인 사용자로 묶음 (3)
  const peerList = useSyncExternalStore(peers.subscribe, peers.getPeers)
  const editors = useMemo(() => collectEditors(peerList), [peerList])
  // 고른 부모 node에는 rel-parent class, 다른 사용자가 편집 중인 node에는 editors를 붙여 화면에 넘김
  const shownNodes = useMemo(
    () => decorateNodes(nodes, parentId, editors),
    [nodes, parentId, editors],
  )
  // 같은 목록을 관계별로도 묶어, 다른 사용자가 편집 중인 관계선에 editors를 붙여 화면에 넘김
  const relationEditors = useMemo(() => collectRelationEditors(peerList), [peerList])
  const shownEdges = useMemo(() => decorateEdges(edges, relationEditors), [edges, relationEditors])

  // 선택이 바뀌면 선택한 table·관계선 id 목록을 App에 알림, React Flow 요구대로 같은 함수를 유지
  // node.id = table id, edge.id = relation id
  const handleSelectionChange = useCallback<OnSelectionChangeFunc<TableNodeType, RelationEdgeType>>(
    ({ nodes: selectedNodes, edges: selectedEdges }) =>
      onSelect({
        tableIds: selectedNodes.map((node) => node.id),
        relationIds: selectedEdges.map((edge) => edge.id),
      }),
    [onSelect],
  )

  //키보드 처리 로직 - 캔버스 차원에서의 EventListener를 수행하도록 함
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.repeat) {
        return
      }
      // 관계 버튼을 누른 직후에는 focus가 툴바 버튼에 있으므로 캔버스 밖이어도 Esc로 관계 모드 취소
      if (event.key === 'Escape' && relationMode && !isTextEntry(event.target)) {
        onCancelRelation()
        return
      }
      if (!isCanvasTarget(event.target)) {
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
  }, [doc, getNodes, onClosePanel, relationMode, onCancelRelation])

  return (
    <div className={relationMode ? 'canvas-wrap rel-mode' : 'canvas-wrap'}>
      {relationMode && <div className="mode-hint">{relationHint(relationMode)}</div>}
      <ReactFlow
        nodes={shownNodes}
        onNodesChange={onNodesChange}
        edges={shownEdges}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // Handle을 끌어 관계를 만드는 기능은 쓰지 않음 (관계는 툴바의 관계 모드로 생성)
        nodesConnectable={false}
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
        onNodeClick={(_event, node) => onClickTable(node.id)}
        // edge.id = relation id
        onEdgeClick={(_event, edge) => onOpenRelation(edge.id)}
        onPaneClick={onClosePanel}
        onSelectionChange={handleSelectionChange}
        // 객체의 필드 4개를 각각 prop으로 펼쳐서 전달
        {...dragHandlers}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d7dde8" />
      </ReactFlow>
    </div>
  )
}
