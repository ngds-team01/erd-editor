import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addColumn,
  canonicalDoc,
  canonicalJSON,
  createRelation,
  createTable,
  docHash,
  getTables,
  updateColumn,
} from './index'

// 빈 문서의 canonicalDoc '{"relations":{},"tables":{}}' 의 SHA-256 (Node crypto로 미리 계산한 값)
const EMPTY_DOC_HASH = 'c8a84e7188fe6fd0d77c83467afe5f3c5cd0dc38e2500ffbfad63ac5b44007be'

function exchange(a: Y.Doc, b: Y.Doc): void {
  const fromA = Y.encodeStateAsUpdate(a)
  const fromB = Y.encodeStateAsUpdate(b)
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

function newTable(doc: Y.Doc, physicalName: string): string {
  return createTable(doc, { logicalName: physicalName, physicalName, position: { x: 0, y: 0 } })
}

describe('canonicalJSON', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('keeps array order and sorts objects inside arrays', () => {
    expect(canonicalJSON([3, 1, { z: 1, y: 2 }])).toBe('[3,1,{"y":2,"z":1}]')
  })

  it('gives the same string regardless of key insertion order', () => {
    expect(canonicalJSON({ x: 1, y: [2], z: null })).toBe(canonicalJSON({ z: null, y: [2], x: 1 }))
  })

  it('handles values the same way JSON.stringify does', () => {
    const value = {
      text: '따옴표 " 와 \\ 와 줄바꿈\n',
      nothing: null,
      skipped: undefined,
      list: [undefined, true, -1.5],
    }
    expect(JSON.parse(canonicalJSON(value))).toEqual(JSON.parse(JSON.stringify(value)))
    expect(canonicalJSON(value)).not.toContain('skipped')
  })
})

describe('docHash', () => {
  it('hashes an empty doc that never called getMap', async () => {
    const doc = new Y.Doc()
    expect(canonicalDoc(doc)).toBe('{"relations":{},"tables":{}}')
    expect(await docHash(doc)).toBe(EMPTY_DOC_HASH)
  })

  it('returns 64 lowercase hex characters', async () => {
    const doc = new Y.Doc()
    newTable(doc, 'users')
    expect(await docHash(doc)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives the same hash for the same content', async () => {
    const a = new Y.Doc()
    newTable(a, 'users')
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    expect(await docHash(b)).toBe(await docHash(a))
  })

  it('converges even when two docs received concurrent edits in a different order', async () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    // 서로 모르는 상태에서 각자 테이블을 만들고 컬럼을 추가
    const users = newTable(a, 'users')
    addColumn(a, users, { physicalName: 'email', type: 'VARCHAR(255)' })
    const posts = newTable(b, 'posts')
    addColumn(b, posts, { physicalName: 'title', type: 'VARCHAR(255)' })

    exchange(a, b)
    createRelation(a, { fromTable: users, toTable: posts, cardinality: '1:N', identifying: false })
    exchange(a, b)

    // 키 순서는 받은 순서대로라 두 문서에서 다름 → 정렬 없이 비교하면 다르게 보임
    expect(Object.keys(getTables(a).toJSON())).not.toEqual(Object.keys(getTables(b).toJSON()))
    expect(canonicalDoc(a)).toBe(canonicalDoc(b))
    expect(await docHash(a)).toBe(await docHash(b))
  })

  it('changes when any value changes', async () => {
    const doc = new Y.Doc()
    const users = newTable(doc, 'users')
    const email = addColumn(doc, users, { physicalName: 'email', type: 'VARCHAR(255)' })
    const before = await docHash(doc)

    updateColumn(doc, users, email!, { type: 'TEXT' })

    expect(await docHash(doc)).not.toBe(before)
  })
})
