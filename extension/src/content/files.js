export function decodeFileEntries(entries) {
  return entries.map((entry) => new File(
    [Uint8Array.from(atob(entry.data), (char) => char.charCodeAt(0))],
    entry.name,
    { type: entry.type || 'application/octet-stream' }
  ));
}
