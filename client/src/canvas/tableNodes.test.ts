import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createTable, getTables, moveTables, updateTable } from '../model'
import { mergeTables, readNodes } from './tableNodes'

const noop = () => {}
const FROM = { x: 0, y: 0 }
const TO = { x: 300, y: 200 }

// 다른 사용자 B가 앞선 변경(이름 수정)과 이동을 차례로 보냈는데, 이동만 먼저 도착하는 상황을 만듦
// Yjs는 같은 사용자의 변경을 순서대로만 적용하므로, 이동만 받으면 이전 위치 삭제만 반영되고 새 위치는 대기함
function setup() {
  const origin = new Y.Doc()
  const id = createTable(origin, { logicalName: '회원', physicalName: 'member', position: FROM })
  const created = Y.encodeStateAsUpdate(origin)

  const b = new Y.Doc()
  Y.applyUpdate(b, created)
  const updates: Uint8Array[] = []
  b.on('update', (update: Uint8Array) => updates.push(update))
  updateTable(b, id, { logicalName: '회원2' })
  moveTables(b, [{ id, position: TO }])
  const [earlier, move] = updates

  return { id, created, earlier, move }
}

describe('position이 잠깐 빈 table', () => {
  it('준비: 이동만 먼저 받으면 position이 비고, 앞선 변경이 오면 채워짐', () => {
    const { id, created, earlier, move } = setup()
    const doc = new Y.Doc()
    Y.applyUpdate(doc, created)
    Y.applyUpdate(doc, move)
    expect(getTables(doc).get(id)?.get('position')).toBeUndefined()
    Y.applyUpdate(doc, earlier)
    expect(getTables(doc).get(id)?.get('position')).toEqual(TO)
  })

  it('화면에 있던 table은 이전 위치를 유지하고, 앞선 변경이 오면 새 위치로 옮김', () => {
    const { id, created, earlier, move } = setup()
    const doc = new Y.Doc()
    Y.applyUpdate(doc, created)
    const nodes = readNodes(doc, noop)
    expect(nodes.map((node) => node.position)).toEqual([FROM])

    Y.applyUpdate(doc, move)
    const during = mergeTables(nodes, doc, noop, new Set([id]))
    expect(during.map((node) => node.position)).toEqual([FROM])

    Y.applyUpdate(doc, earlier)
    const after = mergeTables(during, doc, noop, new Set([id]))
    expect(after.map((node) => node.position)).toEqual([TO])
  })

  it('처음 그릴 때 위치가 빈 table은 건너뛰고, 위치가 오면 추가함', () => {
    const { id, created, earlier, move } = setup()
    const doc = new Y.Doc()
    Y.applyUpdate(doc, created)
    Y.applyUpdate(doc, move)
    expect(readNodes(doc, noop)).toEqual([])

    Y.applyUpdate(doc, earlier)
    const after = mergeTables([], doc, noop, new Set([id]))
    expect(after.map((node) => node.position)).toEqual([TO])
  })

  it('새로 들어온 table도 위치가 비어 있으면 건너뛰고, 위치가 오면 추가함', () => {
    const { id, created, earlier, move } = setup()
    const doc = new Y.Doc()
    // table 생성과 이동을 한 번에 받아, 화면에 없던 table이 위치가 빈 채로 들어옴
    Y.applyUpdate(doc, Y.mergeUpdates([created, move]))
    expect(mergeTables([], doc, noop, new Set([id]))).toEqual([])

    Y.applyUpdate(doc, earlier)
    expect(mergeTables([], doc, noop, new Set([id])).map((node) => node.position)).toEqual([TO])
  })
})
