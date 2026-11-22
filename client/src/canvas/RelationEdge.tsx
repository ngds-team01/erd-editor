import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from '@xyflow/react'
import type { Edge, EdgeProps, InternalNode } from '@xyflow/react'
import type { RelationData } from '../model'
import type { Peer } from '../sync/presence'
import { manyMarker, oneMarker, relationGeometry } from './relationGeometry'
import type { Point, Rect } from './relationGeometry'

// React Flow Edge에 RelationData의 type 적용, source = 부모 table id, target = 자식 table id
// editors: 이 관계를 편집 중인 다른 사용자 (Canvas가 화면에 넘길 때만 붙임, 없으면 undefined)
export type RelationEdgeType = Edge<{ relation: RelationData; editors?: Peer[] }, 'relation'>

// 선을 클릭하기 쉽도록 보이지 않는 굵은 선을 함께 그림 (px)
const INTERACTION_WIDTH = 14

// React Flow가 측정한 node의 캔버스 좌표 사각형, 아직 크기를 재지 않았으면 null
function nodeRect(node: InternalNode | undefined): Rect | null {
  const width = node?.measured.width
  const height = node?.measured.height
  if (!node || !width || !height) {
    return null
  }
  const { x, y } = node.internals.positionAbsolute
  return { x, y, width, height }
}

// 이 관계를 편집 중인 다른 사용자의 이름표, 관계선 가운데(label)에 사용자 색으로 표시
// EdgeLabelRenderer: edge는 SVG 안에 그려져 HTML 이름표를 넣을 수 없으므로, React Flow가 캔버스 위에 둔 HTML 층에 그림
// 이 층은 캔버스 이동·확대를 따라 움직이므로 캔버스 좌표를 그대로 쓰고, translate(-50%, -50%)로 이름표 가운데를 그 점에 맞춤
// key: 같은 사람이 탭 두 개로 같은 관계를 열 수 있으므로 user.id가 아닌 접속 번호(clientId) 사용
function RelationEditorBadges({ editors, at }: { editors: Peer[]; at: Point }) {
  return (
    <EdgeLabelRenderer>
      <div
        className="rel-editors"
        style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
        aria-label="편집 중인 사용자"
      >
        {editors.map(({ clientId, user }) => (
          <span key={clientId} className="t-editor" style={{ background: user.color }}>
            {user.name}
          </span>
        ))}
      </div>
    </EdgeLabelRenderer>
  )
}

// 부모·자식 table node의 위치와 크기를 직접 읽어 가까운 변끼리 연결
// Handle 위치는 쓰지 않음 (Handle은 React Flow가 edge를 그리기 위해 요구하는 형식상 연결점)
function RelationEdgeView({ id, source, target, data }: EdgeProps<RelationEdgeType>) {
  // node가 움직이거나 크기가 바뀌면 이 edge도 다시 그려짐
  const parentNode = useInternalNode(source)
  const childNode = useInternalNode(target)
  const parentRect = nodeRect(parentNode)
  const childRect = nodeRect(childNode)
  if (!data || !parentRect || !childRect) {
    return null
  }

  // editors = []: Canvas가 붙이지 않았으면(편집 중인 사람 없음) 빈 배열로 취급
  const { relation, editors = [] } = data
  // 강조선 색은 먼저 접속한 편집자의 색 (table 테두리와 같은 기준)
  const editorColor = editors[0]?.user.color
  const geometry = relationGeometry(parentRect, childRect, source === target)
  // 부모 쪽은 항상 1, 자식 쪽은 1:1이면 1, 1:N이면 까마귀 발
  const markers =
    oneMarker(geometry.parent) +
    ' ' +
    (relation.cardinality === '1:N' ? manyMarker(geometry.child) : oneMarker(geometry.child))

  return (
    <>
      {/* 편집 중 강조선: 관계선보다 먼저 그려 아래에 깔리게 함, 클릭은 위의 관계선이 받음 */}
      {editorColor && <path className="rel-editing" d={geometry.path} style={{ stroke: editorColor }} />}
      {/* 식별 관계는 실선, 비식별 관계는 점선 (2.5) */}
      <BaseEdge
        id={id}
        path={geometry.path}
        className={relation.identifying ? 'rel-line' : 'rel-line dashed'}
        interactionWidth={INTERACTION_WIDTH}
      />
      <path className="rel-mark" d={markers} />
      {editors.length > 0 && <RelationEditorBadges editors={editors} at={geometry.label} />}
    </>
  )
}

// 받은 props가 이전과 같으면 이전 결과 reuse
export const RelationEdge = memo(RelationEdgeView)
