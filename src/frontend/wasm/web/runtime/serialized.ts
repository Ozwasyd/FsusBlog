export function createSerializedExecutor() {
  let queue: Promise<void> = Promise.resolve()

  return async function runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const previous = queue
    let release!: () => void
    queue = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }
}
