// 봇의 재접속 규칙 (contracts 4.3)
// 대기 시간 계산은 client의 reconnect.ts를 그대로 가져와, 봇이 브라우저 클라이언트와 같은 간격으로 재접속하게 함
// (y-websocket 기본값은 0.1s부터 최대 2.5s라 그대로 두면 실험 2에서 실제보다 빠른 복구 시간이 나옴)
import { CLOSE_SERVICE_RESTART, reconnectDelay } from '../../client/src/sync/reconnect'

export { CLOSE_INVALID_DOC_ID, CLOSE_SERVICE_RESTART } from '../../client/src/sync/reconnect'

// 서버가 연결을 닫았을 때 y-websocket이 'closed' 이벤트로 넘겨주는 값
export type CloseInfo = { code: number; reason: string }

// 재접속을 맡길 provider에 필요한 기능만 요구, 테스트에서는 가짜 provider를 넣음
export type ReconnectTarget = {
  on(name: 'closed', listener: (event: CloseInfo) => void): void
  on(name: 'sync', listener: (synced: boolean) => void): void
  connect(): void
}

// retry: delayMs 뒤 다시 접속함, attempt는 이번 대기 시간 계산에 쓴 연속 실패 횟수 (0 → 0.5s, 1 → 1s …)
// stop: 재접속하지 않음 (4400, 잘못된 문서 주소)
export type ReconnectEvent =
  | { kind: 'retry'; code: number; delayMs: number; attempt: number }
  | { kind: 'stop'; code: number }

export type Reconnector = {
  // 걸어 둔 재접속을 취소하고 이후 재접속도 하지 않음, 봇을 끝낼 때 사용
  cancel: () => void
}

// provider가 닫힐 때마다 close code로 대기 시간을 정해 직접 다시 접속 (client의 connection.ts와 같은 흐름)
// provider는 shouldReconnect: () => false로 만들어야 y-websocket이 따로 재접속하지 않음
// random: 지터용 난수, 봇의 편집용 시드 난수를 쓰면 재접속 횟수에 따라 편집 순서가 달라지므로 따로 둠
export function attachReconnect(
  provider: ReconnectTarget,
  onEvent: (event: ReconnectEvent) => void,
  random: () => number = Math.random,
): Reconnector {
  // 동기화에 성공한 뒤로 연속으로 실패한 횟수
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  provider.on('closed', ({ code }) => {
    if (cancelled) {
      return
    }
    const delay = reconnectDelay(code, attempt, random)
    if (delay === null) {
      onEvent({ kind: 'stop', code })
      return
    }
    onEvent({ kind: 'retry', code, delayMs: delay, attempt })
    // 1012는 계획된 재시작이라 실패로 세지 않음
    if (code !== CLOSE_SERVICE_RESTART) {
      attempt += 1
    }
    timer = setTimeout(() => {
      timer = null
      provider.connect()
    }, delay)
  })

  // 동기화에 성공하면 백오프 횟수를 처음부터 다시 셈
  provider.on('sync', (synced) => {
    if (synced) {
      attempt = 0
    }
  })

  return {
    cancel: () => {
      cancelled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
