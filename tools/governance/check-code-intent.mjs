#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultRoot = path.resolve(moduleDirectory, '../..')
const defaultRegistryPath = 'tests/governance/code-intent-registry.json'
const authorityPath = 'config/development/authoritative-development-docs.json'
const validClaimLevels = new Set(['S', 'M', 'R', 'C'])
const measuredClaimLevels = new Set(['M', 'R', 'C'])
const validIntentMarkers = new Set([
    'OWNERSHIP:',
    'SECURITY-INVARIANT:',
    'PERF-INVARIANT:',
    'COMPATIBILITY:',
    'MEASUREMENT:',
    'NON-GOAL:'
])
const validIntentKinds = new Set([
    'ownership',
    'lifetime',
    'disposal',
    'sensitive-clearing',
    'copy-boundary',
    'unsafe-abi-wire',
    'concurrency',
    'backpressure',
    'fail-open-closed',
    'deliberate-buffer',
    'deliberate-branch',
    'deliberate-validation',
    'deliberate-lock',
    'cache-state',
    'compatibility',
    'workaround',
    'performance',
    'measurement',
    'non-goal'
])

function text(value) {
    return typeof value === 'string' ? value.trim() : ''
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function lineNumber(source, index) {
    return source.slice(0, index).split('\n').length
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function globToRegex(pattern) {
    let expression = ''
    for (let index = 0; index < pattern.length;) {
        if (pattern.startsWith('**/', index)) {
            expression += '(?:.*/)?'
            index += 3
            continue
        }
        if (pattern.startsWith('**', index)) {
            expression += '.*'
            index += 2
            continue
        }
        if (pattern[index] === '*') {
            expression += '[^/]*'
            index += 1
            continue
        }
        if (pattern[index] === '?') {
            expression += '[^/]'
            index += 1
            continue
        }
        expression += escapeRegex(pattern[index])
        index += 1
    }
    return new RegExp(`^${expression}$`, 'u')
}

function resolveRepositoryPath(root, relativePath, errors, label) {
    const normalized = text(relativePath).replaceAll('\\', '/')
    if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
        errors.push(`${label} must be a repository-relative path without '..': ${relativePath ?? 'missing'}`)
        return null
    }
    const absolute = path.resolve(root, normalized)
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        errors.push(`${label} escapes the repository root: ${normalized}`)
        return null
    }
    return absolute
}

function listRepositoryFiles(root) {
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8'
    })
    if (result.status !== 0) {
        throw new Error(`git ls-files failed: ${text(result.stderr) || `exit ${result.status}`}`)
    }
    return result.stdout.split('\0').map((entry) => entry.trim()).filter(Boolean)
}

function classificationMatchers(authority, registry) {
    const excluded = new Set(registry?.commentPolicy?.excludedClassifications ?? [])
    return (authority?.pathClassifications ?? [])
        .filter((entry) => excluded.has(entry?.id))
        .flatMap((entry) => (entry.patterns ?? []).map((pattern) => ({
            id: entry.id,
            pattern,
            regex: globToRegex(pattern)
        })))
}

function isClassified(relativePath, matchers) {
    return matchers.some((entry) => entry.regex.test(relativePath))
}

