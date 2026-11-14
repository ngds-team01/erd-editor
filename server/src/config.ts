import os from 'node:os'

/**
 * 숫자 환경 변수를 읽는다. 양의 정수가 아니면 경고를 남기고 기본값을 쓴다.
 * (예: HEARTBEAT_INTERVAL_MS=abc 가 그대로 NaN이 되면 타이머가 1ms마다 돌고 피어 타임아웃 판정이 깨진다)
 */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (Number.isInteger(value) && value > 0) return value
  console.warn(`[config] ${name}=${raw} 는 양의 정수가 아니라 기본값 ${fallback}을 씁니다`)
  return fallback
}

// 환경 변수 목록과 의미는 docs/contracts.md 7.5 "포트·환경 변수" 표가 기준이다.
export const config = {
  port: positiveInt('PORT', 8080),
  // Kubernetes에서는 Downward API로 metadata.name(파드 이름)을 넣는다.
  podId: process.env.POD_ID ?? os.hostname(),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // contracts 5.4: adaptive(기본) = 피어가 있을 때만 발행, broadcast = 항상 발행 (실험 3 비교용)
  propagationMode: process.env.PROPAGATION_MODE === 'broadcast' ? 'broadcast' : 'adaptive',
  // contracts 5.3-5: SHARED 파드의 HEARTBEAT 주기. 피어 타임아웃은 3배(기본 15초)
  heartbeatIntervalMs: positiveInt('HEARTBEAT_INTERVAL_MS', 5000),
}
