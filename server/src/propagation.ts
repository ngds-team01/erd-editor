// 파드 사이 적응형 전파 (docs/contracts.md 5.3, 5.4).
// 문서를 이 파드만 열고 있으면 LOCAL(발행 안 함), 다른 파드도 열고 있으면 SHARED(발행함).
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { config } from './config.js'
import { MessageType, decodeEnvelope, encodeEnvelope, typeName } from './envelope.js'
import type { Envelope } from './envelope.js'
import { countMessage, syncLatency } from './metrics.js'
import { isRedisReady, onRedisReady, redis, subscriber } from './redis.js'

/** Pub/Sub로 받은 변경에 붙이는 origin. 이 origin의 변경은 다시 발행하지 않는다. */
export const REMOTE_ORIGIN = Symbol('remote')

// 5.3-5: HEARTBEAT 5초마다, 15초 동안 소식이 없으면 피어에서 뺀다 (HEARTBEAT 3번 놓침)
const PEER_TIMEOUT_MS = config.heartbeatIntervalMs * 3

const EMPTY = new Uint8Array(0)
const CHANNEL_PREFIX = 'doc:'
const CHANNEL_SUFFIX = ':updates'

/** 전파 대상 문서가 갖춰야 하는 것 */
export type PropagatedDoc = Y.Doc & {
  readonly name: string
  readonly awareness: awarenessProtocol.Awareness
  /** 이 파드에 붙은 클라이언트들이 올린 awareness clientID */
  localAwarenessIds(): number[]
}

/** docId → 그 문서의 전파 상태. Pub/Sub 메시지를 문서로 보내는 데 쓴다. */
const propagations = new Map<string, DocPropagation>()

export function channelOf(docId: string): string {
  return `${CHANNEL_PREFIX}${docId}${CHANNEL_SUFFIX}`
}

export class DocPropagation {
  private readonly channel: string
  /** 피어 podId → 마지막으로 메시지를 받은 시각(ms). HEARTBEAT 타임아웃(5.3-5)에 쓴다. */
  private readonly peers = new Map<string, number>()
  /** 우리 SYNC1을 이미 보낸 피어. 피어마다 한 번씩 양방향 동기화를 시작한다. */
  private readonly syncedPeers = new Set<string>()
  private subscribed = false
  private left = false
  private readonly heartbeatTimer: NodeJS.Timeout

  constructor(private readonly doc: PropagatedDoc) {
    this.channel = channelOf(doc.name)
    propagations.set(doc.name, this)
    this.heartbeatTimer = setInterval(() => this.heartbeat(), config.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
    void this.start()
  }

  /** 발행 여부. broadcast 모드면 피어가 없어도 항상 발행한다 (5.4). */
  get shared(): boolean {
    return config.propagationMode === 'broadcast' || this.peers.size > 0
  }

  // 5.3-1: 구독한 뒤 JOIN 발행. (3주차: 이 앞에 MinIO·Streams 복원이 들어간다)
  private async start() {
    try {
      await subscriber.subscribe(this.channel)
    } catch (err) {
      console.warn(`[doc:${this.doc.name}] 채널 구독 실패: ${(err as Error).message}`)
      return
    }
    if (this.left) {
      // 구독이 끝나기 전에 문서가 내려갔다. 그사이 같은 문서가 다시 열렸으면 그쪽 구독을 건드리지 않는다.
      if (!propagations.has(this.doc.name)) subscriber.unsubscribe(this.channel).catch(() => {})
      return
    }
    this.subscribed = true
    this.join()
  }

  /** JOIN 발행. 처음 열 때와 Redis 재연결 후에 부른다 (재연결 후 SYNC 재교환, 6.2). */
  join() {
    if (!this.subscribed || this.left) return
    this.syncedPeers.clear()
    this.publish(MessageType.JOIN, EMPTY)
  }

  /**
   * 5.3-5: 15초 동안 소식 없는 피어를 빼고(LEAVE 없이 죽은 파드), SHARED면 HEARTBEAT를 보낸다.
   * 피어가 모두 빠지면 LOCAL로 돌아간다 (5.3-7).
   */
  private heartbeat() {
    const now = Date.now()
    for (const [peer, lastSeen] of this.peers) {
      if (now - lastSeen <= PEER_TIMEOUT_MS) continue
      const wasShared = this.shared
      this.peers.delete(peer)
      this.syncedPeers.delete(peer)
      this.logModeChange(wasShared, `${peer} ${PEER_TIMEOUT_MS / 1000}초 무응답`)
    }
    if (this.shared && this.subscribed) this.publish(MessageType.HEARTBEAT, EMPTY)
  }

  /** 이 파드의 클라이언트가 만든 문서 변경 (5.3-4) */
  onLocalUpdate(update: Uint8Array) {
    if (this.shared) this.publish(MessageType.UPDATE, update)
  }

  /** 이 파드의 클라이언트가 만든 awareness 변경 (5.3-4) */
  onLocalAwareness(update: Uint8Array) {
    if (this.shared) this.publish(MessageType.AWARENESS, update)
  }

  handle(envelope: Envelope) {
    const { type, from, to, payload } = envelope
    // 5.2: 자기가 보낸 메시지와 다른 파드 앞으로 온 메시지는 무시
    if (this.left || from === config.podId) return
    if (to !== '' && to !== config.podId) return

    if (type === MessageType.LEAVE) {
      const wasShared = this.shared
      this.peers.delete(from)
      this.syncedPeers.delete(from)
      this.logModeChange(wasShared, `${from} LEAVE`)
      return
    }

    // 5.3-2: 피어에게서 어떤 메시지든 받으면 피어 목록에 넣고 SHARED
    const wasShared = this.shared
    const isNewPeer = !this.peers.has(from)
    this.peers.set(from, Date.now())
    if (isNewPeer) {
      this.logModeChange(wasShared, `${from} ${typeName(type)}`)
      // 이 파드 사용자들의 커서·편집 중 표시를 새 피어에게 바로 보여 준다 (15초 갱신을 기다리지 않게)
      this.publishLocalAwareness()
    }

    if (type === MessageType.JOIN) {
      // 5.3-2: JOIN을 받으면 보낸 파드에게 HEARTBEAT와 SYNC1
      this.publish(MessageType.HEARTBEAT, EMPTY, from)
      this.sendSync1(from)
    } else if (!this.syncedPeers.has(from)) {
      // 5.3-3: 아직 SYNC1을 보내지 않은 피어면 우리 SYNC1도 보내 양방향으로 맞춘다.
      // (JOIN을 보낸 쪽은 상대의 HEARTBEAT를 먼저 받으므로 "처음 보는 피어"가 아니라 "SYNC1을 안 보낸 피어"로 판단한다)
      this.sendSync1(from)
    }

    switch (type) {
      case MessageType.SYNC1:
        // 5.3-3: 상대 state vector에 없는 부분만 돌려준다
        this.publish(MessageType.SYNC2, Y.encodeStateAsUpdate(this.doc, payload), from)
        break
      case MessageType.UPDATE:
        // 7.3: 다른 파드 사용자의 편집이 이 파드에 도착하기까지 걸린 시간
        syncLatency.observe(Math.max(0, Date.now() - envelope.sentAt) / 1000)
        Y.applyUpdate(this.doc, payload, REMOTE_ORIGIN)
        break
      case MessageType.SYNC2:
        Y.applyUpdate(this.doc, payload, REMOTE_ORIGIN)
        break
      case MessageType.AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.doc.awareness, payload, REMOTE_ORIGIN)
        break
    }
  }

