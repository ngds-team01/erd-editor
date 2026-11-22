import os from 'node:os'

/**
 * 숫자 환경 변수를 읽는다. 양의 정수가 아니면 경고를 남기고 기본값을 쓴다.
 * (예: SNAPSHOT_INTERVAL_MS=abc 가 그대로 NaN이 되면 타이머가 1ms마다 돈다)
 */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (Number.isInteger(value) && value > 0) return value
  console.warn(`[config] ${name}=${raw} 는 양의 정수가 아니라 기본값 ${fallback}을 씁니다`)
  return fallback
}

/** 빈 문자열은 값이 없는 것으로 본다. */
function optional(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  return raw ? raw : undefined
}

// 환경 변수 목록과 의미는 docs/contracts.md 7.5 "포트·환경 변수" 표가 기준이다.
export const config = {
  // contracts 7.5: snapshot-worker는 8081 (/healthz, /metrics)
  port: positiveInt('PORT', 8081),
  // 로그 앞에 붙이는 이름. Kubernetes에서는 파드 이름(hostname)이 된다.
  name: process.env.POD_ID ?? os.hostname(),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // contracts 6.3: 30초마다 스냅샷
  intervalMs: positiveInt('SNAPSHOT_INTERVAL_MS', 30_000),
  // AWS S3로 바꿀 때는 S3_ENDPOINT를 비운다 (undefined면 SDK가 AWS 주소를 쓴다)
  s3Endpoint: optional('S3_ENDPOINT'),
  s3Bucket: optional('S3_BUCKET') ?? 'erd-snapshots',
  // contracts 7.5: Secret(s3-credentials)에서 S3_ACCESS_KEY·S3_SECRET_KEY로 주입된다.
  // SDK는 이 이름을 읽지 않으므로 S3Client에 credentials로 직접 넘긴다 (s3.ts).
  s3AccessKey: optional('S3_ACCESS_KEY'),
  s3SecretKey: optional('S3_SECRET_KEY'),
  awsRegion: optional('AWS_REGION') ?? 'us-east-1',
}
