import { useSyncExternalStore } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import { TextField } from '../panel/TextField'
import { randomNickname } from '../sync/nickname'
import { MAX_USER_NAME, otherUsers, renameUser } from '../sync/presence'
import type { PeerStore, PresenceUser } from '../sync/presence'

// 이름까지 보여줄 다른 사용자 수, 넘으면 나머지는 +N으로 줄이고 마우스를 올리면 이름 목록 표시
const MAX_VISIBLE_USERS = 4

// awareness: 내 이름을 바꿀 곳, peers: 다른 사용자 목록과 내 사용자 정보 (connection에서 받음)
type UserListProps = {
  awareness: Awareness
  peers: PeerStore
}

// 다른 사용자 1명: 색 점 + 이름, 긴 이름은 말줄임표로 줄이고 마우스를 올리면 전체 이름 표시
function UserChip({ user }: { user: PresenceUser }) {
  return (
    <span className="u-chip" title={user.name}>
      <span className="u-dot" style={{ background: user.color }} />
      <span className="u-name">{user.name}</span>
    </span>
  )
}

// 툴바 오른쪽의 접속자 표시: 다른 사용자들 → 내 이름 칸(클릭해서 변경) → 🎲 무작위 이름
export function UserList({ awareness, peers }: UserListProps) {
  // React 바깥의 awareness를 구독, 다른 사용자가 들어오고 나가거나 내 이름이 바뀌면 다시 그림
  const peerList = useSyncExternalStore(peers.subscribe, peers.getPeers)
  const self = useSyncExternalStore(peers.subscribe, peers.getSelf)

  const users = otherUsers(peerList, self?.id ?? null)
  const visible = users.slice(0, MAX_VISIBLE_USERS)
  const hidden = users.slice(MAX_VISIBLE_USERS)

  return (
    <div className="users" aria-label="접속자">
      {visible.map((user) => (
        <UserChip key={user.id} user={user} />
      ))}
      {hidden.length > 0 && (
        <span className="u-more" title={hidden.map((user) => user.name).join(', ')}>
          +{hidden.length}
        </span>
      )}
      {self && (
        <span className="u-me">
          <span className="u-dot" style={{ background: self.color }} />
          <span className="u-tag">나</span>
          {/* 입력 중에는 내 화면에만 보이고, Enter·포커스 이탈 때 반영 (Esc 취소, 빈 이름은 무시) */}
          <TextField
            className="u-input"
            value={self.name}
            maxLength={MAX_USER_NAME}
            title="클릭해서 이름 변경"
            aria-label="내 이름"
            onCommit={(name) => renameUser(awareness, name)}
          />
          <button
            type="button"
            className="btn tb u-dice"
            title="무작위 이름으로 바꾸기"
            aria-label="무작위 이름으로 바꾸기"
            onClick={() => renameUser(awareness, randomNickname())}
          >
            🎲
          </button>
        </span>
      )}
    </div>
  )
}
