import { useCallback, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'
import { Toolbar } from './canvas/Toolbar'
import { TablePanel } from './panel/TablePanel'
import type { Connection } from './sync/connection'

// Toolbar와 Canvas가 공유할 문서 연결
type AppProps = {
  connection: Connection
}

// ReactFlowProvider: <ReactFlow> 바깥에 있는 Toolbar도 React Flow 상태를 쓸 수 있게 공유
function App({ connection }: AppProps) {
  // 편집 패널에 띄울 table id, null이면 패널 닫힘 (내 화면에만 있는 값, Y.Doc에 저장하지 않음)
  const [editingTableId, setEditingTableId] = useState<string | null>(null)
  // TablePanel의 구독 의존 값이므로 useCallback으로 같은 함수를 유지해 매 렌더링 재구독을 막음
  const closePanel = useCallback(() => setEditingTableId(null), [])

  return (
    <ReactFlowProvider>
      <div className="editor">
        <Toolbar connection={connection} />
        <main className="ed-body">
          {/* table node를 더블클릭하면 그 table id로 패널을 엶 */}
          <Canvas doc={connection.doc} onOpenTable={setEditingTableId} />
          {/* key: 다른 table을 열면 패널을 새로 만들어 그 table을 처음부터 다시 읽음 */}
          {editingTableId && (
            <TablePanel
              key={editingTableId}
              doc={connection.doc}
              tableId={editingTableId}
              onClose={closePanel}
            />
          )}
        </main>
      </div>
    </ReactFlowProvider>
  )
}

export default App
