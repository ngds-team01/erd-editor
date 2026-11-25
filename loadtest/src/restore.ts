// 전원 이탈 후 복원 확인 (실험 2-b)
// 봇이 모두 나가기 전 문서 상태를 적어 두고, 서버 데이터(스냅샷 + Streams)만으로 복원한 문서와 비교해 빠진 연산 수를 셈
//
// Yjs는 클라이언트(clientID)마다 만든 항목에 0, 1, 2 … 번호(clock)를 붙임
//   상태 벡터: 클라이언트마다 몇 번 항목까지 가지고 있는지 명시 (Y.snapshot(doc).sv)
//   삭제 집합: 클라이언트마다 몇 번부터 몇 개가 지워졌는지 명시 (Y.snapshot(doc).ds)
// 해시는 같은지 다른지만 알려 주므로, 개수는 이 두 표를 클라이언트별로 비교해 구함
//   추가가 빠짐 = 기대 clock − 복원 clock (테이블 이름 5글자 입력은 5로 셈, Yjs가 글자마다 번호를 붙이므로)
//   삭제가 빠짐 = 기대 삭제 수 − 복원 삭제 수 (상태 벡터에는 삭제가 나타나지 않아 따로 셈)
import * as Y from 'yjs'

// 문서 하나의 상태 요약, 클라이언트 번호 → 개수
export type DocState = {
  // 그 클라이언트가 만든 항목 수 (= 다음에 붙일 clock)
  clocks: Map<number, number>
  // 그 클라이언트가 만든 항목 중 지워진 수
  deleted: Map<number, number>
}

// 클라이언트 한 명의 비교 결과
export type ClientLoss = {
  client: number
  expectedClock: number
  restoredClock: number
  expectedDeleted: number
  restoredDeleted: number
}

export type LossReport = {
  // 빠진 추가 수 합계
  missingInserts: number
  // 빠진 삭제 수 합계
  missingDeletes: number
  // 무엇이든 빠진 클라이언트 (빠진 것이 없으면 빈 배열), 클라이언트 번호 순
  clients: ClientLoss[]
}

export function captureState(doc: Y.Doc): DocState {
  const snapshot = Y.snapshot(doc)
  const deleted = new Map<number, number>()
  for (const [client, items] of snapshot.ds.clients) {
    deleted.set(
      client,
      items.reduce((sum, item) => sum + item.len, 0),
    )
  }
  return { clocks: new Map(snapshot.sv), deleted }
}

// 기대 상태에 있는데 복원 상태에 없는 것만 셈
// 복원 쪽이 더 많은 경우(기대 상태를 적은 뒤 누가 편집함)는 유실이 아니므로 0으로 봄
export function compareStates(expected: DocState, restored: DocState): LossReport {
  const clientIds = new Set([...expected.clocks.keys(), ...expected.deleted.keys()])
  const clients: ClientLoss[] = []
  let missingInserts = 0
  let missingDeletes = 0
  for (const client of [...clientIds].sort((a, b) => a - b)) {
    const loss: ClientLoss = {
      client,
      expectedClock: expected.clocks.get(client) ?? 0,
      restoredClock: restored.clocks.get(client) ?? 0,
      expectedDeleted: expected.deleted.get(client) ?? 0,
      restoredDeleted: restored.deleted.get(client) ?? 0,
    }
    const inserts = Math.max(0, loss.expectedClock - loss.restoredClock)
    const deletes = Math.max(0, loss.expectedDeleted - loss.restoredDeleted)
    if (inserts > 0 || deletes > 0) {
      clients.push(loss)
      missingInserts += inserts
      missingDeletes += deletes
    }
  }
  return { missingInserts, missingDeletes, clients }
}
