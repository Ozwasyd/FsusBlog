function lineIndent(rawLine, source, lineNumber) {
  const leading = rawLine.match(/^[ \t]*/u)?.[0] ?? ''
  if (leading.includes('\t')) throw new Error(`${source}:${lineNumber}: YAML indentation must not contain tabs`)
  return leading.length
}

function inlineList(raw, source, lineNumber) {
  const value = raw.trim()
  if (!value) return []
  if (!value.startsWith('[')) return [value]
  if (!value.endsWith(']')) throw new Error(`${source}:${lineNumber}: unterminated workflow flow sequence`)
  return value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean)
}

function addNeed(job, value, source, lineNumber) {
  const need = value.trim().replace(/,$/u, '')
  if (!/^[A-Za-z0-9_-]+$/u.test(need)) throw new Error(`${source}:${lineNumber}: invalid workflow need ${need}`)
  job.add(need)
}

export function parseWorkflowJobNeeds(text, options = {}) {
  const source = options.source ?? '<workflow>'
  const lines = String(text ?? '').split(/\r?\n/u)
  const jobs = new Map()
  let jobsIndent = null
  let jobIndent = null
  let fieldIndent = null
  let currentJob = null
  let collecting = null

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const indent = lineIndent(rawLine, source, index + 1)
    const trimmed = rawLine.trim()
    if (jobsIndent == null) {
      if (/^jobs:\s*$/u.test(rawLine)) jobsIndent = indent
      continue
    }
    if (trimmed && indent <= jobsIndent) break

    const mapping = rawLine.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/u)
    if (jobIndent == null && mapping && indent > jobsIndent) jobIndent = indent
    if (mapping && indent === jobIndent && mapping[2] === '') {
      currentJob = mapping[1]
      if (jobs.has(currentJob)) throw new Error(`${source}:${index + 1}: duplicate workflow job ${currentJob}`)
      jobs.set(currentJob, new Set())
      fieldIndent = null
      collecting = null
      continue
    }
    if (!currentJob) continue

    if (collecting) {
      if (!trimmed) continue
      if (indent <= collecting.indent) {
        if (collecting.flow) throw new Error(`${source}:${index + 1}: unterminated needs flow sequence`)
        collecting = null
      } else if (trimmed === '[') {
        collecting.flow = true
        continue
      } else if (collecting.flow && trimmed === ']') {
        collecting = null
        continue
      } else if (collecting.flow) {
        for (const item of trimmed.split(',').filter(Boolean)) addNeed(jobs.get(currentJob), item, source, index + 1)
        continue
      } else {
        const item = trimmed.match(/^-\s+([A-Za-z0-9_-]+)\s*$/u)
        if (!item) throw new Error(`${source}:${index + 1}: workflow needs must be a sequence of job ids`)
        addNeed(jobs.get(currentJob), item[1], source, index + 1)
        continue
      }
    }

    if (fieldIndent == null && mapping && indent > jobIndent && !trimmed.startsWith('-')) fieldIndent = indent
    if (mapping && indent === fieldIndent && mapping[1] === 'needs') {
      for (const need of inlineList(mapping[2], source, index + 1)) addNeed(jobs.get(currentJob), need, source, index + 1)
      collecting = mapping[2] === '' ? { indent, flow: false } : null
    }
  }

  if (collecting?.flow) throw new Error(`${source}: unterminated needs flow sequence`)
  return jobs
}

export function workflowSectionKeys(text, sectionKey, options = {}) {
  const source = options.source ?? '<workflow>'
  const lines = String(text ?? '').split(/\r?\n/u)
  const sectionPattern = new RegExp(`^${sectionKey.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:\\s*$`, 'u')
  const start = lines.findIndex((line) => sectionPattern.test(line))
  if (start < 0) return new Set()
  const sectionIndent = lineIndent(lines[start], source, start + 1)
  let childIndent = null
  const keys = new Set()
  for (let index = start + 1; index < lines.length; index += 1) {
    const rawLine = lines[index]
    if (!rawLine.trim()) continue
    const indent = lineIndent(rawLine, source, index + 1)
    if (indent <= sectionIndent) break
    const mapping = rawLine.match(/^\s*([A-Za-z0-9_-]+):(?:\s+.*|\s*)$/u)
    if (!mapping) continue
    if (childIndent == null) childIndent = indent
    if (indent === childIndent) keys.add(mapping[1])
  }
  return keys
}