function usesCommentPolicy(relativePath, registry) {
    const roots = registry?.commentPolicy?.scanRoots ?? []
    const inRoot = roots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`))
    if (!inRoot) return false
    if ((registry?.commentPolicy?.specialFiles ?? []).includes(path.basename(relativePath))) return true
    return (registry?.commentPolicy?.extensions ?? []).includes(path.extname(relativePath))
}

function createComment(source, start, end, raw, kind, hasCodeBefore) {
    const withoutMarkers = raw
        .replace(/^\/\/\/?\s?/u, '')
        .replace(/^\/\*\*?\s?/u, '')
        .replace(/\*\/$/u, '')
        .replace(/^<!--\s?/u, '')
        .replace(/\s?-->$/u, '')
        .replace(/^(?:#|--)\s?/u, '')
        .trim()
    return {
        text: withoutMarkers,
        raw,
        kind,
        startLine: lineNumber(source, start),
        endLine: lineNumber(source, Math.max(start, end - 1)),
        hasCodeBefore
    }
}

function regexLiteralStart(source, index) {
    const prefix = source.slice(0, index).trimEnd()
    if (!prefix) return true
    if (/[([{=,:;!?&|+*%^~<>-]/u.test(prefix.at(-1))) return true
    const keyword = prefix.match(/(?:^|[^\w$])(return|case|throw|else|do|typeof|instanceof|in|of|yield|await)$/u)?.[1]
    return Boolean(keyword)
}

function skipRegexLiteral(source, index) {
    let cursor = index + 1
    let escaped = false
    let inCharacterClass = false
    while (cursor < source.length) {
        const character = source[cursor]
        if (character === '\n' || character === '\r') return index + 1
        if (escaped) {
            escaped = false
            cursor += 1
            continue
        }
        if (character === '\\') {
            escaped = true
            cursor += 1
            continue
        }
        if (character === '[') inCharacterClass = true
        if (character === ']') inCharacterClass = false
        if (character === '/' && !inCharacterClass) {
            cursor += 1
            while (/[a-z]/iu.test(source[cursor] ?? '')) cursor += 1
            return cursor
        }
        cursor += 1
    }
    return index + 1
}

function extractCStyleComments(source) {
    const comments = []
    let index = 0
    let lineStart = 0
    let quote = null
    let escaped = false
    let rawQuoteCount = 0
    let verbatim = false
    const templateStack = []

    while (index < source.length) {
        const character = source[index]
        if (character === '\n') {
            lineStart = index + 1
            index += 1
            continue
        }
        if (rawQuoteCount > 0) {
            const delimiter = '"'.repeat(rawQuoteCount)
            if (source.startsWith(delimiter, index)) {
                index += rawQuoteCount
                rawQuoteCount = 0
            } else {
                index += 1
            }
            continue
        }
        if (quote !== null) {
            if (quote === '`') {
                if (escaped) {
                    escaped = false
                    index += 1
                    continue
                }
                if (character === '\\') {
                    escaped = true
                    index += 1
                    continue
                }
                if (source.startsWith('${', index)) {
                    const frame = templateStack.at(-1)
                    frame.mode = 'expression'
                    frame.braceDepth = 1
                    quote = null
                    index += 2
                    continue
                }
                if (character === '`') {
                    templateStack.pop()
                    quote = null
                }
                index += 1
                continue
            }
            if (verbatim && quote === '"' && source.startsWith('""', index)) {
                index += 2
                continue
            }
            if (!verbatim && escaped) {
                escaped = false
                index += 1
                continue
            }
            if (!verbatim && character === '\\') {
                escaped = true
                index += 1
                continue
            }
            if (character === quote) {
                quote = null
                verbatim = false
            }
            index += 1
            continue
        }

        const raw = source.slice(index).match(/^(?:\$+)?("{3,})/u)
        if (raw) {
            rawQuoteCount = raw[1].length
            index += raw[0].length
            continue
        }
        const cppRaw = source.slice(index).match(/^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/u)
        if (cppRaw) {
            const close = `)${cppRaw[1]}"`
            const boundary = source.indexOf(close, index + cppRaw[0].length)
            index = boundary < 0 ? source.length : boundary + close.length
            continue
        }
        if (source.startsWith('$@"', index) || source.startsWith('@$"', index)) {
            quote = '"'
            verbatim = true
            index += 3
            continue
        }
        if (source.startsWith('@"', index)) {
            quote = '"'
            verbatim = true
            index += 2
            continue
        }
        if (source.startsWith('$"', index)) {
            quote = '"'
            index += 2
            continue
        }
        if (character === '`') {
            templateStack.push({ mode: 'text', braceDepth: 0 })
            quote = '`'
            index += 1
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
            index += 1
            continue
        }
        const templateFrame = templateStack.at(-1)
        if (templateFrame?.mode === 'expression') {
            if (character === '{') {
                templateFrame.braceDepth += 1
                index += 1
                continue
            }
            if (character === '}') {
                templateFrame.braceDepth -= 1
                index += 1
                if (templateFrame.braceDepth === 0) {
                    templateFrame.mode = 'text'
                    quote = '`'
                }
                continue
            }
        }
        if (source.startsWith('//', index)) {
            const end = source.indexOf('\n', index)
            const boundary = end < 0 ? source.length : end
            const rawComment = source.slice(index, boundary)
            comments.push(createComment(
                source,
                index,
                boundary,
                rawComment,
                rawComment.startsWith('///') ? 'doc-line' : 'line',
                source.slice(lineStart, index).trim().length > 0
            ))
            index = boundary
            continue
        }
        if (source.startsWith('/*', index)) {
            const close = source.indexOf('*/', index + 2)
            const boundary = close < 0 ? source.length : close + 2
            const rawComment = source.slice(index, boundary)
            comments.push(createComment(
                source,
                index,
                boundary,
                rawComment,
                rawComment.startsWith('/**') ? 'doc-block' : 'block',
                source.slice(lineStart, index).trim().length > 0
            ))
            index = boundary
            continue
        }
        if (character === '/' && regexLiteralStart(source, index)) {
            index = skipRegexLiteral(source, index)
            continue
        }
        index += 1
    }
    return comments
}

function extractHashComments(source, relativePath) {
    const comments = []
    const lines = source.split(/\r?\n/u)
    let offset = 0
    for (const line of lines) {
        let quote = null
        let escaped = false
        for (let index = 0; index < line.length; index += 1) {
            const character = line[index]
            if (escaped) {
                escaped = false
                continue
            }
            if (character === '\\' && quote === '"') {
                escaped = true
                continue
            }
            if (quote !== null) {
                if (character === quote) quote = null
                continue
            }
            if (character === '"' || character === "'") {
                quote = character
                continue
            }
            if (character === '#') {
                if (index === 0 && line.startsWith('#!')) break
                const previous = index > 0 ? line[index - 1] : ''
                const startsCommentToken = index === 0 || /[\s;(){}]/u.test(previous)
                if (!startsCommentToken || (path.extname(relativePath) === '.sh' && previous === '$')) continue
                comments.push(createComment(
                    source,
                    offset + index,
                    offset + line.length,
                    line.slice(index),
                    'line',
                    line.slice(0, index).trim().length > 0
                ))
                break
            }
        }
        offset += line.length + 1
    }
    return comments
}

