import type { Awareness } from 'y-protocols/awareness'
import { randomNickname } from './nickname'

// Awareness: Y.Doc에 저장하지 않고 지금 접속한 사람의 상태만 주고받는 채널 (3)
// 서버는 내용을 해석하지 않고 중계만 하므로, 받은 상태는 이 파일에서 형식을 검사한 뒤 사용

// 사용자 이름 최대 길이, 테이블 논리명과 같은 기준 (2.2)
export const MAX_USER_NAME = 20

// 사용자 색 팔레트, 노드 테두리·이름표 배경으로 쓰므로 흰 글자가 보이는 진한 색만 둠
export const USER_COLORS = [
  '#e5484d',
  '#e5701a',
  '#2b9a66',
  '#0d74ce',
  '#8e4ec6',
  '#d6409f',
  '#12a594',
  '#a0613c',
] as const

// 사용자 1명의 정보, color = '#rrggbb'
export type PresenceUser = {
  id: string
  name: string
  color: string
}

// 편집 중인 테이블, 컬럼 입력 중이면 columnId도 있음
export type Editing = {
  tableId: string
  columnId: string | null
}

// awareness에 올리는 내 상태 , cursor는 Should 항목이라 지금은 항상 null
export type PresenceState = {
  user: PresenceUser
  editing: Editing | null
  cursor: { x: number; y: number } | null
}

// 다른 사용자 1명, clientId: awareness가 접속마다 붙이는 번호 (그 탭 Y.Doc의 clientID)
export type Peer = {
  clientId: number
  user: PresenceUser
  editing: Editing | null 
}

// awareness 'change' 이벤트가 넘겨주는 값: 상태가 새로 생긴·바뀐·사라진 clientId 목록
type AwarenessChanges = { added: number[]; updated: number[]; removed: number[] }

// 사용자 정보를 저장할 곳, 테스트에서 가짜 저장소를 넣을 수 있게 필요한 함수 2개만 요구
export type UserStorage = Pick<Storage, 'getItem' | 'setItem'>

// sessionStorage에 저장할 때 쓰는 key
const USER_STORAGE_KEY = 'erd-editor:user'
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i

// null이 아닌 객체인지 확인, 받은 값의 필드를 꺼내기 전에 사용 - value is Record(타입 가드) 활용
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// 앞뒤 공백을 지우고 MAX_USER_NAME자로 자름, 비면 null
// [...name]: 글자 단위로 나눠 이모지처럼 두 칸을 쓰는 글자가 반으로 잘리지 않게 함
export function normalizeUserName(name: string): string | null {
  const trimmed = [...name.trim()].slice(0, MAX_USER_NAME).join('')
  return trimmed === '' ? null : trimmed
}

// 받은 값이 사용자 정보 형식이면 이름을 다듬어 돌려주고, 아니면 null
export function parseUser(value: unknown): PresenceUser | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, name, color } = value
  if (typeof id !== 'string' || typeof name !== 'string' || typeof color !== 'string') {
    return null
  }
  const normalized = normalizeUserName(name)
  if (normalized === null || !COLOR_PATTERN.test(color)) {
    return null
  }
  return { id, name: normalized, color }
}

// 받은 값이 editing 형식이면 돌려주고, 아니면 null (편집 중 아님으로 취급)
export function parseEditing(value: unknown): Editing | null {
  if (!isRecord(value)) {
    return null
  }
  const { tableId, columnId } = value
  if (typeof tableId !== 'string' || (columnId !== null && typeof columnId !== 'string')) {
    return null
  }
  return { tableId, columnId }
}

// 무작위 이름과 색으로 새 사용자 생성
export function createUser(random: () => number = Math.random): PresenceUser {
  return {
    id: crypto.randomUUID(),
    name: randomNickname(random),
    color: USER_COLORS[Math.floor(random() * USER_COLORS.length)],
  }
}

// 브라우저의 sessionStorage, 사생활 보호 모드 등으로 막혀 있으면 null
function browserStorage(): UserStorage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

