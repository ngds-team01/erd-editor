import { Background, BackgroundVariant, ReactFlow, useNodesState } from '@xyflow/react'
import type { NodeTypes, SnapGrid } from '@xyflow/react'
import type { TableData } from '../model'
import { TableNode } from './TableNode'
import type { TableNodeType } from './TableNode'

// key: node의 type, value: node Component(TableNode)
const nodeTypes: NodeTypes = { table: TableNode }
//가로, 세로 간격
const SNAP_GRID: SnapGrid = [10, 10]
//처음 화면 배율 : 1, 캔버스 좌표 (0, 0) = 화면 (40, 40)
const DEFAULT_VIEWPORT = { x: 40, y: 40, zoom: 1 }

//Canvas 작업을 위해 TableData가 필요
type CanvasProps = {
  tables: TableData[]
}

// TableData를 React Flow - Node 형식으로 변환
function toNode(table: TableData): TableNodeType {
  return {
    id: table.id,
    type: 'table',
    position: table.position,
    data: { table },
  }
}

// tables를 node 상태로 만들어 캔버스에 표시, 드래그·선택 변경은 onNodesChange
// useNodeState ≒ useState
// 최소 20%, 최대 250% 줌 적용 가능
export function Canvas({ tables }: CanvasProps) {
  const [nodes, , onNodesChange] = useNodesState(tables.map(toNode))

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        snapToGrid
        snapGrid={SNAP_GRID}
        minZoom={0.2}
        maxZoom={2.5}
        defaultViewport={DEFAULT_VIEWPORT}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d7dde8" />
      </ReactFlow>
    </div>
  )
}