function extractSqlComments(source) {
    const comments = extractCStyleComments(source)
    const lines = source.split(/\r?\n/u)
    let offset = 0
    let quote = null
    for (const line of lines) {
        for (let index = 0; index < line.length; index += 1) {
            const character = line[index]
            if (quote !== null) {
                if (character === quote && line[index + 1] === quote) {
                    index += 1
                } else if (character === quote) {
                    quote = null
                }
                continue
            }
            if (character === "'" || character === '"') {
                quote = character
                continue
            }
            if (line.startsWith('--', index)) {
                comments.push(createComment(
                    source,
                    offset + index,
                    offset + line.length,
                    line.slice(index),
                    'line',
                    line.slice(0, index).trim().length > 0
                ))
                break
            }
        }
        offset += line.length + 1
    }
    return comments
}

function extractXmlComments(source) {
    const comments = []
    const expression = /<!--[\s\S]*?-->/gu
    for (const match of source.matchAll(expression)) {
        const start = match.index
        const lineStart = source.lastIndexOf('\n', start - 1) + 1
        comments.push(createComment(
            source,
            start,
            start + match[0].length,
            match[0],
            'block',
            source.slice(lineStart, start).trim().length > 0
        ))
    }
    return comments
}

export function extractComments(source, relativePath = 'source.cs') {
    const extension = path.extname(relativePath).toLowerCase()
    if (['.sh', '.yml', '.yaml', '.cmake'].includes(extension) || path.basename(relativePath) === 'CMakeLists.txt') {
        return extractHashComments(source, relativePath)
    }
    if (['.csproj', '.props', '.dcproj', '.pubxml', '.xml'].includes(extension)) {
        return extractXmlComments(source)
    }
    if (extension === '.sql') return extractSqlComments(source)
    if (extension === '.vue') return [...extractCStyleComments(source), ...extractXmlComments(source)]
    return extractCStyleComments(source)
}

function nextCodeLine(source, comment) {
    return source.split(/\r?\n/u)
        .slice(comment.endLine)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('//') && !line.startsWith('/*')) ?? ''
}

function isCppNamespaceClosingComment(relativePath, source, comment) {
    if (!['.cpp', '.hpp'].includes(path.extname(relativePath).toLowerCase())) return false
    const line = source.split(/\r?\n/u)[comment.startLine - 1] ?? ''
    return /^\s*\}\s*\/\/\s*namespace(?:\s+[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)?\s*$/u.test(line)
}

