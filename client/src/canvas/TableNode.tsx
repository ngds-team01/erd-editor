import { Fragment, memo } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import type * as Y from 'yjs'
import { addNextColumn } from '../model'
import type { ColumnData, TableData } from '../model'
import type { Peer } from '../sync/presence'

//React Flow Node에 TableData의 type 적용
// doc: + 컬럼 버튼에서 addNextColumn을 호출하기 위해 함께 전달
// editors: 이 table을 편집 중인 다른 사용자 (Canvas가 화면에 넘길 때만 붙임, 없으면 undefined)
export type TableNodeType = Node<
  { table: TableData; doc: Y.Doc; onOpen: (tableId: string) => void; editors?: Peer[] },
  'table'
>

// 색상 채널(0~255)을 0~1로 변환한 뒤 조도 적용(sRGB 공식)
function channelLuminance(channel: number): number {
  const value = channel / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

// hex 색에서 r, g, b를 추출해 상대 밝기(0~1)를 계산, 형식 검사
function luminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) {
    return 0
  }

  const rgb = parseInt(match[1], 16)
  return (
    0.2126 * channelLuminance((rgb >> 16) & 255) +
    0.7152 * channelLuminance((rgb >> 8) & 255) +
    0.0722 * channelLuminance(rgb & 255)
  )
}

// 흰 글자와 배경의 대비가 3:1 미만이면 밝은 배경
function isLightBackground(hex: string): boolean {
  return 1.05 / (luminance(hex) + 0.05) < 3
}

//pk 칸의 gold key design
function PrimaryKeyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16">
      <circle cx="5" cy="8" r="3" fill="none" stroke="#c9a227" strokeWidth="1.8" />
      <path d="M8 8h7M12 8v3M15 8v2.5" stroke="#c9a227" strokeWidth="1.8" fill="none" />
    </svg>
  )
}

//column들의 위에 오는, 각 column의 특성 명시 row
// // 첫 번째 열(키 아이콘 칸)은 비워 grid 6칸 맞춤
function ColumnHeader() {
  return (
    <div className="t-colhead" aria-hidden="true">
      <span />
      <span>논리명</span>
      <span>물리명</span>
      <span>타입</span>
      <span title="NOT NULL">NN</span>
      <span title="UNIQUE">UQ</span>
    </div>
  )
}

// column마다 그 column을 편집 중인 다른 사용자의 색, 여러 명이면 먼저 접속한 사람의 색
function editorColorsByColumn(editors: Peer[]): Map<string, string> {
  const colors = new Map<string, string>()
  for (const { user, editing } of editors) {
    if (editing?.columnId && !colors.has(editing.columnId)) {
      colors.set(editing.columnId, user.color)
    }
  }
  return colors
}

// 이 table을 편집 중인 다른 사용자의 이름표, node 위쪽에 사용자 색으로 표시
// key: 같은 사람이 탭 두 개로 같은 table을 열 수 있으므로 user.id가 아닌 접속 번호(clientId) 사용
function EditorBadges({ editors }: { editors: Peer[] }) {
  return (
    <div className="t-editors" aria-label="편집 중인 사용자">
      {editors.map(({ clientId, user }) => (
        <span key={clientId} className="t-editor" style={{ background: user.color }}>
          {user.name}
        </span>
      ))}
    </div>
  )
}

// { column }: props에서 꺼낸 값, columnData를 html 태그 부착해 표시
// editorColor: 이 column을 편집 중인 다른 사용자의 색, 있으면 행 왼쪽에 색 막대 표시
function ColumnRow({ column, editorColor }: { column: ColumnData; editorColor?: string }) {
  return (
    <div
      className={column.logicalName ? 't-col has-label' : 't-col'}
      style={editorColor ? { boxShadow: `inset 3px 0 0 ${editorColor}` } : undefined}
    >
      <span className="c-key">{column.pk && <PrimaryKeyIcon />}</span>
      <span className="c-label">{column.logicalName}</span>
      <span className="c-name">{column.physicalName}</span>
      <span className="c-type">{column.type}</span>
      {/* PK는 항상 NN으로 표시, UQ는 표시하지 않음 (pk && unique이면 unique 무시, 2.3) */}
      <span className="c-nn">{column.notNull || column.pk ? 'NN' : ''}</span>
      <span className="c-uq">{column.unique && !column.pk ? 'UQ' : ''}</span>
    </div>
  )
}

