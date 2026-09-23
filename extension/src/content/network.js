export function summarizeResources(entries, limit = 0) {
  const summary = entries.map(entry => ({
    url: entry.name,
    type: entry.initiatorType ?? 'other',
    durationMs: Math.round(entry.duration ?? 0),
    size: entry.transferSize ?? 0,
    status: entry.responseStatus ?? 0
  }));
  return limit > 0 ? summary.slice(-limit) : summary;
}
