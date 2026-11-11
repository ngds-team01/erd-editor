import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App.tsx'
import { connect, readDocId } from './sync/connection'

const docId = readDocId(window.location.search)
// 페이지당 연결 1개만 생성, 컴포넌트 안에 두면 렌더링마다 여러 개 생길 수 있음
const connection = docId === null ? null : connect(docId)

// 문서 ID 형식이 틀리면 접속하지 않고 오류 문구를 표시
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {connection ? (
      <App connection={connection} />
    ) : (
      <p className="doc-error">문서 ID 형식이 올바르지 않습니다.</p>
    )}
  </StrictMode>,
)
