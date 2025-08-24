import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'

export default function MindMap({
  data,
  onSelect,
  onAddChild,
  onDelete,
  onRename,
  onToggleCollapse,
  onReparent,
  onMoveNode, // (id, x, y) -> persist manual position
  onMoveCommit, // () -> commit a single history step
  lockCanvas, // boolean to disable pan/zoom & dragging
  selectedId,
  editSignal // { id, tick }
}) {
  const svgRef = useRef(null)
  const gRef = useRef(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [zoomTransform, setZoomTransform] = useState(d3.zoomIdentity)
  const [editing, setEditing] = useState(null)
  const [dragging, setDragging] = useState(null) // { id, mode: 'move'|'reparent', dx, dy }
  const [hoverTargetId, setHoverTargetId] = useState(null)

  // Resize observer
  useEffect(() => {
    const el = svgRef.current?.parentElement
    const resize = () => {
      const rect = el.getBoundingClientRect()
      setSize({ w: rect.width, h: rect.height })
    }
    resize()
    const obs = new ResizeObserver(resize)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Zoom + pan
  useEffect(() => {
    const svg = d3.select(svgRef.current)
    svg.on('.zoom', null)
    if (lockCanvas) return
    const zoom = d3.zoom().scaleExtent([0.4, 2.5]).on('zoom', (event) => {
      d3.select(gRef.current).attr('transform', event.transform)
      setZoomTransform(event.transform)
    })
    const { w, h } = size
    const init = d3.zoomIdentity.translate(w / 2, h / 2).scale(1)
    svg.call(zoom)
    svg.call(zoom.transform, init)
  }, [size.w, size.h, lockCanvas])

  // Build hierarchy with color by first-level branch
  const { nodes, links, colorById, byId } = useMemo(() => {
    const root = d3.hierarchy(data, d => (d.collapsed ? [] : (d.children || [])))
    const radius = Math.max(260, Math.min(size.w, size.h) * 0.42)
    const tree = d3.tree().size([2 * Math.PI, radius]).separation((a, b) => (a.parent === b.parent ? 1 : 2))
    const laid = tree(root)

    // branch index for coloring
    const branchIndex = new Map()
    laid.children?.forEach((c, i) => { c.each(d => branchIndex.set(d.data.id, i)) })
    branchIndex.set(laid.data.id, -1)

    const scheme = d3.schemeTableau10
    const colorById = (id) => {
      const idx = branchIndex.get(id)
      if (idx === undefined || idx < 0) return '#60a5fa'
      return scheme[idx % scheme.length]
    }

    // compute positioned nodes (manual override via px/py if present)
    const nodes = laid.descendants().map(d => {
      const autoX = d.y * Math.cos(d.x - Math.PI / 2)
      const autoY = d.y * Math.sin(d.x - Math.PI / 2)
      const px = (d.data.px ?? autoX)
      const py = (d.data.py ?? autoY)
      return {
        ...d.data,
        depth: d.depth,
        x: px, y: py,
        autoX, autoY,
        angle: d.x, r: d.y,
        parentId: d.parent?.data?.id || null,
        hasChildren: (d.children && d.children.length > 0)
      }
    })

    const idMap = new Map(nodes.map(n => [n.id, n]))

    // curved links (cubic Bezier) using current positions
    const links = laid.links().map(l => {
      const s = idMap.get(l.source.data.id)
      const t = idMap.get(l.target.data.id)
      const dx = t.x - s.x, dy = t.y - s.y
      const dist = Math.hypot(dx, dy)
      const nx = dx / (dist || 1), ny = dy / (dist || 1)
      const ox = -ny, oy = nx  // normal
      const bend = Math.min(80, Math.max(20, dist * 0.2))
      const c1x = s.x + dx * 0.33 + ox * bend * 0.2
      const c1y = s.y + dy * 0.33 + oy * bend * 0.2
      const c2x = s.x + dx * 0.66 - ox * bend * 0.2
      const c2y = s.y + dy * 0.66 - oy * bend * 0.2
      const path = `M ${s.x},${s.y} C ${c1x},${c1y} ${c2x},${c2y} ${t.x},${t.y}`
      const depth = (l.target.depth ?? 1)
      const width = Math.max(1.5, 4 - depth * 0.4)
      const color = colorById(t.id)
      return { path, depth, color, width }
    })

    return { nodes, links, colorById, byId: idMap }
  }, [data, size.w, size.h])

  // external rename trigger
  useEffect(() => {
    if (!editSignal) return
    const node = nodes.find(n => n.id === editSignal.id)
    if (node) setEditing({ id: node.id, name: node.name })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSignal?.tick])

  const toScreen = (x, y) => {
    const t = zoomTransform
    return [x * t.k + t.x, y * t.k + t.y]
  }
  const toGraph = (sx, sy) => {
    const t = zoomTransform.invert([sx, sy])
    return t
  }

  // Dragging
  const handleMouseDownNode = (e, n) => {
    if (lockCanvas) return;
    e.preventDefault();
    e.stopPropagation()
    const mode = e.shiftKey ? 'reparent' : 'move'
    const [gx, gy] = toGraph(e.clientX, e.clientY)
    setDragging({ id: n.id, mode, dx: n.x - gx, dy: n.y - gy })
    onSelect?.(n.id)
  }

  const handleMouseMove = (e) => {
    if (lockCanvas || !dragging) return;
    const [gx, gy] = toGraph(e.clientX, e.clientY);

    // Allow switching mode during drag based on Shift key
    const mode = e.shiftKey ? 'reparent' : 'move';
    if (dragging.mode !== mode) {
      setDragging(prev => ({ ...prev, mode }));
    }

    if (mode === 'move') {
      const nx = gx + dragging.dx;
      const ny = gy + dragging.dy;
      onMoveNode?.(dragging.id, nx, ny);
      setHoverTargetId(null);
    } else {
      // Reparent hover detection with zoom-aware radius
      const radius = 60 / (zoomTransform.k || 1); // 60px in screen space
      let nearest = null, minD = Infinity;
      for (const nd of nodes) {
        if (nd.id === dragging.id) continue;
        const dx = nd.x - gx, dy = nd.y - gy;
        const d2 = dx*dx + dy*dy;
        if (d2 < minD) { minD = d2; nearest = nd; }
      }
      if (nearest && Math.sqrt(minD) < radius) setHoverTargetId(nearest.id);
      else setHoverTargetId(null);
    }
  }

  const handleMouseUp = () => {
    if (lockCanvas) return;
    if (lockCanvas || !dragging) return
    if (dragging.mode === 'reparent' && hoverTargetId && hoverTargetId !== dragging.id) {
      onReparent?.(dragging.id, hoverTargetId)
    }
    if (dragging?.mode === 'move') { onMoveCommit?.() }
    setDragging(null)
    setHoverTargetId(null)
  }

  const startEdit = (n) => {
    setEditing({ id: n.id, name: n.name })
    onSelect?.(n.id)
  }

  const selectedNode = nodes.find(n => n.id === selectedId)
  const selectedScreen = selectedNode ? toScreen(selectedNode.x, selectedNode.y) : null

  return (
    <div className="container">
      <svg style={{ cursor: dragging?.mode === "reparent" ? "copy" : "default" }}
        ref={svgRef}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <g ref={gRef}>
          <g className="links">
            {links.map((l, i) => (
              <path key={i} className="link" d={l.path} style={{ stroke: l.color, strokeWidth: l.width }} />
            ))}
          </g>

          <g className="nodes">
            {nodes.map((n) => (
              <g
                key={n.id}
                className={`node ${n.id === selectedId ? 'selected' : ''} ${hoverTargetId === n.id ? 'drop-target' : ''} ${dragging?.id === n.id ? 'dragging' : ''}`}
                transform={`translate(${n.x},${n.y})`}
                onMouseDown={(e) => handleMouseDownNode(e, n)}
                onClick={(e) => { e.stopPropagation(); onSelect?.(n.id) }}
                onDoubleClick={(e) => { e.stopPropagation(); startEdit(n) }}
              >
                <circle r={20} />
                {n.hasChildren && (
                  <g onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(n.id) }}>
                    <circle className="badge" cx={-26} cy={-26} r={10} />
                    <text x={-26} y={-22.5} textAnchor="middle" fontSize="12" pointerEvents="none">−</text>
                  </g>
                )}
                <text x={28} y={6}>{n.name}</text>
              </g>
            ))}
          </g>
        </g>
      </svg>

      {/* Inline editor */}
      {editing && (() => {
        const node = nodes.find(nd => nd.id === editing.id)
        if (!node) return null
        const [sx, sy] = toScreen(node.x + 28, node.y - 16)
        return (
          <div
            className="floating-panel"
            style={{ left: sx, top: sy }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              className="inline-input"
              autoFocus
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              onBlur={() => { onRename?.(editing.id, editing.name); setEditing(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onRename?.(editing.id, editing.name); setEditing(null) }
                if (e.key === 'Escape') setEditing(null)
              }}
              placeholder="Node text"
            />
          </div>
        )
      })()}

      {/* Node action bubble for selected */}
      {selectedNode && selectedScreen && (
        <div
          className="floating-panel"
          style={{ left: selectedScreen[0], top: selectedScreen[1] }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button onClick={() => onAddChild?.(selectedId)}>+ Child</button>
          {selectedNode.depth > 0 && (
            <button className="danger" onClick={() => onDelete?.(selectedId)}>Delete</button>
          )}
          <button onClick={() => onToggleCollapse?.(selectedId)}>Toggle</button>
        </div>
      )}

      <div className="legend">
        Drag to move • Hold <b>Shift</b> (even mid-drag) to reparent • Double‑click to rename • Enter: add child • Del: delete • F2: rename • Scroll to zoom • Drag canvas to pan
      </div>
    </div>
  )
}
