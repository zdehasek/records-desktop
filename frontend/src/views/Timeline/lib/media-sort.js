function parsePhotoTime(value) {
  if (!value) return null

  const exifMatch = value.match(
    /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/
  )
  if (exifMatch) {
    const [, year, month, day, hour, minute, second = "00"] = exifMatch
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ).getTime()
  }

  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

export function getAttachmentPhotoTime(att) {
  return (
    parsePhotoTime(att?.exif_data?.DateTimeOriginal) ||
    parsePhotoTime(att?.exif_data?.CreateDate) ||
    parsePhotoTime(att?.exif_data?.ModifyDate) ||
    parsePhotoTime(att?.created_at) ||
    0
  )
}

export function getAttachmentPhotoDate(att) {
  const timestamp = getAttachmentPhotoTime(att)
  return timestamp ? new Date(timestamp) : null
}

export function sortAttachmentsOldestFirst(attachments) {
  return [...(attachments || [])].sort(
    (a, b) => getAttachmentPhotoTime(a) - getAttachmentPhotoTime(b)
  )
}
