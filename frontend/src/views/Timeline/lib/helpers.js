export function getTimelineItemKey(item) {
  return `msg-${item.id}`
}

export function findMessageByAttachmentId(
  attachmentId,
  messages,
  attachmentsByMessage
) {
  return messages.find((msg) =>
    (attachmentsByMessage[msg.id] || []).some((att) => att.id === attachmentId)
  )
}
