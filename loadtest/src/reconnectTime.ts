// 재접속 시간 기록 (실험 2-a)
// 연결이 끊긴 순간부터 다시 붙어 서버와 동기화를 마친 순간까지를 끊김 한 번마다 기록
// 서버는 문서 복원을 마치기 전에는 SyncStep1에 답하지 않으므로(contracts 6.4) 이 시간에는 새 파드의 복원 시간도 들어감
// (서버 쪽 복원 시간만 보려면 editor_doc_restore_seconds를 함께 봄)
import { probeNow } from './probe'
import type { ReconnectTarget } from './reconnect'

// 끊김 한 번의 기록, 시각은 epoch ms (probe.ts와 같은 시계)
export type ReconnectSample = {
  // 봇 번호
  bot: number
  // 처음 끊길 때 받은 close code (1006 = 강제 종료처럼 정상 종료 절차 없이 끊김, 1012 = 서버 재시작)
  closeCode: number
  disconnectedAt: number
  syncedAt: number
  durationMs: number
  // 다시 동기화되기까지 실패한 재접속 수 (붙을 파드가 남아 있으면 보통 0)
  failedAttempts: number
}

export type ReconnectLog = {
  // 다시 동기화를 마친 끊김들
  samples: () => ReconnectSample[]
  // 아직 다시 동기화되지 않은 끊김 수 (0 또는 1), 실행이 끝날 때 1이면 그 봇은 끝까지 복구하지 못함
  pending: () => number
}

// 'closed'·'sync' 이벤트만 쓰므로 재접속 규칙(reconnect.ts)과 같은 provider 형식을 받음
type Target = Pick<ReconnectTarget, 'on'>

// 끊긴 상태: 처음 끊긴 시각·code와, 그 뒤 실패한 재접속 수
type Outage = { code: number; at: number; failed: number }

// provider의 끊김·동기화를 지켜보며 재접속 시간을 기록
// onRecovered: 다시 동기화될 때마다 불림, 봇 로그 출력용
export function trackReconnects(
  target: Target,
  bot: number,
  onRecovered: (sample: ReconnectSample) => void = () => {},
  now: () => number = probeNow,
): ReconnectLog {
  const samples: ReconnectSample[] = []
  // 첫 동기화 전의 접속 실패는 끊김이 아님 (그때는 waitSynced가 시간 초과로 실행을 멈춤)
  let everSynced = false
  let outage: Outage | null = null

  // y-websocket은 연결이 닫힐 때마다 'closed'를 보냄 (shouldReconnect: () => false라서)
  // 붙어 있다가 끊긴 것과, 재접속 시도가 실패한 것을 모두 이 이벤트로 받음
  target.on('closed', ({ code }) => {
    if (!everSynced) {
      return
    }
    if (outage === null) {
      outage = { code, at: now(), failed: 0 }
    } else {
      outage.failed += 1
    }
  })

  // 'sync'가 true = 서버와 SyncStep1·2를 주고받아 끊긴 동안의 편집까지 맞춘 상태
  target.on('sync', (synced) => {
    if (!synced) {
      return
    }
    everSynced = true
    if (outage === null) {
      return
    }
    const syncedAt = now()
    const sample: ReconnectSample = {
      bot,
      closeCode: outage.code,
      disconnectedAt: outage.at,
      syncedAt,
      durationMs: syncedAt - outage.at,
      failedAttempts: outage.failed,
    }
    outage = null
    samples.push(sample)
    onRecovered(sample)
  })

  return {
    samples: () => [...samples],
    pending: () => (outage === null ? 0 : 1),
  }
}
