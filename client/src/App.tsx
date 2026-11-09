import { Canvas } from './canvas/Canvas'
import { Toolbar } from './canvas/Toolbar'

function App() {
  return (
    <div className="editor">
      <Toolbar />
      <main className="ed-body">
        <Canvas tables={[]} />
      </main>
    </div>
  )
}

export default App
