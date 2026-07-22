#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const toolFile = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.dirname(toolFile), '..')
const defaultPolicy = 'tests/governance/csharp-entrypoint-ownership.json'
const ignoredDirectoryNames = new Set([
  '.git',
  '.tmp',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'playwright-report',
  'test-results'
])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalize(relative) {
  return String(relative).replaceAll('\\', '/').replace(/^\.\//u, '')
}

function isSafeRelative(relative) {
  const value = normalize(text(relative))
  return Boolean(value)
    && value !== '.'
    && value !== '..'
    && !value.startsWith('../')
    && !path.posix.isAbsolute(value)
}

function isInside(relative, root) {
  const candidate = normalize(relative)
  const boundary = normalize(root).replace(/\/$/u, '')
  return candidate === boundary || candidate.startsWith(`${boundary}/`)
}

function readJson(file, label, errors) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    errors.push(`${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function listRepositoryFiles(root, errors) {
  const files = []
  const walk = (directory, relativeDirectory = '') => {
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      errors.push(`cannot enumerate ${relativeDirectory || '.'}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relative = normalize(path.posix.join(relativeDirectory, entry.name))
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) walk(path.join(directory, entry.name), relative)
      } else if (entry.isFile()) {
        files.push(relative)
      }
    }
  }
  walk(root)
  return files.sort()
}

function uniqueNonEmptyStrings(values, label, errors, { relative = false } = {}) {
  const normalized = array(values).map((value) => text(value)).filter(Boolean)
  if (normalized.length !== array(values).length || new Set(normalized).size !== normalized.length) {
    errors.push(`${label} must contain unique non-empty strings`)
  }
  if (relative) {
    for (const value of normalized) {
      if (!isSafeRelative(value)) errors.push(`${label} contains unsafe repository path: ${value}`)
    }
  }
  return normalized.map(normalize)
}

