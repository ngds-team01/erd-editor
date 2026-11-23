// 가벼운 봇: 내 편집과 awareness는 보내고, 서버가 보내는 다른 사람의 편집은 받기만 하고 반영하지 않음
// 정식 봇(bot.ts)은 봇 N개가 모든 편집을 각자 반영해 봇 프로세스의 일이 N²으로 늘어남 → 봇 100개에서 봇 프로세스가 포화
// 가벼운 봇은 반영을 건너뛰어 봇 프로세스 부담을 줄이고, 서버가 받는 부하(N명이 보내고 N명에게 퍼뜨림)는 그대로 유지
//
// 서버와 주고받는 메시지는 y-websocket과 같음 (contracts 4, server/src/doc.ts)
// - 서버는 문서 복원을 마치면 SyncStep1(서버 상태 벡터)을 보냄 → 이것을 접속 완료 신호로 씀
// - 가벼운 봇은 SyncStep1을 보내지 않음 → 서버가 문서 전체(SyncStep2)를 보내지 않아 접속 비용도 줄어듦
// - 내 편집은 진짜 Y.Doc으로 만든 정상 업데이트라 서버와 다른 클라이언트는 정식 클라이언트와 구분하지 못함
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import WebSocket from 'ws'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { initPresence } from './presence'
import type { PresenceUser } from './presence'
import { attachReconnect } from './reconnect'
import type { CloseInfo, ReconnectEvent, ReconnectTarget } from './reconnect'

// y-websocket 메시지 종류 (첫 숫자)
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

export type LightBotOptions = {
  // 서버 주소, 뒤에 /{docId}를 붙여 접속 (contracts 4.1)
  url: string
  docId: string
  // 봇 번호, 로그에 사용
  index: number
  // awareness에 올릴 사용자 정보 (정식 봇과 같은 형식)
  user: PresenceUser
  // 재접속할 때마다 불림, 로그 출력은 부르는 쪽이 정함
  onReconnect?: (event: ReconnectEvent) => void
  // 재접속 지터용 난수, 테스트에서 고정값을 넣음
  random?: () => number
}

export type LightBotStats = {
  // 서버에서 받은 메시지 수와 크기 (반영하지 않고 버린 것 포함)
  messagesReceived: number
  bytesReceived: number
  // 동기화된 뒤 끊긴 횟수
  disconnects: number
}

export type LightBot = {
  index: number
  // 내 편집만 들어 있는 문서, 다른 사람의 편집은 반영하지 않으므로 서버 문서와 다름 (수렴 확인에서 뺌)
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  stats: LightBotStats
  // 서버가 첫 SyncStep1을 보낼 때까지 대기, timeoutMs 안에 안 오면 오류
  waitSynced: (timeoutMs: number) => Promise<void>
  // 접속 종료
  destroy: () => void
}

// 종류 번호를 앞에 붙여 메시지 하나를 만듦
function message(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, type)
  write(encoder)
  return encoding.toUint8Array(encoder)
}

