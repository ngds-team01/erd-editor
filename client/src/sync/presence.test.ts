import { afterEach, describe, expect, it } from 'vitest'
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  collectEditors,
  collectPeers,
  collectRelationEditors,
  createPeerStore,
  initPresence,
  loadUser,
  otherUsers,
  parseEditing,
  parseUser,
  pickEditing,
  renameUser,
  saveUser,
  setEditing,
  USER_COLORS,
} from './presence'
import type { EditingSources, PresenceUser, UserStorage } from './presence'

const alice: PresenceUser = { id: 'u-alice', name: '졸린 수달', color: '#e5484d' }
const bob: PresenceUser = { id: 'u-bob', name: '용감한 펭귄', color: '#0d74ce' }

// 메모리에만 저장하는 가짜 sessionStorage
function memoryStorage(): UserStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

// 테스트마다 만든 awareness, 30초 검사 타이머가 남지 않게 끝나면 정리
const created: Awareness[] = []
function newAwareness(): Awareness {
  const awareness = new Awareness(new Y.Doc())
  created.push(awareness)
  return awareness
}
afterEach(() => {
  created.splice(0).forEach((awareness) => awareness.destroy())
})

// from의 내 상태를 to에 전달 (서버 중계를 대신함)
function relay(from: Awareness, to: Awareness): void {
  applyAwarenessUpdate(to, encodeAwarenessUpdate(from, [from.clientID]), 'test')
}

describe('parseUser', () => {
  it('형식이 맞으면 이름의 앞뒤 공백을 지우고 20자로 자름', () => {
    expect(parseUser({ ...alice, name: `  ${'가'.repeat(25)}  ` })).toEqual({
      ...alice,
      name: '가'.repeat(20),
    })
  })

  it('필드가 없거나, 색이 #rrggbb가 아니거나, 이름이 비면 null', () => {
    expect(parseUser(null)).toBeNull()
    expect(parseUser({ id: 'x', name: '이름' })).toBeNull()
    expect(parseUser({ ...alice, color: 'red' })).toBeNull()
    expect(parseUser({ ...alice, name: '   ' })).toBeNull()
  })
})

describe('parseEditing', () => {
  it('테이블 형식과 관계 형식을 각각 인정', () => {
    expect(parseEditing({ tableId: 't1', columnId: null })).toEqual({ tableId: 't1', columnId: null })
    expect(parseEditing({ relationId: 'r1' })).toEqual({ relationId: 'r1' })
  })

  it('relationId가 문자열이 아니거나 tableId와 함께 있으면 null', () => {
    expect(parseEditing({ relationId: 42 })).toBeNull()
    expect(parseEditing({ relationId: 'r1', tableId: 't1', columnId: null })).toBeNull()
  })
})

describe('loadUser', () => {
  it('저장된 값이 없으면 새로 만들어 저장하고, 다음에는 같은 사용자를 돌려줌', () => {
    const storage = memoryStorage()
    const first = loadUser(storage)
    expect(USER_COLORS).toContain(first.color)
    expect(loadUser(storage)).toEqual(first)
  })

  it('저장된 값이 깨져 있으면 새 사용자로 덮어씀', () => {
    const storage = memoryStorage()
    storage.data.set('erd-editor:user', '{깨진 JSON')
    const user = loadUser(storage)
    expect(JSON.parse(storage.data.get('erd-editor:user')!)).toEqual(user)
  })

  it('저장소가 막혀 있어도 사용자를 만듦', () => {
    const blocked: UserStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(parseUser(loadUser(blocked))).not.toBeNull()
    expect(() => saveUser(alice, blocked)).not.toThrow()
  })
})

