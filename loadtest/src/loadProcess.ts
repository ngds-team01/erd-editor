// 부하 프로세스 하나를 띄우고 제어 (측정 프로세스 쪽)
// 측정 프로세스: 보내는 봇·받는 봇 + 정식 봇 몇 개 + 수렴 확인 (index.ts)
// 부하 프로세스: 가벼운 봇만, 측정 프로세스의 지시대로 편집 (loadWorker.ts)
// 둘은 Node의 IPC 채널(fork가 만들어 줌)로 아래 메시지를 주고받음
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ActionName } from './actions'
import type { EventLoopSummary } from './eventLoop'

// 부하 프로세스 하나에 넘기는 설정
export type LoadWorkerOptions = {
  url: string
  docId: string
  seed: number
  // 봇 1개의 초당 편집 수
  rate: number
  // 이 프로세스가 맡을 봇 번호: firstIndex부터 count개
  firstIndex: number
  count: number
  // 봇 접속 사이 간격(ms)
  rampMs: number
  // 봇 1개가 서버와 첫 동기화를 끝내야 하는 시간(ms)
  syncTimeoutMs: number
}

// 부하 프로세스 하나의 합계
export type LoadStats = {
  bots: number
  actions: Partial<Record<ActionName, number>>
  updatesSent: number
  // 받기만 하고 반영하지 않은 메시지 수·크기
  messagesReceived: number
  bytesReceived: number
  disconnects: number
  // 이 프로세스의 편집 구간 이벤트 루프 (편집을 시작하지 않고 멈췄으면 null)
  eventLoop: EventLoopSummary | null
}

// 측정 프로세스 → 부하 프로세스
export type ToWorker = { type: 'start' } | { type: 'stop' }

// 부하 프로세스 → 측정 프로세스
export type FromWorker =
  // 봇이 모두 첫 동기화를 마침
  | { type: 'ready' }
  // 편집을 멈추고 접속을 닫음, 이 메시지 뒤에 프로세스가 끝남
  | { type: 'stopped'; stats: LoadStats }
  // 준비나 멈춤 중 오류
  | { type: 'failed'; message: string }

export type LoadProcess = {
  // 봇이 모두 동기화되면 끝남, 실패하거나 프로세스가 죽으면 오류
  ready: Promise<void>
  // 편집 시작
  start: () => void
  // 편집을 멈추고 통계를 받음, 받은 뒤 부하 프로세스는 스스로 끝남
  stop: () => Promise<LoadStats>
  // 오류로 중간에 끝낼 때 강제 종료
  kill: () => void
}

const WORKER_PATH = fileURLToPath(new URL('./loadWorker.ts', import.meta.url))

export function startLoadProcess(options: LoadWorkerOptions): LoadProcess {
  // execArgv를 따로 주지 않으면 지금 프로세스의 것을 물려받음 → tsx로 실행 중이면 자식도 .ts를 그대로 실행
  // stdio는 물려받아 부하 프로세스의 재접속 로그가 같은 터미널에 나옴
  const child = fork(WORKER_PATH, [JSON.stringify(options)], { stdio: 'inherit' })

  // 원하는 종류의 메시지가 올 때까지 기다림, 'failed'나 프로세스 종료가 먼저 오면 오류
  // 'failed'는 기다리는 대상이 아니라 언제 오든 오류로 끝내는 신호이므로 type에서 뺌 (waitFor('failed')는 타입 오류)
  function waitFor<T extends Exclude<FromWorker['type'], 'failed'>>(type: T): Promise<Extract<FromWorker, { type: T }>> {
    return new Promise((resolve, reject) => {
      const onMessage = (message: FromWorker) => {
        if (message.type === type) {
          cleanup()
          resolve(message as Extract<FromWorker, { type: T }>)
        } else if (message.type === 'failed') {
          cleanup()
          reject(new Error(`부하 프로세스(봇 ${options.firstIndex}~): ${message.message}`))
        }
      }
      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`부하 프로세스(봇 ${options.firstIndex}~)가 ${type} 전에 끝났습니다 (code ${code})`))
      }
      const cleanup = () => {
        child.off('message', onMessage)
        child.off('exit', onExit)
      }
      child.on('message', onMessage)
      child.on('exit', onExit)
    })
  }

  const send = (message: ToWorker) => child.send(message)
  const ready = waitFor('ready').then(() => undefined)
  // ready를 기다리기 전에 실패하면 처리되지 않은 Promise 오류가 나므로, 여기서 한 번 붙잡아 둠 (부르는 쪽은 그대로 오류를 받음)
  ready.catch(() => {})

  return {
    ready,
    start: () => send({ type: 'start' }),
    stop: async () => {
      const stopped = waitFor('stopped')
      send({ type: 'stop' })
      return (await stopped).stats
    },
    kill: () => {
      if (child.exitCode === null) {
        child.kill()
      }
    },
  }
}
