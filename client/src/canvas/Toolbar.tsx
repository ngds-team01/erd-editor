import { useSyncExternalStore } from 'react'
import { useStoreApi } from '@xyflow/react'
import { createTable, getTables } from '../model'
import type { Connection, ConnectionStatus } from '../sync/connection'

// Canvas의 SNAP_GRID와 같은 간격
const GRID_SIZE = 10
// 새 table의 가운데가 화면 중앙에 오도록 왼쪽 위 좌표에서 빼는 값
const NEW_TABLE_OFFSET = { x: 110, y: 80 }

// 접속 상태별 화면 문구
const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: '연결 중',
  connected: '연결됨',
  disconnected: '연결 끊김',
}

// table을 추가할 문서와 표시할 접속 상태
type ToolbarProps = {
  connection: Connection
}

// 가장 가까운 GRID_SIZE의 배수로 맞춤
function snap(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE
}

// 상단 툴바: 로고와 table 추가 버튼
export function Toolbar({ connection }: ToolbarProps) {
  const { doc, docId, subscribeStatus, getStatus } = connection
  // React 바깥의 접속 상태를 구독, 상태가 바뀌면 Toolbar를 다시 그림
  const status = useSyncExternalStore(subscribeStatus, getStatus)
  // React Flow 내부 상태(캔버스 크기, 이동량, 배율)에 접근
  const store = useStoreApi()

  // 현재 보고 있는 화면의 중앙에 새 table 생성
  function handleAddTable() {
    // transform = [x 이동량, y 이동량, 배율]
    const {
      width,
      height,
      transform: [viewportX, viewportY, zoom],
    } = store.getState()
    // 이름에 붙일 번호, 동시에 추가하면 번호가 같을 수 있지만 id는 달라서 둘 다 유지됨
    const n = getTables(doc).size + 1

    createTable(doc, {
      logicalName: `테이블${n}`,
      physicalName: `table_${n}`,
      // 화면 중앙을 캔버스 좌표로 변환: 캔버스 = (화면 - 이동량) / 배율
      position: {
        x: snap((width / 2 - viewportX) / zoom - NEW_TABLE_OFFSET.x),
        y: snap((height / 2 - viewportY) / zoom - NEW_TABLE_OFFSET.y),
      },
    })
  }

  return (
    <header className="ed-head">
      <span className="logo">
        <span className="logo-mark">E</span>
        ERD Editor
      </span>
      <div className="tb-sep" />
      <button type="button" className="btn tb" title="테이블 추가" onClick={handleAddTable}>
        <svg width="14" height="14" viewBox="0 0 16 16">
          <rect
            x="1.5"
            y="2"
            width="13"
            height="12"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M1.5 6.5h13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        테이블
      </button>
      {/* flex-sp: 남는 공간을 차지해 접속 상태를 오른쪽 끝으로 밈 */}
      <span className="flex-sp" />
      <span className="save-state">
        {docId} · {STATUS_LABELS[status]}
      </span>
    </header>
  )
}
