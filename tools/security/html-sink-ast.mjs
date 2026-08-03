import { createRequire } from 'node:module'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const frontendRequire = createRequire(resolve(repoRoot, 'src/frontend/package.json'))
const sinkCandidatePattern = /(?:innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|parseFromString|srcdoc|srcDoc|v-html|\bdocument\s*(?:\.\s*write(?:ln)?\b|\[\s*['"]write(?:ln)?['"]\s*\]))/u
const destructuredDocumentWritePattern = /\{[^}\n]*\bwrite(?:ln)?\b[^}\n]*\}\s*=\s*(?:window\.)?document/u

let ts
let compileTemplate
let parseSfc

function loadParsers() {
  if (ts) {
    return
  }
  ts = frontendRequire('typescript')
  ;({ compileTemplate, parse: parseSfc } = frontendRequire('@vue/compiler-sfc'))
}

function mayContainHtmlSink(source) {
  if (sinkCandidatePattern.test(source)) {
    return true
  }
  if (source.indexOf('document') < 0 || source.indexOf('write') < 0) {
    return false
  }
  return destructuredDocumentWritePattern.test(source)
}

const htmlWriteProperties = new Map([
  ['innerHTML', 'dom-innerHTML-write'],
  ['outerHTML', 'dom-outerHTML-write'],
  ['srcdoc', 'dom-srcdoc-write'],
  ['srcDoc', 'dom-srcdoc-write']
])

const htmlMethodSinks = new Map([
  ['insertAdjacentHTML', 'dom-insertAdjacentHTML'],
  ['createContextualFragment', 'dom-createContextualFragment']
])

const renderPropSinks = new Map([
  ['innerHTML', 'render-innerHTML-prop'],
  ['outerHTML', 'render-outerHTML-prop'],
  ['srcdoc', 'render-srcdoc-prop'],
  ['srcDoc', 'render-srcdoc-prop']
])

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text
  }
  if (ts.isElementAccessExpression(node)
    && node.argumentExpression
    && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text
  }
  return null
}

function declaredPropertyName(node) {
  if (!node) {
    return null
  }
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isComputedPropertyName(node)
    && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression))) {
    return node.expression.text
  }
  return null
}

function isDocumentExpression(node) {
  if (ts.isIdentifier(node)) {
    return node.text === 'document'
  }
  return propertyName(node) === 'document'
}

function methodSink(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
    return null
  }

  const name = propertyName(node)
  if (name && htmlMethodSinks.has(name)) {
    return htmlMethodSinks.get(name)
  }

  const receiver = node.expression
  if ((name === 'write' || name === 'writeln') && isDocumentExpression(receiver)) {
    return 'dom-document-write'
  }
  if (name === 'parseFromString') {
    return 'domparser-text-html'
  }
  return null
}

function literalText(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text
  }
  return null
}

function boundSink(initializer, aliases) {
  if (!initializer) {
    return null
  }
  if (ts.isIdentifier(initializer)) {
    return aliases.get(initializer.text) ?? null
  }

  const direct = methodSink(initializer)
  if (direct) {
    return direct
  }

  if (ts.isCallExpression(initializer)
    && propertyName(initializer.expression) === 'bind'
    && (ts.isPropertyAccessExpression(initializer.expression) || ts.isElementAccessExpression(initializer.expression))) {
    return methodSink(initializer.expression.expression)
  }
  return null
}

