import type * as Y from 'yjs'
import {
  deleteColumn,
  MAX_LOGICAL_NAME,
  MAX_PHYSICAL_NAME,
  moveColumn,
  readRelations,
  updateColumn,
} from '../model'
import type { ColumnData, ColumnPatch } from '../model'
import { TextField } from './TextField'

// index: 화면 순서상 위치(↑↓ 이동 계산), isLast: 맨 아래 여부(↓ 비활성)
// duplicateAutoIncrement: AI인데 테이블의 첫 번째 AI column이 아님 → 경고 표시
type ColumnEditorProps = {
  doc: Y.Doc
  tableId: string
  column: ColumnData
  index: number
  isLast: boolean
  duplicateAutoIncrement: boolean
}

// PK, NN, UQ, AI 체크박스 1개에 필요한 값
type CheckProps = {
  label: string
  checked: boolean
  disabled?: boolean
  title?: string
  onChange: (checked: boolean) => void
}

// label로 감싼 체크박스, 체크는 클릭이 곧 확정이므로 TextField와 달리 바로 onChange 호출
// dis: 비활성 스타일, title: 마우스를 올렸을 때 보일 이유 설명
function Check({ label, checked, disabled = false, title, onChange }: CheckProps) {
  return (
    <label className={disabled ? 'ck dis' : 'ck'} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

// 동시 편집 등으로 옵션 규칙이 어긋난 경우 보여줄 경고 (2.3), 데이터는 고치지 않음
function columnWarning(column: ColumnData, duplicateAutoIncrement: boolean): string | null {
  if (column.autoIncrement && !column.pk) {
    return 'PK가 아니어서 AUTO_INCREMENT가 내보내기에서 무시됩니다'
  }
  if (duplicateAutoIncrement) {
    return 'AUTO_INCREMENT는 테이블당 1개만 반영됩니다 (첫 번째 컬럼 기준)'
  }
  return null
}

// default, comment는 string | null (2.3) → 입력칸을 비우면 null로 저장
function nullIfEmpty(value: string): string | null {
  return value === '' ? null : value
}

// column 1개의 편집 영역: 이름 / 타입, PK, NN, UQ, ↑↓, ✕ / 기본값, AI / 경고 / 코멘트
export function ColumnEditor({
  doc,
  tableId,
  column,
  index,
  isLast,
  duplicateAutoIncrement,
}: ColumnEditorProps) {
  const warning = columnWarning(column, duplicateAutoIncrement)

  // 이 column에 대한 updateColumn 호출을 줄여 쓰기 위한 함수
  function update(patch: ColumnPatch) {
    updateColumn(doc, tableId, column.id, patch)
  }

  // 물리명·타입은 비울 수 없으므로 앞뒤 공백 제거 후 비어 있으면 쓰지 않음 (입력칸은 원래 값으로 돌아감)
  function handleRequired(key: 'physicalName' | 'type', value: string) {
    const trimmed = value.trim()
    if (trimmed) {
      update({ [key]: trimmed })
    }
  }

  // 이 column을 FK로 쓰는 관계가 있으면 관계도 함께 삭제되므로 확인 후 삭제
  function handleDelete() {
    const usedAsForeignKey = readRelations(doc).some(
      (relation) => relation.toTable === tableId && relation.toColumn === column.id,
    )
    if (usedAsForeignKey && !window.confirm('이 컬럼을 FK로 쓰는 관계도 함께 삭제됩니다. 삭제할까요?')) {
      return
    }
    deleteColumn(doc, tableId, column.id)
  }

  return (
    <div className="p-col">
      <div className="r1">
        <TextField
          value={column.logicalName}
          placeholder="논리명"
          aria-label="논리명"
          maxLength={MAX_LOGICAL_NAME}
          onCommit={(logicalName) => update({ logicalName })}
        />
        <TextField
          className="mono"
          value={column.physicalName}
          placeholder="물리명"
          aria-label="물리명"
          maxLength={MAX_PHYSICAL_NAME}
          onCommit={(value) => handleRequired('physicalName', value)}
        />
      </div>
      <div className="r2">
        {/* list: TablePanel의 datalist(column-types)와 연결된 추천 목록, 목록 밖의 타입도 입력 가능 */}
        <TextField
          className="mono"
          value={column.type}
          placeholder="타입"
          aria-label="타입"
          list="column-types"
          onCommit={(value) => handleRequired('type', value)}
        />
        {/* PK를 켜면 updateColumn이 unique=false도 함께 씀 (2.3) */}
        <Check label="PK" checked={column.pk} onChange={(pk) => update({ pk })} />
        {/* PK는 항상 NOT NULL로 표시하고 잠금 (TableNode 표시와 동일) */}
        <Check
          label="NN"
          checked={column.notNull || column.pk}
          disabled={column.pk}
          title={column.pk ? 'PK는 항상 NOT NULL입니다' : undefined}
          onChange={(notNull) => update({ notNull })}
        />
        {/* PK면 UQ 비활성 (2.3), pk && unique로 어긋난 데이터도 체크 해제로 표시 */}
        <Check
          label="UQ"
          checked={column.unique && !column.pk}
          disabled={column.pk}
          title={column.pk ? 'PK는 항상 UNIQUE입니다' : undefined}
          onChange={(unique) => update({ unique })}
        />
        {/* toIndex = 이동 후 위치, 맨 위·맨 아래에서는 해당 버튼 비활성 */}
        <span className="ord">
          <button
            type="button"
            title="위로"
            disabled={index === 0}
            onClick={() => moveColumn(doc, tableId, column.id, index - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            title="아래로"
            disabled={isLast}
            onClick={() => moveColumn(doc, tableId, column.id, index + 1)}
          >
            ↓
          </button>
          <button type="button" title="컬럼 삭제" onClick={handleDelete}>
            ✕
          </button>
        </span>
      </div>
      <div className="r3">
        {/* AI면 값이 자동으로 들어가므로 기본값 입력 잠금, 입력한 문자열 그대로 저장 (2.3) */}
        <TextField
          className="mono"
          value={column.default ?? ''}
          placeholder={
            column.autoIncrement ? 'AUTO_INCREMENT로 자동 증가' : '기본값 (예: 0, CURRENT_TIMESTAMP)'
          }
          aria-label="기본값"
          disabled={column.autoIncrement}
          onCommit={(value) => update({ default: nullIfEmpty(value) })}
        />
        {/* AI는 PK일 때만 켤 수 있음 (2.3), 이미 켜진 AI는 PK가 아니어도 끌 수 있게 활성 유지 */}
        <Check
          label="AI"
          checked={column.autoIncrement}
          disabled={!column.pk && !column.autoIncrement}
          title={column.pk ? 'AUTO_INCREMENT' : 'PK 컬럼만 자동 증가할 수 있습니다'}
          onChange={(autoIncrement) => update({ autoIncrement })}
        />
      </div>
      {warning && <p className="p-warn">{warning}</p>}
      <TextField
        value={column.comment ?? ''}
        placeholder="코멘트"
        aria-label="코멘트"
        onCommit={(value) => update({ comment: nullIfEmpty(value) })}
      />
    </div>
  )
}
