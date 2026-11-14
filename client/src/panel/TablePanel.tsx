import { useLayoutEffect, useState } from 'react'
import type * as Y from 'yjs'
import {
  addNextColumn,
  addUnique,
  deleteTable,
  getTables,
  MAX_LOGICAL_NAME,
  MAX_PHYSICAL_NAME,
  observeTables,
  readTable,
  TABLE_COLORS,
  updateTable,
} from '../model'
import type { TableData } from '../model'
import { ColumnEditor } from './ColumnEditor'
import { TextField } from './TextField'
import { UniqueEditor } from './UniqueEditor'

//타입 입력칸의 추천 목록
const COLUMN_TYPES = [
  'BIGINT',
  'INT',
  'SMALLINT',
  'TINYINT',
  'DECIMAL(10,2)',
  'DOUBLE',
  'BOOLEAN',
  'CHAR(1)',
  'VARCHAR(50)',
  'VARCHAR(100)',
  'VARCHAR(255)',
  'TEXT',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'JSON',
]

type TablePanelProps = {
  doc: Y.Doc
  tableId: string
  onClose: () => void
}

//tableid로 테이블 Y.Map을 찾아 tableData로 변환
function readTableById(doc: Y.Doc, tableId: string): TableData | null {
  const table = getTables(doc).get(tableId)
  return table ? readTable(table) : null
}

// table 읽기와 구독 실행하는 custom hook
// 반환값: 현재 TableData (Y.Doc의 table이 바뀌면 다시 그려짐), onMissing: table이 삭제됐을 때 호출 (패널 닫기)
function useTable(doc: Y.Doc, tableId: string, onMissing: () => void): TableData | null {
  // 함수를 넘겨 첫 렌더링 때만 Y.Doc에서 읽음, 다른 table을 열면 App의 key로 패널이 새로 생성되어 다시 읽음
  const [table, setTable] = useState(() => readTableById(doc, tableId))

  // observeTables가 돌려주는 구독 해제 함수를 그대로 반환 → 패널이 사라질 때 React가 호출
  // useEffect가 아닌 이유: 첫 읽기와 구독 시작 사이에 도착한 변경을 놓치지 않기 위함
  useLayoutEffect(
    () =>
      observeTables(doc, (tableIds) => {
        // 다른 table의 변경(드래그 등)이면 패널을 다시 그리지 않음
        if (!tableIds.has(tableId)) {
          return
        }

        // 다시 읽어 상태를 바꾸면 React가 패널을 다시 그림, 없으면 삭제된 table (내가 지운 경우도 동일)
        const next = readTableById(doc, tableId)
        if (next) {
          setTable(next)
        } else {
          onMissing()
        }
      }),
    // 값이 바뀌면 이전 구독을 해제하고 다시 구독, onMissing은 App에서 useCallback으로 고정해 매 렌더링 재구독을 막음
    [doc, tableId, onMissing],
  )

  return table
}

//TablePanel에서 직접 처리하는 table 이름, 색상 및 삭제 작업은 직접 처리
// - 나머지는 columnEditor, UniqueEditor가 수행
export function TablePanel({ doc, tableId, onClose }: TablePanelProps) {
  const table = useTable(doc, tableId, onClose)
  if (!table) {
    return null
  }

  const firstAutoIncrementId = table.columns.find((column) => column.autoIncrement)?.id

  //Table 삭제 시 Handler
  function handleDelete() {
    if (window.confirm('테이블을 삭제할까요? 연결된 관계와 자동 생성된 FK 컬럼도 함께 삭제됩니다.')) {
      deleteTable(doc, tableId)
    }
  }

  //physicalName이 MySQL에 넣기 적절하도록 다듬어 update 적용
  function handlePhysicalName(value: string) {
    const physicalName = value.trim()
    if (physicalName) {
      updateTable(doc, tableId, { physicalName })
    }
  }

  //TablePanel 화면을 구성하도록 tag return
  return (
    <aside className="panel" aria-label="테이블 편집">
      <div className="p-title">
        테이블 편집
        <span className="p-title-btns">
          <button type="button" className="btn danger" onClick={handleDelete}>
            삭제
          </button>
          <button type="button" className="btn" title="패널 닫기" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>

      <label className="p-field">
        <span className="p-label">논리명</span>
        <TextField
          value={table.logicalName}
          maxLength={MAX_LOGICAL_NAME}
          onCommit={(logicalName) => updateTable(doc, tableId, { logicalName })}
        />
      </label>
      <label className="p-field">
        <span className="p-label">물리명 (SQL 테이블명)</span>
        <TextField
          className="mono"
          value={table.physicalName}
          maxLength={MAX_PHYSICAL_NAME}
          onCommit={handlePhysicalName}
        />
      </label>

      <span className="p-label">색상</span>
      <div className="swatches">
        {TABLE_COLORS.map(({ name, value }) => (
          <button
            key={value}
            type="button"
            className={value === table.color ? 'sw on' : 'sw'}
            style={{ background: value }}
            title={name}
            aria-label={name}
            aria-pressed={value === table.color}
            onClick={() => updateTable(doc, tableId, { color: value })}
          />
        ))}
      </div>

      <div className="p-sub">
        컬럼 <span>{table.columns.length}개</span>
      </div>
      {table.columns.map((column, index) => (
        <ColumnEditor
          key={column.id}
          doc={doc}
          tableId={tableId}
          column={column}
          index={index}
          isLast={index === table.columns.length - 1}
          duplicateAutoIncrement={column.autoIncrement && column.id !== firstAutoIncrementId}
        />
      ))}
      <button type="button" className="btn p-add" onClick={() => addNextColumn(doc, tableId)}>
        ＋ 컬럼 추가
      </button>

      <div className="p-sub">
        복합 UNIQUE <span>{table.uniques.length}개</span>
        <button type="button" className="btn p-sub-btn" onClick={() => addUnique(doc, tableId)}>
          ＋ 추가
        </button>
      </div>
      {table.uniques.length === 0 ? (
        <p className="p-hint">여러 컬럼을 묶어 하나의 UNIQUE 제약으로 지정합니다</p>
      ) : (
        table.uniques.map((unique, index) => (
          <UniqueEditor key={unique.id} doc={doc} table={table} unique={unique} number={index + 1} />
        ))
      )}

      <datalist id="column-types">
        {COLUMN_TYPES.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
    </aside>
  )
}