// 사용자 정보 저장, 저장소가 없거나 막혀 있으면 저장하지 않고 넘어감 (새로고침하면 새 이름)
export function saveUser(user: PresenceUser, storage: UserStorage | null = browserStorage()): void {
  try {
    storage?.setItem(USER_STORAGE_KEY, JSON.stringify(user))
  } catch {
    // 저장 실패는 무시, 이름은 이번 접속 동안만 유지됨
  }
}

// 이 탭의 사용자 정보: 저장된 값이 있으면 그대로 쓰고, 없거나 형식이 틀리면 새로 만들어 저장
// sessionStorage는 탭마다 따로 있어 두 탭이 서로 다른 사용자가 되고, 새로고침해도 유지됨
export function loadUser(storage: UserStorage | null = browserStorage()): PresenceUser {
  try {
    const saved = parseUser(JSON.parse(storage?.getItem(USER_STORAGE_KEY) ?? 'null'))
    if (saved) {
      return saved
    }
  } catch {
    // 읽기 실패나 깨진 JSON은 저장된 값이 없는 것으로 취급
  }

  const user = createUser()
  saveUser(user, storage)
  return user
}

// 접속 직후 내 상태를 처음으로 올림, 편집 중인 테이블은 아직 없음
export function initPresence(awareness: Awareness, user: PresenceUser): void {
  const state: PresenceState = { user, editing: null, cursor: null }
  awareness.setLocalState(state)
}

// 내 이름을 바꿈: 다듬은 이름이 비었거나 지금과 같으면 무시
// 바뀌면 awareness의 user 필드를 통째로 바꿔 다른 사용자에게 알리고, 새로고침해도 남도록 sessionStorage에도 저장
// user를 통째로 바꾸는 이유: awareness는 필드 단위로만 바꿀 수 있어 user.name만 따로 바꿀 수 없음
export function renameUser(
  awareness: Awareness,
  name: string,
  storage: UserStorage | null = browserStorage(),
): void {
  const user = parseUser(awareness.getLocalState()?.user)
  const normalized = normalizeUserName(name)
  if (!user || normalized === null || normalized === user.name) {
    return
  }

  const renamed: PresenceUser = { ...user, name: normalized }
  awareness.setLocalStateField('user', renamed)
  saveUser(renamed, storage)
}

// 툴바에 보여줄 다른 사용자: 같은 사람이 탭을 여러 개 열면(탭 복제 등) 한 번만 표시
// 나와 user.id가 같은 접속(내 다른 탭)도 빼서, 툴바에는 다른 사람만 남김
export function otherUsers(peers: Peer[], selfId: string | null): PresenceUser[] {
  const seen = new Set<string>(selfId === null ? [] : [selfId])
  const users: PresenceUser[] = []
  for (const { user } of peers) {
    if (!seen.has(user.id)) {
      seen.add(user.id)
      users.push(user)
    }
  }
  return users
}

// 내 편집 대상을 정함 (3)
// 1순위: 패널이 열린 table, 패널 안 column 영역에 포커스가 있으면 그 column도 함께
// 2순위: 패널이 없으면 하나만 선택한 table (여러 개를 고르면 하나로 정할 수 없어 null)
// focusedColumn: 패널에서 포커스가 있는 column, 다른 table의 것이면 무시
export function pickEditing(
  panelTableId: string | null,
  focusedColumn: Editing | null,
  selectedTableIds: readonly string[],
): Editing | null {
  if (panelTableId !== null) {
    const columnId = focusedColumn?.tableId === panelTableId ? focusedColumn.columnId : null
    return { tableId: panelTableId, columnId }
  }
  return selectedTableIds.length === 1 ? { tableId: selectedTableIds[0], columnId: null } : null
}

// 두 editing 값이 같은지 비교
function sameEditing(a: Editing | null, b: Editing | null): boolean {
  return a?.tableId === b?.tableId && a?.columnId === b?.columnId
}

