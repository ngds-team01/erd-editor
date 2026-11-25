// randomEdit가 돌려주는 편집 대상(awareness editing)이 문서에 실제로 있는 대상인지 확인
// 실행: npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { randomEdit } from './actions'
import { getColumns, getRelations, getTables } from './model'
import { isTableEditing, parseEditing } from './presence'
import { createRandom } from './random'

describe('randomEdit의 editing', () => {
  it('편집 직후 돌려준 대상이 문서에 있고, awareness editing 형식에 맞음', async () => {
    const doc = new Y.Doc()
    const random = createRandom(7)
    const kinds = new Set<string>()

    for (let step = 0; step < 500; step += 1) {
      const { action, editing } = await randomEdit(doc, random)
      if (editing === null) {
        continue
      }
      // client가 받은 상태를 검사할 때 쓰는 parseEditing을 통과해야 다른 사용자 화면에 표시됨
      assert.deepEqual(parseEditing(editing), editing, `${action}: 형식이 틀림`)
      if (isTableEditing(editing)) {
        const table = getTables(doc).get(editing.tableId)
        assert.ok(table, `${action}: 없는 테이블`)
        if (editing.columnId !== null) {
          assert.ok(getColumns(table).has(editing.columnId), `${action}: 없는 컬럼`)
          kinds.add('column')
        } else {
          kinds.add('table')
        }
      } else {
        assert.ok(getRelations(doc).has(editing.relationId), `${action}: 없는 관계`)
        kinds.add('relation')
      }
    }
    // 세 종류의 대상이 모두 한 번 이상 나왔는지 (한 종류만 나오면 검사가 의미 없음)
    assert.deepEqual([...kinds].sort(), ['column', 'relation', 'table'])
  })

  it('테이블 삭제는 편집 대상을 남기지 않음', async () => {
    const doc = new Y.Doc()
    const random = createRandom(11)
    let deletes = 0
    for (let step = 0; step < 500; step += 1) {
      const { action, editing } = await randomEdit(doc, random)
      if (action === 'deleteTable') {
        deletes += 1
        assert.equal(editing, null)
      }
    }
    assert.ok(deletes > 0, '테이블 삭제가 한 번도 나오지 않음')
  })
})
