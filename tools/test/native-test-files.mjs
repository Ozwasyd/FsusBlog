import fs from 'node:fs'
import path from 'node:path'

export function listNativeFiles(root, relativeDirectory) {
  const absolute = path.join(root, relativeDirectory)
  if (!fs.existsSync(absolute)) return []
  return fs.readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(relativeDirectory, entry.name)
      return entry.isDirectory() ? listNativeFiles(root, relative) : [relative]
    })
    .sort()
}
