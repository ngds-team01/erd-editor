// 네트워크 없이 Y.Doc 여러 개로 동시 편집을 흉내 내, 봇의 편집과 수렴 검증기 자체가 맞게 동작하는지 확인
// 실행: npm test (Node 내장 테스트 러너 node:test)
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { performDrag, randomEdit } from './actions'
import { firstDifference, groupByHash, waitForConvergence } from './converge'
import type { NamedDoc } from './converge'
import { createTable, getTables } from './model'
import type { Position } from './model'
import { createRandom } from './random'

function named(docs: Y.Doc[]): NamedDoc[] {
  return docs.map((doc, index) => ({ name: `doc ${index}`, doc }))
}

// 두 문서가 서로의 변경을 모두 받음
function exchange(a: Y.Doc, b: Y.Doc): void {
  const fromA = Y.encodeStateAsUpdate(a)
  const fromB = Y.encodeStateAsUpdate(b)
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

// 모든 문서가 모든 변경을 받음 = 서버가 중계를 다 마친 상태
function syncAll(docs: Y.Doc[]): void {
  const merged = Y.mergeUpdates(docs.map((doc) => Y.encodeStateAsUpdate(doc)))
  docs.forEach((doc) => Y.applyUpdate(doc, merged))
}

// 동시 편집 흉내: 라운드마다 모든 문서가 편집 1번씩 하고, 무작위 두 문서만 변경을 주고받음
// (네트워크 지연으로 변경이 일부 사용자에게만 먼저 도착한 상황)
async function simulate(count: number, rounds: number, seed: number): Promise<Y.Doc[]> {
  const docs = Array.from({ length: count }, () => new Y.Doc())
  const randoms = docs.map((_, index) => createRandom(seed + index))
  const network = createRandom(seed + 1000)
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < count; index += 1) {
      await randomEdit(docs[index], randoms[index])
    }
    exchange(network.pick(docs)!, network.pick(docs)!)
  }
  return docs
}

describe('randomEdit + 수렴', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: 변경을 일부만 주고받은 동안은 다르고, 모두 주고받으면 같아짐`, async () => {
      const docs = await simulate(4, 150, seed)

      assert.ok((await groupByHash(named(docs))).length > 1, '편집 도중에는 문서가 달라야 테스트가 의미 있음')
      syncAll(docs)
      assert.equal((await groupByHash(named(docs))).length, 1)
    })
  }
})

describe('groupByHash', () => {
  it('같은 해시끼리 묶고, 문서가 많은 묶음부터 정렬', async () => {
    const [a, b, c] = await simulate(3, 30, 7)
    syncAll([a, b])

    const groups = await groupByHash([
      { name: 'c', doc: c },
      { name: 'a', doc: a },
      { name: 'b', doc: b },
    ])

    assert.equal(groups.length, 2)
    assert.deepEqual(groups[0].names, ['a', 'b'])
    assert.deepEqual(groups[1].names, ['c'])
  })
})

describe('waitForConvergence', () => {
  it('이미 같으면 바로 수렴', async () => {
    const docs = await simulate(3, 30, 11)
    syncAll(docs)

    const result = await waitForConvergence(named(docs), 1000, 20)

    assert.equal(result.converged, true)
    assert.ok(result.elapsedMs < 1000)
  })

  it('기다리는 동안 변경이 도착하면 수렴', async () => {
    const docs = await simulate(3, 30, 12)
    // 100ms 뒤에 남은 변경이 도착하는 상황
    setTimeout(() => syncAll(docs), 100)

    const result = await waitForConvergence(named(docs), 2000, 20)

    assert.equal(result.converged, true)
  })

  it('제한 시간 안에 같아지지 않으면 실패와 해시 묶음을 돌려줌', async () => {
    const docs = await simulate(3, 30, 13)

    const result = await waitForConvergence(named(docs), 100, 20)

    assert.equal(result.converged, false)
    assert.ok(result.groups.length > 1)
  })
})

describe('firstDifference', () => {
  it('같은 문서면 null, 다르면 처음 달라지는 위치와 앞뒤 내용', async () => {
    const [a, b] = await simulate(2, 30, 21)

    const difference = firstDifference(a, b)
    assert.ok(difference)
    assert.notEqual(difference.a, difference.b)

    syncAll([a, b])
    assert.equal(firstDifference(a, b), null)
  })
})

describe('performDrag', () => {
  it('경로 좌표마다 한 번씩 쓰고 사이마다 wait을 기다림, 마지막 위치에 멈춤', async () => {
    const doc = new Y.Doc()
    const tableId = createTable(doc, { logicalName: '회원', physicalName: 'users', position: { x: 0, y: 0 } })
    const steps: Position[] = [
      { x: 10, y: 5 },
      { x: 20, y: 10 },
      { x: 30, y: 15 },
    ]
    let updates = 0
    let waits = 0
    doc.on('update', () => {
      updates += 1
    })

    await performDrag(doc, { tableId, steps }, async () => {
      waits += 1
    })

    assert.equal(updates, 3)
    assert.equal(waits, 3)
    assert.deepEqual(getTables(doc).get(tableId)?.get('position'), { x: 30, y: 15 })
  })

  it('드래그 도중 테이블이 지워지면 아무것도 쓰지 않음', async () => {
    const doc = new Y.Doc()
    const tableId = createTable(doc, { logicalName: '회원', physicalName: 'users', position: { x: 0, y: 0 } })
    let updates = 0
    doc.on('update', () => {
      updates += 1
    })

    await performDrag(doc, { tableId, steps: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }, async () => {
      getTables(doc).delete(tableId)
    })

    // 첫 좌표 쓰기 1번 + 삭제 1번, 두 번째 좌표는 테이블이 없어 쓰지 않음
    assert.equal(updates, 2)
    assert.equal(getTables(doc).has(tableId), false)
  })
})
