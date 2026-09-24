export function buildDaySections({ messages }) {
  const items = [...messages]
    .filter((message) =>
      ["photo", "video"].includes(
        String(message?.message_type || "").toLowerCase()
      )
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at))

  return [
    {
      id: "media",
      title: "Photos and videos",
      items,
      count: items.length
    }
  ]
}
