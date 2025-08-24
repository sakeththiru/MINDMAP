import React, { useEffect, useMemo, useState } from 'react'
import MindMap from './MindMap.jsx'
import { assignIds, stripIds, findNode, mapTree, clone, normalize, DEFAULT_TREE } from './utils.js'

export default function App() {
  const [tree, setTree] = useState(() => {
    const saved = localStorage.getItem('mindmap.tree')
    return saved ? JSON.parse(saved) : DEFAULT_TREE
  })
  const [selectedId, setSelectedId] = useState(() => {
    const saved = localStorage.getItem('mindmap.selected')
    return saved || (tree?.id)
  })
  const [editSignal, setEditSignal] = useState(null) // {id, tick}
  const [lockCanvas, setLockCanvas] = useState(false)

  // Undo/Redo state
  const [undoStack, setUndoStack] = useState([])   // array of snapshots (string)
  const [redoStack, setRedoStack] = useState([])
  const [preDragSnapshot, setPreDragSnapshot] = useState(null) // snapshot before a drag begins

  // AUTOSAVE
  useEffect(() => {
    localStorage.setItem('mindmap.tree', JSON.stringify(tree))
  }, [tree])
  useEffect(() => {
    if (selectedId) localStorage.setItem('mindmap.selected', selectedId)
  }, [selectedId])

  // Ensure selected exists
  useEffect(() => {
    if (!findNode(tree, selectedId)) setSelectedId(tree.id)
  }, [tree, selectedId])

  const selected = useMemo(() => findNode(tree, selectedId) || tree, [tree, selectedId])

  // --- History helpers ---
  const snapshot = () => JSON.stringify({ tree, selectedId })
  const restore = (snap) => {
    try {
      const obj = JSON.parse(snap)
      setTree(obj.tree)
      setSelectedId(obj.selectedId)
    } catch {}
  }
  const pushUndo = () => {
    setUndoStack(prev => {
      const next = [...prev, snapshot()]
      return next.length > 10 ? next.slice(next.length - 10) : next
    })
    setRedoStack([]) // clear redo on new action
  }

  // --- Tree operations ---
  const addChild = (id) => {
    if (!preDragSnapshot) pushUndo()
    const newTree = mapTree(clone(tree), (n) => {
      if (n.id === id) {
        const child = assignIds({ name: 'New Node', children: [] })
        const children = (n.children || []).concat(child)
        return { ...n, children }
      }
      return n
    })
    setTree(newTree)
    setSelectedId(id)
  }

  const deleteNode = (id) => {
    if (tree.id === id) return
    if (!preDragSnapshot) pushUndo()
    const newTree = (function remove(n) {
      const children = (n.children || []).filter(c => c.id !== id).map(remove)
      return { ...n, children }
    })(clone(tree))
    setTree(newTree)
    setSelectedId(newTree.id)
  }

  const renameNode = (id, name) => {
    if (!preDragSnapshot) pushUndo()
    const newTree = mapTree(clone(tree), (n) => (n.id === id ? { ...n, name: (name || 'Node').trim() || 'Node' } : n))
    setTree(newTree)
  }

  const toggleCollapse = (id) => {
    if (!preDragSnapshot) pushUndo()
    const newTree = mapTree(clone(tree), (n) => (n.id === id ? { ...n, collapsed: !n.collapsed } : n))
    setTree(newTree)
  }

  // Reparent: move 'childId' under 'newParentId'
  const reparent = (childId, newParentId) => {
    if (childId === tree.id) return // root can't move
    if (childId === newParentId) return
    // prevent making a node a child of its own descendant
    const childNode = findNode(tree, childId)
    const isDesc = (n, id) => {
      if (n.id === id) return true
      return (n.children || []).some(c => isDesc(c, id))
    }
    if (isDesc(childNode, newParentId)) return
    if (!preDragSnapshot) pushUndo()
    // remove from current parent and add to new parent
    let moved = null
    const without = (function remove(n) {
      const kids = (n.children || []).filter(c => {
        if (c.id === childId) { moved = c; return false }
        return true
      }).map(remove)
      return { ...n, children: kids }
    })(clone(tree))
    if (!moved) return
    const reattached = mapTree(without, (n) => {
      if (n.id === newParentId) {
        const children = (n.children || []).concat(moved)
        return { ...n, children }
      }
      return n
    })
    setTree(reattached)
    setSelectedId(childId)
  }

  // Move node (manual position) - live updates only
  const moveNode = (id, x, y) => {
    if (!preDragSnapshot) setPreDragSnapshot(snapshot())
    const newTree = mapTree(clone(tree), (n) => (n.id === id ? { ...n, px: x, py: y } : n))
    setTree(newTree)
  }
  // Commit one history entry at drag end
  const moveCommit = () => {
    if (preDragSnapshot) {
      setUndoStack(prev => {
        const next = [...prev, preDragSnapshot]
        return next.length > 10 ? next.slice(next.length - 10) : next
      })
      setRedoStack([])
      setPreDragSnapshot(null)
    }
  }

  // Undo/Redo functions
  const undo = () => {
    if (undoStack.length === 0) return
    const last = undoStack[undoStack.length - 1]
    setUndoStack(undoStack.slice(0, -1))
    setRedoStack(prev => [...prev, snapshot()])
    restore(last)
  }
  const redo = () => {
    if (redoStack.length === 0) return
    const last = redoStack[redoStack.length - 1]
    setRedoStack(redoStack.slice(0, -1))
    setUndoStack(prev => [...prev, snapshot()])
    restore(last)
  }

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        addChild(selectedId || tree.id)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if ((selectedId || tree.id) !== tree.id) {
          e.preventDefault()
          deleteNode(selectedId)
        }
      } else if (e.key === 'F2') {
        e.preventDefault()
        setEditSignal({ id: selectedId || tree.id, tick: Date.now() })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, tree.id])

  // Global shortcuts: Undo/Redo
  useEffect(() => {
    const onGlobalKey = (e) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onGlobalKey)
    return () => window.removeEventListener('keydown', onGlobalKey)
  }, [undoStack, redoStack, tree, selectedId])

  const exportJSON = () => {
    // include manual positions, but strip IDs
    const strip = (n) => ({
      name: n.name,
      ...(n.px !== undefined && n.py !== undefined ? { px: n.px, py: n.py } : {}),
      children: (n.children || []).map(strip)
    })
    const data = strip(tree)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'mindmap.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const importJSON = (file) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result)
        // keep px/py if provided by user; assign ids
        const withIds = (function addIds(n) {
          const base = assignIds({ name: n.name, children: n.children || [] })
          if (n.px !== undefined && n.py !== undefined) {
            base.px = n.px; base.py = n.py
          }
          base.children = (n.children || []).map(addIds)
          return base
        })(json)
        setTree(withIds)
        setSelectedId(withIds.id)
        setUndoStack([]); setRedoStack([])
      } catch (e) {
        alert('Invalid JSON')
      }
    }
    reader.readAsText(file)
  }

  // Export PNG from current SVG
  const exportPNG = () => {
    const svg = document.querySelector('svg')
    const serializer = new XMLSerializer()
    const source = serializer.serializeToString(svg)
    const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)

    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const rect = svg.getBoundingClientRect()
      canvas.width = rect.width * devicePixelRatio
      canvas.height = rect.height * devicePixelRatio
      const ctx = canvas.getContext('2d')
      ctx.scale(devicePixelRatio, devicePixelRatio)
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg') || '#0b0f14'
      ctx.fillRect(0, 0, rect.width, rect.height)
      ctx.drawImage(img, 0, 0, rect.width, rect.height)
      URL.revokeObjectURL(url)

      canvas.toBlob((blob) => {
        const dl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = dl
        a.download = 'mindmap.png'
        a.click()
        URL.revokeObjectURL(dl)
      }, 'image/png')
    }
    img.src = url
  }

  const saveLocal = () => localStorage.setItem('mindmap.tree', JSON.stringify(tree))
  const loadLocal = () => {
    const saved = localStorage.getItem('mindmap.tree')
    if (saved) setTree(JSON.parse(saved))
  }
  const reset = () => { setTree(assignIds({ name: 'Central Topic', children: [] })); setSelectedId(null); setUndoStack([]); setRedoStack([]) }

  return (
    <div className="app">
      <div className="toolbar">
        <div className="title">🧠 Mind Map Editor</div>
        <label style={{display:'flex',alignItems:'center',gap:6}}>
          <input type="checkbox" checked={lockCanvas} onChange={e=>setLockCanvas(e.target.checked)} /> Lock canvas
        </label>

        <button className="primary" onClick={() => addChild(selected?.id || tree.id)}>+ Child (Enter)</button>
        <button onClick={() => setEditSignal({ id: selected?.id || tree.id, tick: Date.now() })}>Rename (F2)</button>
        <button onClick={() => toggleCollapse(selected?.id || tree.id)}>Toggle</button>
        <button className="danger" onClick={() => deleteNode(selected?.id || tree.id)} disabled={(selected?.id || tree.id) === tree.id}>Delete (Del)</button>

        <button onClick={undo} disabled={!undoStack.length}>Undo (Ctrl/Cmd+Z)</button>
        <button onClick={redo} disabled={!redoStack.length}>Redo (Ctrl/Cmd+Y or Shift+Z)</button>

        <div style={{ flex: 1 }} />
        <button onClick={saveLocal}>Save</button>
        <button onClick={loadLocal}>Load</button>
        <button onClick={exportJSON}>Export JSON</button>
        <label>
          Import JSON
          <input type="file" accept="application/json" onChange={(e) => e.target.files[0] && importJSON(e.target.files[0])} />
        </label>
        <button className="green" onClick={exportPNG}>Export PNG</button>
        <button onClick={reset}>New</button>
      </div>

      <MindMap
        data={tree}
        onSelect={setSelectedId}
        onAddChild={addChild}
        onDelete={deleteNode}
        onRename={renameNode}
        onToggleCollapse={toggleCollapse}
        onReparent={reparent}
        onMoveNode={moveNode}
        onMoveCommit={moveCommit}
        lockCanvas={lockCanvas}
        selectedId={selectedId}
        editSignal={editSignal}
      />
    </div>
  )
}