function isRedundantComment(comment, followingLine) {
    const normalized = comment.text
        .replace(/[.`'"<>]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase()
    if (/^(?:return|returns|returning|返回)(?: the)? (?:result|value|值|结果)[。. ]*$/u.test(normalized)) {
        return /^return\b/u.test(followingLine)
    }
    if (/^(?:increment|increments|递增|增加)(?: the)? [a-z_][a-z0-9_]*[。. ]*$/u.test(normalized)) {
        return /(?:\+\+|\+=\s*1)/u.test(followingLine)
    }
    if (/^(?:set|sets|设置)(?: the)? [a-z_][a-z0-9_]*(?: value)?[。. ]*$/u.test(normalized)) {
        return /^[A-Za-z_][A-Za-z0-9_.]*\s*=/u.test(followingLine)
    }
    return false
}

function todoMatchesRegistry(relativePath, comment, match, trackedTodos) {
    const issue = match.groups?.issue ?? ''
    const body = text(match.groups?.body)
    return trackedTodos.some((entry) => entry?.path === relativePath
        && String(entry?.issue) === issue
        && entry?.state === 'open'
        && text(entry?.removalCondition)
        && body.includes(entry.removalCondition))
}

function sourceContainsTrackedTodo(relativePath, source, todo) {
    const issuePattern = new RegExp(`\\b(?:TODO|FIXME)\\(#${todo.issue}\\):`, 'u')
    return extractComments(source, relativePath).some((comment) => issuePattern.test(comment.text)
        && comment.text.includes(todo.removalCondition))
}

function readLiveIssue(repository, issue) {
    const result = spawnSync('gh', [
        'issue',
        'view',
        String(issue),
        '--repo',
        repository,
        '--json',
        'number,state,url'
    ], { encoding: 'utf8' })
    if (result.status !== 0) {
        throw new Error(text(result.stderr) || text(result.stdout) || `gh exited ${result.status}`)
    }
    return JSON.parse(result.stdout)
}

export function validateTrackedTodoIssues(registry, { resolveIssue = readLiveIssue } = {}) {
    const errors = []
    const repository = text(registry?.trackedTodoPolicy?.repository)
    for (const todo of registry?.trackedTodos ?? []) {
        if (!Number.isInteger(todo?.issue) || todo.issue <= 0 || !repository) continue
        let issue
        try {
            issue = resolveIssue(repository, todo.issue)
        } catch (error) {
            errors.push(`tracked TODO ${todo?.id ?? 'unknown'} live issue verification failed closed: ${error.message}`)
            continue
        }
        const canonicalUrl = `https://github.com/${repository}/issues/${todo.issue}`
        if (issue?.number !== todo.issue || issue?.url !== canonicalUrl) {
            errors.push(`tracked TODO ${todo?.id ?? 'unknown'} live issue identity is missing or mismatched`)
        }
        if (issue?.state !== 'OPEN') {
            errors.push(`tracked TODO ${todo?.id ?? 'unknown'} issue #${todo.issue} is not open`)
        }
    }
    return errors
}

export function validateCommentPolicy({ path: relativePath, source, registry, scoped = false }) {
    const errors = []
    const comments = extractComments(source, relativePath)
    const historicalTerms = registry?.commentPolicy?.historicalNarrativeTerms ?? []
    const absoluteTerms = registry?.commentPolicy?.absolutePerformanceTerms ?? []
    const maxBlockCommentLines = Number(registry?.commentPolicy?.maxBlockCommentLines ?? 8)
    const trackedTodos = registry?.trackedTodos ?? []
    const datePattern = /(?:19|20)\d{2}(?:[-/.年](?:0?[1-9]|1[0-2]))(?:[-/.月](?:0?[1-9]|[12]\d|3[01])日?)?/u
    const todoPattern = /\b(?:TODO|FIXME)\(#(?<issue>\d+)\):\s*(?<body>[^\n]+)/gu
    const quantitativePerformancePattern = /(?:performance|latency|throughput|qps|rps|ops(?:\/| per )s|duration|耗时|延迟|吞吐|性能|速度)[\s\S]{0,80}?\d+(?:\.\d+)?\s*(?:ns|[µμu]s|ms|s|gb\/s|mb\/s|k?ops\/s|qps|rps|%)/iu

    for (const comment of comments) {
        const location = `${relativePath}:${comment.startLine}`
        const narrativeTerm = historicalTerms.find((term) => comment.text.includes(term))
        const datedNarrative = datePattern.test(comment.text)
            && /(?:date|dated|fix(?:ed)?|modified|updated|revision|history|修复|修改|修订|创建|版本|历史)/iu.test(comment.text)
        if (narrativeTerm || datedNarrative) {
            errors.push(`${location} historical/date narrative must move to docs; keep only the current intent`)
        }
        const performanceTerm = absoluteTerms.find((term) => comment.text.toLowerCase().includes(term.toLowerCase()))
        if (performanceTerm) {
            errors.push(`${location} unbounded performance claim '${performanceTerm}' must be structural or evidence-registered`)
        }
        if (quantitativePerformancePattern.test(comment.text)) {
            errors.push(`${location} quantitative performance claim must move to current measured evidence`)
        }

        const anyTodo = /\b(?:TODO|FIXME)\b/u.test(comment.text)
        const todos = [...comment.text.matchAll(todoPattern)]
        if (anyTodo && todos.length === 0) {
            errors.push(`${location} TODO/FIXME must use TODO(#1234): reason; removal condition`)
        }
        for (const match of todos) {
            if (!/remov(?:e|al)|delete|删除条件|移除条件/iu.test(match.groups?.body ?? '')) {
                errors.push(`${location} TODO(#${match.groups?.issue}) must state a removal condition`)
                continue
            }
            if (!todoMatchesRegistry(relativePath, comment, match, trackedTodos)) {
                errors.push(`${location} TODO(#${match.groups?.issue}) is not bound to an open registry entry and matching removal condition`)
            }
        }

        if (!scoped) continue
        if (comment.hasCodeBefore && !isCppNamespaceClosingComment(relativePath, source, comment)) {
            errors.push(`${location} trailing comments are prohibited; place the intent immediately above the code`)
        }
        if (comment.kind === 'block' && comment.endLine - comment.startLine + 1 > maxBlockCommentLines) {
            errors.push(`${location} long design block comment must move to an authoritative document`)
        }
        if (comment.kind !== 'doc-line' && comment.kind !== 'doc-block'
            && isRedundantComment(comment, nextCodeLine(source, comment))) {
            errors.push(`${location} comment restates the following code without adding intent`)
        }
    }
    return errors
}

export function validateMarkerRegistration({ path: relativePath, source, registeredMarkers = new Set() }) {
    const errors = []
    for (const comment of extractComments(source, relativePath)) {
        for (const match of comment.text.matchAll(/\b(OWNERSHIP|SECURITY-INVARIANT|PERF-INVARIANT|COMPATIBILITY|MEASUREMENT|NON-GOAL):/gu)) {
            const marker = `${match[1]}:`
            if (!registeredMarkers.has(marker)) {
                errors.push(`${relativePath}:${comment.startLine} intent marker ${marker} is not registered for this source path`)
            }
        }
    }
    return errors
}

export function validatePublicPerformanceText(relativePath, source, registry) {
    const errors = []
    for (const term of registry?.commentPolicy?.absolutePerformanceTerms ?? []) {
        if (source.toLowerCase().includes(term.toLowerCase())) {
            errors.push(`${relativePath} public performance claim '${term}' requires a registered S/M/R/C boundary`)
        }
    }
    return errors
}

function declarationPattern(contract) {
    const symbol = escapeRegex(contract.symbol)
    if (contract.language === 'csharp') {
        return new RegExp(`^\\s*public\\s+[^\\n]*\\b${symbol}\\b`, 'mu')
    }
    if (contract.language === 'typescript' || contract.language === 'javascript') {
        return new RegExp(`export\\s+(?:async\\s+)?(?:function|class|interface|type|const|enum)\\s+${symbol}\\b`, 'u')
    }
    if (contract.language === 'vue') {
        return new RegExp(`^\\s*${symbol}\\??:\\s*`, 'mu')
    }
    if (contract.language === 'cpp') {
        return new RegExp(`^(?!\\s*//)[^\\n]*\\b${symbol}\\s*\\(`, 'mu')
    }
    if (contract.language === 'shell') {
        return new RegExp(`^\\s*${symbol}\\s*$`, 'mu')
    }
    if (contract.language === 'cmake') {
        return new RegExp(`^\\s*function\\(\\s*${symbol}\\b`, 'miu')
    }
    return null
}

export function validatePublicContract(contract, source) {
    const errors = []
    const pattern = declarationPattern(contract)
    if (!pattern) return [`public contract ${contract?.id ?? 'unknown'} has unsupported language ${contract?.language ?? 'missing'}`]
    const match = pattern.exec(source)
    if (!match) return [`public contract ${contract.id} symbol is missing: ${contract.symbol}`]
    const prefix = source.slice(Math.max(0, match.index - 1600), match.index).trimEnd()
    let documentation = ''
    if (contract.documentationStyle === 'xml-doc') {
        documentation = prefix.match(/((?:^|\n)(?:\s*\/\/\/[^\n]*)+)\s*$/u)?.[1] ?? ''
        if (!/<summary>[\s\S]*<\/summary>/u.test(documentation)) {
            errors.push(`public contract ${contract.id} requires an adjacent XML summary`)
        }
    } else if (['tsdoc', 'jsdoc', 'vue-tsdoc', 'doxygen'].includes(contract.documentationStyle)) {
        const blockStart = prefix.lastIndexOf('/**')
        const blockDocumentation = blockStart >= 0 ? prefix.slice(blockStart) : ''
        const lineDocumentation = prefix.match(/((?:^|\n)(?:\s*\/\/\/[^\n]*)+)\s*$/u)?.[1] ?? ''
        documentation = /^\/\*\*[\s\S]*\*\/\s*$/u.test(blockDocumentation) ? blockDocumentation : lineDocumentation
        if (!documentation) {
            errors.push(`public contract ${contract.id} requires adjacent ${contract.documentationStyle}`)
        }
    } else if (contract.documentationStyle === 'shell-doc' || contract.documentationStyle === 'cmake-doc') {
        const commentBlock = prefix.match(/(?:^|\n)((?:\s*#(?![!])[^\n]*\n?)+)\s*$/u)?.[1] ?? ''
        for (const field of ['Contract:', 'Input:', 'Output:', 'Failure:']) {
            if (!commentBlock.includes(field)) errors.push(`public contract ${contract.id} requires adjacent ${contract.documentationStyle} field ${field}`)
        }
    } else {
        errors.push(`public contract ${contract.id} has unsupported documentationStyle ${contract.documentationStyle}`)
    }
    if (documentation) {
        const meaningful = documentation
            .replaceAll('/**', ' ')
            .replaceAll('*/', ' ')
            .replaceAll('///', ' ')
            .replace(/<[^>]+>/gu, ' ')
            .replaceAll('*', ' ')
            .replace(new RegExp(escapeRegex(contract.symbol), 'giu'), ' ')
            .replace(/\s+/gu, ' ')
            .trim()
        if (meaningful.length < 20) errors.push(`public contract ${contract.id} documentation must state a meaningful boundary`)
    }
    return errors
}

function validateUniqueIds(entries, label, errors) {
    const seen = new Set()
    for (const entry of entries) {
        const id = text(entry?.id)
        if (!id) {
            errors.push(`${label} entry requires id`)
        } else if (seen.has(id)) {
            errors.push(`${label} id must be unique: ${id}`)
        }
        seen.add(id)
    }
}

function readReferencedFile(root, relativePath, errors, label) {
    const absolute = resolveRepositoryPath(root, relativePath, errors, label)
    if (!absolute) return null
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        errors.push(`${label} does not exist: ${relativePath}`)
        return null
    }
    return fs.readFileSync(absolute, 'utf8')
}

export function validateRegistry(registry, { root = defaultRoot, now = new Date() } = {}) {
    const errors = []
    if (registry?.schema !== 'fsusblog.code-intent-registry.v1') {
        errors.push('registry schema must be fsusblog.code-intent-registry.v1')
        return errors
    }
    if (!isObject(registry.commentPolicy)) errors.push('commentPolicy must be an object')
    if (registry?.commentPolicy?.scopedRules?.mode !== 'registered-intents-and-public-contracts') {
        errors.push('commentPolicy.scopedRules.mode must be registered-intents-and-public-contracts')
    }
    if (!isObject(registry.claimLevels)) errors.push('claimLevels must be an object')
    if (!isObject(registry.trackedTodoPolicy)) errors.push('trackedTodoPolicy must be an object')
    if (registry?.trackedTodoPolicy?.repository !== 'Ozwasyd/FsusBlog') {
        errors.push('trackedTodoPolicy.repository must be Ozwasyd/FsusBlog')
    }
    const todoVerificationMaxAgeHours = Number(registry?.trackedTodoPolicy?.verificationMaxAgeHours)
    if (!Number.isInteger(todoVerificationMaxAgeHours) || todoVerificationMaxAgeHours <= 0) {
        errors.push('trackedTodoPolicy.verificationMaxAgeHours must be a positive integer')
    }
    for (const level of validClaimLevels) {
        if (!isObject(registry?.claimLevels?.[level])) errors.push(`claimLevels.${level} must be defined`)
    }
    if (!Array.isArray(registry.trackedTodos)) errors.push('trackedTodos must be an array')
    if (!Array.isArray(registry.publicContracts)) errors.push('publicContracts must be an array')
    if (!Array.isArray(registry.intents)) errors.push('intents must be an array')
    if (errors.length > 0) return errors

    validateUniqueIds(registry.trackedTodos, 'trackedTodos', errors)
    validateUniqueIds(registry.publicContracts, 'publicContracts', errors)
    validateUniqueIds(registry.intents, 'intents', errors)

    if (!Array.isArray(registry?.commentPolicy?.publicClaimDocuments)
        || registry.commentPolicy.publicClaimDocuments.length === 0) {
        errors.push('commentPolicy.publicClaimDocuments must be a non-empty array')
    } else {
        for (const document of registry.commentPolicy.publicClaimDocuments) {
            readReferencedFile(root, document, errors, 'public claim document')
        }
    }

    for (const todo of registry.trackedTodos) {
        if (!Number.isInteger(todo?.issue) || todo.issue <= 0) errors.push(`tracked TODO ${todo?.id ?? 'unknown'} requires a positive issue number`)
        if (todo?.state !== 'open') errors.push(`tracked TODO ${todo?.id ?? 'unknown'} must reference an open issue`)
        if (todo?.issueUrl !== `https://github.com/Ozwasyd/FsusBlog/issues/${todo?.issue}`) {
            errors.push(`tracked TODO ${todo?.id ?? 'unknown'} requires the canonical FsusBlog issue URL`)
        }
        const verifiedAtUtc = todo?.verifiedAtUtc ?? ''
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(verifiedAtUtc)) {
            errors.push(`tracked TODO ${todo?.id ?? 'unknown'} requires verifiedAtUtc from a live issue read`)
        } else {
            const verifiedAt = Date.parse(verifiedAtUtc)
            const nowValue = now instanceof Date ? now.getTime() : Date.parse(now)
            const maxAge = todoVerificationMaxAgeHours * 60 * 60 * 1000
            if (!Number.isFinite(nowValue)) {
                errors.push('registry validation now value must be a valid date')
            } else if (verifiedAt > nowValue + 5 * 60 * 1000) {
                errors.push(`tracked TODO ${todo?.id ?? 'unknown'} verifiedAtUtc cannot be in the future`)
            } else if (nowValue - verifiedAt > maxAge) {
                errors.push(`tracked TODO ${todo?.id ?? 'unknown'} live issue verification is expired`)
            }
        }
        if (!text(todo?.removalCondition)) errors.push(`tracked TODO ${todo?.id ?? 'unknown'} requires removalCondition`)
        const source = readReferencedFile(root, todo?.path, errors, `tracked TODO ${todo?.id ?? 'unknown'} path`)
        if (source !== null && text(todo?.removalCondition)
            && !sourceContainsTrackedTodo(todo.path, source, todo)) {
            errors.push(`tracked TODO ${todo?.id ?? 'unknown'} record is stale or missing from its source path`)
        }
    }

    for (const contract of registry.publicContracts) {
        const label = `public contract ${contract?.id ?? 'unknown'}`
        const source = readReferencedFile(root, contract?.path, errors, `${label} path`)
        if (!text(contract?.symbol)) errors.push(`${label} requires symbol`)
        if (source !== null) errors.push(...validatePublicContract(contract, source))
    }

    for (const intent of registry.intents) {
        const label = `intent ${intent?.id ?? 'unknown'}`
        if (!Array.isArray(intent?.sourcePaths) || intent.sourcePaths.length === 0) {
            errors.push(`${label} requires sourcePaths`)
        }
        if (!Array.isArray(intent?.intentKinds) || intent.intentKinds.length === 0) {
            errors.push(`${label} requires intentKinds`)
        } else {
            for (const kind of intent.intentKinds) {
                if (!validIntentKinds.has(kind)) errors.push(`${label} has unsupported intent kind ${kind}`)
            }
        }
        if (!validClaimLevels.has(intent?.claimLevel)) errors.push(`${label} has invalid claimLevel ${intent?.claimLevel ?? 'missing'}`)
        const sourceCache = new Map()
        for (const sourcePath of intent?.sourcePaths ?? []) {
            const source = readReferencedFile(root, sourcePath, errors, `${label} sourcePath`)
            if (source !== null) sourceCache.set(sourcePath, source)
        }
        if (!Array.isArray(intent?.anchors) || intent.anchors.length === 0) {
            errors.push(`${label} requires at least one intent anchor`)
        }
        for (const anchor of intent?.anchors ?? []) {
            if (!(intent?.sourcePaths ?? []).includes(anchor?.path)) {
                errors.push(`${label} anchor path must also be a sourcePath: ${anchor?.path ?? 'missing'}`)
                continue
            }
            const source = sourceCache.get(anchor.path)
            if (source === undefined) continue
            if (!validIntentMarkers.has(anchor?.marker)) {
                errors.push(`${label} anchor marker must use a supported code-intent marker: ${anchor?.marker ?? 'missing'}`)
            }
            if (!text(anchor?.marker) || !source.includes(anchor.marker)) {
                errors.push(`${label} marker is stale or missing in ${anchor.path}: ${anchor?.marker ?? 'missing'}`)
            }
            if (!text(anchor?.symbol) || !source.includes(anchor.symbol)) {
                errors.push(`${label} symbol is stale or missing in ${anchor.path}: ${anchor?.symbol ?? 'missing'}`)
            }
            if (text(anchor?.marker) && text(anchor?.symbol)
                && source.includes(anchor.marker) && source.includes(anchor.symbol)) {
                const markerLines = [...source.matchAll(new RegExp(escapeRegex(anchor.marker), 'gu'))]
                    .map((match) => lineNumber(source, match.index))
                const symbolLines = [...source.matchAll(new RegExp(escapeRegex(anchor.symbol), 'gu'))]
                    .map((match) => lineNumber(source, match.index))
                const nearest = Math.min(...markerLines.flatMap((markerLine) => symbolLines.map((symbolLine) => Math.abs(markerLine - symbolLine))))
                const maxLineDistance = Number(anchor.maxLineDistance ?? 40)
                if (!Number.isInteger(maxLineDistance) || maxLineDistance <= 0) {
                    errors.push(`${label} anchor maxLineDistance must be a positive integer`)
                } else if (nearest > maxLineDistance) {
                    errors.push(`${label} marker is ${nearest} lines from ${anchor.symbol}, beyond maxLineDistance=${maxLineDistance}`)
                }
            }
        }

        if (intent.claimLevel === 'S') {
            if (intent.status !== 'structural-only') errors.push(`${label} Level S status must remain structural-only`)
            if (!text(intent.structuralBoundary)) errors.push(`${label} Level S requires structuralBoundary`)
            if (intent.evidence?.authority) errors.push(`${label} Level S cannot claim measured authority`)
        } else if (measuredClaimLevels.has(intent.claimLevel)) {
            if (intent.status !== 'measurement-contract') {
                errors.push(`${label} ${intent.claimLevel} status must be measurement-contract; only a current receipt may claim measured`)
            }
            const evidence = intent.evidence
            if (!isObject(evidence)) {
                errors.push(`${label} ${intent.claimLevel} requires evidence`)
                continue
            }
            readReferencedFile(root, evidence.producer, errors, `${label} evidence producer`)
            for (const evidencePath of evidence.paths ?? []) {
                readReferencedFile(root, evidencePath, errors, `${label} evidence path`)
            }
            if (!Array.isArray(evidence.paths) || evidence.paths.length === 0) errors.push(`${label} evidence.paths must be non-empty`)
            const policy = readReferencedFile(root, evidence?.policy?.path, errors, `${label} evidence policy`)
            if (policy !== null && (!text(evidence?.policy?.anchor) || !policy.includes(evidence.policy.anchor))) {
                errors.push(`${label} evidence policy anchor is stale: ${evidence?.policy?.anchor ?? 'missing'}`)
            }
            for (const field of ['requiresCurrentCommit', 'requiresArtifactDigest', 'requiresMachineIdentity']) {
                if (evidence?.authority?.[field] !== true) errors.push(`${label} evidence.authority.${field} must be true`)
            }
            const statistics = new Set(evidence.requiredStatistics ?? [])
            for (const statistic of ['mean', 'p50', 'p95', 'allocation', 'iterations', 'noise']) {
                if (!statistics.has(statistic)) errors.push(`${label} requires statistic ${statistic}`)
            }
            if (!Array.isArray(intent.nonGoals) || intent.nonGoals.length === 0) errors.push(`${label} measured claim requires nonGoals`)
        }
    }
    return errors
}

export function evaluatePerformanceClaim(intent, receipt = {}, expectedCommit = '') {
    if (intent?.claimLevel === 'S') {
        return {
            status: 'structural-only',
            measured: false,
            reasons: ['level-s-cannot-upgrade-to-measured']
        }
    }
    const reasons = []
    if (!measuredClaimLevels.has(intent?.claimLevel)) reasons.push('invalid-claim-level')
    if (!/^[0-9a-f]{40}$/u.test(expectedCommit) || receipt.commitSha !== expectedCommit) reasons.push('stale-or-wrong-commit')
    if (!/^sha256:[0-9a-f]{64}$/u.test(receipt.artifactDigest ?? '')) reasons.push('artifact-digest-unavailable')
    for (const field of ['cpu', 'os', 'runtime']) {
        if (!text(receipt?.machineIdentity?.[field])) reasons.push(`${field}-identity-unavailable`)
    }
    if (!Array.isArray(receipt.rawRounds) || receipt.rawRounds.length === 0) reasons.push('raw-rounds-unavailable')
    for (const statistic of intent?.evidence?.requiredStatistics ?? []) {
        if (!(statistic in (receipt.statistics ?? {}))) reasons.push(`${statistic}-unavailable`)
    }
    if (intent?.claimLevel === 'R' || intent?.claimLevel === 'C') {
        for (const field of ['route', 'protocol', 'status', 'cacheState', 'errorFrame']) {
            if (!(field in (receipt.routeDimensions ?? {}))) reasons.push(`${field}-dimension-unavailable`)
        }
    }
    if (intent?.claimLevel === 'C') {
        if (receipt?.capacity?.saturationObserved !== true) reasons.push('saturation-unavailable')
        if (!text(receipt?.capacity?.targetIdentity)) reasons.push('target-identity-unavailable')
        if (!text(receipt?.capacity?.loadGeneratorIdentity)) reasons.push('load-generator-identity-unavailable')
        if (!text(receipt?.capacity?.hardwareCounterAuthority)) reasons.push('hardware-counter-authority-unavailable')
    }
    return reasons.length === 0
        ? { status: 'measured', measured: true, reasons: [] }
        : { status: 'blocked', measured: false, reasons }
}

// BEHAVIOR-OWNER: code-intent-governance
/**
 * Checks repository comment policy, public documentation, and registered source/evidence references.
 * Returns every discovered error so independent debt remains visible in one run.
 */
export function checkCodeIntent({
    root = defaultRoot,
    registryPath = defaultRegistryPath,
    files = null,
    resolveIssue = readLiveIssue
} = {}) {
    const errors = []
    const absoluteRegistry = resolveRepositoryPath(root, registryPath, errors, 'registry path')
    if (!absoluteRegistry || !fs.existsSync(absoluteRegistry)) {
        errors.push(`registry does not exist: ${registryPath}`)
        return { errors, checkedFiles: 0, scopedFiles: 0 }
    }
    let registry
    try {
        registry = JSON.parse(fs.readFileSync(absoluteRegistry, 'utf8'))
    } catch (error) {
        errors.push(`registry JSON is invalid: ${error.message}`)
        return { errors, checkedFiles: 0, scopedFiles: 0 }
    }
    errors.push(...validateRegistry(registry, { root }))
    errors.push(...validateTrackedTodoIssues(registry, { resolveIssue }))

    for (const document of registry?.commentPolicy?.publicClaimDocuments ?? []) {
        const absolute = resolveRepositoryPath(root, document, errors, `public claim document ${document}`)
        if (!absolute || !fs.existsSync(absolute)) continue
        errors.push(...validatePublicPerformanceText(document, fs.readFileSync(absolute, 'utf8'), registry))
    }

    let authority = {}
    const absoluteAuthority = path.join(root, authorityPath)
    try {
        authority = JSON.parse(fs.readFileSync(absoluteAuthority, 'utf8'))
    } catch (error) {
        errors.push(`${authorityPath} is invalid: ${error.message}`)
    }
    const matchers = classificationMatchers(authority, registry)
    const repositoryFiles = files ?? listRepositoryFiles(root)
    const scoped = new Set([
        ...(registry.publicContracts ?? []).map((entry) => entry.path),
        ...(registry.intents ?? []).flatMap((entry) => entry.sourcePaths ?? [])
    ])
    const registeredMarkers = new Map()
    for (const intent of registry.intents ?? []) {
        for (const anchor of intent.anchors ?? []) {
            if (!registeredMarkers.has(anchor.path)) registeredMarkers.set(anchor.path, new Set())
            registeredMarkers.get(anchor.path).add(anchor.marker)
        }
    }
    let checkedFiles = 0
    let scopedFiles = 0
    for (const relativePath of repositoryFiles) {
        if (!usesCommentPolicy(relativePath, registry) || isClassified(relativePath, matchers)) continue
        const absolute = resolveRepositoryPath(root, relativePath, errors, `source ${relativePath}`)
        if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue
        const source = fs.readFileSync(absolute, 'utf8')
        const isScoped = scoped.has(relativePath)
        checkedFiles += 1
        if (isScoped) scopedFiles += 1
        errors.push(...validateCommentPolicy({ path: relativePath, source, registry, scoped: isScoped }))
        errors.push(...validateMarkerRegistration({
            path: relativePath,
            source,
            registeredMarkers: registeredMarkers.get(relativePath) ?? new Set()
        }))
    }
    return { errors, checkedFiles, scopedFiles }
}

function main() {
    const rootIndex = process.argv.indexOf('--root')
    const registryIndex = process.argv.indexOf('--registry')
    const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : defaultRoot
    const registryPath = registryIndex >= 0 ? process.argv[registryIndex + 1] : defaultRegistryPath
    const result = checkCodeIntent({ root, registryPath })
    if (result.errors.length > 0) {
        console.error(`[code-intent] ${result.errors.length} error(s) across ${result.checkedFiles} checked file(s):`)
        for (const error of result.errors) console.error(`- ${error}`)
        process.exitCode = 1
        return
    }
    console.log(`[code-intent] ok (${result.checkedFiles} checked file(s), ${result.scopedFiles} registered source file(s))`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