export function createLightBot(options: LightBotOptions): LightBot {
  const { url, docId, index, user, onReconnect = () => {}, random = Math.random } = options
  const doc = new Y.Doc()
  // Awareness는 15초마다 내 상태를 다시 올려 줌 (안 올리면 30초 뒤 다른 사람 화면에서 나간 사람으로 처리됨)
  const awareness = new awarenessProtocol.Awareness(doc)
  const stats: LightBotStats = { messagesReceived: 0, bytesReceived: 0, disconnects: 0 }

  let socket: WebSocket | null = null
  let synced = false
  let destroyed = false
  // attachReconnect에 넘길 이벤트 구독자
  const closedListeners: ((event: CloseInfo) => void)[] = []
  const syncListeners: ((synced: boolean) => void)[] = []

  // 열려 있을 때만 보냄, 끊긴 동안의 편집은 다시 붙을 때 SyncStep2로 한꺼번에 보냄
  function send(data: Uint8Array): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(data)
    }
  }

  function setSynced(next: boolean): void {
    synced = next
    // 복사본을 돎: waitSynced의 리스너가 불리는 도중 목록에서 자기를 빼도 다음 리스너를 건너뛰지 않게 함
    ;[...syncListeners].forEach((listener) => listener(next))
  }

  // 받은 메시지: 서버의 SyncStep1에만 답하고 나머지(다른 사람의 편집·awareness)는 버림
  function handle(data: Uint8Array): void {
    stats.messagesReceived += 1
    stats.bytesReceived += data.byteLength
    const decoder = decoding.createDecoder(data)
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) {
      return
    }
    if (decoding.readVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) {
      return
    }
    // 서버 상태 벡터를 보고 서버에 없는 내 편집만 SyncStep2로 보냄 (끊긴 동안 한 편집이 여기서 올라감)
    const serverStateVector = decoding.readVarUint8Array(decoder)
    send(message(MESSAGE_SYNC, (encoder) => syncProtocol.writeSyncStep2(encoder, doc, serverStateVector)))
    if (!synced) {
      setSynced(true)
    }
  }

  function connect(): void {
    if (destroyed) {
      return
    }
    const ws = new WebSocket(`${url}/${docId}`)
    ws.binaryType = 'arraybuffer'
    socket = ws
    ws.on('open', () => {
      // 접속하자마자 내 사용자 정보를 올림 (y-websocket과 같음)
      send(
        message(MESSAGE_AWARENESS, (encoder) =>
          encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])),
        ),
      )
    })
    ws.on('message', (data: ArrayBuffer) => handle(new Uint8Array(data)))
    // 접속 실패도 'error' 뒤에 'close'(1006)가 오므로 여기서는 아무것도 하지 않음 (리스너가 없으면 Node가 프로세스를 멈춤)
    ws.on('error', () => {})
    ws.on('close', (code: number, reason: Buffer) => {
      if (socket !== ws) {
        return
      }
      socket = null
      if (synced) {
        stats.disconnects += 1
        setSynced(false)
      }
      if (!destroyed) {
        closedListeners.forEach((listener) => listener({ code, reason: reason.toString() }))
      }
    })
  }

  // 재접속은 정식 봇과 같은 규칙(contracts 4.3)을 그대로 씀
  const target: ReconnectTarget = {
    on(name: 'closed' | 'sync', listener: never) {
      if (name === 'closed') {
        closedListeners.push(listener)
      } else {
        syncListeners.push(listener)
      }
    },
    connect,
  }
  const reconnector = attachReconnect(target, onReconnect, random)

  // 내 편집 → 서버로 (다른 사람의 편집은 반영하지 않으므로 이 문서의 변경은 모두 내 편집)
  doc.on('update', (update: Uint8Array) => {
    send(message(MESSAGE_SYNC, (encoder) => syncProtocol.writeUpdate(encoder, update)))
  })
  // 내 awareness 변경·15초 재전송 → 서버로 (다른 사람 상태는 적용하지 않으므로 바뀌는 것은 내 상태뿐)
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const changed = added.concat(updated, removed)
    send(
      message(MESSAGE_AWARENESS, (encoder) =>
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed)),
      ),
    )
  })

  initPresence(awareness, user)
  connect()

  return {
    index,
    doc,
    awareness,
    stats,
    waitSynced: (timeoutMs) =>
      new Promise((resolve, reject) => {
        if (synced) {
          resolve()
          return
        }
        // 끝나면(성공이든 시간 초과든) 구독을 빼서 리스너가 쌓이지 않게 함
        const unsubscribe = () => syncListeners.splice(syncListeners.indexOf(onSync), 1)
        const timer = setTimeout(() => {
          unsubscribe()
          reject(new Error(`가벼운 봇 ${index}: ${timeoutMs}ms 안에 서버와 동기화하지 못했습니다 (${url}/${docId})`))
        }, timeoutMs)
        const onSync = (next: boolean) => {
          if (next) {
            clearTimeout(timer)
            unsubscribe()
            resolve()
          }
        }
        syncListeners.push(onSync)
      }),
    destroy: () => {
      destroyed = true
      reconnector.cancel()
      // 내 상태를 지워 다른 사람 화면에서 바로 빠지게 한 뒤 닫음 (Awareness의 15초 타이머도 멈춤)
      awareness.destroy()
      socket?.close()
      doc.destroy()
    },
  }
}
