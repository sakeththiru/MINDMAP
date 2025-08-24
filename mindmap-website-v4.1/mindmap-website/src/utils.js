import { nanoid } from 'nanoid'

export function assignIds(node) {
  const id = node.id || nanoid(8)
  const named = node.name ?? 'Node'
  const children = (node.children || []).map(assignIds)
  return { ...node, id, name: named, children }
}

export function stripIds(node) {
  return {
    name: node.name,
    children: (node.children || []).map(stripIds)
  }
}

export function findNode(root, id) {
  if (!root) return null
  if (root.id === id) return root
  for (const c of root.children || []) {
    const found = findNode(c, id)
    if (found) return found
  }
  return null
}

export function mapTree(node, fn) {
  const next = fn(node)
  return {
    ...next,
    children: (next.children || []).map(c => mapTree(c, fn))
  }
}

export function clone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

// Convert uploaded JSON (name/children) to internal format with ids.
export function normalize(json) {
  const withIds = assignIds(json)
  return withIds
}

// Example default tree
export const DEFAULT_TREE = assignIds({
  name: 'Central Topic',
  children: [
    { name: 'Idea A', children: [{ name: 'Detail A1' }, { name: 'Detail A2' }] },
    { name: 'Idea B', children: [{ name: 'Detail B1' }] },
    { name: 'Idea C' }
  ]
})
