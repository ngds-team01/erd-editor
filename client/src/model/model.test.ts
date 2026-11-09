import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, createTable, getTables, moveTables, readTable, readTables, sortColumns } from './index'
import type { Position } from './index'

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
