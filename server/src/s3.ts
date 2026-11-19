// MinIO(S3) 스냅샷 읽기 (docs/contracts.md 6.3, 6.4, 7.5).
// 스냅샷은 스냅샷 워커(worker/)가 만든다. 서버는 문서를 처음 열 때 읽기만 한다.
// 키: snapshots/{docId}/latest.bin, 메타데이터: x-amz-meta-last-stream-id
import { GetObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3'
import { config } from './config.js'
import type { SnapshotReader } from './restore.js'

// SDK는 메타데이터 이름을 소문자로 다루고 x-amz-meta- 접두사를 붙여 보낸다.
const LAST_STREAM_ID = 'last-stream-id'

const s3 = new S3Client({
  // AWS S3로 바꿀 때는 S3_ENDPOINT를 비우면 된다 (config에서 빈 문자열은 undefined)
  endpoint: config.s3Endpoint,
  region: config.awsRegion,
  // MinIO는 path-style 주소(http://minio:9000/버킷/키)만 지원한다
  forcePathStyle: true,
  // contracts 7.5: Secret의 S3_ACCESS_KEY·S3_SECRET_KEY를 넘긴다.
  // 둘 다 없으면 SDK 기본 방식(AWS_ACCESS_KEY_ID, IAM 역할 등)으로 찾는다.
  credentials:
    config.s3AccessKey && config.s3SecretKey
      ? { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey }
      : undefined,
  // 복원이 끝날 때까지 클라이언트가 기다리므로 MinIO가 응답하지 않으면 오래 붙잡지 않는다.
  // 끊기면 스냅샷 없이 Streams 기록만으로 복원하고, 문서가 열려 있는 동안 다시 읽는다 (doc.ts).
  // - requestTimeout: 응답 헤더가 올 때까지. throwOnRequestTimeout이 없으면 SDK가 경고만 남기고 계속 기다린다.
  // - socketTimeout: 헤더를 받은 뒤 본문이 이 시간 동안 한 바이트도 안 오면 끊는다 (requestTimeout은 본문을 안 본다).
  // 느려도 계속 받고 있는 본문은 끊지 않는다. 시간 초과는 SDK가 한 번 더 시도한다 (최악 약 4초).
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000, throwOnRequestTimeout: true, socketTimeout: 2_000 },
})

function snapshotKey(docId: string): string {
  return `snapshots/${docId}/latest.bin`
}

function isNotFound(err: unknown): boolean {
  return err instanceof S3ServiceException && (err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404)
}

export const s3Snapshots: SnapshotReader = {
  async read(docId) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: snapshotKey(docId) }))
      const state = await res.Body!.transformToByteArray()
      // 메타데이터가 없는 스냅샷은 어디까지 반영됐는지 모르므로 '0'으로 보고 남은 로그를 전부 적용한다.
      // (Yjs 업데이트는 여러 번 적용해도 결과가 같다)
      return { state, lastStreamId: res.Metadata?.[LAST_STREAM_ID] ?? '0' }
    } catch (err) {
      // 아직 스냅샷이 없는 문서 (처음 만든 문서이거나 워커가 아직 한 번도 돌지 않음)
      if (isNotFound(err)) return null
      throw err
    }
  },
}
