export function normalizeRoomIdentity(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function sameRoomIdentity(left: unknown, right: unknown) {
  const normalizedLeft = normalizeRoomIdentity(left);
  return normalizedLeft !== "" && normalizedLeft === normalizeRoomIdentity(right);
}