export function validateCSharpEntrypointOwnershipPolicy(policy) {
  const errors = []
  if (policy?.schema !== 'fsusblog.csharp-entrypoint-ownership.v1') {
    errors.push('C# entrypoint ownership schema must be fsusblog.csharp-entrypoint-ownership.v1')
  }

  const javascriptRoots = array(policy?.javascriptProjectRoots)
  const rootPaths = javascriptRoots.map((entry) => normalize(text(entry?.path))).filter(Boolean)
  if (javascriptRoots.length === 0 || rootPaths.length !== javascriptRoots.length || new Set(rootPaths).size !== rootPaths.length) {
    errors.push('javascriptProjectRoots must declare unique non-empty roots')
  }
  for (const entry of javascriptRoots) {
    const rootPath = normalize(text(entry?.path))
    const project = normalize(text(entry?.project))
    if (!isSafeRelative(rootPath)) errors.push(`JavaScript project root is unsafe: ${rootPath || '<missing>'}`)
    if (!isSafeRelative(project) || !isInside(project, rootPath)) {
      errors.push(`JavaScript project descriptor must stay under ${rootPath || '<missing>'}`)
    }
    if (project && !project.endsWith('.esproj')) {
      errors.push(`JavaScript project descriptor must use .esproj: ${project}`)
    }
  }

  const entrypointNames = uniqueNonEmptyStrings(policy?.entrypointNames, 'entrypointNames', errors)
  if (!entrypointNames.includes('Program.cs')) errors.push('entrypointNames must include Program.cs')
  const projectExtensions = uniqueNonEmptyStrings(policy?.dotnetProjectExtensions, 'dotnetProjectExtensions', errors)
  if (!projectExtensions.includes('.csproj') || projectExtensions.some((extension) => !/^\.[a-z0-9]+proj$/u.test(extension))) {
    errors.push('dotnetProjectExtensions must include valid .csproj ownership')
  }

  const fixedRoots = uniqueNonEmptyStrings(
    policy?.forbiddenFixedGlobalOutputRoots,
    'forbiddenFixedGlobalOutputRoots',
    errors
  )
  for (const root of fixedRoots) {
    if (!root.startsWith('/') || root.endsWith('/')) {
      errors.push(`forbidden fixed global output root must be an absolute path without a trailing slash: ${root}`)
    }
  }

  const fileBasedApps = array(policy?.fileBasedApps)
  const fileBasedPaths = fileBasedApps.map((entry) => normalize(text(entry?.path))).filter(Boolean)
    if (fileBasedPaths.length !== fileBasedApps.length || new Set(fileBasedPaths).size !== fileBasedPaths.length)
    {
        errors.push('fileBasedApps must use unique non-empty paths');
    }

    const sourceFixtureRoots = uniqueNonEmptyStrings(
        policy?.sourceFixtureRoots,
        'sourceFixtureRoots',
        errors,
        { relative: true }
    );
    for (const fixtureRoot of sourceFixtureRoots)
    {
        if (!isInside(fixtureRoot, 'tests/fixtures'))
        {
            errors.push(`C# source fixture root must stay under tests/fixtures: ${fixtureRoot}`);
        }
    }
  for (const entry of fileBasedApps) {
    const appPath = normalize(text(entry?.path))
    if (!isSafeRelative(appPath) || !appPath.endsWith('.cs')) {
      errors.push(`file-based app path must be a repository-relative C# file: ${appPath || '<missing>'}`)
    }
    for (const field of ['owner', 'reason', 'invocation', 'outputContract']) {
      if (!text(entry?.[field])) errors.push(`file-based app ${appPath || '<missing>'} requires ${field}`)
    }
    if (uniqueNonEmptyStrings(
      entry?.dependencyDeclarations,
      `file-based app ${appPath || '<missing>'} dependencyDeclarations`,
      errors
    ).length === 0) {
      errors.push(`file-based app ${appPath || '<missing>'} requires at least one dependency declaration`)
    }
    if (uniqueNonEmptyStrings(entry?.tests, `file-based app ${appPath || '<missing>'} tests`, errors, { relative: true }).length === 0) {
      errors.push(`file-based app ${appPath || '<missing>'} requires at least one test`)
    }
  }

  const fixtures = object(policy?.protocolFixtures)
  const fixtureRoots = uniqueNonEmptyStrings(fixtures.roots, 'protocolFixtures.roots', errors, { relative: true })
  const fixtureSuffixes = uniqueNonEmptyStrings(fixtures.suffixes, 'protocolFixtures.suffixes', errors)
  if (fixtureRoots.length === 0) errors.push('protocolFixtures.roots must not be empty')
  if (fixtureSuffixes.length === 0 || fixtureSuffixes.some((suffix) => !suffix.startsWith('.'))) {
    errors.push('protocolFixtures.suffixes must contain file suffixes beginning with a dot')
  }

  const generators = array(fixtures.generators)
  const generatorIds = generators.map((entry) => text(entry?.id)).filter(Boolean)
  if (generatorIds.length !== generators.length || new Set(generatorIds).size !== generatorIds.length) {
    errors.push('protocol fixture generators must use unique non-empty ids')
  }
  const fixtureOwners = new Map()
  for (const generator of generators) {
    const id = text(generator?.id) || '<missing>'
    const project = normalize(text(generator?.project))
    const manifest = normalize(text(generator?.manifest))
    const generatedFixtures = uniqueNonEmptyStrings(generator?.fixtures, `protocol fixture generator ${id} fixtures`, errors, { relative: true })
    if (!isSafeRelative(project) || !projectExtensions.some((extension) => project.endsWith(extension))) {
      errors.push(`protocol fixture generator ${id} requires an owned .csproj project`)
    }
    if (!isSafeRelative(manifest)) errors.push(`protocol fixture generator ${id} requires a repository manifest path`)
    for (const [field, verb] of [['generateCommand', 'generate'], ['checkCommand', 'check']]) {
      const command = text(generator?.[field])
      if (!command || !command.includes(project) || !new RegExp(`(?:^|\\s)${verb}(?:\\s|$)`, 'u').test(command)) {
        errors.push(`protocol fixture generator ${id} ${field} must invoke ${project || '<missing>'} with ${verb}`)
      }
    }
    if (generatedFixtures.length === 0) errors.push(`protocol fixture generator ${id} must own at least one fixture`)
    for (const fixture of generatedFixtures) {
      if (!fixtureRoots.some((root) => isInside(fixture, root)) || !fixtureSuffixes.some((suffix) => fixture.endsWith(suffix))) {
        errors.push(`protocol fixture generator ${id} owns an out-of-contract fixture: ${fixture}`)
      }
      const owners = fixtureOwners.get(fixture) ?? []
      owners.push(id)
      fixtureOwners.set(fixture, owners)
    }
  }
  for (const [fixture, owners] of fixtureOwners) {
    if (owners.length !== 1) errors.push(`generated protocol fixture must have exactly one owner: ${fixture}`)
  }
  return errors
}

