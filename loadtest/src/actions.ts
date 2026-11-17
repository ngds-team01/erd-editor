import type * as Y from 'yjs'
import {
  addColumn,
  createRelation,
  createTable,
  deleteColumn,
  deleteTable,
  getColumns,
  getRelations,
  getTables,
  moveColumn,
  moveTables,
  TABLE_COLORS,
  updateColumn,
  updateTable,
} from './model'
import type { ColumnPatch, Position } from './model'
import type { Random } from './random'

// 봇이 하는 편집 종류
export type ActionName =
  | 'drag'
  | 'renameTable'
  | 'recolorTable'
  | 'editColumn'
  | 'addColumn'
  | 'moveColumn'
  | 'deleteColumn'
  | 'createTable'
  | 'createRelation'
  | 'deleteTable'

// 편집 종류별 비중, 실제 사용 패턴처럼 드래그와 값 수정이 가장 잦고 생성·삭제는 드묾
const WEIGHTS: Record<ActionName, number> = {
  drag: 30,
  editColumn: 20,
  renameTable: 8,
  recolorTable: 4,
  addColumn: 10,
  moveColumn: 8,
  deleteColumn: 5,
  createTable: 6,
  createRelation: 6,
  deleteTable: 3,
}

// 문서가 끝없이 커지거나 텅 비지 않게 하는 한도
export type EditLimits = {
  maxTables: number
  maxColumns: number
  maxRelations: number
  // 테이블이 이보다 많을 때만 테이블 삭제
  minTables: number
}

export const DEFAULT_LIMITS: EditLimits = { maxTables: 30, maxColumns: 12, maxRelations: 40, minTables: 3 }

// 드래그 1번: 대상 테이블과 50ms마다 쓸 좌표 목록
export type Drag = {
  tableId: string
  steps: Position[]
}

const COLUMN_TYPES = ['BIGINT', 'INT', 'VARCHAR(255)', 'VARCHAR(50)', 'TEXT', 'DATETIME', 'DECIMAL(10,2)', 'BOOLEAN']
// 캔버스 좌표 범위, 드래그 1번에 움직이는 최대 거리
const CANVAS_SIZE = 3000
const MAX_DRAG_DISTANCE = 300

// 지금 문서 상태에서 할 수 있는 편집만 골라 비중대로 하나를 뽑음
// 예: 테이블이 없으면 createTable만, 한도에 닿은 생성은 제외
export function pickAction(doc: Y.Doc, random: Random, limits: EditLimits = DEFAULT_LIMITS): ActionName {
  const tableCount = getTables(doc).size
  if (tableCount === 0) {
    return 'createTable'
  }

  const available = (Object.keys(WEIGHTS) as ActionName[]).filter((action) => {
    switch (action) {
      case 'createTable':
        return tableCount < limits.maxTables
      case 'createRelation':
        return getRelations(doc).size < limits.maxRelations
      case 'deleteTable':
        return tableCount > limits.minTables
      default:
        return true
    }
  })

  // 비중 합 안에서 난수를 하나 뽑고, 앞에서부터 비중을 빼 가며 그 값이 떨어지는 칸을 고름
  const total = available.reduce((sum, action) => sum + WEIGHTS[action], 0)
  let roll = random.next() * total
  for (const action of available) {
    roll -= WEIGHTS[action]
    if (roll < 0) {
      return action
    }
  }
  return available[available.length - 1]
}

// 드래그 경로 만들기: 현재 위치에서 무작위 지점까지 steps개로 나눈 좌표, 테이블이 없으면 null
export function planDrag(doc: Y.Doc, random: Random): Drag | null {
  const tableId = randomTableId(doc, random)
  const table = tableId && getTables(doc).get(tableId)
  if (!tableId || !table) {
    return null
  }

  const from = table.get('position') as Position
  const to = {
    x: clamp(from.x + random.int(-MAX_DRAG_DISTANCE, MAX_DRAG_DISTANCE), 0, CANVAS_SIZE),
    y: clamp(from.y + random.int(-MAX_DRAG_DISTANCE, MAX_DRAG_DISTANCE), 0, CANVAS_SIZE),
  }
  const count = random.int(5, 15)
  const steps = []

  for (let index = 0; index < count; index += 1) {
    const ratio = (index + 1) / count
    const x = from.x + (to.x - from.x) * ratio
    const y = from.y + (to.y - from.y) * ratio
    steps.push({ x: Math.round(x), y: Math.round(y) })
  }

  return { tableId, steps }
}

// 드래그 실행: 경로 좌표를 하나씩 쓰고, 좌표 사이마다 wait()이 끝나길 기다림
// 쉬는 방법은 부르는 쪽이 정함 → 봇은 50ms 쉬기(contracts 2.7), 네트워크 없는 테스트는 쉬지 않음
// 드래그 도중 다른 사용자가 테이블을 지웠으면 moveTables가 아무것도 쓰지 않음
export async function performDrag(doc: Y.Doc, drag: Drag, wait: () => Promise<void>): Promise<void> {
  for (const position of drag.steps) {
    moveTables(doc, [{ id: drag.tableId, position }])
    await wait()
  }
}

