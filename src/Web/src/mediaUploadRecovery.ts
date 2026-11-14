const prefix = 'fsus.private-media.resume.v1:'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

export async function mediaRecovery(file: File, digest: string, current: string, key: string, signal: AbortSignal) {
  const manifest = new TextEncoder().encode(JSON.stringify([current, file.name, file.type, file.size, digest]))
  const hash = await crypto.subtle.digest('SHA-256', manifest)
  signal.throwIfAborted()
  const suffix = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  const coordinate = prefix + suffix
  try {
    const found = sessionStorage.getItem(coordinate)
    if (found && uuid.test(found)) return { coordinate, key: found }
    // Keep the same-tab recovery journal bounded. Entries contain only opaque command keys.
    const owned = Object.keys(sessionStorage).filter(entry => entry.startsWith(prefix))
    if (owned.length >= 16) sessionStorage.removeItem(owned[0])
    sessionStorage.setItem(coordinate, key)
  } catch { /* A storage-disabled tab can still retry with the same in-memory file and key. */ }
  return { coordinate, key }
}

export function forgetMediaRecovery(coordinate: string) {
  try { sessionStorage.removeItem(coordinate) }
  catch { /* The in-memory upload has already finished. */ }
}