function closestProject(entrypoint, projectFiles) {
  let directory = path.posix.dirname(entrypoint)
  while (directory && directory !== '.') {
    const owned = projectFiles.find((project) => path.posix.dirname(project) === directory)
    if (owned) return owned
    const parent = path.posix.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return ''
}

function fixedGlobalWrite(source, fixedRoots) {
  for (const root of fixedRoots) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const directFileWrite = new RegExp(
      `File\\.(?:WriteAllText|WriteAllBytes|Create|OpenWrite)\\s*\\([\\s\\S]{0,256}?"${escaped}(?:/|")`,
      'u'
    )
    const directStream = new RegExp(`new\\s+FileStream\\s*\\([\\s\\S]{0,256}?"${escaped}(?:/|")`, 'u')
    if (directFileWrite.test(source) || directStream.test(source)) return root
  }
  return ''
}

export function checkCSharpEntrypointOwnership({ root = defaultRoot, policyFile = defaultPolicy } = {}) {
  const errors = []
  const absoluteRoot = path.resolve(root)
  const absolutePolicy = path.isAbsolute(policyFile) ? policyFile : path.join(absoluteRoot, policyFile)
  const policy = readJson(absolutePolicy, 'C# entrypoint ownership policy', errors)
  errors.push(...validateCSharpEntrypointOwnershipPolicy(policy))
  const files = listRepositoryFiles(absoluteRoot, errors)
  const fileSet = new Set(files)

  const javascriptRoots = array(policy?.javascriptProjectRoots)
  for (const declaration of javascriptRoots) {
    const project = normalize(text(declaration?.project))
    if (project && !fileSet.has(project)) errors.push(`JavaScript project descriptor is missing: ${project}`)
  }

  const csharpFiles = files.filter((file) => file.endsWith('.cs'))
  const projectExtensions = array(policy?.dotnetProjectExtensions).map((value) => text(value)).filter(Boolean)
  const projectFiles = files.filter((file) => projectExtensions.some((extension) => file.endsWith(extension)))
  const fileBasedApps = new Map(array(policy?.fileBasedApps).map((entry) => [normalize(text(entry?.path)), entry]))
    const sourceFixtureRoots = array(policy?.sourceFixtureRoots).map(normalize).filter(Boolean);
  const entrypointNames = new Set(array(policy?.entrypointNames).map((value) => text(value)).filter(Boolean))

  for (const file of csharpFiles) {
    const javascriptOwner = javascriptRoots.find((entry) => isInside(file, entry?.path))
    if (javascriptOwner) {
      errors.push(`C# source cannot live under JavaScript project root ${normalize(javascriptOwner.path)}: ${file}`)
    }
        const sourceFixture = sourceFixtureRoots.some((fixtureRoot) => isInside(file, fixtureRoot));
        if (!closestProject(file, projectFiles) && !fileBasedApps.has(file) && !sourceFixture)
        {
      const sourceKind = entrypointNames.has(path.posix.basename(file)) ? 'entrypoint' : 'source'
      errors.push(`C# ${sourceKind} has no owning project or file-based app contract: ${file}`)
    }
    let source
    try {
      source = fs.readFileSync(path.join(absoluteRoot, file), 'utf8')
    } catch (error) {
      errors.push(`cannot read C# source ${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const fixedRoot = fixedGlobalWrite(source, array(policy?.forbiddenFixedGlobalOutputRoots).map((value) => text(value)).filter(Boolean))
    if (fixedRoot) errors.push(`C# generator writes to fixed global output root ${fixedRoot}: ${file}`)
  }

  for (const [appPath, declaration] of fileBasedApps) {
    if (!fileSet.has(appPath)) errors.push(`declared file-based app is missing: ${appPath}`)
    for (const testFile of array(declaration?.tests).map(normalize)) {
      if (testFile && !fileSet.has(testFile)) errors.push(`file-based app test is missing: ${appPath} -> ${testFile}`)
    }
  }

  const fixturePolicy = object(policy?.protocolFixtures)
  const fixtureRoots = array(fixturePolicy.roots).map(normalize).filter(Boolean)
  const fixtureSuffixes = array(fixturePolicy.suffixes).map((value) => text(value)).filter(Boolean)
  const actualFixtures = files.filter((file) =>
    fixtureRoots.some((fixtureRoot) => isInside(file, fixtureRoot))
    && fixtureSuffixes.some((suffix) => file.endsWith(suffix)))
  const declaredFixtureOwners = new Map()
  for (const generator of array(fixturePolicy.generators)) {
    const id = text(generator?.id) || '<missing>'
    const project = normalize(text(generator?.project))
    const manifest = normalize(text(generator?.manifest))
    if (project && !fileSet.has(project)) errors.push(`protocol fixture generator project is missing: ${id} -> ${project}`)
    if (manifest && !fileSet.has(manifest)) errors.push(`protocol fixture generator manifest is missing: ${id} -> ${manifest}`)
    for (const fixture of array(generator?.fixtures).map(normalize).filter(Boolean)) {
      const owners = declaredFixtureOwners.get(fixture) ?? []
      owners.push(id)
      declaredFixtureOwners.set(fixture, owners)
      if (!fileSet.has(fixture)) errors.push(`declared generated protocol fixture is missing: ${id} -> ${fixture}`)
    }
  }
  for (const fixture of actualFixtures) {
    const owners = declaredFixtureOwners.get(fixture) ?? []
    if (owners.length !== 1) errors.push(`generated protocol fixture has no unique generator/check owner: ${fixture}`)
  }

  return {
    ok: errors.length === 0,
    errors,
    csharpFileCount: csharpFiles.length,
    entrypointCount: csharpFiles.filter((file) => entrypointNames.has(path.posix.basename(file))).length,
    javascriptProjectRootCount: javascriptRoots.length,
    protocolFixtureCount: actualFixtures.length,
        sourceFixtureCount: csharpFiles.filter((file) => sourceFixtureRoots.some((fixtureRoot) => isInside(file, fixtureRoot))).length,
    generatorCount: array(fixturePolicy.generators).length
  }
}

function parseArgs(args) {
  const options = { root: defaultRoot, policyFile: defaultPolicy }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--root') options.root = args[++index]
    else if (argument.startsWith('--root=')) options.root = argument.slice('--root='.length)
    else if (argument === '--policy') options.policyFile = args[++index]
    else if (argument.startsWith('--policy=')) options.policyFile = argument.slice('--policy='.length)
    else throw new Error(`unknown option ${argument}`)
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolFile) {
  try {
    const result = checkCSharpEntrypointOwnership(parseArgs(process.argv.slice(2)))
    if (!result.ok) {
      for (const error of result.errors) console.error(`[csharp-entrypoint-ownership] ${error}`)
      process.exit(1)
    }
    console.log(
      `[csharp-entrypoint-ownership] ok csharp=${result.csharpFileCount} entrypoints=${result.entrypointCount} `
      + `javascript-roots=${result.javascriptProjectRootCount} protocol-fixtures=${result.protocolFixtureCount} generators=${result.generatorCount}`
    )
  } catch (error) {
    console.error(`[csharp-entrypoint-ownership] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
