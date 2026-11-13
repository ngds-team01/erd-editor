import * as Y from 'yjs'
import { addColumn, deleteColumn, moveColumn, sortedColumnMaps, updateColumn } from './columns'
import { getColumns, getRelations, getTables, MAX_PHYSICAL_NAME, writeChanged } from './schema'
import type { ColumnMap, RelationData, RelationMap, TableMap } from './schema'

// Table 간의 Relation 생성 시 받는 Relation information
// id는 random UUID로 만들고, toColumn은 FK 컬럼을 만든 뒤 결정
export type NewRelation = Omit<RelationData, 'id' | 'toColumn'>
// Relation의 Option 변경 시 활용하는 type → relation의 cardinality, 식별 여부
// fromTable, toTable은 변경 불가 (연결 대상을 바꾸려면 삭제 후 재생성)
export type RelationPatch = Partial<Pick<RelationData, 'cardinality' | 'identifying'>>

// column이 PK인지 판정
function isPrimaryKey(column: ColumnMap): boolean {
  return column.get('pk') === true
}

// fromTable에서 FK가 참조할 PK column 선정
// 복합 PK여도 프로젝트의 pk 기본명인 id를 우선 탐색, 없으면 첫 PK, PK가 없으면 undefined
function referencedColumn(parent: TableMap): ColumnMap | undefined {
  const primaryKeys = sortedColumnMaps(parent).filter(isPrimaryKey)
  return primaryKeys.find((column) => column.get('physicalName') === 'id') ?? primaryKeys[0]
}

// toTable(자식)에 만들 FK column의 물리명 생성: {부모 물리명}_{참조 column 물리명} (예: users_id)
// 자기 참조이거나 부모 물리명이 비어 있으면 parent_id, 이미 있는 이름이면 _2, _3 부착
function foreignKeyName(parent: TableMap, child: TableMap, referenced: ColumnMap): string {
  const parentName = parent.get('physicalName') as string
  const prefix = parent === child || !parentName ? 'parent' : parentName
  const base = `${prefix}_${referenced.get('physicalName') as string}`.slice(0, MAX_PHYSICAL_NAME)
  const taken = new Set([...getColumns(child).values()].map((column) => column.get('physicalName')))

  let name = base
  for (let n = 2; taken.has(name); n += 1) {
    const suffix = `_${n}`
    name = base.slice(0, MAX_PHYSICAL_NAME - suffix.length) + suffix
  }
  return name
}

// toTable(자식)에 FK column을 추가하고 id 반환, 부모에 PK가 없으면 null (테이블 단위 관계)
// 식별 관계면 FK도 PK이므로 자식의 PK column들 바로 뒤로 이동, 비식별 관계면 맨 끝에 둠
function addForeignKey(
  doc: Y.Doc,
  parent: TableMap,
  child: TableMap,
  input: NewRelation,
): string | null {
  const referenced = referencedColumn(parent)
  if (!referenced) {
    return null
  }

  // FK 추가 전에 자식의 마지막 PK 다음 위치를 계산 (PK가 없으면 -1 + 1 = 0, 맨 위)
  const childColumns = sortedColumnMaps(child)
  const afterPrimaryKeys = childColumns.findLastIndex(isPrimaryKey) + 1

  // 타입은 참조 column과 같게, 관계가 있으면 FK 값은 반드시 있어야 하므로 NN
  const columnId = addColumn(doc, input.toTable, {
    logicalName: referenced.get('logicalName') as string,
    physicalName: foreignKeyName(parent, child, referenced),
    type: referenced.get('type') as string,
    pk: input.identifying,
    notNull: true,
  })

  if (columnId && input.identifying) {
    moveColumn(doc, input.toTable, columnId, afterPrimaryKeys)
  }
  return columnId
}

