import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const servicesRoot = path.join(repoRoot, 'src/backend/Services')
const namedRead = /\b[A-Za-z_][A-Za-z0-9_]*\.(Read(?:Boolean|DateTime|Double|FieldValue(?:<[^>]+>)?|Int32|Int64|String|Value)|IsNull)\("([^"]+)"\)/gu

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return entry.isFile() && entry.name.endsWith('.cs') ? [absolute] : []
  }))
  return nested.flat()
}

const projections = []
for (const absolute of (await sourceFiles(servicesRoot)).sort()) {
  const text = await readFile(absolute, 'utf8')
  const columns = new Map()
  for (const match of text.matchAll(namedRead)) {
    const accessors = columns.get(match[2]) ?? new Set()
    accessors.add(match[1])
    columns.set(match[2], accessors)
  }
  if (columns.size === 0) continue

  projections.push({
    path: path.relative(repoRoot, absolute).split(path.sep).join('/'),
    columns: [...columns.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, accessors]) => ({ name, accessors: [...accessors].sort() })),
  })
}

const schema = {
  schema: 'fsusblog.data-reader-projections.v1',
  generatedBy: 'tools/schema/generate-data-reader-projection-schema.mjs',
  sourceFileCount: projections.length,
  projections,
}

const rendered = `${JSON.stringify(schema, null, 2)}\n`
if (process.argv.includes('--write')) {
  const output = path.join(repoRoot, 'docs/schema-migrations/data-reader-projections.json')
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, rendered, 'utf8')
}
process.stdout.write(rendered)
