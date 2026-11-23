// 봇 프로세스의 이벤트 루프 상태 기록
// 봇 수백 개가 한 프로세스(스레드 하나)에서 도므로, 프로세스가 바쁘면 받은 메시지를 늦게 처리해 측정 지연이 부풀려짐
// 측정 지연과 함께 이 값을 보고, 지연이 서버 때문인지 봇 프로세스 때문인지 가름
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

// 타이머 지연을 재는 간격(ms), Node 기본값
const RESOLUTION_MS = 10

export type EventLoopSummary = {
  // 바쁜 시간 비율(0~1, Event Loop Utilization): 기다리지 않고 코드를 실행하던 시간 / 전체 시간
  // OS와 상관없이 정확하므로 "봇 프로세스가 바빴는가"는 이 값으로 판단
  utilization: number
  // 타이머 지연(ms): RESOLUTION_MS마다 깨어나기로 한 타이머가 예정보다 늦게 깨어난 시간
  // 긴 동기 작업으로 루프가 멈춘 순간을 잡음
  // Windows는 OS 타이머 단위(약 15.6ms) 때문에 쉬고 있어도 p50 약 5ms, p99 약 12ms가 나옴 (Linux는 1ms 이하)
  lagP50Ms: number
  lagP99Ms: number
  lagMaxMs: number
}

// 기록 시작, 반환값: 기록을 멈추고 요약을 돌려주는 함수
export function startEventLoopMonitor(): () => EventLoopSummary {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()
  // 시작 시점의 누적값, 끝날 때 이 값을 넘기면 그 사이 구간만 계산됨
  const started = performance.eventLoopUtilization()

  return () => {
    histogram.disable()
    const { utilization } = performance.eventLoopUtilization(started)
    // histogram은 샘플 사이 전체 간격을 ns로 기록하므로, 예정 간격(RESOLUTION_MS)을 빼 늦어진 시간만 남김
    const lag = (ns: number) => Math.max(0, ns / 1e6 - RESOLUTION_MS)
    return {
      utilization,
      lagP50Ms: lag(histogram.percentile(50)),
      lagP99Ms: lag(histogram.percentile(99)),
      lagMaxMs: lag(histogram.max),
    }
  }
}
