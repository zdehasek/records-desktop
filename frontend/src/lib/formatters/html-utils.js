export const stripMarkdown = (markdown) => {
  if (!markdown) return ""
  return markdown
    .replace(/#{1,6}\s/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, (match) =>
      match.replace(/^`{1,3}/, "").replace(/`{1,3}$/, "")
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-+*]\s/gm, "")
    .replace(/^\s*\d+\.\s/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^-{3,}$/gm, "")
    .trim()
}