// 드래그를 제외한 편집 1번을 실행, 실제로 문서를 바꿨으면 true
// 드래그는 시간에 걸쳐 여러 번 쓰므로 performDrag가 따로 처리
// Exclude<ActionName, 'drag'>: 편집 이름 중 'drag'만 뺀 타입, 'drag'를 넘기면 타입 오류
export function applyAction(
  doc: Y.Doc,
  random: Random,
  action: Exclude<ActionName, 'drag'>,
  limits: EditLimits = DEFAULT_LIMITS,
): boolean {
  switch (action) {
    case 'createTable': {
      const number = random.int(1, 999)
      const position = { x: random.int(0, CANVAS_SIZE), y: random.int(0, CANVAS_SIZE) }
      createTable(doc, { logicalName: `테이블${number}`, physicalName: `table_${number}`, position })
      return true
    }
    case 'renameTable': {
      const tableId = randomTableId(doc, random)
      const number = random.int(1, 999)
      return !!tableId && updateTable(doc, tableId, { logicalName: `테이블${number}`, physicalName: `table_${number}` })
    }
    case 'recolorTable': {
      const tableId = randomTableId(doc, random)
      const color = random.pick(TABLE_COLORS)
      return !!tableId && !!color && updateTable(doc, tableId, { color: color.value })
    }
    case 'deleteTable': {
      const tableId = randomTableId(doc, random)
      return !!tableId && deleteTable(doc, tableId)
    }
    case 'addColumn': {
      const tableId = randomTableId(doc, random)
      const table = tableId && getTables(doc).get(tableId)
      if (!tableId || !table || getColumns(table).size >= limits.maxColumns) {
        return false
      }
      const type = random.pick(COLUMN_TYPES) ?? 'INT'
      return addColumn(doc, tableId, { physicalName: `column_${random.int(1, 999)}`, type }) !== null
    }
    case 'editColumn': {
      const target = randomColumn(doc, random)
      return !!target && updateColumn(doc, target.tableId, target.columnId, randomColumnPatch(random))
    }
    case 'moveColumn': {
      const target = randomColumn(doc, random)
      return !!target && moveColumn(doc, target.tableId, target.columnId, random.int(0, target.columnCount - 1))
    }
    case 'deleteColumn': {
      const target = randomColumn(doc, random)
      // 컬럼이 하나뿐인 테이블은 비우지 않음
      return !!target && target.columnCount > 1 && deleteColumn(doc, target.tableId, target.columnId)
    }
    case 'createRelation': {
      // 자기 참조도 허용 (contracts 2.5)
      const fromTable = randomTableId(doc, random)
      const toTable = randomTableId(doc, random)
      if (!fromTable || !toTable) {
        return false
      }
      const cardinality = random.chance(0.7) ? '1:N' : '1:1'
      return createRelation(doc, { fromTable, toTable, cardinality, identifying: random.chance(0.3) }) !== null
    }
  }
}

// 편집 1번: pickAction으로 고르고, 드래그면 performDrag, 나머지는 applyAction으로 실행
// wait: 드래그 좌표 사이에 쉬는 방법, 봇은 50ms 쉬기를 넘기고 테스트는 기본값(쉬지 않음)을 씀
export async function randomEdit(
  doc: Y.Doc,
  random: Random,
  limits: EditLimits = DEFAULT_LIMITS,
  wait: () => Promise<void> = noWait,
): Promise<ActionName> {
  const action = pickAction(doc, random, limits)
  if (action === 'drag') {
    const drag = planDrag(doc, random)
    if (drag) {
      await performDrag(doc, drag, wait)
    }
  } else {
    // 위 if에서 'drag'를 걸렀으므로 TypeScript가 action을 'drag'가 아닌 타입으로 좁혀 줌
    applyAction(doc, random, action, limits)
  }
  return action
}

// 기다리지 않고 바로 끝나는 wait
function noWait(): Promise<void> {
  return Promise.resolve()
}

function randomTableId(doc: Y.Doc, random: Random): string | undefined {
  return random.pick([...getTables(doc).keys()])
}

// 무작위 테이블의 무작위 컬럼, 컬럼이 없으면 undefined
function randomColumn(
  doc: Y.Doc,
  random: Random,
): { tableId: string; columnId: string; columnCount: number } | undefined {
  const tableId = randomTableId(doc, random)
  const table = tableId && getTables(doc).get(tableId)
  if (!tableId || !table) {
    return undefined
  }
  const columnIds = [...getColumns(table).keys()]
  const columnId = random.pick(columnIds)
  return columnId ? { tableId, columnId, columnCount: columnIds.length } : undefined
}

// 컬럼 값 하나를 무작위로 바꾸는 patch, 패널에서 한 칸을 고치는 것과 같음
function randomColumnPatch(random: Random): ColumnPatch {
  const number = random.int(1, 999)
  const patches: ColumnPatch[] = [
    { type: random.pick(COLUMN_TYPES) },
    { physicalName: `column_${number}` },
    { logicalName: `컬럼${number}` },
    { notNull: random.chance(0.5) },
    { unique: random.chance(0.3) },
    { default: random.chance(0.5) ? String(number) : null },
    { comment: random.chance(0.5) ? `메모 ${number}` : null },
  ]
  return random.pick(patches) ?? {}
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
