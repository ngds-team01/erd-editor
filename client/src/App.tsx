import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'
import { Toolbar } from './canvas/Toolbar'
import type { Connection } from './sync/connection'

// Toolbar와 Canvas가 공유할 문서 연결
type AppProps = {
  connection: Connection
}

// ReactFlowProvider: <ReactFlow> 바깥에 있는 Toolbar도 React Flow 상태를 쓸 수 있게 공유
function App({ connection }: AppProps) {
  return (
    <ReactFlowProvider>
      <div className="editor">
        <Toolbar connection={connection} />
        <main className="ed-body">
          <Canvas doc={connection.doc} />
        </main>
      </div>
    </ReactFlowProvider>
  )
}

export default App
