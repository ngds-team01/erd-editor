import { useSyncExternalStore } from 'react'
import { useStoreApi } from '@xyflow/react'
import { createTable, getTables } from '../model'
import type { Connection, ConnectionStatus } from '../sync/connection'
import { sameKind } from './relationMode'
import type { RelationKind } from './relationMode'

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

// 관계 버튼 4개 = 카디널리티 2종 × 식별 여부 2종 (2.5)
const RELATION_TOOLS: (RelationKind & { label: string })[] = [
  { cardinality: '1:N', identifying: true, label: '1:N 식별 관계 (실선)' },
  { cardinality: '1:N', identifying: false, label: '1:N 비식별 관계 (점선)' },
  { cardinality: '1:1', identifying: true, label: '1:1 식별 관계 (실선)' },
  { cardinality: '1:1', identifying: false, label: '1:1 비식별 관계 (점선)' },
]

// connection: table을 추가할 문서와 표시할 접속 상태
// relationKind: 지금 켜진 관계 버튼 (관계 모드가 아니면 null), onToggleRelation: 관계 버튼을 눌렀을 때 호출
type ToolbarProps = {
  connection: Connection
  relationKind: RelationKind | null
  onToggleRelation: (kind: RelationKind) => void
}

// 가장 가까운 GRID_SIZE의 배수로 맞춤
function snap(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE
}

// 관계 버튼 아이콘: 왼쪽 막대 = 부모 쪽 1, 오른쪽 끝 = 자식 쪽 1(막대) 또는 N(까마귀 발)
function RelationIcon({ cardinality, identifying }: RelationKind) {
  // 비식별 관계는 점선
  const dash = identifying ? undefined : '4 3'
  return (
    <svg width="42" height="16" viewBox="0 0 42 16">
      <path d="M8 2v12" stroke="currentColor" strokeWidth="1.5" />
      {cardinality === '1:N' ? (
        <>
          <path d="M1 8h33" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dash} />
          <path d="M34 8l7-5.5M34 8h8M34 8l7 5.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </>
      ) : (
        <>
          <path d="M1 8h40" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dash} />
          <path d="M34 2v12" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
    </svg>
  )
}

// 상단 툴바: 로고, table 추가 버튼, 관계 버튼 4개
export function Toolbar({ connection, relationKind, onToggleRelation }: ToolbarProps) {
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
      <div className="tb-sep" />
      {RELATION_TOOLS.map(({ label, ...kind }) => {
        // 지금 켜진 버튼이면 on 표시, 다시 누르면 관계 모드 해제
        const active = relationKind !== null && sameKind(relationKind, kind)
        return (
          <button
            key={label}
            type="button"
            className={active ? 'btn tb rel on' : 'btn tb rel'}
            title={`${label}: 부모 → 자식 테이블 순서로 클릭`}
            aria-label={label}
            aria-pressed={active}
            onClick={() => onToggleRelation(kind)}
          >
            <RelationIcon {...kind} />
          </button>
        )
      })}
      {/* flex-sp: 남는 공간을 차지해 접속 상태를 오른쪽 끝으로 밈 */}
      <span className="flex-sp" />
      <span className="save-state">
        {docId} · {STATUS_LABELS[status]}
      </span>
    </header>
  )
}
