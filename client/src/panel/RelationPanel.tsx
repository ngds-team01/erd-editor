import { useLayoutEffect, useState } from 'react'
import type * as Y from 'yjs'
import {
  deleteRelation,
  getColumns,
  getRelations,
  getTables,
  observeRelations,
  observeTables,
  readRelation,
  updateRelation,
} from '../model'
import type { Cardinality, RelationData, TableMap } from '../model'

// 카디널리티 선택 버튼
const CARDINALITIES: Cardinality[] = ['1:1', '1:N']

type RelationPanelProps = {
  doc: Y.Doc
  relationId: string
  onClose: () => void
}

// 패널에 표시할 값: relation과, 부모·자식 table 이름, FK column 물리명
// table이나 FK column이 없으면 null (동시 편집으로 생긴 고아 관계, 2.7)
type RelationView = {
  relation: RelationData
  parent: string | null
  child: string | null
  foreignKey: string | null
}

// table 이름 표시: 논리명과 물리명
function tableLabel(table: TableMap | undefined): string | null {
  if (!table) {
    return null
  }
  return `${table.get('logicalName') as string} (${table.get('physicalName') as string})`
}

// relation id로 relation을 찾아 패널에 표시할 값으로 변환, relation이 없으면 null
function readRelationView(doc: Y.Doc, relationId: string): RelationView | null {
  const relationMap = getRelations(doc).get(relationId)
  if (!relationMap) {
    return null
  }

  const relation = readRelation(relationMap)
  const tables = getTables(doc)
  const child = tables.get(relation.toTable)
  const foreignKey =
    child && relation.toColumn ? getColumns(child).get(relation.toColumn)?.get('physicalName') : undefined

  return {
    relation,
    parent: tableLabel(tables.get(relation.fromTable)),
    child: tableLabel(child),
    foreignKey: (foreignKey as string | undefined) ?? null,
  }
}

// relation 읽기와 구독을 실행하는 custom hook (TablePanel의 useTable과 같은 구조)
// relation이 바뀌거나, 부모·자식 table(이름, FK column)이 바뀌면 다시 읽음
// onMissing: relation이 삭제됐을 때 호출 (패널 닫기)
function useRelationView(doc: Y.Doc, relationId: string, onMissing: () => void): RelationView | null {
  const [view, setView] = useState(() => readRelationView(doc, relationId))

  useLayoutEffect(() => {
    // 다시 읽어 상태를 바꾸면 React가 패널을 다시 그림, 없으면 삭제된 relation
    function refresh() {
      const next = readRelationView(doc, relationId)
      if (next) {
        setView(next)
      } else {
        onMissing()
      }
    }

    const stopRelations = observeRelations(doc, (relationIds) => {
      if (relationIds.has(relationId)) {
        refresh()
      }
    })
    const stopTables = observeTables(doc, (tableIds) => {
      // 다른 table의 변경(드래그 등)이면 다시 읽지 않음
      const current = getRelations(doc).get(relationId)
      if (
        current &&
        (tableIds.has(current.get('fromTable') as string) || tableIds.has(current.get('toTable') as string))
      ) {
        refresh()
      }
    })

    // 패널이 사라질 때 두 구독을 모두 해제
    return () => {
      stopRelations()
      stopTables()
    }
  }, [doc, relationId, onMissing])

  return view
}

// 관계 편집 패널: 부모·자식 표시, 카디널리티, 식별 여부, 삭제
// 패널 틀(p-title, p-label 등)은 TablePanel과 같은 class를 사용
export function RelationPanel({ doc, relationId, onClose }: RelationPanelProps) {
  const view = useRelationView(doc, relationId, onClose)
  if (!view) {
    return null
  }

  const { relation, parent, child, foreignKey } = view

  // 관계 삭제 시 Handler, FK column도 함께 삭제되며 구독이 패널을 닫음
  function handleDelete() {
    if (window.confirm('관계를 삭제할까요? 자동 생성된 FK 컬럼도 함께 삭제됩니다.')) {
      deleteRelation(doc, relationId)
    }
  }

  return (
    <aside className="panel" aria-label="관계 편집">
      <div className="p-title">
        관계 편집
        <span className="p-title-btns">
          <button type="button" className="btn danger" onClick={handleDelete}>
            삭제
          </button>
          <button type="button" className="btn" title="패널 닫기" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>

      <dl className="p-info">
        <dt>부모 (참조되는 테이블)</dt>
        <dd>{parent ?? '삭제된 테이블'}</dd>
        <dt>자식 (참조하는 테이블)</dt>
        <dd>{child ?? '삭제된 테이블'}</dd>
        <dt>FK 컬럼</dt>
        <dd className={foreignKey ? 'mono' : undefined}>
          {foreignKey ?? '없음 (부모 테이블에 PK가 없어 FK 컬럼을 만들지 않음)'}
        </dd>
      </dl>

      <span className="p-label">카디널리티</span>
      <div className="seg" role="group" aria-label="카디널리티">
        {CARDINALITIES.map((cardinality) => (
          <button
            key={cardinality}
            type="button"
            className={cardinality === relation.cardinality ? 'on' : undefined}
            aria-pressed={cardinality === relation.cardinality}
            onClick={() => updateRelation(doc, relationId, { cardinality })}
          >
            {cardinality === '1:1' ? '1 : 1' : '1 : N'}
          </button>
        ))}
      </div>

      <label className="ck p-check">
        <input
          type="checkbox"
          checked={relation.identifying}
          onChange={(event) => updateRelation(doc, relationId, { identifying: event.target.checked })}
        />
        식별 관계 (FK가 자식 PK에 포함, 실선)
      </label>

      <p className="p-hint p-foot">관계를 삭제하면 자동 생성된 FK 컬럼도 함께 삭제됩니다.</p>
    </aside>
  )
}
