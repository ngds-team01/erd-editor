import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addColumn,
  addUnique,
  createRelation,
  createTable,
  deleteColumn,
  deleteRelation,
  deleteTable,
  deleteTables,
  deleteUnique,
  getRelations,
  getTables,
  isRelationDrawable,
  moveColumn,
  moveTables,
  observeRelations,
  observeTables,
  readRelations,
  readTable,
  readTables,
  sortColumns,
  toggleUniqueColumn,
  updateColumn,
  updateRelation,
  updateTable,
} from './index'
import type { ColumnData, Position, TableData } from './index'

const origin: Position = { x: 0, y: 0 }

function newTable(doc: Y.Doc): string {
  return createTable(doc, { logicalName: '회원', physicalName: 'users', position: origin })
}

function exchange(a: Y.Doc, b: Y.Doc): void {
  const fromA = Y.encodeStateAsUpdate(a)
  const fromB = Y.encodeStateAsUpdate(b)
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

function cloneOf(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc()
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source))
  return clone
}

describe('createTable', () => {
  it('creates the table and its first column in one transaction', () => {
    const doc = new Y.Doc()
    let updates = 0
    doc.on('update', () => {
      updates += 1
    })

    const id = newTable(doc)
    const [table] = readTables(doc)

    expect(updates).toBe(1)
    expect(table.id).toBe(id)
    expect(table.position).toEqual(origin)
    expect(table.columns).toHaveLength(1)
    expect(table.columns[0]).toMatchObject({
      physicalName: 'id',
      pk: true,
      unique: false,
      order: 1,
    })
  })
})

describe('addColumn', () => {
  it('appends after the largest order', () => {
    const doc = new Y.Doc()
    const tableId = newTable(doc)

    addColumn(doc, tableId, { physicalName: 'email', type: 'VARCHAR(255)' })

    const table = readTable(getTables(doc).get(tableId)!)
    expect(table.columns.map((column) => column.physicalName)).toEqual(['id', 'email'])
    expect(table.columns.map((column) => column.order)).toEqual([1, 2])
  })

  it('uses the largest order even when every order is negative', () => {
    const doc = new Y.Doc()
    const tableId = newTable(doc)
    const columns = getTables(doc).get(tableId)!.get('columns') as Y.Map<Y.Map<unknown>>
    const [firstColumn] = [...columns.values()]
    firstColumn.set('order', -3)

    addColumn(doc, tableId, { physicalName: 'email', type: 'TEXT' })

    const table = readTable(getTables(doc).get(tableId)!)
    expect(table.columns.map((column) => column.order)).toEqual([-3, -2])
  })

  it('returns null when the table does not exist', () => {
    const doc = new Y.Doc()

    expect(addColumn(doc, 'missing', { physicalName: 'email', type: 'TEXT' })).toBeNull()
  })
})

