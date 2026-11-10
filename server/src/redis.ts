// Redis 연결. 명령(XADD·PUBLISH)용 연결 하나를 둔다.
// Pub/Sub 구독은 구독 중인 연결에서 다른 명령을 못 쓰므로, 2주차에 redis.duplicate()로 따로 만든다.
import { Redis } from 'ioredis'
import { config } from './config.js'

const RETRY_MAX_DELAY_MS = 5_000

export const redis = new Redis(config.redisUrl, {
  // 끊기면 0.2초, 0.4초, … 최대 5초 간격으로 계속 재접속한다.
  retryStrategy: (times) => Math.min(times * 200, RETRY_MAX_DELAY_MS),
  // 끊긴 동안 보낸 명령은 쌓아 두지 않고 바로 실패시킨다.
  // contracts 6.2: 기록할 업데이트는 서버가 메모리 버퍼에 모아 두었다가 재연결 후 flush한다.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
})

// 끊긴 동안에는 close·reconnecting·error가 재시도마다 반복되므로,
// 끊길 때 한 번, 다시 붙을 때 한 번만 로그를 남긴다.
let connected = false
let retries = 0
let firstError = ''

function log(message: string) {
  console.log(`[${config.podId}] Redis ${message}`)
}

redis.on('ready', () => {
  connected = true
  log(retries > 0 ? `다시 연결됨 (${retries}번 재시도)` : `연결됨: ${config.redisUrl}`)
  retries = 0
  firstError = ''
})
redis.on('close', () => {
  if (!connected) return
  connected = false
  log('연결 끊김, 재접속 시도 중')
})
redis.on('reconnecting', () => {
  retries += 1
})
redis.on('error', (err: NodeJS.ErrnoException) => {
  // Node의 연결 거부 오류는 message가 비어 있을 수 있어 code를 대신 쓴다.
  const reason = err.message || err.code || 'unknown'
  if (firstError) return
  firstError = reason
  log(`오류: ${reason}`)
})

export function isRedisReady(): boolean {
  return redis.status === 'ready'
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }
}
