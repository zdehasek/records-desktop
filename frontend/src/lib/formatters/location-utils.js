export function formatCoords(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return ""
  if (latitude < -90 || latitude > 90) return ""
  if (longitude < -180 || longitude > 180) return ""
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
}
