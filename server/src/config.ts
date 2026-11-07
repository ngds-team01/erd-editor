import os from 'node:os'

// 환경 변수 목록과 의미는 docs/contracts.md 7.5 "포트·환경 변수" 표가 기준이다.
export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Kubernetes에서는 Downward API로 metadata.name(파드 이름)을 넣는다.
  podId: process.env.POD_ID ?? os.hostname(),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
}
