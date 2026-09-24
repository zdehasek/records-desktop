export const STICKY_NOTE_COLORS = [
  { key: "white", label: "White" },
  { key: "butter", label: "Butter" },
  { key: "blush", label: "Blush" },
  { key: "mint", label: "Mint" },
  { key: "sky", label: "Sky" },
  { key: "lavender", label: "Lavender" }
]

const STICKY_NOTE_COLOR_KEYS = new Set(
  STICKY_NOTE_COLORS.map((color) => color.key)
)

export function getStickyNoteColor(metadata) {
  const color = metadata?.note_style?.color
  return STICKY_NOTE_COLOR_KEYS.has(color) ? color : "white"
}
