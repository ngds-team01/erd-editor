// MinIO(S3) 스냅샷 읽기·쓰기 (docs/contracts.md 6.3, 7.5).
// 키: snapshots/{docId}/latest.bin, 메타데이터: x-amz-meta-last-stream-id
import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3'
import { config } from './config.js'
import type { SnapshotStore } from './snapshot.js'

// SDK는 메타데이터 이름을 소문자로 다루고 x-amz-meta- 접두사를 붙여 보낸다.
const LAST_STREAM_ID = 'last-stream-id'

export const s3 = new S3Client({
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
  // MinIO가 응답하지 않을 때 주기 전체가 멈추지 않게 한다. 끊기면 그 문서는 다음 주기에 다시 한다.
  // - requestTimeout: 응답 헤더가 올 때까지 (PUT은 본문 업로드를 마친 뒤 헤더가 오므로 업로드 시간도 포함).
  //   throwOnRequestTimeout이 없으면 SDK가 경고만 남기고 계속 기다린다.
  // - socketTimeout: 헤더를 받은 뒤 본문이 이 시간 동안 한 바이트도 안 오면 끊는다 (requestTimeout은 본문을 안 본다).
  // 느려도 계속 받고 있는 본문은 끊지 않는다. 시간 초과는 SDK가 재시도한다 (기본 3번).
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000, throwOnRequestTimeout: true, socketTimeout: 10_000 },
})

export function snapshotKey(docId: string): string {
  return `snapshots/${docId}/latest.bin`
}

function isNotFound(err: unknown): boolean {
  return err instanceof S3ServiceException && (err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404)
}

export const s3Snapshots: SnapshotStore = {
  async read(docId) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: snapshotKey(docId) }))
      const state = await res.Body!.transformToByteArray()
      // 메타데이터가 없는 스냅샷은 어디까지 반영됐는지 모르므로 '0'으로 보고 남은 로그를 전부 다시 적용한다.
      // (Yjs 업데이트는 여러 번 적용해도 결과가 같다)
      const lastStreamId = res.Metadata?.[LAST_STREAM_ID] ?? '0'
      return { state, lastStreamId }
    } catch (err) {
      // 아직 스냅샷이 없는 문서. 그 밖의 오류(버킷 없음, 접속 실패 등)는 그대로 던져서 이 문서를 건너뛴다.
      if (isNotFound(err)) return null
      throw err
    }
  },

  async write(docId, state, lastStreamId) {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: snapshotKey(docId),
        Body: state,
        ContentType: 'application/octet-stream',
        Metadata: { [LAST_STREAM_ID]: lastStreamId },
      }),
    )
  },
}
