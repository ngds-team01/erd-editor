import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Y from 'yjs'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App.tsx'

// 페이지당 문서 1개만 생성, 컴포넌트 안에 두면 렌더링마다 여러 개 생길 수 있음
const doc = new Y.Doc()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App doc={doc} />
  </StrictMode>,
)
