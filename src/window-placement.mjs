/** Center on the parent's actual bounds, clamped to its display's usable area. All values are Electron DIPs. */
export function centeredChildPosition(parent, child, workArea) {
  const rectangle = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))
    && value.width > 0 && value.height > 0
  if (!rectangle(parent) || !rectangle(child)) return undefined
  let x = parent.x + (parent.width - child.width) / 2
  let y = parent.y + (parent.height - child.height) / 2
  if (rectangle(workArea)) {
    x = Math.max(workArea.x, Math.min(x, workArea.x + Math.max(0, workArea.width - child.width)))
    y = Math.max(workArea.y, Math.min(y, workArea.y + Math.max(0, workArea.height - child.height)))
  }
  return [Math.round(x), Math.round(y)]
}

/** Position only a hidden shell window; never move an already-visible user-dragged window. */
export function centerHiddenChild(window, parent, screen) {
  if (!window || window.isDestroyed() || window.isVisible?.() === true || !parent || parent.isDestroyed()) return false
  if (!window.getBounds || !window.setPosition || !parent.getBounds) return false
  try {
    const bounds = parent.getBounds()
    const position = centeredChildPosition(bounds, window.getBounds(), screen?.getDisplayMatching(bounds)?.workArea)
    if (!position) return false
    window.setPosition(...position, false)
    return true
  } catch {
    // Closing parents or disconnected displays must not prevent the dialog opening.
    return false
  }
}
