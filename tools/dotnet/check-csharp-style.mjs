#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.dirname(scriptPath), '../..')
const defaultPolicyPath = 'config/development/csharp-style-policy.json'
const policySchema = 'fsusblog.csharp-style-policy.v1'
const baselineSchema = 'fsusblog.csharp-style-baseline.v1'
const validModes = new Set(['changed', 'full', 'strict-full'])

let root = defaultRoot
let policy = null
let policyFile = null
let baseline = new Map()
const failures = []

function fail(message) {
  failures.push(`[csharp-style] ${message}`)
}

function parseArgs(argv) {
  const parsed = { files: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--update-baseline') {
      parsed.updateBaseline = true
      continue
    }
    if (!['--root', '--policy', '--mode', '--base', '--file'].includes(argument)) {
      throw new Error(`unknown argument ${argument}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`${argument} requires a value`)
    if (argument === '--file') parsed.files.push(value)
    else parsed[argument.slice(2)] = value
    index += 1
  }
  return parsed
}

function toPosix(value) {
  return value.replaceAll(path.sep, '/')
}

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    fail(`missing ${label}`)
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`invalid JSON ${label}: ${error.message}`)
    return null
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function globToRegExp(pattern) {
  let source = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  source = source.replaceAll('**', '\0').replaceAll('*', '[^/]*').replaceAll('\0', '.*')
  return new RegExp(`^${source}$`, 'u')
}

function command(args, { allowFailure = false } = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DOTNET_NOLOGO: '1' },
    maxBuffer: 32 * 1024 * 1024
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

function walkCSharpFiles(directory, base = directory, output = []) {
  if (!fs.existsSync(directory)) return output
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['.git', '.tmp', 'node_modules', 'bin', 'obj', 'dist', 'coverage'].includes(entry.name)) continue
      walkCSharpFiles(absolute, base, output)
    } else if (entry.isFile() && entry.name.endsWith('.cs')) {
      output.push(toPosix(path.relative(base, absolute)))
    }
  }
  return output
}

function allCSharpFiles() {
  const result = command(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', '*.cs'], { allowFailure: true })
  const files = result.status === 0
    ? result.stdout.split(/\r?\n/u).filter(Boolean).map(toPosix)
    : walkCSharpFiles(root)
  return [...new Set(files)].sort()
}

function normalizeFile(value) {
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value)
  const relative = toPosix(path.relative(root, absolute))
  if (relative === '..' || relative.startsWith('../')) {
    throw new Error(`file is outside repository root: ${value}`)
  }
  return relative
}

function changedCSharpFiles(base) {
  const files = new Set()
  const diff = command(['git', 'diff', '--name-only', '--diff-filter=ACMR', base, '--', '*.cs'], { allowFailure: true })
  if (diff.status === 0) {
    for (const file of diff.stdout.split(/\r?\n/u)) if (file) files.add(toPosix(file))
  } else {
    fail(`cannot resolve changed-file base ${base}: ${(diff.stderr || diff.stdout).trim()}`)
  }
  const untracked = command(['git', 'ls-files', '--others', '--exclude-standard', '--', '*.cs'], { allowFailure: true })
  if (untracked.status === 0) {
    for (const file of untracked.stdout.split(/\r?\n/u)) if (file) files.add(toPosix(file))
  }
  return [...files].sort()
}

function selectFiles(args) {
  if (args.files.length > 0) return [...new Set(args.files.map(normalizeFile))].sort()
  if (args.mode === 'full' || args.mode === 'strict-full' || args.updateBaseline) return allCSharpFiles()
  return changedCSharpFiles(args.base ?? policy.format.changedDefaultBase)
}

function isExcluded(file, exclusions) {
  return exclusions.some((pattern) => pattern.test(file))
}

function makeViolation(file, line, rule, evidence, message) {
  const normalizedEvidence = String(evidence).trim().replace(/\s+/gu, ' ')
  return {
    id: `${rule}:${file}:${line}:${sha256(normalizedEvidence).slice(0, 16)}`,
    file,
    line,
    rule,
    evidence: normalizedEvidence,
    message
  }
}

function stripStringsAndComments(lines) {
  let inBlockComment = false
  let rawQuoteCount = 0
  return lines.map((line) => {
    let output = ''
    for (let index = 0; index < line.length;) {
      if (rawQuoteCount > 0) {
        const delimiter = '"'.repeat(rawQuoteCount)
        const close = line.indexOf(delimiter, index)
        if (close < 0) {
          output += ' '.repeat(line.length - index)
          index = line.length
        } else {
          output += ' '.repeat(close + rawQuoteCount - index)
          index = close + rawQuoteCount
          rawQuoteCount = 0
        }
        continue
      }
      if (inBlockComment) {
        const close = line.indexOf('*/', index)
        if (close < 0) {
          output += ' '.repeat(line.length - index)
          index = line.length
        } else {
          output += ' '.repeat(close + 2 - index)
          index = close + 2
          inBlockComment = false
        }
        continue
      }
      if (line.startsWith('//', index)) {
        output += ' '.repeat(line.length - index)
        break
      }
      if (line.startsWith('/*', index)) {
        output += '  '
        index += 2
        inBlockComment = true
        continue
      }
      const raw = line.slice(index).match(/^(?:\$+)?("{3,})/u)
      if (raw) {
        rawQuoteCount = raw[1].length
        output += ' '.repeat(raw[0].length)
        index += raw[0].length
        continue
      }
      const prefixLength = line.startsWith('$@"', index) || line.startsWith('@$"', index)
        ? 3
        : (line.startsWith('@"', index) || line.startsWith('$"', index) ? 2 : (line[index] === '"' ? 1 : 0))
      if (prefixLength > 0) {
        const verbatim = line.slice(index, index + prefixLength).includes('@')
        output += ' '.repeat(prefixLength)
        index += prefixLength
        while (index < line.length) {
          if (verbatim && line.startsWith('""', index)) {
            output += '  '
            index += 2
            continue
          }
          if (line[index] === '"') {
            output += ' '
            index += 1
            break
          }
          if (!verbatim && line[index] === '\\' && index + 1 < line.length) {
            output += '  '
            index += 2
            continue
          }
          output += ' '
          index += 1
        }
        continue
      }
      if (line[index] === "'") {
        output += ' '
        index += 1
        while (index < line.length) {
          if (line[index] === '\\' && index + 1 < line.length) {
            output += '  '
            index += 2
            continue
          }
          output += ' '
          if (line[index] === "'") {
            index += 1
            break
          }
          index += 1
        }
        continue
      }
      output += line[index]
      index += 1
    }
    return output
  })
}

function isPascalCase(value) {
  return /^[A-Z][A-Za-z0-9]*$/u.test(value) && !value.includes('__')
}

function isCamelCase(value) {
  return /^[a-z][A-Za-z0-9]*$/u.test(value) && !value.includes('__')
}

function hasXmlDoc(lines, declarationIndex) {
  let sawAttribute = false
  for (let index = declarationIndex - 1; index >= 0 && declarationIndex - index <= 16; index -= 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    if (trimmed.startsWith('///')) return true
    if (trimmed.startsWith('[') || trimmed.endsWith(']') || sawAttribute) {
      sawAttribute = true
      if (trimmed.startsWith('[')) sawAttribute = false
      continue
    }
    return false
  }
  return false
}

function isXmlDocScope(file, scopePatterns) {
  return scopePatterns.some((pattern) => pattern.test(file))
}

function findMatchingParenthesis(value, openIndex) {
  let depth = 0
  for (let index = openIndex; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function splitTopLevelParameters(value) {
  const parameters = []
  let start = 0
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    if ('(<[{'.includes(value[index])) depth += 1
    else if (')>]}'.includes(value[index])) depth = Math.max(0, depth - 1)
    else if (value[index] === ',' && depth === 0) {
      parameters.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parameters.push(value.slice(start).trim())
  return parameters.filter(Boolean)
}

function parseMethodDeclaration(trimmed) {
  if (!/^(?:public|protected|private|internal)\s+/u.test(trimmed)) return null
  if (/\b(?:class|struct|record|interface|enum|delegate)\b/u.test(trimmed)) return null
  const nonMethodNames = new Set([
    'public', 'protected', 'private', 'internal', 'file', 'new', 'static', 'abstract',
    'virtual', 'sealed', 'override', 'readonly', 'unsafe', 'required', 'volatile',
    'async', 'partial', 'extern', 'operator'
  ])
  for (let openIndex = trimmed.indexOf('('); openIndex >= 0; openIndex = trimmed.indexOf('(', openIndex + 1)) {
    const prefix = trimmed.slice(0, openIndex)
    if (prefix.includes('=')) return null
    const namePrefix = prefix.replace(/<[^<>]*>\s*$/u, '').trimEnd()
    const name = namePrefix.match(/([A-Za-z_]\w*)$/u)?.[1]
    if (!name || nonMethodNames.has(name)) continue
    const closeIndex = findMatchingParenthesis(trimmed, openIndex)
    if (closeIndex < 0) continue
    return {
      name,
      parameters: splitTopLevelParameters(trimmed.slice(openIndex + 1, closeIndex))
    }
  }
  return null
}

function checkFile(file, xmlScopePatterns) {
  const absolute = path.join(root, file)
  const violations = []
  if (!fs.existsSync(absolute)) {
    violations.push(makeViolation(file, 0, 'file-exists', file, 'selected C# file does not exist'))
    return violations
  }
  const buffer = fs.readFileSync(absolute)
  if (!isUtf8(buffer)) violations.push(makeViolation(file, 1, 'utf8', file, 'file is not valid UTF-8'))
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    violations.push(makeViolation(file, 1, 'utf8-bom', file, 'UTF-8 BOM is forbidden'))
  }
  const text = buffer.toString('utf8')
  if (text.includes('\r')) violations.push(makeViolation(file, 1, 'line-ending', 'CR', 'line endings must be LF'))
  if (!text.endsWith('\n')) violations.push(makeViolation(file, Math.max(1, text.split(/\n/u).length), 'final-newline', file, 'file must end with newline'))
  const lines = text.split(/\r?\n/u)
  const codeLines = stripStringsAndComments(lines)
  let namespaceSeen = false
  const usings = []
  const xmlScope = isXmlDocScope(file, xmlScopePatterns)

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const raw = lines[index]
    const code = codeLines[index]
    const trimmed = code.trim()
    if (/\t/u.test(raw)) violations.push(makeViolation(file, lineNumber, 'tab', raw, 'Tab indentation is forbidden'))
    if (/[ \t]+$/u.test(raw)) violations.push(makeViolation(file, lineNumber, 'trailing-whitespace', raw, 'trailing whitespace is forbidden'))
    const indent = raw.match(/^ */u)?.[0].length ?? 0
    if (trimmed && !trimmed.startsWith('#') && indent % 4 !== 0) {
      violations.push(makeViolation(file, lineNumber, 'indent', raw, `indentation ${indent} is not a 4-space multiple`))
    }
    if (trimmed.includes('{') && trimmed !== '{') {
      violations.push(makeViolation(file, lineNumber, 'allman-brace', code, 'opening brace must be on its own line'))
    }
    const semicolons = [...trimmed.matchAll(/;/gu)].length
    if (semicolons > 1 && !/^for\s*\(/u.test(trimmed)) {
      violations.push(makeViolation(file, lineNumber, 'one-statement', code, 'only one statement is allowed per line'))
    }
    if (!trimmed.includes('(') && /^(?:const\s+)?[A-Za-z_][\w<>,.?\[\]]*\s+[A-Za-z_]\w*\s*,\s*[A-Za-z_]\w*/u.test(trimmed)) {
      violations.push(makeViolation(file, lineNumber, 'one-declaration', code, 'only one declaration is allowed per line'))
    }

    if (/^namespace\b/u.test(trimmed)) namespaceSeen = true
    const usingMatch = trimmed.match(/^using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;/u)
    if (usingMatch) {
      if (namespaceSeen) violations.push(makeViolation(file, lineNumber, 'using-placement', code, 'using directives must be outside namespace'))
      const namespace = usingMatch[1]
      const group = namespace === 'System' || namespace.startsWith('System.') ? 0 : (namespace === 'FsusBlog' || namespace.startsWith('FsusBlog.') ? 2 : 1)
      usings.push({ line: lineNumber, namespace, group })
    }

    for (const identifier of trimmed.matchAll(/\b[A-Za-z_]\w*__\w*\b/gu)) {
      violations.push(makeViolation(file, lineNumber, 'double-underscore', identifier[0], 'consecutive underscores are forbidden in internal identifiers'))
    }

    const interfaceMatch = trimmed.match(/\binterface\s+([A-Za-z_]\w*)/u)
    if (interfaceMatch && !/^I[A-Z][A-Za-z0-9]*$/u.test(interfaceMatch[1])) {
      violations.push(makeViolation(file, lineNumber, 'interface-name', interfaceMatch[1], 'interface must use I + PascalCase'))
    }
    const typeMatch = trimmed.match(/\b(?:class|struct|record(?:\s+(?:class|struct))?|enum|delegate)\s+([A-Za-z_]\w*)/u)
    if (typeMatch && !isPascalCase(typeMatch[1])) {
      violations.push(makeViolation(file, lineNumber, 'type-name', typeMatch[1], 'type must use PascalCase'))
    }

    const fieldMatch = trimmed.match(/^(?<access>public|protected|private|internal)\s+(?<modifiers>(?:(?:static|readonly|volatile|const|unsafe|required|new)\s+)*)(?<type>[A-Za-z_][\w<>,.?\[\]]*)\s+(?<name>[A-Za-z_]\w*)\s*(?<terminator>=|;|=>|\{)/u)
    if (fieldMatch?.groups) {
      const { access, modifiers, name, terminator } = fieldMatch.groups
      const threadStatic = lines.slice(Math.max(0, index - 4), index).some((candidate) => candidate.includes('[ThreadStatic]'))
      const property = terminator === '=>' || terminator === '{'
      if (property) {
        if (!isPascalCase(name)) violations.push(makeViolation(file, lineNumber, 'property-name', name, 'property must use PascalCase'))
      } else if (modifiers.includes('const')) {
        if (!isPascalCase(name)) violations.push(makeViolation(file, lineNumber, 'constant-name', name, 'constant must use PascalCase'))
      } else if (threadStatic) {
        if (!/^t_[a-z][A-Za-z0-9]*$/u.test(name)) violations.push(makeViolation(file, lineNumber, 'thread-static-field-name', name, 'thread-static field must use t_camelCase'))
      } else if ((access === 'private' || access === 'internal') && modifiers.includes('static')) {
        if (!/^s_[a-z][A-Za-z0-9]*$/u.test(name)) violations.push(makeViolation(file, lineNumber, 'private-static-field-name', name, 'private/internal static field must use s_camelCase'))
      } else if (access === 'private' || access === 'internal') {
        if (!/^_[a-z][A-Za-z0-9]*$/u.test(name)) violations.push(makeViolation(file, lineNumber, 'private-field-name', name, 'private/internal instance field must use _camelCase'))
      } else if (!isPascalCase(name)) {
        violations.push(makeViolation(file, lineNumber, 'public-member-name', name, 'public/protected member must use PascalCase'))
      }
    }

    const method = parseMethodDeclaration(trimmed)
    if (method) {
      const methodName = method.name
      if (!isPascalCase(methodName)) violations.push(makeViolation(file, lineNumber, 'method-name', methodName, 'method/local function must use PascalCase'))
      for (const parameter of method.parameters) {
        const parameterName = parameter.replace(/\s*=.*$/u, '').match(/([A-Za-z_]\w*)\s*$/u)?.[1]
        if (parameterName && !isCamelCase(parameterName)) {
          violations.push(makeViolation(file, lineNumber, 'parameter-name', parameterName, 'parameter must use camelCase'))
        }
      }
    }

    const localMatch = trimmed.match(/^(?:var|[A-Za-z_][\w<>,.?\[\]]*)\s+([A-Za-z_]\w*)\s*=/u)
    if (localMatch && !isCamelCase(localMatch[1])) {
      violations.push(makeViolation(file, lineNumber, 'local-name', localMatch[1], 'local must use camelCase'))
    }

    const enumMatch = trimmed.match(/\benum\s+([A-Za-z_]\w*)/u)
    if (enumMatch) {
      const flags = lines.slice(Math.max(0, index - 4), index).some((candidate) => candidate.includes('[Flags]'))
      const plural = enumMatch[1].endsWith('s') && !policy.enumNaming.acceptedSingularSuffixes.some((suffix) => enumMatch[1].endsWith(suffix))
      if (flags && !plural) violations.push(makeViolation(file, lineNumber, 'flags-enum-name', enumMatch[1], 'flags enum must use a plural name'))
      if (!flags && plural) violations.push(makeViolation(file, lineNumber, 'enum-name', enumMatch[1], 'non-flags enum must use a singular name'))
    }

    if (xmlScope && /^public\s+/u.test(trimmed) && !/\boverride\b/u.test(trimmed)) {
      const declaration = /\b(?:class|struct|record|interface|enum|delegate)\b/u.test(trimmed)
        || /\b[A-Za-z_]\w*\s*\(/u.test(trimmed)
        || /\b[A-Za-z_]\w*\s*(?:=>|\{|;)/u.test(trimmed)
      if (declaration && !hasXmlDoc(lines, index)) {
        violations.push(makeViolation(file, lineNumber, 'xml-documentation', trimmed, 'public contract declaration requires meaningful XML documentation'))
      }
    }
  }

  for (let index = 1; index < usings.length; index += 1) {
    const previous = usings[index - 1]
    const current = usings[index]
    if (current.group < previous.group || (current.group === previous.group && current.namespace.localeCompare(previous.namespace) < 0)) {
      violations.push(makeViolation(file, current.line, 'using-order', current.namespace, 'using directives must be System, third-party, FsusBlog and sorted within a group'))
    }
    if (current.group !== previous.group && lines[current.line - 2]?.trim() !== '') {
      violations.push(makeViolation(file, current.line, 'using-group', current.namespace, 'using groups must be separated by one blank line'))
    }
  }
  return violations
}

function loadBaseline() {
  const baselinePath = path.join(root, policy.baseline)
  if (!fs.existsSync(baselinePath)) return new Map()
  const document = readJson(baselinePath, policy.baseline)
  if (!document) return new Map()
  if (document.schema !== baselineSchema) fail(`baseline schema must be ${baselineSchema}`)
  const policyDigest = sha256(fs.readFileSync(policyFile))
  if (document.policySha256 !== policyDigest) fail('C# style baseline policy digest is stale')
  if (!Array.isArray(document.files)) {
    fail('C# style baseline files must be an array')
    return new Map()
  }
  return new Map(document.files.map((entry) => [entry.path, entry]))
}

function runDotnetFormat(files, mode) {
  if (files.length === 0 || mode === 'full') return
  const relativeFiles = files.map((file) => path.join(root, file))
  const whitespace = command([
    'dotnet', 'format', 'whitespace', root, '--folder', '--verify-no-changes', '--include', ...relativeFiles, '--verbosity', 'quiet'
  ], { allowFailure: true })
  if (whitespace.status !== 0) {
    fail(`dotnet format whitespace rejected selected files: ${(whitespace.stderr || whitespace.stdout).trim()}`)
  }
  const workspace = path.join(root, policy.workspace)
  if (fs.existsSync(workspace)) {
    const style = command([
      'dotnet', 'format', 'style', workspace, '--verify-no-changes', '--no-restore', '--severity', 'info', '--include', ...relativeFiles, '--verbosity', 'quiet'
    ], { allowFailure: true })
    if (style.status !== 0) {
      fail(`dotnet format style rejected selected files: ${(style.stderr || style.stdout).trim()}`)
    }
  }
}

function writeBaseline(violations) {
  const target = path.join(root, policy.baseline)
  const commit = command(['git', 'rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim() || 'uncommitted'
  const byFile = new Map()
  for (const violation of violations) {
    const entry = byFile.get(violation.file) ?? { rules: {}, ids: [] }
    entry.rules[violation.rule] = (entry.rules[violation.rule] ?? 0) + 1
    entry.ids.push(violation.id)
    byFile.set(violation.file, entry)
  }
  const files = [...byFile.entries()].map(([file, entry]) => ({
    path: file,
    sourceSha256: sha256(fs.readFileSync(path.join(root, file))),
    violationCount: entry.ids.length,
    violationDigest: sha256(entry.ids.sort().join('\n')),
    rules: Object.fromEntries(Object.entries(entry.rules).sort(([left], [right]) => left.localeCompare(right)))
  })).sort((left, right) => left.path.localeCompare(right.path))
  const document = {
    schema: baselineSchema,
    generatedFrom: commit,
    policySha256: sha256(fs.readFileSync(policyFile)),
    violationCount: violations.length,
    fileCount: files.length,
    files
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`[csharp-style] baseline updated violations=${violations.length} path=${policy.baseline}`)
}

function validatePolicy() {
  if (policy.schema !== policySchema) fail(`policy schema must be ${policySchema}`)
  for (const field of ['editorConfig', 'workspace', 'baseline']) {
    if (typeof policy[field] !== 'string' || !policy[field]) fail(`policy is missing ${field}`)
  }
  if (!fs.existsSync(path.join(root, policy.editorConfig))) fail(`missing ${policy.editorConfig}`)
  if (policy.minimumDotnetMajor !== 10) fail('minimumDotnetMajor must be 10')
  if (!Array.isArray(policy.excludedPaths) || policy.excludedPaths.length === 0) fail('excludedPaths must be non-empty')
  if (!Array.isArray(policy.xmlDocumentation?.scopes) || policy.xmlDocumentation.scopes.length === 0) fail('xmlDocumentation.scopes must be non-empty')
  for (const required of ['_', 's_', 't_']) {
    const values = Object.values(policy.naming ?? {})
    if (!values.includes(required)) fail(`naming policy is missing required prefix ${required}`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  root = path.resolve(args.root ?? defaultRoot)
  args.mode ??= 'changed'
  if (!validModes.has(args.mode)) throw new Error(`invalid mode ${args.mode}`)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`repository root does not exist: ${root}`)
  policyFile = path.resolve(args.policy ?? path.join(root, defaultPolicyPath))
  policy = readJson(policyFile, args.policy ?? defaultPolicyPath)
  if (!policy) return null
  validatePolicy()

  const exclusions = (policy.excludedPaths ?? []).map(globToRegExp)
  const xmlScopes = (policy.xmlDocumentation?.scopes ?? []).map(globToRegExp)
  const files = selectFiles(args).filter((file) => file.endsWith('.cs') && !isExcluded(file, exclusions))
  const violations = files.flatMap((file) => checkFile(file, xmlScopes))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule))

  if (args.updateBaseline) {
    writeBaseline(violations)
    return { files: files.length, violations: violations.length, unexpected: 0 }
  }

  baseline = loadBaseline()
  runDotnetFormat(files, args.mode)
  const sourceDigests = new Map(files.map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]))
  const unexpected = args.mode === 'strict-full'
    ? violations
    : violations.filter((violation) => {
        const entry = baseline.get(violation.file)
        return !entry || entry.sourceSha256 !== sourceDigests.get(violation.file)
      })
  for (const violation of unexpected) {
    fail(`${violation.file}:${violation.line} ${violation.rule}: ${violation.message} [${violation.evidence}]`)
  }
  return { files: files.length, violations: violations.length, unexpected: unexpected.length }
}

let summary = null
try {
  summary = main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else if (summary) {
  console.log(`[csharp-style] ok files=${summary.files} violations=${summary.violations} new=${summary.unexpected}`)
}
