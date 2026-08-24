export function boundedSemanticScale(pressureScale) {
  const pressure = Number.isFinite(pressureScale)
    ? Math.max(1, pressureScale)
    : 1
  return 1 + ((pressure - 1) / (2 * pressure))
}