describe('sortColumns', () => {
  it('sorts by order and then by id', () => {
    const sorted = sortColumns([
      { id: 'c', order: 2 },
      { id: 'b', order: 1 },
      { id: 'a', order: 1 },
    ])

    expect(sorted.map((column) => column.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('moveTables', () => {
  it('does not create a table that does not exist', () => {
    const doc = new Y.Doc()

    moveTables(doc, [{ id: 'missing', position: { x: 10, y: 10 } }])

    expect(getTables(doc).size).toBe(0)
  })
})

describe('observeTables', () => {
  it('reports the table id for new tables and nested column changes', () => {
    const doc = new Y.Doc()
    const reported: string[][] = []
    observeTables(doc, (tableIds) => {
      reported.push([...tableIds])
    })

    const tableId = newTable(doc)
    addColumn(doc, tableId, { physicalName: 'email', type: 'TEXT' })

    expect(reported).toEqual([[tableId], [tableId]])
  })

  it('stops reporting after unsubscribing', () => {
    const doc = new Y.Doc()
    let calls = 0
    const unsubscribe = observeTables(doc, () => {
      calls += 1
    })

    unsubscribe()
    newTable(doc)

    expect(calls).toBe(0)
  })
})

describe('convergence', () => {
  it('keeps columns added concurrently by two clients', () => {
    const a = new Y.Doc()
    const tableId = newTable(a)
    const b = cloneOf(a)

    addColumn(a, tableId, { physicalName: 'email', type: 'TEXT' })
    addColumn(b, tableId, { physicalName: 'phone', type: 'TEXT' })
    exchange(a, b)

    const names = readTables(a)[0].columns.map((column) => column.physicalName)
    expect(a.toJSON()).toEqual(b.toJSON())
    expect(names).toHaveLength(3)
    expect(names).toEqual(expect.arrayContaining(['id', 'email', 'phone']))
    expect(readTables(a)).toEqual(readTables(b))
  })

  it('never mixes x and y from concurrent moves', () => {
    const a = new Y.Doc()
    const tableId = newTable(a)
    const b = cloneOf(a)
    const fromA = { x: 100, y: 200 }
    const fromB = { x: 300, y: 400 }

    moveTables(a, [{ id: tableId, position: fromA }])
    moveTables(b, [{ id: tableId, position: fromB }])
    exchange(a, b)

    expect(a.toJSON()).toEqual(b.toJSON())
    expect([fromA, fromB]).toContainEqual(readTables(a)[0].position)
  })
})

function snapshotOf(doc: Y.Doc): unknown {
  return { tables: getTables(doc).toJSON(), relations: getRelations(doc).toJSON() }
}

function tableOf(doc: Y.Doc, tableId: string): TableData {
  return readTable(getTables(doc).get(tableId)!)
}

function namesOf(doc: Y.Doc, tableId: string): string[] {
  return tableOf(doc, tableId).columns.map((column) => column.physicalName)
}

function columnOf(doc: Y.Doc, tableId: string, physicalName: string): ColumnData {
  return tableOf(doc, tableId).columns.find((column) => column.physicalName === physicalName)!
}

function tableWithColumns(doc: Y.Doc, physicalName: string, columns: string[]): string {
  const tableId = createTable(doc, { logicalName: physicalName, physicalName, position: origin })
  for (const name of columns) {
    addColumn(doc, tableId, { physicalName: name, type: 'TEXT' })
  }
  return tableId
}

function countUpdates(doc: Y.Doc, action: () => void): number {
  let updates = 0
  const listener = () => {
    updates += 1
  }
  doc.on('update', listener)
  action()
  doc.off('update', listener)
  return updates
}

function relate(doc: Y.Doc, fromTable: string, toTable: string, identifying = false): string {
  return createRelation(doc, { fromTable, toTable, cardinality: '1:N', identifying })!
}

describe('updateTable', () => {
  it('writes only the keys that changed', () => {
    const doc = new Y.Doc()
    const tableId = newTable(doc)

    const unchanged = countUpdates(doc, () => updateTable(doc, tableId, { logicalName: '회원' }))
    const changed = countUpdates(doc, () =>
      updateTable(doc, tableId, { physicalName: 'members', color: '#d64545' }),
    )

    expect(unchanged).toBe(0)
    expect(changed).toBe(1)
    expect(tableOf(doc, tableId)).toMatchObject({
      logicalName: '회원',
      physicalName: 'members',
      color: '#d64545',
    })
  })

  it('returns false when the table does not exist', () => {
    expect(updateTable(new Y.Doc(), 'missing', { logicalName: 'x' })).toBe(false)
  })
})

describe('updateColumn', () => {
  it('turns unique off when the column becomes a primary key', () => {
    const doc = new Y.Doc()
    const tableId = tableWithColumns(doc, 'users', ['email'])
    const { id } = columnOf(doc, tableId, 'email')
    updateColumn(doc, tableId, id, { unique: true, type: 'VARCHAR(100)' })

    updateColumn(doc, tableId, id, { pk: true })

    expect(columnOf(doc, tableId, 'email')).toMatchObject({
      pk: true,
      unique: false,
      type: 'VARCHAR(100)',
    })
  })
})

describe('moveColumn', () => {
  it('places the column between its new neighbours', () => {
    const doc = new Y.Doc()
    const tableId = tableWithColumns(doc, 'users', ['a', 'b', 'c'])

    moveColumn(doc, tableId, columnOf(doc, tableId, 'c').id, 1)

    expect(namesOf(doc, tableId)).toEqual(['id', 'c', 'a', 'b'])
    expect(columnOf(doc, tableId, 'c').order).toBe(1.5)
  })

  it('moves to the top and to the bottom', () => {
    const doc = new Y.Doc()
    const tableId = tableWithColumns(doc, 'users', ['a', 'b'])

    moveColumn(doc, tableId, columnOf(doc, tableId, 'b').id, 0)
    moveColumn(doc, tableId, columnOf(doc, tableId, 'id').id, 2)

    expect(namesOf(doc, tableId)).toEqual(['b', 'a', 'id'])
    expect(columnOf(doc, tableId, 'b').order).toBe(0)
    expect(columnOf(doc, tableId, 'id').order).toBe(3)
  })

  it('does nothing when the column is already at the index', () => {
    const doc = new Y.Doc()
    const tableId = tableWithColumns(doc, 'users', ['a'])

    let moved = true
    const updates = countUpdates(doc, () => {
      moved = moveColumn(doc, tableId, columnOf(doc, tableId, 'a').id, 1)
    })

    expect(moved).toBe(false)
    expect(updates).toBe(0)
  })

  it('reranks every column when there is no room between the neighbours', () => {
    const doc = new Y.Doc()
    const tableId = tableWithColumns(doc, 'users', ['a', 'b', 'c'])
    const columns = getTables(doc).get(tableId)!.get('columns') as Y.Map<Y.Map<unknown>>
    columns.get(columnOf(doc, tableId, 'b').id)!.set('order', 2)
    const [first, second, third] = namesOf(doc, tableId)

    moveColumn(doc, tableId, columnOf(doc, tableId, 'c').id, 2)

    expect(namesOf(doc, tableId)).toEqual([first, second, 'c', third])
    expect(tableOf(doc, tableId).columns.map((column) => column.order)).toEqual([1, 2, 3, 4])
  })
})

describe('deleteColumn', () => {
  it('removes relations that point to it and drops it from composite uniques', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    const orders = tableWithColumns(doc, 'orders', ['code'])
    const relationId = relate(doc, users, orders)
    const foreignKey = readRelations(doc)[0].toColumn!
    const code = columnOf(doc, orders, 'code').id
    const uniqueId = addUnique(doc, orders)!
    toggleUniqueColumn(doc, orders, uniqueId, foreignKey)
    toggleUniqueColumn(doc, orders, uniqueId, code)

    deleteColumn(doc, orders, foreignKey)

    expect(getRelations(doc).has(relationId)).toBe(false)
    expect(namesOf(doc, orders)).toEqual(['id', 'code'])
    expect(tableOf(doc, orders).uniques[0].columnIds).toEqual([code])
  })
})

describe('createRelation', () => {
  it('adds a foreign key that references the id primary key of the parent', () => {
    const doc = new Y.Doc()
    const users = tableWithColumns(doc, 'users', ['tenant_id'])
    const tenant = columnOf(doc, users, 'tenant_id')
    updateColumn(doc, users, tenant.id, { pk: true, type: 'INT' })
    moveColumn(doc, users, tenant.id, 0)
    const orders = tableWithColumns(doc, 'orders', ['memo'])

    relate(doc, users, orders)

    const [relation] = readRelations(doc)
    expect(namesOf(doc, orders)).toEqual(['id', 'memo', 'users_id'])
    expect(columnOf(doc, orders, 'users_id')).toMatchObject({
      id: relation.toColumn,
      type: 'BIGINT',
      pk: false,
      notNull: true,
      autoIncrement: false,
    })
  })

  it('puts an identifying foreign key right after the primary keys', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    const orders = tableWithColumns(doc, 'orders', ['memo'])

    relate(doc, users, orders, true)

    expect(namesOf(doc, orders)).toEqual(['id', 'users_id', 'memo'])
    expect(columnOf(doc, orders, 'users_id').pk).toBe(true)
  })

  it('names a self reference parent_id and avoids taken names', () => {
    const doc = new Y.Doc()
    const categories = tableWithColumns(doc, 'categories', ['parent_id'])

    relate(doc, categories, categories)

    expect(namesOf(doc, categories)).toEqual(['id', 'parent_id', 'parent_id_2'])
  })

  it('makes a table level relation when the parent has no primary key', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    updateColumn(doc, users, tableOf(doc, users).columns[0].id, { pk: false })
    const orders = newTable(doc)

    relate(doc, users, orders)

    expect(readRelations(doc)[0].toColumn).toBeUndefined()
    expect(namesOf(doc, orders)).toEqual(['id'])
  })

  it('creates the relation and the foreign key in one transaction', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    const orders = newTable(doc)

    expect(countUpdates(doc, () => relate(doc, users, orders, true))).toBe(1)
  })

  it('returns null when a table does not exist', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)

    const input = { fromTable: users, toTable: 'missing', cardinality: '1:N', identifying: false } as const
    expect(createRelation(doc, input)).toBeNull()
    expect(getRelations(doc).size).toBe(0)
  })
})

