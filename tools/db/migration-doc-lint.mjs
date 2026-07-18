#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.env.FSUSBLOG_REPO_ROOT
  ? path.resolve(process.env.FSUSBLOG_REPO_ROOT)
  : path.resolve(import.meta.dirname, '../..')

const docsPath = path.join(root, 'docs/database-migration.md')
const registryPath = path.join(root, 'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs')
const migrationRoot = path.dirname(registryPath)
const definitionsPath = path.join(migrationRoot, 'Definitions')
const catalogsPath = path.join(migrationRoot, 'Catalogs')
const manifestPath = path.join(migrationRoot, 'SchemaMigrationManifest.cs')

const expectedRows = [
  {
    column: 'sys_user.username',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy password-login identity only',
    droppedAtVersion: '20260621-post-user-legacy-identity-columns-finalize',
    registry: { drop: ['sys_user', 'username'] }
  },
  {
    column: 'sys_user.password',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy password-login credential only',
    droppedAtVersion: '20260621-post-user-legacy-identity-columns-finalize',
    registry: { drop: ['sys_user', 'password'] }
  },
  {
    column: 'sys_user.role',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy role authority only',
    droppedAtVersion: '20260621-post-user-legacy-identity-columns-finalize',
    registry: { drop: ['sys_user', 'role'] }
  },
  {
    column: 'sys_user.lastusernameupdatetime',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy username rename throttle only',
    droppedAtVersion: '20260621-post-user-legacy-identity-columns-finalize',
    registry: { drop: ['sys_user', 'lastusernameupdatetime'] }
  },
  {
    column: 'sys_user.last_username_update_time',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy username rename throttle only',
    droppedAtVersion: '20260621-post-user-legacy-identity-columns-finalize',
    registry: { drop: ['sys_user', 'last_username_update_time'] }
  },
  {
    column: 'sys_user.refreshtoken',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy plaintext refresh-token cleanup only',
    droppedAtVersion: '20260602-post-user-auth-security-hardening',
    registry: { drop: ['sys_user', 'refreshtoken'] }
  },
  {
    column: 'sys_user.refreshtokenexpirytime',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy plaintext refresh-token cleanup only',
    droppedAtVersion: '20260602-post-user-auth-security-hardening',
    registry: { drop: ['sys_user', 'refreshtokenexpirytime'] }
  },
  {
    column: 'sys_user.refresh_token',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy plaintext refresh-token cleanup only',
    droppedAtVersion: '20260602-post-user-auth-security-hardening',
    registry: { drop: ['sys_user', 'refresh_token'] }
  },
  {
    column: 'sys_user.refresh_token_expiry_time',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy plaintext refresh-token cleanup only',
    droppedAtVersion: '20260602-post-user-auth-security-hardening',
    registry: { drop: ['sys_user', 'refresh_token_expiry_time'] }
  },
  {
    column: 'sys_user.lastloginip',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy login observation only',
    droppedAtVersion: '20260621-post-sys-user-security-profile-split-finalize',
    registry: { drop: ['sys_user', 'lastloginip'] }
  },
  {
    column: 'sys_user.lastlogintime',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy login observation only',
    droppedAtVersion: '20260621-post-sys-user-security-profile-split-finalize',
    registry: { drop: ['sys_user', 'lastlogintime'] }
  },
  {
    column: 'sys_user.mfasecretencrypted',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'migrated to user_mfa_profile.mfa_secret_encrypted',
    droppedAtVersion: '20260621-post-sys-user-security-profile-split-finalize',
    registry: { drop: ['sys_user', 'mfasecretencrypted'], copiedTo: 'mfa_secret_encrypted' }
  },
  {
    column: 'sys_user.mfapendingsecretencrypted',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'migrated to user_mfa_profile.mfa_pending_secret_encrypted',
    droppedAtVersion: '20260621-post-sys-user-security-profile-split-finalize',
    registry: { drop: ['sys_user', 'mfapendingsecretencrypted'], copiedTo: 'mfa_pending_secret_encrypted' }
  },
  {
    column: 'sys_user.mfapendingcreatedat',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'migrated to user_mfa_profile.mfa_pending_created_at',
    droppedAtVersion: '20260621-post-sys-user-security-profile-split-finalize',
    registry: { drop: ['sys_user', 'mfapendingcreatedat'], copiedTo: 'mfa_pending_created_at' }
  },
  {
    column: 'sys_user.mfaverifiedat',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'migrated to user_mfa_profile.mfa_verified_at',
    droppedAtVersion: '20260621-post-sys-user-security-profile-split-finalize',
    registry: { drop: ['sys_user', 'mfaverifiedat'], copiedTo: 'mfa_verified_at' }
  },
  {
    column: 'sys_user.mfarecoverycodeshash',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'migrated to user_mfa_profile.mfa_recovery_codes_hash',
    droppedAtVersion: '20260621-post-sys-user-security-profile-split-finalize',
    registry: { drop: ['sys_user', 'mfarecoverycodeshash'], copiedTo: 'mfa_recovery_codes_hash' }
  },
  {
    column: 'comment.user_id',
    physical: 'present nullable',
    codeMapped: 'yes',
    keptFor: 'explicit public attribution compatibility',
    droppedAtVersion: 'n/a',
    registry: { ensureOrReference: ['comment', 'user_id'], notDropped: true }
  },
  {
    column: 'comment.reply_to_user_id',
    physical: 'present nullable',
    codeMapped: 'yes',
    keptFor: 'legacy public reply projection',
    droppedAtVersion: 'n/a',
    registry: { ensure: ['comment', 'reply_to_user_id'], notDropped: true }
  },
  {
    column: 'comment.moderated_by_user_id',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'renamed to comment.moderated_by_admin_principal_id',
    droppedAtVersion: '20260621-pre-comment-moderation-admin-principal-attribution',
    registry: {
      rename: ['comment', 'moderated_by_user_id', 'moderated_by_admin_principal_id'],
      drop: ['comment', 'moderated_by_user_id']
    }
  },
  {
    column: 'sys_user.account_subject_hash',
    physical: 'present nullable during rolling expand',
    codeMapped: 'yes',
    keptFor: 'stable account subject projection; startup gate requires every row populated',
    droppedAtVersion: 'n/a',
    registry: { ensure: ['sys_user', 'account_subject_hash'], notDropped: true }
  },
  {
    column: 'sys_visit_log.userid',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy human-read account binding only',
    droppedAtVersion: '20260621-post-visit-log-anonymous-attribution-finalize',
    registry: { drop: ['sys_visit_log', 'userid'] }
  },
  {
    column: 'sys_visit_log.user_id',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'legacy human-read account binding only',
    droppedAtVersion: '20260621-post-visit-log-anonymous-attribution-finalize',
    registry: { drop: ['sys_visit_log', 'user_id'] }
  },
  {
    column: 'sys_visit_log.ip',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'replaced transitionally by sys_visit_log.ip_hash before full table retirement',
    droppedAtVersion: '20260621-post-visit-log-ip-anonymization',
    registry: { drop: ['sys_visit_log', 'ip'], replacement: 'ip_hash' }
  },
  {
    column: 'sys_visit_log',
    physical: 'dropped',
    codeMapped: 'no',
    keptFor: 'event-level read trajectory table retired in favor of aggregate-only tables',
    droppedAtVersion: '20260715-post-read-event-retirement',
    registry: { dropTable: 'sys_visit_log' }
  }
]

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function readSourceDirectory(directory) {
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.cs'))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((name) => ({ name, source: readFile(path.join(directory, name)) }))
}

