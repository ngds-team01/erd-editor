import type { Awareness } from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { createPeerStore, initPresence, loadUser } from './presence'
import type { PeerStore } from './presence'

// VITE_WS_URL을 지정하지 않았을 때의 서버 주소 (7.5)
const DEFAULT_WS_URL = 'ws://localhost:8088/ws'
// 주소에 ?doc= 가 없을 때 여는 문서
const DEFAULT_DOC_ID = 'demo'
// 문서 ID 형식: 영문, 숫자, _, - 로 1~64자 (4.1)
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// connecting: 접속 시도 중, connected: 접속됨, disconnected: 접속 중 끊김
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

// subscribeStatus: 상태가 바뀔 때 호출할 함수를 등록하고 해제 함수를 돌려줌
// getStatus: 현재 상태를 돌려줌
// awareness: 내 사용자 정보·편집 중인 테이블을 올리는 곳 (3), peers: 다른 사용자 목록
export type Connection = {
  doc: Y.Doc
  docId: string
  subscribeStatus: (listener: () => void) => () => void
  getStatus: () => ConnectionStatus
  awareness: Awareness
  peers: PeerStore
}

// 주소의 ?doc= 값을 읽어 형식이 맞으면 돌려주고, 틀리면 null
export function readDocId(search: string): string | null {
  const docId = new URLSearchParams(search).get('doc') ?? DEFAULT_DOC_ID
  return DOC_ID_PATTERN.test(docId) ? docId : null
}

// 문서를 만들고 서버에 접속, 변경 전송·수신과 재접속은 WebsocketProvider가 담당
export function connect(docId: string): Connection {
  const doc = new Y.Doc()
  const serverUrl: string = import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL
  // disableBc: 탭끼리 서버 없이 직접 통신하는 기능을 끄고, 모든 동기화가 서버를 거치게 함
  const provider = new WebsocketProvider(serverUrl, docId, doc, { disableBc: true })
  // 상태가 바뀔 때 호출할 함수 모음
  const listeners = new Set<() => void>()
  // 재시도 사이에는 provider 내부 값이 이벤트 없이 바뀌므로, 마지막 이벤트 값을 보관
  let status: ConnectionStatus = 'connecting'
  // provider가 만든 awareness에 이 탭의 사용자 정보를 올림, 접속 전이면 접속하자마자 전송됨
  const { awareness } = provider
  initPresence(awareness, loadUser())

  // provider의 접속 상태 이벤트를 받아 저장하고, 등록된 함수에 알림
  provider.on('status', (event) => {
    status = event.status
    listeners.forEach((listener) => listener())
  })

  return {
    doc,
    docId,
    subscribeStatus: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getStatus: () => status,
    awareness,
    peers: createPeerStore(awareness),
  }
}