describe('updateRelation', () => {
  it('keeps the primary key flag of the foreign key in step with identifying', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    const orders = newTable(doc)
    const relationId = relate(doc, users, orders)
    updateColumn(doc, orders, readRelations(doc)[0].toColumn!, { unique: true })

    updateRelation(doc, relationId, { identifying: true, cardinality: '1:1' })

    expect(readRelations(doc)[0]).toMatchObject({ identifying: true, cardinality: '1:1' })
    expect(columnOf(doc, orders, 'users_id')).toMatchObject({ pk: true, unique: false })

    updateRelation(doc, relationId, { identifying: false })

    expect(columnOf(doc, orders, 'users_id').pk).toBe(false)
  })
})

describe('deleteRelation', () => {
  it('removes the foreign key column with the relation in one transaction', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    const orders = newTable(doc)
    const relationId = relate(doc, users, orders)

    expect(countUpdates(doc, () => deleteRelation(doc, relationId))).toBe(1)
    expect(getRelations(doc).size).toBe(0)
    expect(namesOf(doc, orders)).toEqual(['id'])
  })
})

describe('deleteTable', () => {
  it('removes its relations and the foreign keys they added in one transaction', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    const orders = newTable(doc)
    const items = newTable(doc)
    relate(doc, users, orders)
    relate(doc, orders, items)

    expect(countUpdates(doc, () => deleteTable(doc, orders))).toBe(1)
    expect(getTables(doc).has(orders)).toBe(false)
    expect(getRelations(doc).size).toBe(0)
    expect(namesOf(doc, items)).toEqual(['id'])
  })
})

