/** Assembly tree panel with per-part visibility checkboxes. */
import type { TreeNodeData } from './model'

export function renderTree(
  container: HTMLElement,
  tree: TreeNodeData,
  onToggle: (partId: number, visible: boolean) => void,
): void {
  container.innerHTML = ''
  const rootList = document.createElement('ul')
  rootList.className = 'tree-root'
  // skip the artificial "root" node; render its children
  for (const child of tree.children ?? []) {
    rootList.appendChild(renderNode(child, onToggle))
  }
  container.appendChild(rootList)
}

function renderNode(
  node: TreeNodeData,
  onToggle: (partId: number, visible: boolean) => void,
): HTMLLIElement {
  const li = document.createElement('li')
  const label = document.createElement('label')

  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = true

  const name = document.createElement('span')
  name.textContent = node.name
  label.append(checkbox, name)
  li.appendChild(label)

  const childBoxes: HTMLInputElement[] = []
  if (node.children?.length) {
    const ul = document.createElement('ul')
    for (const child of node.children) {
      const childLi = renderNode(child, onToggle)
      childBoxes.push(...Array.from(childLi.querySelectorAll('input')))
      ul.appendChild(childLi)
    }
    li.appendChild(ul)
  }

  checkbox.addEventListener('change', () => {
    if (node.partId !== undefined) onToggle(node.partId, checkbox.checked)
    // group node: cascade to all descendants
    for (const cb of childBoxes) {
      if (cb.checked !== checkbox.checked) {
        cb.checked = checkbox.checked
        cb.dispatchEvent(new Event('change'))
      }
    }
  })

  return li
}
