import type * as Y from 'yjs'
import { deleteUnique, MAX_PHYSICAL_NAME, toggleUniqueColumn, updateUnique } from '../model'
import type { TableData, UniqueData } from '../model'
import { TextField } from './TextField'

// table: 칩으로 보여줄 column 목록과 자동 이름의 table 물리명, number: 화면의 U1, U2 번호
type UniqueEditorProps = {
  doc: Y.Doc
  table: TableData
  unique: UniqueData
  number: number
}

// 복합 UQ 1개의 편집 영역: 번호·이름·삭제 / column 칩 / 안내 문구
export function UniqueEditor({ doc, table, unique, number }: UniqueEditorProps) {
  const selected = new Set(unique.columnIds)
  // 지금 table에 있는 column만 남김, 지워진 column id는 무시 (2.4)
  const selectedColumns = table.columns.filter((column) => selected.has(column.id))
  // 이름을 비웠을 때 내보내기에서 붙을 이름을 placeholder로 미리 보여줌 (uq_{table}_{col1}_{col2})
  const autoName =
    selectedColumns.length > 0
      ? `uq_${table.physicalName}_${selectedColumns.map((column) => column.physicalName).join('_')}`
      : '제약 이름 (비우면 자동)'

  return (
    <div className="p-uq">
      <div className="uq-top">
        <span className="uq-no">U{number}</span>
        {/* 비우거나 공백만 입력하면 null로 저장 → 자동 이름 사용 */}
        <TextField
          className="mono"
          value={unique.name ?? ''}
          placeholder={autoName}
          aria-label="제약 이름"
          maxLength={MAX_PHYSICAL_NAME}
          onCommit={(value) => updateUnique(doc, table.id, unique.id, { name: value.trim() || null })}
        />
        <button
          type="button"
          className="uq-del"
          title="복합 UNIQUE 삭제"
          onClick={() => deleteUnique(doc, table.id, unique.id)}
        >
          ✕
        </button>
      </div>
      {/* table의 모든 column을 칩으로 표시, 클릭하면 이 제약에 넣거나 뺌 */}
      <div className="uq-cols">
        {table.columns.map((column) => (
          <button
            key={column.id}
            type="button"
            className={selected.has(column.id) ? 'uq-chip on' : 'uq-chip'}
            aria-pressed={selected.has(column.id)}
            onClick={() => toggleUniqueColumn(doc, table.id, unique.id, column.id)}
          >
            {column.physicalName}
          </button>
        ))}
      </div>
      {/* 유효 column이 2개 이상일 때만 UNIQUE KEY로 내보냄 (2.4) */}
      {selectedColumns.length < 2 && (
        <p className="p-hint">컬럼을 2개 이상 선택해야 내보내기에 반영됩니다</p>
      )}
    </div>
  )
}
