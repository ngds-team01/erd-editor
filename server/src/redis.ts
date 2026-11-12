// Redis 연결 두 개.
// - redis: 명령(PUBLISH·XADD)용
// - subscriber: Pub/Sub 구독 전용. 구독 중인 연결에서는 다른 명령을 쓸 수 없어서 따로 둔다.
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

// 구독은 끊긴 동안 요청해도 다시 붙으면 처리되도록 쌓아 둔다.
// 재연결 후에는 ioredis가 기존 구독 채널을 자동으로 다시 구독한다(autoResubscribe 기본값).
export const subscriber = redis.duplicate({
  enableOfflineQueue: true,
  maxRetriesPerRequest: null,
})

function watch(client: Redis, label: string) {
  // 끊긴 동안에는 close·reconnecting·error가 재시도마다 반복되므로,
  // 끊길 때 한 번, 다시 붙을 때 한 번만 로그를 남긴다.
  let connected = false
  let retries = 0
  let firstError = ''
  const log = (message: string) => console.log(`[${config.podId}] Redis${label} ${message}`)

  client.on('ready', () => {
    connected = true
    log(retries > 0 ? `다시 연결됨 (${retries}번 재시도)` : `연결됨: ${config.redisUrl}`)
    retries = 0
    firstError = ''
  })
  client.on('close', () => {
    if (!connected) return
    connected = false
    log('연결 끊김, 재접속 시도 중')
  })
  client.on('reconnecting', () => {
    retries += 1
  })
  client.on('error', (err: NodeJS.ErrnoException) => {
    // Node의 연결 거부 오류는 message가 비어 있을 수 있어 code를 대신 쓴다.
    const reason = err.message || err.code || 'unknown'
    if (firstError) return
    firstError = reason
    log(`오류: ${reason}`)
  })
}

watch(redis, '')
watch(subscriber, '(구독)')

export function isRedisReady(): boolean {
  return redis.status === 'ready'
}

/** 명령 연결과 구독 연결이 모두 준비될 때마다 호출한다 (처음 연결, 재연결 모두). */
export function onRedisReady(listener: () => void) {
  const check = () => {
    if (redis.status === 'ready' && subscriber.status === 'ready') listener()
  }
  redis.on('ready', check)
  subscriber.on('ready', check)
}

async function quit(client: Redis) {
  try {
    await client.quit()
  } catch {
    client.disconnect()
  }
}

export async function closeRedis(): Promise<void> {
  await Promise.all([quit(redis), quit(subscriber)])
}