// Table 하나를 헤더(논리명, 물리명)와 column 표로 표시, selected = React Flow가 넘겨주는 선택 여부
function TableNodeView({ data, selected }: NodeProps<TableNodeType>) {
  // editors = []: Canvas가 붙이지 않았으면(편집 중인 사람 없음) 빈 배열로 취급
  const { table, doc, onOpen, editors = [] } = data
  // 테두리 색은 먼저 접속한 편집자의 색, column별로는 색 막대
  const editorColor = editors[0]?.user.color
  const columnColors = editorColorsByColumn(editors)
  // --editor-color: CSS의 .table.editing 테두리가 읽는 변수, 사용자마다 색이 달라 여기서 넣음
  const tableClass = ['table', selected && 'sel', editorColor && 'editing'].filter(Boolean).join(' ')
  const tableStyle = editorColor ? ({ '--editor-color': editorColor } as CSSProperties) : undefined
  // PK가 아닌 첫 column의 위치, 이 행 앞에 구분선을 넣음 (없으면 -1)
  const firstNonPk =table.columns.findIndex((column) => !column.pk)

  // 기본 이름과 타입으로 column 추가, 화면은 Y.Doc 변경을 구독하는 Canvas가 갱신
  function handleAddColumn() {
    addNextColumn(doc, table.id)
  }

  // 이름표는 table 바깥(React Flow node 기준)에 두어 table 크기 측정에 영향을 주지 않음
  return (
    <>
      {editors.length > 0 && <EditorBadges editors={editors} />}
      <div className={tableClass} style={tableStyle}>
        {/* 숨긴 Handle: React Flow는 edge 양 끝에 Handle이 있어야 edge를 그림 */}
        {/* 실제 선의 위치는 RelationEdge가 table 사각형으로 계산, 드래그로 연결하는 기능은 끔 */}
        <Handle type="target" position={Position.Left} className="t-handle" isConnectable={false} />
        <Handle type="source" position={Position.Right} className="t-handle" isConnectable={false} />
        <div
          className={isLightBackground(table.color) ? 't-head light' : 't-head'}
          style={{ background: table.color }}
        >
          <span className="t-name">{table.logicalName}</span>
          {table.physicalName && <span className="t-pname">{table.physicalName}</span>}
          {/* 해당 버튼(...) 클릭 시 편집 메뉴 open, nodrag 설정을 통해 drag 상태 방지 */}
          <button
            type="button"
            className="t-more nodrag"
            title="테이블 편집"
            aria-label="테이블 편집"
            onClick={() => onOpen(table.id)}
          >
            ⋯
          </button>
        </div>
        <div className="t-cols">
          {table.columns.length === 0 ? (
            <div className="t-empty">컬럼 없음</div>
          ) : (
            <>
              <ColumnHeader />
              {table.columns.map((column, index) => (
                <Fragment key={column.id}>
                  {index > 0 && index === firstNonPk && <div className="t-div" />}
                  <ColumnRow column={column} editorColor={columnColors.get(column.id)} />
                </Fragment>
              ))}
            </>
          )}
          {/* nodrag: 버튼을 눌러도 node 드래그가 시작되지 않게 하는 React Flow class */}
          <button type="button" className="t-add nodrag" onClick={handleAddColumn}>
            + 컬럼
          </button>
        </div>
      </div>
    </>
  )
}

// 받은 props가 이전과 같으면 이전 결과 reuse
export const TableNode = memo(TableNodeView)