// 내 editing 값을 바꿈, 값이 그대로면 보내지 않음
// awareness는 값이 같아도 바꿀 때마다 서버로 메시지를 보내므로, 선택 이벤트처럼 자주 불리는 곳에서 낭비를 막음
export function setEditing(awareness: Awareness, editing: Editing | null): void {
  const current = parseEditing(awareness.getLocalState()?.editing)
  if (!sameEditing(current, editing)) {
    awareness.setLocalStateField('editing', editing)
  }
}

// 전체 awareness 상태에서 나를 뺀 다른 사용자 목록을 만듦, 형식이 틀린 상태는 건너뜀
// 순서는 awareness가 상태를 받은 순서 (먼저 접속한 사람이 앞)
export function collectPeers(states: Map<number, unknown>, selfClientId: number): Peer[] {
  const peers: Peer[] = []
  for (const [clientId, state] of states) {
    if (clientId === selfClientId || !isRecord(state)) {
      continue
    }
    const user = parseUser(state.user)
    if (user) {
      peers.push({ clientId, user, editing: parseEditing(state.editing) })
    }
  }
  return peers
}

// 다른 사용자 목록을 테이블별로 묶음, key = table id, value = 그 테이블을 편집 중인 사용자들
export function collectEditors(peers: Peer[]): Map<string, Peer[]> {
  const editors = new Map<string, Peer[]>()
  for (const peer of peers) {
    if (!peer.editing) {
      continue
    }
    const list = editors.get(peer.editing.tableId)
    if (list) {
      list.push(peer)
    } else {
      editors.set(peer.editing.tableId, [peer])
    }
  }
  return editors
}

// React의 useSyncExternalStore로 구독할 수 있는 다른 사용자 목록과 내 사용자 정보
// subscribe: 목록이 바뀔 때 호출할 함수를 등록하고 해제 함수를 돌려줌, getPeers: 현재 목록
// getSelf: 내 사용자 정보 (툴바의 내 이름 칸), 상태를 아직 올리지 않았으면 null
export type PeerStore = {
  subscribe: (listener: () => void) => () => void
  getPeers: () => Peer[]
  getSelf: () => PresenceUser | null
}

// awareness 변경을 받아 다른 사용자 목록을 다시 만드는 저장소 생성
// getPeers는 바뀌지 않았으면 같은 배열을 돌려줘야 React가 불필요하게 다시 그리지 않으므로 목록을 보관해 둠
export function createPeerStore(awareness: Awareness): PeerStore {
  let peers = collectPeers(awareness.getStates(), awareness.clientID)
  let self = parseUser(awareness.getLocalState()?.user)
  const listeners = new Set<() => void>()

  // 'change': 상태 내용이 실제로 바뀌었을 때만 발생 ('update'는 15초마다 같은 값을 다시 보낼 때도 발생)
  // 접속 끊김·30초 응답 없음으로 사용자가 빠질 때, 내가 이름을 바꿀 때도 발생
  // 인자: 상태가 바뀐 clientId 목록 (새로 들어옴, 바뀜, 나감)
  awareness.on('change', ({ added, updated, removed }: AwarenessChanges) => {
    // 바뀐 게 내 상태뿐이면(이름 변경, 편집 대상 변경) 다른 사용자 목록은 이전 배열 그대로 둠
    if ([...added, ...updated, ...removed].some((clientId) => clientId !== awareness.clientID)) {
      peers = collectPeers(awareness.getStates(), awareness.clientID)
    }
    // 내 이름·색이 그대로면 이전 객체를 유지해 내 이름 칸을 다시 그리지 않음
    const nextSelf = parseUser(awareness.getLocalState()?.user)
    if (nextSelf?.name !== self?.name || nextSelf?.color !== self?.color || nextSelf?.id !== self?.id) {
      self = nextSelf
    }
    listeners.forEach((listener) => listener())
  })

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getPeers: () => peers,
    getSelf: () => self,
  }
}
