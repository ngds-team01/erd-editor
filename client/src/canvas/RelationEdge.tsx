import { memo } from 'react'
import { BaseEdge, useInternalNode } from '@xyflow/react'
import type { Edge, EdgeProps, InternalNode } from '@xyflow/react'
import type { RelationData } from '../model'
import { manyMarker, oneMarker, relationGeometry } from './relationGeometry'
import type { Rect } from './relationGeometry'

// React Flow Edge에 RelationData의 type 적용, source = 부모 table id, target = 자식 table id
export type RelationEdgeType = Edge<{ relation: RelationData }, 'relation'>

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

  const { relation } = data
  const geometry = relationGeometry(parentRect, childRect, source === target)
  // 부모 쪽은 항상 1, 자식 쪽은 1:1이면 1, 1:N이면 까마귀 발
  const markers =
    oneMarker(geometry.parent) +
    ' ' +
    (relation.cardinality === '1:N' ? manyMarker(geometry.child) : oneMarker(geometry.child))

  return (
    <>
      {/* 식별 관계는 실선, 비식별 관계는 점선 (2.5) */}
      <BaseEdge
        id={id}
        path={geometry.path}
        className={relation.identifying ? 'rel-line' : 'rel-line dashed'}
        interactionWidth={INTERACTION_WIDTH}
      />
      <path className="rel-mark" d={markers} />
    </>
  )
}

// 받은 props가 이전과 같으면 이전 결과 reuse
export const RelationEdge = memo(RelationEdgeView)
