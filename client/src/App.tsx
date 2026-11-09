import { ReactFlowProvider } from '@xyflow/react'
import type * as Y from 'yjs'
import { Canvas } from './canvas/Canvas'
import { Toolbar } from './canvas/Toolbar'

// Toolbar와 Canvas가 공유할 문서
type AppProps = {
  doc: Y.Doc
}

// ReactFlowProvider: <ReactFlow> 바깥에 있는 Toolbar도 React Flow 상태를 쓸 수 있게 공유
function App({ doc }: AppProps) {
  return (
    <ReactFlowProvider>
      <div className="editor">
        <Toolbar doc={doc} />
        <main className="ed-body">
          <Canvas doc={doc} />
        </main>
      </div>
    </ReactFlowProvider>
  )
}

export default App
