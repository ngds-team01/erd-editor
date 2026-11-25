// 전원 이탈 복원의 빠진 연산 수 계산 확인: 일부 편집만 받은 문서를 만들어 기대 상태와 비교
// 실행: npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { createTable, deleteTable, updateTable } from './model'
import { captureState, compareStates } from './restore'

// 편집하는 문서 하나와, 그 편집을 update로 모아 두는 목록 (다른 문서에 골라서 적용할 수 있게)
function recordingDoc() {
  const doc = new Y.Doc()
  const updates: Uint8Array[] = []
  doc.on('update', (update: Uint8Array) => updates.push(update))
  return { doc, updates }
}

// updates를 적용한 새 문서 = 서버가 그 update들로 복원한 문서
function restoredFrom(updates: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc()
  updates.forEach((update) => Y.applyUpdate(doc, update))
  return doc
}

describe('compareStates', () => {
  it('모든 편집을 받은 문서는 빠진 것이 없음', () => {
    const { doc, updates } = recordingDoc()
    const id = createTable(doc, { logicalName: 'user', physicalName: 'user', position: { x: 0, y: 0 } })
    updateTable(doc, id, { logicalName: 'member' })

    const loss = compareStates(captureState(doc), captureState(restoredFrom(updates)))
    assert.deepEqual(loss, { missingInserts: 0, missingDeletes: 0, clients: [] })
  })

  it('마지막 편집이 빠지면 그 클라이언트의 빠진 추가 수를 셈', () => {
    const { doc, updates } = recordingDoc()
    createTable(doc, { logicalName: 'user', physicalName: 'user', position: { x: 0, y: 0 } })
    const kept = updates.length
    createTable(doc, { logicalName: 'order', physicalName: 'order', position: { x: 100, y: 0 } })

    const expected = captureState(doc)
    const loss = compareStates(expected, captureState(restoredFrom(updates.slice(0, kept))))
    const [client] = loss.clients
    assert.equal(client.client, doc.clientID)
    assert.equal(client.expectedClock, expected.clocks.get(doc.clientID))
    assert.ok(loss.missingInserts > 0)
    assert.equal(loss.missingInserts, client.expectedClock - client.restoredClock)
  })

  it('삭제만 빠지면 상태 벡터는 같고 빠진 삭제 수로 잡힘', () => {
    const { doc, updates } = recordingDoc()
    const id = createTable(doc, { logicalName: 'user', physicalName: 'user', position: { x: 0, y: 0 } })
    const kept = updates.length
    // 테이블 지우기: 새 항목 없이 삭제 집합만 늘어남
    deleteTable(doc, id)

    const restored = restoredFrom(updates.slice(0, kept))
    const loss = compareStates(captureState(doc), captureState(restored))
    assert.equal(loss.missingInserts, 0)
    assert.ok(loss.missingDeletes > 0)
  })

  it('복원 쪽에만 있는 편집은 유실로 세지 않음', () => {
    const before = new Y.Doc()
    createTable(before, { logicalName: 'user', physicalName: 'user', position: { x: 0, y: 0 } })
    // 기대 상태를 적은 뒤 다른 클라이언트가 편집한 문서
    const after = new Y.Doc()
    Y.applyUpdate(after, Y.encodeStateAsUpdate(before))
    createTable(after, { logicalName: 'order', physicalName: 'order', position: { x: 100, y: 0 } })

    const loss = compareStates(captureState(before), captureState(after))
    assert.deepEqual(loss.clients, [])
  })
})
