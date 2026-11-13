import { Fragment, memo } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import type * as Y from 'yjs'
import { addNextColumn } from '../model'
import type { ColumnData, TableData } from '../model'

//React Flow Node에 TableData의 type 적용
// doc: + 컬럼 버튼에서 addNextColumn을 호출하기 위해 함께 전달
export type TableNodeType = Node<{ table: TableData; doc: Y.Doc }, 'table'>

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

// { column }: props에서 꺼낸 값, columnData를 html 태그 부착해 표시
function ColumnRow({ column }: { column: ColumnData }) {
  return (
    <div className={column.logicalName ? 't-col has-label' : 't-col'}>
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
  const { table, doc } = data
  // PK가 아닌 첫 column의 위치, 이 행 앞에 구분선을 넣음 (없으면 -1)
  const firstNonPk =table.columns.findIndex((column) => !column.pk)

  // 기본 이름과 타입으로 column 추가, 화면은 Y.Doc 변경을 구독하는 Canvas가 갱신
  function handleAddColumn() {
    addNextColumn(doc, table.id)
  }

  return (
    <div className={selected ? 'table sel' : 'table'}>
      <div
        className={isLightBackground(table.color) ? 't-head light' : 't-head'}
        style={{ background: table.color }}
      >
        <span className="t-name">{table.logicalName}</span>
        {table.physicalName && <span className="t-pname">{table.physicalName}</span>}
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
                <ColumnRow column={column} />
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
  )
}

// 받은 props가 이전과 같으면 이전 결과 reuse
export const TableNode = memo(TableNodeView)
