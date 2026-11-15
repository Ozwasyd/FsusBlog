export function moveLibraryFocus(event: KeyboardEvent, results: HTMLElement | undefined) {
  if (!(event.target instanceof HTMLButtonElement)) return
  const buttons = [...(results?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
  const index = buttons.indexOf(event.target)
  const target = event.key === 'ArrowDown' ? buttons[index + 1] : event.key === 'ArrowUp' ? buttons[index - 1]
    : event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1) : undefined
  if (!target) return
  event.preventDefault()
  target.focus()
}
