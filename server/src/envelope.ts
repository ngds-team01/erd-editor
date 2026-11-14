// 파드 사이 Pub/Sub 메시지 봉투 (docs/contracts.md 5.2).
// 순서: type(varUint) · from(varString) · to(varString) · sentAt(float64, ms) · payload(varUint8Array)
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export const MessageType = {
  UPDATE: 0,
  JOIN: 1,
  LEAVE: 2,
  HEARTBEAT: 3,
  SYNC1: 4,
  SYNC2: 5,
  AWARENESS: 6,
} as const

export type MessageType = (typeof MessageType)[keyof typeof MessageType]

const TYPE_NAMES = Object.fromEntries(Object.entries(MessageType).map(([name, value]) => [value, name]))

export type Envelope = {
  type: MessageType
  /** 보낸 podId */
  from: string
  /** 받을 podId. 빈 문자열이면 전체 */
  to: string
  /** 보낸 시각(ms). 동기화 지연 지표용 */
  sentAt: number
  payload: Uint8Array
}

export function typeName(type: MessageType): string {
  return TYPE_NAMES[type] ?? String(type)
}

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, envelope.type)
  encoding.writeVarString(encoder, envelope.from)
  encoding.writeVarString(encoder, envelope.to)
  encoding.writeFloat64(encoder, envelope.sentAt)
  encoding.writeVarUint8Array(encoder, envelope.payload)
  return encoding.toUint8Array(encoder)
}

/** 형식이 틀리면 예외를 던진다. */
export function decodeEnvelope(data: Uint8Array): Envelope {
  const decoder = decoding.createDecoder(data)
  const type = decoding.readVarUint(decoder)
  if (!(type in TYPE_NAMES)) throw new Error(`알 수 없는 메시지 타입 ${type}`)
  return {
    type: type as MessageType,
    from: decoding.readVarString(decoder),
    to: decoding.readVarString(decoder),
    sentAt: decoding.readFloat64(decoder),
    payload: decoding.readVarUint8Array(decoder),
  }
}