describe('collectPeers / collectEditors', () => {
  it('나와 형식이 틀린 상태는 빼고, editing 형식이 틀리면 편집 중 아님으로 취급', () => {
    const states = new Map<number, unknown>([
      [1, { user: alice, editing: null }],
      [2, { user: bob, editing: { tableId: 't1', columnId: null } }],
      [3, { user: { name: '형식 틀림' } }],
      [4, { user: { ...bob, id: 'u-carol' }, editing: { tableId: 42 } }],
    ])
    expect(collectPeers(states, 1)).toEqual([
      { clientId: 2, user: bob, editing: { tableId: 't1', columnId: null } },
      { clientId: 4, user: { ...bob, id: 'u-carol' }, editing: null },
    ])
  })

  it('같은 테이블을 여러 명이 편집하면 한 목록에 모음', () => {
    const peers = collectPeers(
      new Map<number, unknown>([
        [2, { user: alice, editing: { tableId: 't1', columnId: null } }],
        [3, { user: bob, editing: { tableId: 't1', columnId: 'c1' } }],
        [4, { user: { ...bob, id: 'u-carol' }, editing: { tableId: 't2', columnId: null } }],
      ]),
      1,
    )
    const editors = collectEditors(peers)
    expect(editors.get('t1')?.map((peer) => peer.clientId)).toEqual([2, 3])
    expect(editors.get('t2')?.map((peer) => peer.clientId)).toEqual([4])
  })

  it('관계 편집자는 관계별로만 묶고, 테이블 묶음에는 넣지 않음', () => {
    const peers = collectPeers(
      new Map<number, unknown>([
        [2, { user: alice, editing: { relationId: 'r1' } }],
        [3, { user: bob, editing: { relationId: 'r1' } }],
        [4, { user: { ...bob, id: 'u-carol' }, editing: { tableId: 't1', columnId: null } }],
      ]),
      1,
    )
    const relationEditors = collectRelationEditors(peers)
    expect(relationEditors.get('r1')?.map((peer) => peer.clientId)).toEqual([2, 3])
    expect(relationEditors.has('t1')).toBe(false)
    expect([...collectEditors(peers).keys()]).toEqual(['t1'])
  })
})

describe('awareness 2개 사이 전달', () => {
  it('내가 올린 사용자 정보와 editing이 상대의 목록에 보이고, 편집을 끝내면 사라짐', () => {
    const mine = newAwareness()
    const theirs = newAwareness()
    const store = createPeerStore(theirs)
    let notified = 0
    store.subscribe(() => notified++)

    initPresence(mine, alice)
    setEditing(mine, { tableId: 't1', columnId: 'c1' })
    relay(mine, theirs)
    expect(store.getPeers()).toEqual([
      { clientId: mine.clientID, user: alice, editing: { tableId: 't1', columnId: 'c1' } },
    ])
    expect(collectEditors(store.getPeers()).has('t1')).toBe(true)

    setEditing(mine, null)
    relay(mine, theirs)
    expect(collectEditors(store.getPeers()).size).toBe(0)
    expect(notified).toBe(2)
  })

  it('같은 editing 값을 다시 넣으면 메시지를 보내지 않음', () => {
    const mine = newAwareness()
    initPresence(mine, alice)
    let updates = 0
    mine.on('update', () => updates++)

    setEditing(mine, { tableId: 't1', columnId: null })
    setEditing(mine, { tableId: 't1', columnId: null })
    expect(updates).toBe(1)
  })

  it('관계 editing도 상대에게 전달되고, 같은 관계를 다시 넣으면 보내지 않음', () => {
    const mine = newAwareness()
    const theirs = newAwareness()
    const store = createPeerStore(theirs)
    initPresence(mine, alice)
    let updates = 0
    mine.on('update', () => updates++)

    setEditing(mine, { tableId: 't1', columnId: null })
    setEditing(mine, { relationId: 'r1' })
    setEditing(mine, { relationId: 'r1' })
    setEditing(mine, { relationId: 'r2' })
    expect(updates).toBe(3)

    relay(mine, theirs)
    expect(store.getPeers()[0].editing).toEqual({ relationId: 'r2' })
    expect(collectRelationEditors(store.getPeers()).has('r2')).toBe(true)
  })

  it('상대가 나가면 목록에서 빠지고, 바뀌지 않은 동안은 같은 배열을 돌려줌', () => {
    const mine = newAwareness()
    const theirs = newAwareness()
    const store = createPeerStore(theirs)
    initPresence(mine, alice)
    relay(mine, theirs)
    expect(store.getPeers()).toBe(store.getPeers())

    mine.setLocalState(null)
    relay(mine, theirs)
    expect(store.getPeers()).toEqual([])
  })
})