function fail(message) {
  errors.push(message)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function parseFinalStateTable(markdown) {
  const heading = markdown.match(/^## 字段最终态表\s*$/mu)
  if (!heading) {
    fail('docs/database-migration.md 缺少 "## 字段最终态表" 标题')
    return new Map()
  }

  const section = markdown.slice(heading.index)
  const nextHeadingIndex = section.slice(heading[0].length).search(/^##\s+/mu)
  const body = nextHeadingIndex === -1
    ? section
    : section.slice(0, heading[0].length + nextHeadingIndex)
  const rows = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))

  const header = rows[0]
  const normalizedHeader = header
    ?.split('|')
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join('|')

  if (normalizedHeader !== 'column|physical|code-mapped|kept-for|dropped-at-version') {
    fail('字段最终态表表头必须是 column | physical | code-mapped | kept-for | dropped-at-version')
    return new Map()
  }

  const table = new Map()
  for (const rawRow of rows.slice(2)) {
    const cells = rawRow
      .split('|')
      .map((cell) => cell.trim())
      .filter((_, index, all) => index > 0 && index < all.length - 1)

    if (cells.length !== 5) {
      fail(`字段最终态表行列数错误: ${rawRow}`)
      continue
    }

    const [column, physical, codeMapped, keptFor, droppedAtVersion] = cells
    table.set(column.replaceAll('`', ''), {
      column: column.replaceAll('`', ''),
      physical,
      codeMapped,
      keptFor,
      droppedAtVersion
    })
  }

  return table
}

function assertRegistryState(registry, rule) {
  const checks = rule.registry ?? {}
  if (checks.drop) {
    const [table, column] = checks.drop
    const pattern = new RegExp(`new\\s+DropColumnStep\\(\\s*"${escapeRegExp(table)}",\\s*"${escapeRegExp(column)}"\\s*,`, 'u')
    if (!pattern.test(registry)) {
      fail(`${rule.column} 文档标记为 dropped，但 migration definitions 缺少 DropColumnStep("${table}", "${column}")`)
    }
  }

  if (checks.ensure) {
    const [table, column] = checks.ensure
    const pattern = new RegExp(`new\\s+EnsureColumnStep\\(\\s*"${escapeRegExp(table)}",\\s*"${escapeRegExp(column)}"`, 'u')
    if (!pattern.test(registry)) {
      fail(`${rule.column} 文档标记为保留，但 migration definitions 缺少 EnsureColumnStep("${table}", "${column}", ...)`)
    }
  }

  if (checks.dropTable) {
    const pattern = new RegExp(`new\\s+DropTableStep\\(\\s*"${escapeRegExp(checks.dropTable)}"\\s*,`, 'u')
    if (!pattern.test(registry)) {
      fail(`${rule.column} 文档标记为 dropped，但 migration definitions 缺少 DropTableStep("${checks.dropTable}")`)
    }
  }

  if (checks.ensureOrReference) {
    const [table, column] = checks.ensureOrReference
    const pattern = new RegExp(`table_name\\s*=\\s*'${escapeRegExp(table)}'[\\s\\S]+column_name\\s*=\\s*'${escapeRegExp(column)}'`, 'u')
    if (!pattern.test(registry)) {
      fail(`${rule.column} 文档标记为保留，但 migration definitions 缺少 ${table}.${column} 兼容引用`)
    }
  }

  if (checks.rename) {
    const [table, from, to] = checks.rename
    const pattern = new RegExp(`new\\s+RenameColumnStep\\(\\s*"${escapeRegExp(table)}",\\s*"${escapeRegExp(from)}",\\s*"${escapeRegExp(to)}"\\)`, 'u')
    if (!pattern.test(registry)) {
      fail(`${rule.column} 文档标记为 rename legacy，但 migration definitions 缺少 RenameColumnStep("${table}", "${from}", "${to}")`)
    }
  }

  if (checks.notDropped) {
    const [table, column] = rule.column.split('.')
    const pattern = new RegExp(`new\\s+DropColumnStep\\(\\s*"${escapeRegExp(table)}",\\s*"${escapeRegExp(column)}"(?:\\s*,|\\s*\\))`, 'u')
    if (pattern.test(registry)) {
      fail(`${rule.column} 文档标记为保留，但 migration definitions 存在 DropColumnStep("${table}", "${column}")`)
    }
  }

  for (const literal of [checks.copiedTo, checks.replacement].filter(Boolean)) {
    if (!registry.includes(literal)) {
      fail(`${rule.column} 文档标记的迁移目标 ${literal} 未出现在 migration definitions`)
    }
  }

  if (rule.droppedAtVersion !== 'n/a' && !registry.includes(rule.droppedAtVersion)) {
    fail(`${rule.column} 的 dropped-at-version ${rule.droppedAtVersion} 未出现在 migration definitions`)
  }
}

function assertCatalogStructure(registry, definitions, catalogs, manifest) {
  if (registry.includes('partial class SchemaMigrationRegistry')) {
    fail('SchemaMigrationRegistry 必须是 manifest 的薄适配器，不得继续声明 partial 聚合')
  }
  if (registry.includes('new SchemaMigrationDescriptor(') || /Build\w+Migration\(\)/u.test(registry)) {
    fail('SchemaMigrationRegistry 不得直接声明或追加 migration descriptor')
  }

  const legacyRegistryPartials = fs.readdirSync(migrationRoot)
    .filter((name) => /^SchemaMigrationRegistry\..+\.cs$/u.test(name))
  if (legacyRegistryPartials.length > 0) {
    fail(`旧 SchemaMigrationRegistry partial 文件仍存在: ${legacyRegistryPartials.join(', ')}`)
  }

  const definitionMethods = definitions.flatMap(({ name, source }) => {
    if (source.includes('partial class')) {
      fail(`migration definition 不得继续使用巨型 partial 类型: ${name}`)
    }
    return [...source.matchAll(/internal static ISchemaMigrationDescriptor (Build\w+Migration)\(\)/gu)]
      .map((match) => match[1])
  })
  const catalogMethods = catalogs.flatMap(({ source }) =>
    [...source.matchAll(/\w+MigrationDefinitions\.(Build\w+Migration)\(\)/gu)]
      .map((match) => match[1]))

  const duplicateDefinitionMethods = definitionMethods
    .filter((method, index) => definitionMethods.indexOf(method) !== index)
  const duplicateCatalogMethods = catalogMethods
    .filter((method, index) => catalogMethods.indexOf(method) !== index)
  if (duplicateDefinitionMethods.length > 0) {
    fail(`migration definition method 重复: ${[...new Set(duplicateDefinitionMethods)].join(', ')}`)
  }
  if (duplicateCatalogMethods.length > 0) {
    fail(`migration catalog 重复注册 descriptor: ${[...new Set(duplicateCatalogMethods)].join(', ')}`)
  }

  const sortedDefinitions = [...definitionMethods].sort()
  const sortedCatalogs = [...catalogMethods].sort()
  if (JSON.stringify(sortedDefinitions) !== JSON.stringify(sortedCatalogs)) {
    const missing = sortedDefinitions.filter((method) => !sortedCatalogs.includes(method))
    const unknown = sortedCatalogs.filter((method) => !sortedDefinitions.includes(method))
    fail(`migration catalog/definition 不一致: missing=[${missing.join(', ')}], unknown=[${unknown.join(', ')}]`)
  }

  for (const { name, source } of catalogs.filter(({ name }) => /^SchemaMigrationCatalog\d+To\d+\.cs$/u.test(name))) {
    const typeMatch = source.match(/internal static class (SchemaMigrationCatalog\d+To\d+)/u)
    if (!typeMatch || !manifest.includes(`${typeMatch[1]}.Create()`)) {
      fail(`主 manifest 未注册 catalog: ${name}`)
    }
  }
}

const errors = []
const docs = readFile(docsPath)
const registryAdapter = readFile(registryPath)
const definitions = readSourceDirectory(definitionsPath)
const catalogs = readSourceDirectory(catalogsPath)
const registry = definitions.map(({ source }) => source).join('\n')
const manifest = readFile(manifestPath)
const docRows = parseFinalStateTable(docs)

assertCatalogStructure(registryAdapter, definitions, catalogs, manifest)

for (const expected of expectedRows) {
  const actual = docRows.get(expected.column)
  if (!actual) {
    fail(`字段最终态表缺少 ${expected.column}`)
    continue
  }

  for (const key of ['physical', 'codeMapped', 'keptFor', 'droppedAtVersion']) {
    if (actual[key] !== expected[key]) {
      fail(`${expected.column} 的 ${key} 不一致: expected "${expected[key]}", actual "${actual[key]}"`)
    }
  }

  assertRegistryState(registry, expected)
}

for (const documentedColumn of docRows.keys()) {
  if (!expectedRows.some((row) => row.column === documentedColumn)) {
    fail(`字段最终态表包含未纳入 lint 规则的列: ${documentedColumn}`)
  }
}

if (errors.length > 0) {
  console.error('migration-doc-lint failed:')
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

console.log(`migration-doc-lint passed: ${expectedRows.length} legacy identity fields checked`)
