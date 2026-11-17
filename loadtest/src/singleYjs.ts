import * as Y from 'yjs'
import { createTable, getColumns, getTables } from './model'

// yjs가 한 벌만 로드됐는지 확인, 두 벌이면 오류를 던짐
// loadtest와 client가 같은 Yjs instance를 사용하는지 확인
export function assertSingleYjs(): void {
  const doc = new Y.Doc()
  try {
    // model 쪽 yjs로 만든 Y.Map을 이 파일 쪽 yjs의 Y.Doc에 넣어 봄
    const id = createTable(doc, { logicalName: '확인', physicalName: 'check', position: { x: 0, y: 0 } })
    const table = getTables(doc).get(id)
    if (table instanceof Y.Map && getColumns(table) instanceof Y.Map) {
      return
    }
  } catch {
    // 두 벌이면 yjs가 'Unexpected content type'을 던짐, 아래에서 원인을 알려 주는 오류로 바꿈
  }
  throw new Error(
    'yjs가 두 벌 로드되었습니다. client/에서 npm install을 한 뒤 loadtest/에서 npm install을 다시 실행하세요.',
  )
}
