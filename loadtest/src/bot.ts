import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { DEFAULT_LIMITS } from './actions'
import type { ActionName, EditLimits } from './actions'
import { createEditLoop } from './editLoop'
import { createUser, initPresence } from './presence'
import type { PresenceUser } from './presence'
import { createRandom } from './random'
import { attachReconnect } from './reconnect'
import { trackReconnects } from './reconnectTime'
import type { ReconnectLog } from './reconnectTime'

// 이름·색용 시드를 편집용 시드(seed + 봇 번호)와 겹치지 않게 띄우는 값, 봇 수가 이보다 적으면 겹치지 않음
const USER_SEED_OFFSET = 1_000_000

// 봇 번호의 사용자 정보(이름·색), 같은 seed·번호면 같은 이름, 가벼운 봇도 같은 방식으로 만듦
export function botUser(seed: number, index: number): PresenceUser {
  const userRandom = createRandom(seed + index + USER_SEED_OFFSET)
  return createUser(() => userRandom.next())
}

export type BotOptions = {
  // 서버 주소, provider가 뒤에 /{docId}를 붙임 (contracts 4.1)
  url: string
  docId: string
  // 봇 번호, 로그와 시드에 사용
  index: number
  seed: number
  // 봇 1개가 1초에 하는 편집 수 (드래그 1번 = 편집 1번)
  rate: number
  limits?: EditLimits
}

// 봇 1개의 기록
export type BotStats = {
  // 편집 종류별 횟수
  actions: Partial<Record<ActionName, number>>
  // 내가 만든 문서 변경(update) 수, 드래그는 좌표를 쓸 때마다 1씩 늘어남
  updatesSent: number
  // 접속이 끊긴 횟수
  disconnects: number
}

export type Bot = {
  index: number
  doc: Y.Doc
  // provider가 만든 awareness, 지연 측정(probe.ts)이 편집 중 표시 경로를 잴 때 사용
  awareness: WebsocketProvider['awareness']
  stats: BotStats
  // 끊길 때마다 다시 동기화되기까지 걸린 시간 (실험 2-a)
  reconnects: ReconnectLog
  // 서버와 첫 동기화가 끝날 때까지 대기, timeoutMs 안에 안 끝나면 오류
  waitSynced: (timeoutMs: number) => Promise<void>
  // 편집 반복 시작
  start: () => void
  // 편집 반복을 멈추고, 진행 중인 드래그가 끝날 때까지 대기
  stop: () => Promise<void>
  // 접속 종료
  destroy: () => void
}

export function createBot(options: BotOptions): Bot {
  const { url, docId, index, seed, rate, limits = DEFAULT_LIMITS } = options
  const doc = new Y.Doc()
  // WebSocketPolyfill: Node 20에는 브라우저의 WebSocket이 없어 ws 라이브러리로 대신함
  // disableBc: 클라이언트와 같게, 모든 동기화가 서버를 거치게 함
  const provider = new WebsocketProvider(url, docId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
    // 서버가 닫았을 때의 재접속은 attachReconnect가 close code를 보고 직접 처리 (contracts 4.3)
    shouldReconnect: () => false,
  })
  // 재접속할 때마다 close code와 대기 시간을 출력, 재접속 간격이 0.5s → 1s … 로 늘어나는지 로그로 확인
  const reconnector = attachReconnect(provider, (event) => {
    if (event.kind === 'stop') {
      console.error(`봇 ${index}: 서버가 문서 주소를 거부해 재접속하지 않습니다 (code ${event.code})`)
      return
    }
    // 한 번도 동기화하지 못한 채 닫혔으면 '접속 실패' (서버가 꺼져 있거나 주소가 틀림)
    const what = event.beforeFirstSync ? '접속 실패' : '끊김'
    console.log(
      `봇 ${index}: ${what} (code ${event.code}) → ${Math.round(event.delayMs)}ms 뒤 재접속 (연속 실패 ${event.attempt}회)`,
    )
  })
  // 위 '끊김' 줄과 짝이 되는 줄, 끊긴 뒤 다시 동기화될 때까지 걸린 시간을 출력
  const reconnects = trackReconnects(provider, index, (sample) => {
    console.log(
      `봇 ${index}: 다시 동기화 (끊긴 지 ${Math.round(sample.durationMs)}ms, 실패한 재접속 ${sample.failedAttempts}회)`,
    )
  })
  // 봇마다 시드를 다르게 해서 서로 다른 편집을 하게 함
  const random = createRandom(seed + index)
  const editLoop = createEditLoop({ doc, awareness: provider.awareness, random, rate, limits })
  // actions는 editLoop가 채우는 객체를 그대로 가리킴
  const stats: BotStats = { actions: editLoop.actions, updatesSent: 0, disconnects: 0 }
  // 브라우저 클라이언트처럼 사용자 정보를 awareness에 올림, 접속 전이면 접속하자마자 전송
  // 이름·색은 편집용과 다른 시드 난수로 골라, 시드에 따른 편집 순서에 영향을 미치지 않는다
  initPresence(provider.awareness, botUser(seed, index))

  // origin: 변경을 일으킨 쪽, 서버에서 받은 변경은 provider, 내가 한 편집은 null
  doc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin !== provider) {
      stats.updatesSent += 1
    }
  })
  let destroyed = false
  provider.on('status', ({ status }) => {
    // destroy()로 일부러 접속을 끊을 때도 'disconnected'가 오므로 세지 않음 (restore에서 봇을 내보낼 때)
    if (status === 'disconnected' && !destroyed) {
      stats.disconnects += 1
    }
  })

  return {
    index,
    doc,
    awareness: provider.awareness,
    stats,
    reconnects,
    //Bot 동기화 대기
    waitSynced: (timeoutMs) =>
      new Promise((resolve, reject) => {
        if (provider.synced) {
          resolve()
          return // 동기화 완료 시 성공 후 return
        }
        const timer = setTimeout(() => {
          provider.off('sync', onSync)
          reject(new Error(`봇 ${index}: ${timeoutMs}ms 안에 서버와 동기화하지 못했습니다 (${url}/${docId})`))
        }, timeoutMs) // timeoutMS 이내 동기화가 완료되지 않으면 실패 처리
        const onSync = (synced: boolean) => {
          if (synced) {
            clearTimeout(timer)
            provider.off('sync', onSync)
            resolve()
          }
        }
        provider.on('sync', onSync) // TimeoutMS 이내 성공한 경우 동기화 process
      }),
    start: editLoop.start,
    // stop 이후 loop가 중단될 때까지 대기 - hash 비교는 모든 bot이 동작을 멈춘 후 진행되어야 하므로
    stop: editLoop.stop,
    // 재접속 대기 중에 끝내면 걸어 둔 타이머가 닫은 봇을 다시 접속시키므로 먼저 취소
    destroy: () => {
      // restore에서 봇을 먼저 내보낸 뒤 index.ts의 finally가 다시 부르므로, 두 번째부터는 아무 일도 하지 않음
      if (destroyed) {
        return
      }
      destroyed = true
      // 오류로 중간에 끝날 때는 stop 없이 불리므로, 닫은 문서를 계속 편집하지 않게 반복도 멈춤
      void editLoop.stop()
      reconnector.cancel()
      provider.destroy()
      // provider.destroy()는 awareness의 점검 타이머(setInterval)를 끄지 않아, 그대로 두면 프로세스가 끝나지 않음
      // (실행은 process.exit로 끝나 드러나지 않지만, 봇을 쓰는 테스트는 끝나지 않고 멈춤)
      provider.awareness.destroy()
    },
  }
}
