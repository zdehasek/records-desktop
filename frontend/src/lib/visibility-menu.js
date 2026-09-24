export function buildVisibilityMenuItems({
  visibility = "visible",
  onVisible,
  onMoveToFolder,
  middleItems = [],
  onSelect,
  onDelete
}) {
  const items = [
    {
      label: "Visible",
      active: visibility === "visible",
      action: onVisible
    },
    {
      label: "Move to NSFW...",
      action: onMoveToFolder
    }
  ]

  if (middleItems.length > 0) {
    items.push({ separator: true }, ...middleItems)
  }

  const tailItems = []
  if (onSelect) {
    tailItems.push({
      label: "Select",
      action: onSelect
    })
  }
  if (onDelete) {
    if (tailItems.length > 0) tailItems.push({ separator: true })
    tailItems.push({
      label: "Move to Trash",
      danger: true,
      action: onDelete
    })
  }

  if (tailItems.length > 0) {
    items.push({ separator: true }, ...tailItems)
  }

  return items
}