function collectAliases(sourceFile) {
  const aliases = new Map()
  let changed = true
  let pass = 0

  while (changed && pass < 16) {
    changed = false
    pass += 1

    const visit = (node) => {
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          const sink = boundSink(node.initializer, aliases)
          if (sink && aliases.get(node.name.text) !== sink) {
            aliases.set(node.name.text, sink)
            changed = true
          }
        } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
          const receiverIsDocument = isDocumentExpression(node.initializer)
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) {
              continue
            }
            const name = declaredPropertyName(element.propertyName) ?? element.name.text
            let sink = htmlMethodSinks.get(name) ?? null
            if ((name === 'write' || name === 'writeln') && receiverIsDocument) {
              sink = 'dom-document-write'
            }
            if (name === 'parseFromString') {
              sink = 'domparser-text-html'
            }
            if (sink && aliases.get(element.name.text) !== sink) {
              aliases.set(element.name.text, sink)
              changed = true
            }
          }
        }
      }

      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)) {
        const sink = boundSink(node.right, aliases)
        if (sink && aliases.get(node.left.text) !== sink) {
          aliases.set(node.left.text, sink)
          changed = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return aliases
}

function lineAndColumn(source, offset) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  let line = 1
  for (let index = 0; index < lineStart; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

function analyzeScript(source, scriptSource, filePath, baseOffset, diagnostics) {
  const extension = extname(filePath).toLowerCase()
  const scriptKind = extension === '.tsx' || extension === '.jsx'
    ? ts.ScriptKind.TSX
    : extension === '.js' || extension === '.mjs'
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    filePath,
    scriptSource,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  )

  const add = (sink, node) => {
    const location = lineAndColumn(source, baseOffset + node.getStart(sourceFile))
    diagnostics.push({ filePath, sink, ...location })
  }

  for (const parseDiagnostic of sourceFile.parseDiagnostics) {
    const location = lineAndColumn(source, baseOffset + (parseDiagnostic.start ?? 0))
    diagnostics.push({ filePath, sink: 'typescript-parse-error', ...location })
  }

  const aliases = collectAliases(sourceFile)
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = propertyName(node.left)
      const sink = name ? htmlWriteProperties.get(name) : null
      if (sink) {
        add(sink, node.left)
      }
    }

    if (ts.isCallExpression(node)) {
      let sink = methodSink(node.expression)
      if (!sink && ts.isIdentifier(node.expression)) {
        sink = aliases.get(node.expression.text) ?? null
      }
      if (sink === 'domparser-text-html') {
        if (literalText(node.arguments[1])?.toLowerCase() === 'text/html') {
          add(sink, node.expression)
        }
      } else if (sink) {
        add(sink, node.expression)
      }

      if (propertyName(node.expression) === 'setAttribute'
        && literalText(node.arguments[0])?.toLowerCase() === 'srcdoc') {
        add('dom-setAttribute-srcdoc', node.expression)
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = declaredPropertyName(node.name)
      const sink = name ? renderPropSinks.get(name) : null
      if (sink) {
        add(sink, node.name)
      }
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.text
      const sink = renderPropSinks.get(name)
      if (sink) {
        add(`jsx-${sink.slice('render-'.length)}`, node.name)
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function analyzeVueTemplate(source, template, filePath, diagnostics) {
  const result = compileTemplate({
    source: template.content,
    filename: filePath,
    id: 'fsusblog-html-sink-governance'
  })

  for (const error of result.errors) {
    const offset = template.loc.start.offset + (error.loc?.start?.offset ?? 0)
    diagnostics.push({ filePath, sink: 'vue-template-parse-error', ...lineAndColumn(source, offset) })
  }

  const visit = (node) => {
    if (node?.type === 1 && Array.isArray(node.props)) {
      for (const prop of node.props) {
        if (prop.type === 7 && prop.name === 'html') {
          diagnostics.push({
            filePath,
            sink: 'vue-v-html',
            ...lineAndColumn(source, template.loc.start.offset + prop.loc.start.offset)
          })
        }
        const isBoundSrcdoc = prop.type === 7
          && prop.name === 'bind'
          && prop.arg?.type === 4
          && prop.arg.isStatic
          && prop.arg.content.toLowerCase() === 'srcdoc'
        const isStaticSrcdoc = prop.type === 6 && prop.name.toLowerCase() === 'srcdoc'
        if (isBoundSrcdoc || isStaticSrcdoc) {
          diagnostics.push({
            filePath,
            sink: 'vue-srcdoc',
            ...lineAndColumn(source, template.loc.start.offset + prop.loc.start.offset)
          })
        }
      }
    }

    for (const child of node?.children ?? []) {
      visit(child)
    }
    for (const branch of node?.branches ?? []) {
      visit(branch)
    }
  }
  visit(result.ast)
}

export function analyzeHtmlSinks(source, { filePath = 'input.ts' } = {}) {
  // This lexical gate only avoids parser startup for files that cannot spell a
  // governed sink. Every candidate is still accepted or rejected exclusively
  // by the TypeScript/Vue AST rules below.
  if (!mayContainHtmlSink(source)) {
    return []
  }

  loadParsers()
  const diagnostics = []
  if (!filePath.toLowerCase().endsWith('.vue')) {
    analyzeScript(source, source, filePath, 0, diagnostics)
    return diagnostics
  }

  const parsed = parseSfc(source, { filename: filePath })
  for (const error of parsed.errors) {
    const offset = error.loc?.start?.offset ?? 0
    diagnostics.push({ filePath, sink: 'vue-sfc-parse-error', ...lineAndColumn(source, offset) })
  }

  const { descriptor } = parsed
  if (descriptor.template) {
    analyzeVueTemplate(source, descriptor.template, filePath, diagnostics)
  }
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || block.src) {
      continue
    }
    const extension = block.lang === 'tsx' || block.lang === 'jsx'
      ? `.${block.lang}`
      : block.lang === 'js'
        ? '.js'
        : '.ts'
    analyzeScript(source, block.content, `${filePath}${extension}`, block.loc.start.offset, diagnostics)
  }
  return diagnostics
}