describe('deleteTables', () => {
  it('removes every selected table and the relations between them in one transaction', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    const orders = newTable(doc)
    const items = newTable(doc)
    relate(doc, users, orders)
    relate(doc, orders, items)

    expect(countUpdates(doc, () => deleteTables(doc, [users, orders, 'missing']))).toBe(1)
    expect([...getTables(doc).keys()]).toEqual([items])
    expect(getRelations(doc).size).toBe(0)
    expect(namesOf(doc, items)).toEqual(['id'])
  })
})

describe('uniques', () => {
  it('keeps column ids in column order and deletes the constraint', () => {
    const doc = new Y.Doc()
    const tableId = tableWithColumns(doc, 'users', ['a', 'b'])
    const a = columnOf(doc, tableId, 'a').id
    const b = columnOf(doc, tableId, 'b').id
    const uniqueId = addUnique(doc, tableId)!

    toggleUniqueColumn(doc, tableId, uniqueId, b)
    toggleUniqueColumn(doc, tableId, uniqueId, a)

    expect(tableOf(doc, tableId).uniques[0]).toMatchObject({ name: null, columnIds: [a, b] })

    toggleUniqueColumn(doc, tableId, uniqueId, a)
    expect(tableOf(doc, tableId).uniques[0].columnIds).toEqual([b])

    deleteUnique(doc, tableId, uniqueId)
    expect(tableOf(doc, tableId).uniques).toEqual([])
  })
})

describe('observeRelations', () => {
  it('reports the relation id for new and changed relations', () => {
    const doc = new Y.Doc()
    const users = newTable(doc)
    const orders = newTable(doc)
    const reported: string[][] = []
    observeRelations(doc, (relationIds) => {
      reported.push([...relationIds])
    })

    const relationId = relate(doc, users, orders)
    updateRelation(doc, relationId, { cardinality: '1:1' })

    expect(reported).toEqual([[relationId], [relationId]])
  })
})

describe('edit convergence', () => {
  it('never duplicates a column moved by two clients at once', () => {
    const a = new Y.Doc()
    const tableId = tableWithColumns(a, 'users', ['a', 'b', 'c'])
    const b = cloneOf(a)
    const columnId = columnOf(a, tableId, 'c').id

    moveColumn(a, tableId, columnId, 0)
    moveColumn(b, tableId, columnId, 2)
    exchange(a, b)

    expect(snapshotOf(a)).toEqual(snapshotOf(b))
    expect(namesOf(a, tableId)).toHaveLength(4)
    expect(namesOf(a, tableId)).toEqual(namesOf(b, tableId))
  })

  it('keeps an edit made while another client moves the column', () => {
    const a = new Y.Doc()
    const tableId = tableWithColumns(a, 'users', ['a', 'b'])
    const b = cloneOf(a)
    const columnId = columnOf(a, tableId, 'b').id

    moveColumn(a, tableId, columnId, 0)
    updateColumn(b, tableId, columnId, { type: 'INT', notNull: true })
    exchange(a, b)

    expect(snapshotOf(a)).toEqual(snapshotOf(b))
    expect(namesOf(a, tableId)).toEqual(['b', 'id', 'a'])
    expect(columnOf(a, tableId, 'b')).toMatchObject({ type: 'INT', notNull: true })
  })

  it('drops a column added to a table that another client deleted', () => {
    const a = new Y.Doc()
    const tableId = newTable(a)
    const b = cloneOf(a)

    deleteTable(a, tableId)
    addColumn(b, tableId, { physicalName: 'email', type: 'TEXT' })
    exchange(a, b)

    expect(snapshotOf(a)).toEqual(snapshotOf(b))
    expect(getTables(a).size).toBe(0)
  })

  it('keeps but does not draw a relation to a table deleted at the same time', () => {
    const a = new Y.Doc()
    const users = newTable(a)
    const orders = newTable(a)
    const b = cloneOf(a)

    relate(a, users, orders)
    deleteTable(b, orders)
    exchange(a, b)

    const [relation] = readRelations(a)
    expect(snapshotOf(a)).toEqual(snapshotOf(b))
    expect(relation).toBeDefined()
    expect(isRelationDrawable(a, relation)).toBe(false)
  })
})
