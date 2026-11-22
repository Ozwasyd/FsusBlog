export function bindTestSession(controller: { bindSession(signal: AbortSignal): void }): AbortController {
  const session = new AbortController()
  controller.bindSession(session.signal)
  return session
}