  /**
   * 문서를 내릴 때(5.3-6, 마지막 클라이언트가 떠남)와 서버 종료 때(7.2) 부른다.
   */
  leave() {
    if (this.left) return
    if (this.shared) {
      // 아직 붙어 있는 사용자(종료 중)의 커서가 상대 화면에 남지 않도록 먼저 지운다 (AWARENESS는 SHARED일 때만, 5.3-4).
      // 서버 awareness는 건드리지 않고 "state 없음"만 인코딩해서 보낸다.
      const ids = this.doc.localAwarenessIds().filter((id) => this.doc.awareness.meta.has(id))
      if (ids.length > 0) {
        this.publish(MessageType.AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.doc.awareness, ids, new Map()))
      }
    }
    // 5.3-6: LOCAL이어도 LEAVE는 보낸다
    this.publish(MessageType.LEAVE, EMPTY)
    this.left = true
    clearInterval(this.heartbeatTimer)
    if (propagations.get(this.doc.name) === this) propagations.delete(this.doc.name)
    if (this.subscribed) subscriber.unsubscribe(this.channel).catch(() => {})
  }

  private sendSync1(peer: string) {
    this.syncedPeers.add(peer)
    this.publish(MessageType.SYNC1, Y.encodeStateVector(this.doc), peer)
  }

  private publishLocalAwareness() {
    const ids = this.doc.localAwarenessIds().filter((id) => this.doc.awareness.states.has(id))
    if (ids.length > 0) {
      this.publish(MessageType.AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.doc.awareness, ids))
    }
  }

  private publish(type: MessageType, payload: Uint8Array, to = '') {
    // Redis가 끊긴 동안 못 보낸 변경은 재연결 후 JOIN → SYNC1·SYNC2로 다시 맞춘다.
    if (this.left || !isRedisReady()) return
    const data = encodeEnvelope({ type, from: config.podId, to, sentAt: Date.now(), payload })
    countMessage('pubsub_out')
    redis.publish(this.channel, Buffer.from(data.buffer, data.byteOffset, data.byteLength)).catch((err: Error) => {
      console.warn(`[doc:${this.doc.name}] ${typeName(type)} 발행 실패: ${err.message}`)
    })
  }

  private logModeChange(wasShared: boolean, reason: string) {
    if (wasShared === this.shared) return
    const change = this.shared ? 'LOCAL → SHARED' : 'SHARED → LOCAL'
    console.log(`[doc:${this.doc.name}] ${change} (${reason}, 피어 ${this.peers.size})`)
  }
}

subscriber.on('messageBuffer', (channel: Buffer, message: Buffer) => {
  const name = channel.toString()
  if (!name.startsWith(CHANNEL_PREFIX) || !name.endsWith(CHANNEL_SUFFIX)) return
  // Redis가 이 파드에 배달한 횟수 (자기 메시지·다른 파드 앞 메시지도 배달은 일어나므로 센다)
  countMessage('pubsub_in')
  const docId = name.slice(CHANNEL_PREFIX.length, -CHANNEL_SUFFIX.length)
  const propagation = propagations.get(docId)
  if (!propagation) return
  try {
    propagation.handle(decodeEnvelope(new Uint8Array(message.buffer, message.byteOffset, message.byteLength)))
  } catch (err) {
    console.warn(`[doc:${docId}] Pub/Sub 메시지 처리 실패: ${(err as Error).message}`)
  }
})

// Redis가 다시 붙으면 열린 문서마다 JOIN을 다시 보내 끊긴 동안의 변경을 SYNC로 맞춘다 (6.2).
onRedisReady(() => {
  for (const propagation of propagations.values()) propagation.join()
})

/** 서버 종료 시 모든 문서에서 LEAVE (7.2) */
export function leaveAll() {
  for (const propagation of [...propagations.values()]) propagation.leave()
}