describe('renameUser', () => {
  it('바꾼 이름이 상대 목록과 내 정보에 반영되고 저장소에도 남음', () => {
    const mine = newAwareness()
    const theirs = newAwareness()
    const myStore = createPeerStore(mine)
    const theirStore = createPeerStore(theirs)
    const storage = memoryStorage()
    initPresence(mine, alice)

    renameUser(mine, '  새 이름  ', storage)
    relay(mine, theirs)
    expect(myStore.getSelf()).toEqual({ ...alice, name: '새 이름' })
    expect(theirStore.getPeers()[0].user.name).toBe('새 이름')
    expect(loadUser(storage)).toEqual({ ...alice, name: '새 이름' })
  })

  it('빈 이름이나 지금과 같은 이름이면 보내지 않음', () => {
    const mine = newAwareness()
    initPresence(mine, alice)
    let updates = 0
    mine.on('update', () => updates++)

    renameUser(mine, '   ', memoryStorage())
    renameUser(mine, alice.name, memoryStorage())
    expect(updates).toBe(0)
  })

  it('내 상태만 바뀌면 다른 사용자 목록은 같은 배열을 유지', () => {
    const mine = newAwareness()
    const theirs = newAwareness()
    const myStore = createPeerStore(mine)
    initPresence(theirs, bob)
    relay(theirs, mine)
    initPresence(mine, alice)
    const before = myStore.getPeers()

    renameUser(mine, '새 이름', memoryStorage())
    setEditing(mine, { tableId: 't1', columnId: null })
    expect(myStore.getPeers()).toBe(before)
  })
})

describe('otherUsers', () => {
  it('같은 사람의 여러 접속은 한 번만, 나와 같은 id는 제외', () => {
    const peers = collectPeers(
      new Map<number, unknown>([
        [2, { user: bob }],
        [3, { user: bob }],
        [4, { user: alice }],
        [5, { user: { ...bob, id: 'u-carol', name: '캐롤' } }],
      ]),
      1,
    )
    expect(otherUsers(peers, alice.id).map((user) => user.id)).toEqual(['u-bob', 'u-carol'])
  })
})

describe('pickEditing', () => {
  // 아무것도 열거나 고르지 않은 상태, 테스트마다 필요한 값만 덮어씀
  const none: EditingSources = {
    panel: null,
    focusedColumn: null,
    selectedTableIds: [],
    selectedRelationIds: [],
  }

  it('table 패널이 열려 있으면 그 table, 포커스가 있는 column이 같은 table이면 함께', () => {
    expect(
      pickEditing({
        ...none,
        panel: { kind: 'table', id: 't1' },
        focusedColumn: { tableId: 't1', columnId: 'c1' },
        selectedTableIds: ['t2'],
      }),
    ).toEqual({ tableId: 't1', columnId: 'c1' })
  })

  it('포커스가 다른 table의 column이면 column은 무시', () => {
    expect(
      pickEditing({
        ...none,
        panel: { kind: 'table', id: 't1' },
        focusedColumn: { tableId: 't2', columnId: 'c9' },
      }),
    ).toEqual({ tableId: 't1', columnId: null })
  })

  it('관계 패널이 열려 있으면 선택과 상관없이 그 관계', () => {
    expect(
      pickEditing({
        ...none,
        panel: { kind: 'relation', id: 'r1' },
        focusedColumn: { tableId: 't1', columnId: 'c1' },
        selectedTableIds: ['t1'],
        selectedRelationIds: ['r2'],
      }),
    ).toEqual({ relationId: 'r1' })
  })

  it('패널이 없으면 하나만 선택한 table 또는 관계선', () => {
    expect(pickEditing({ ...none, selectedTableIds: ['t2'] })).toEqual({ tableId: 't2', columnId: null })
    expect(pickEditing({ ...none, selectedRelationIds: ['r1'] })).toEqual({ relationId: 'r1' })
  })

  it('table과 관계선을 합쳐 여러 개를 선택했거나 아무것도 없으면 null', () => {
    expect(pickEditing({ ...none, selectedTableIds: ['t1', 't2'] })).toBeNull()
    expect(pickEditing({ ...none, selectedRelationIds: ['r1', 'r2'] })).toBeNull()
    expect(pickEditing({ ...none, selectedTableIds: ['t1'], selectedRelationIds: ['r1'] })).toBeNull()
    expect(pickEditing(none)).toBeNull()
  })
})