// Relation과 FK column을 한 transaction에서 생성 (2.7), 두 Table 중 하나라도 없으면 null
// 내부 addColumn, moveColumn의 transaction은 바깥 transaction에 합쳐져 update는 1번만 발생
export function createRelation(doc: Y.Doc, input: NewRelation): string | null {
  const tables = getTables(doc)
  const parent = tables.get(input.fromTable)
  const child = tables.get(input.toTable)
  if (!parent || !child) {
    return null
  }

  const id = crypto.randomUUID()

  doc.transact(() => {
    const relation: RelationMap = new Y.Map()
    relation.set('id', id)
    relation.set('fromTable', input.fromTable)
    relation.set('toTable', input.toTable)
    relation.set('cardinality', input.cardinality)
    relation.set('identifying', input.identifying)

    // FK를 못 만들었으면 toColumn key 자체를 두지 않음 (읽을 때 undefined)
    const toColumn = addForeignKey(doc, parent, child, input)
    if (toColumn) {
      relation.set('toColumn', toColumn)
    }

    getRelations(doc).set(id, relation)
  })

  return id
}

// cardinality, identifying 중 바뀐 값만 기록, Relation이 없으면 false
// identifying이 바뀌면 FK column의 pk도 함께 변경, 식별이면 NN도 켬 (unique=false는 updateColumn이 처리)
// FK column의 위치는 옮기지 않음
export function updateRelation(doc: Y.Doc, id: string, patch: RelationPatch): boolean {
  const relation = getRelations(doc).get(id)
  if (!relation) {
    return false
  }

  doc.transact(() => {
    writeChanged(relation, patch)

    const toColumn = relation.get('toColumn') as string | undefined
    if (patch.identifying !== undefined && toColumn) {
      updateColumn(
        doc,
        relation.get('toTable') as string,
        toColumn,
        patch.identifying ? { pk: true, notNull: true } : { pk: false },
      )
    }
  })

  return true
}

// Relation과 자동 생성된 FK column을 한 transaction에서 삭제, Relation이 없으면 false
export function deleteRelation(doc: Y.Doc, id: string): boolean {
  const relations = getRelations(doc)
  const relation = relations.get(id)
  if (!relation) {
    return false
  }

  doc.transact(() => {
    const toColumn = relation.get('toColumn') as string | undefined
    if (toColumn) {
      // deleteColumn이 이 FK를 쓰는 Relation(= 이 Relation)도 함께 삭제
      deleteColumn(doc, relation.get('toTable') as string, toColumn)
    }
    // FK가 없는 테이블 단위 관계는 여기서 삭제, 이미 지워졌다면 아무 동작 X
    relations.delete(id)
  })

  return true
}

// Y.Map인 Relation을 toJSON으로 일반 객체(RelationData)로 변환
export function readRelation(relation: RelationMap): RelationData {
  return relation.toJSON() as RelationData
}

// doc 내 모든 Relation Read
export function readRelations(doc: Y.Doc): RelationData[] {
  return [...getRelations(doc).values()].map(readRelation)
}

// 두 Table과 FK column(있다면)이 모두 존재할 때만 화면에 그림 (2.7 고아 관계)
// 그리지 않을 뿐 데이터는 지우지 않음 → 클라이언트마다 지우면 수렴이 흔들림
export function isRelationDrawable(doc: Y.Doc, relation: RelationData): boolean {
  const tables = getTables(doc)
  const child = tables.get(relation.toTable)
  if (!child || !tables.has(relation.fromTable)) {
    return false
  }
  return relation.toColumn === undefined || getColumns(child).has(relation.toColumn)
}

// observeTables와 동일한 구조, Relation 변경을 감시해 바뀐 relation id들을 전달
// onChange: 바뀐 relation id들을 받아 처리할 함수, 반환값: 구독 해제 함수
export function observeRelations(
  doc: Y.Doc,
  onChange: (relationIds: Set<string>) => void,
): () => void {
  const relations = getRelations(doc)

  // transaction이 끝날 때 변경 목록(events)을 받아 1번 호출됨, 로컬·원격 변경 모두 해당
  const observer: Parameters<typeof relations.observeDeep>[0] = (events) => {
    const relationIds = new Set<string>()

    for (const event of events) {
      // path[0] = relation id, relation의 필드(cardinality 등)가 바뀐 경우
      if (event.path.length > 0) {
        relationIds.add(String(event.path[0]))
      } else {
        // path가 비어 있으면 relations 자체의 변경(relation 추가·삭제), 변경된 key = relation id
        for (const key of event.changes.keys.keys()) {
          relationIds.add(key)
        }
      }
    }

    onChange(relationIds)
  }

  relations.observeDeep(observer)
  return () => relations.unobserveDeep(observer)
}
