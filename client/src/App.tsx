import { useCallback, useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'
import { sameKind } from './canvas/relationMode'
import type { RelationKind, RelationMode } from './canvas/relationMode'
import { Toolbar } from './canvas/Toolbar'
import { createRelation } from './model'
import { RelationPanel } from './panel/RelationPanel'
import { TablePanel } from './panel/TablePanel'
import type { Connection } from './sync/connection'
import { pickEditing, setEditing } from './sync/presence'
import type { Editing } from './sync/presence'

// Toolbar와 Canvas가 공유할 문서 연결
type AppProps = {
  connection: Connection
}

// 편집 패널에 띄울 대상: table 또는 relation 중 하나
type PanelTarget = { kind: 'table'; id: string } | { kind: 'relation'; id: string }

// ReactFlowProvider: <ReactFlow> 바깥에 있는 Toolbar도 React Flow 상태를 쓸 수 있게 공유
function App({ connection }: AppProps) {
  const { doc, awareness, peers } = connection
  // 편집 패널에 띄울 대상, null이면 패널 닫힘 (내 화면에만 있는 값, Y.Doc에 저장하지 않음)
  const [panel, setPanel] = useState<PanelTarget | null>(null)
  // 관계 모드 상태, null이면 관계 모드 아님 (내 화면에만 있는 값)
  const [relationMode, setRelationMode] = useState<RelationMode | null>(null)
  // 캔버스에서 선택한 table id 목록 (내 화면에만 있는 값, 편집 중 표시에 사용)
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([])
  // 패널에서 포커스가 있는 column, 없으면 null (내 화면에만 있는 값)
  const [focusedColumn, setFocusedColumn] = useState<Editing | null>(null)

  // 아래 함수들은 Canvas·패널의 구독 의존 값이므로 useCallback으로 같은 함수를 유지해 매 렌더링 재구독을 막음
  const closePanel = useCallback(() => setPanel(null), [])
  const openTable = useCallback((id: string) => setPanel({ kind: 'table', id }), [])
  const openRelation = useCallback((id: string) => setPanel({ kind: 'relation', id }), [])
  const cancelRelation = useCallback(() => setRelationMode(null), [])

  // 패널의 column 영역에 포커스가 들어옴, 같은 column이면 이전 값을 유지해 다시 그리지 않음
  const focusColumn = useCallback((tableId: string, columnId: string) => {
    setFocusedColumn((current) =>
      current?.tableId === tableId && current.columnId === columnId ? current : { tableId, columnId },
    )
  }, [])
  // 그 column 영역에서 포커스가 나감, 이미 다른 column으로 바뀌었으면 그대로 둠
  const blurColumn = useCallback((columnId: string) => {
    setFocusedColumn((current) => (current?.columnId === columnId ? null : current))
  }, [])

  // 패널·포커스·선택이 바뀌면 내 편집 대상을 다시 정해 awareness에 올림 (값이 같으면 setEditing이 보내지 않음)
  const panelTableId = panel?.kind === 'table' ? panel.id : null
  useEffect(() => {
    setEditing(awareness, pickEditing(panelTableId, focusedColumn, selectedTableIds))
  }, [awareness, panelTableId, focusedColumn, selectedTableIds])

  // 관계 버튼 클릭: 같은 버튼을 다시 누르면 관계 모드 해제, 다른 버튼이면 그 종류로 처음부터 다시 시작
  const toggleRelation = useCallback((kind: RelationKind) => {
    setRelationMode((current) => (current && sameKind(current.kind, kind) ? null : { kind, parentId: null }))
  }, [])

  // table node 클릭
  // 관계 모드: 첫 클릭 = 부모 선택, 두 번째 클릭 = 자식 선택 후 관계 생성 (같은 table이면 자기 참조)
  // 관계 모드가 아니면: 패널이 열려 있을 때만 클릭한 table로 전환
  function clickTable(tableId: string) {
    if (!relationMode) {
      setPanel((current) => (current === null ? null : { kind: 'table', id: tableId }))
      return
    }
    if (relationMode.parentId === null) {
      setRelationMode({ ...relationMode, parentId: tableId })
      return
    }

    // 관계와 FK column을 한 transaction으로 생성, 만든 관계의 편집 패널을 엶
    const relationId = createRelation(doc, {
      fromTable: relationMode.parentId,
      toTable: tableId,
      ...relationMode.kind,
    })
    setRelationMode(null)
    if (relationId) {
      openRelation(relationId)
    }
  }

  return (
    <ReactFlowProvider>
      <div className="editor">
        <Toolbar
          connection={connection}
          relationKind={relationMode?.kind ?? null}
          onToggleRelation={toggleRelation}
        />
        <main className="ed-body">
          {/* table node를 더블클릭하거나 ⋯ 버튼을 누르면 그 table id로 패널을 엶, 관계선을 클릭하면 관계 패널을 엶 */}
          <Canvas
            doc={doc}
            onOpenTable={openTable}
            onClickTable={clickTable}
            onOpenRelation={openRelation}
            onClosePanel={closePanel}
            relationMode={relationMode}
            onCancelRelation={cancelRelation}
            onSelectTables={setSelectedTableIds}
            peers={peers}
          />
          {/* key: 다른 대상을 열면 패널을 새로 만들어 처음부터 다시 읽음 */}
          {panel?.kind === 'table' && (
            <TablePanel
              key={panel.id}
              doc={doc}
              tableId={panel.id}
              onClose={closePanel}
              onFocusColumn={focusColumn}
              onBlurColumn={blurColumn}
            />
          )}
          {panel?.kind === 'relation' && (
            <RelationPanel key={panel.id} doc={doc} relationId={panel.id} onClose={closePanel} />
          )}
        </main>
      </div>
    </ReactFlowProvider>
  )
}

export default App
