import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { DEFAULT_LIMITS, randomEdit } from './actions'
import type { ActionName, EditLimits } from './actions'
import { createRandom } from './random'

// 드래그 중 position을 쓰는 간격 (contracts 2.7: 최대 50ms에 한 번)
const DRAG_INTERVAL_MS = 50

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
  stats: BotStats
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
  })
  // 봇마다 시드를 다르게 해서 서로 다른 편집을 하게 함
  const random = createRandom(seed + index)
  const stats: BotStats = { actions: {}, updatesSent: 0, disconnects: 0 }

  // origin: 변경을 일으킨 쪽, 서버에서 받은 변경은 provider, 내가 한 편집은 null
  doc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin !== provider) {
      stats.updatesSent += 1
    }
  })
  provider.on('status', ({ status }) => {
    if (status === 'disconnected') {
      stats.disconnects += 1
    }
  })

  let running = false
  // 편집 반복(loop)이 돌고 있는 Promise, stop에서 끝날 때까지 기다리는 데 사용
  let loop: Promise<void> = Promise.resolve()

  // 드래그 좌표 사이에 쉬는 방법: 50ms 쉬기
  const dragWait = () => sleep(DRAG_INTERVAL_MS)

  // 편집 1번, 드래그면 좌표를 50ms마다 나눠 씀
  async function editOnce(): Promise<void> {
    const action = await randomEdit(doc, random, limits, dragWait)
    stats.actions[action] = (stats.actions[action] ?? 0) + 1
  }

  async function run(): Promise<void> {
    // 평균 간격 1000/rate ms, 봇들이 같은 순간에 몰리지 않게 0.5~1.5배로 흔듦
    const interval = 1000 / rate
    while (running) {
      await editOnce()
      await sleep(interval * (0.5 + random.next()))
    }
  }

  return {
    index,
    doc,
    stats,
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
    start: () => {
      if (running) {
        return
      }
      running = true
      loop = run()
    },
    // stop 이후 loop가 중단될 때까지 대기 - hash 비교는 모든 bot이 동작을 멈춘 후 진행되어야 하므로
    stop: async () => {
      running = false
      await loop
    },
    destroy: () => provider.destroy(),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
