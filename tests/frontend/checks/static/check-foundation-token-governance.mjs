#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []
const legacyPageToken = `--fsus-page: #${'f8f9f7'};`
const legacyBorderToken = `--fsus-border: #${'e4e4df'};`
const legacyDarkBlueToken = `--fsus-scholarly-blue: #${'7aa2e3'};`
const legacyGrayPageToken = `--fsus-page: #${'F7F7F8'};`
const legacyDarkPageToken = `--fsus-page: #${'09090b'};`
const legacyDarkInkToken = `--fsus-ink: #${'f0f0f4'};`
const legacyScholarlyBlueToken = `--fsus-scholarly-blue: #${'2a599c'};`
const legacyDarkScholarlyBlueToken = `--fsus-scholarly-blue: #${'4B79CC'};`
const legacyFsusBackdropSaturate = `--fsus-${'backdrop-saturate'}`
const legacyFsusBackdropBlurSoft = `--fsus-${'backdrop-blur-soft'}`
const legacyTabularNumsVar = `var(--${'tabular-nums'})`
const legacyFsusFontMonoVar = `var(--fsus-${'font-mono'})`
const unregisteredFsusFontFamilyMono = `--fsus-${'font-family-mono'}`
const legacyElementPrimaryBlue = `#${'409eff'}`
const legacyWarmBrownFallback = `#${'4A453C'}`
const canonicalCodeMonoStack = "font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;"

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function walk(path) {
  return readdirSync(resolve(repoRoot, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`
    return entry.isDirectory() ? walk(child) : [child]
  })
}

function expectIncludes(path, source, needle, label = needle) {
  if (!source.includes(needle)) {
    errors.push(`${path}: missing ${label}`)
  }
}

function expectNotIncludes(path, source, needle, label = needle) {
  if (source.includes(needle)) {
    errors.push(`${path}: must not contain ${label}`)
  }
}

const publicPagePath = 'src/frontend/src/assets/public-page.css'
const publicShellPath = 'src/frontend/src/assets/public-shell-foundation.css'
const motionPath = 'src/frontend/src/assets/motion.css'
const tailwindPath = 'src/frontend/src/assets/tailwind.css'
const markdownPath = 'src/frontend/src/assets/markdown.css'
const accountShellPath = 'src/frontend/src/assets/account-shell.css'
const moderationAuditPath = 'src/frontend/src/views/admin/moderation/ModerationAudit.vue'
const messagesPath = 'src/frontend/src/components/user/messages/MessagesConversationList.vue'
const identityPath = 'src/frontend/src/views/user/IdentityCenter.vue'
const complianceFooterPath = 'src/frontend/src/components/public/PublicComplianceFooter.vue'
const packagePath = 'src/frontend/package.json'

const publicPage = read(publicPagePath)
const publicShell = read(publicShellPath)
const motion = read(motionPath)
const tailwind = read(tailwindPath)
const markdown = read(markdownPath)
const accountShell = read(accountShellPath)
const moderationAudit = read(moderationAuditPath)
const messages = read(messagesPath)
const identity = read(identityPath)
const complianceFooter = read(complianceFooterPath)
const packageJson = JSON.parse(read(packagePath))

for (const path of walk('src/frontend/src')) {
  const source = read(path)
  expectNotIncludes(path, source.toLowerCase(), legacyElementPrimaryBlue, 'Element Plus primary-blue fallback')
  expectNotIncludes(path, source, legacyWarmBrownFallback, 'warm-brown interaction fallback')
  expectNotIncludes(path, source, unregisteredFsusFontFamilyMono, 'unregistered FsusUI mono-font alias')
}

for (const [path, source] of [
  [publicPagePath, publicPage],
  [publicShellPath, publicShell]
]) {
  expectIncludes(path, source, '--bg: #F7F7F8;', '--bg light token')
  expectIncludes(path, source, '--surface: #FFFFFF;', '--surface light token')
  expectIncludes(path, source, '--text: #0F0F11;', '--text light token')
  expectIncludes(path, source, '--border: #E4E4E7;', '--border light token')
  expectIncludes(path, source, '--accent: #2A599C;', '--accent light token')
  expectIncludes(path, source, '--accent-hover: #244E89;', '--accent-hover light token')
  expectIncludes(path, source, '--link: var(--accent);', '--link accent alias')
  expectIncludes(path, source, '--link-hover: var(--accent-hover);', '--link-hover accent alias')
  expectIncludes(path, source, '--bg: #09090B;', '--bg dark token')
  expectIncludes(path, source, '--surface: #121214;', '--surface dark token')
  expectIncludes(path, source, '--text: #F0F0F4;', '--text dark token')
  expectIncludes(path, source, '--border: #27272A;', '--border dark token')
  expectIncludes(path, source, '--accent: #4B79CC;', '--accent dark token')
  expectIncludes(path, source, '--accent-hover: #6F93D7;', '--accent-hover dark token')
  expectIncludes(path, source, '--fsus-page: var(--bg);', '--fsus-page palette alias')
  expectIncludes(path, source, '--fsus-border: var(--border);', '--fsus-border palette alias')
  expectIncludes(path, source, '--fsus-scholarly-blue: var(--accent);', '--fsus Scholarly Blue accent alias')
  expectIncludes(path, source, '--fsusblog-color-primary: var(--fsus-color-action-primary, var(--accent, LinkText));', '--fsusblog primary FsusUI alias')
  expectIncludes(path, source, '--fsusblog-color-focus-ring: var(--fsus-color-focus-ring, var(--accent, Highlight));', '--fsusblog focus ring FsusUI alias')
  expectIncludes(path, source, '--fsusblog-text-primary: var(--fsus-color-text-primary, var(--text));', '--fsusblog primary text FsusUI alias')
  expectIncludes(path, source, '--fsusblog-text-quiet: var(--fsus-color-text-quiet, #A1A1AA);', '--fsusblog quiet text FsusUI alias')
  expectIncludes(path, source, '--fsusblog-text-decorative: var(--fsus-color-text-decorative, var(--text-decorative));', '--fsusblog decorative text FsusUI alias')
  expectIncludes(path, source, '--fsusblog-reading-inline-code-bg: var(--fsus-color-surface-raised, var(--surface-subtle));', '--fsusblog inline code raised surface FsusUI alias')
  expectNotIncludes(path, source, legacyPageToken, 'legacy green-tinted page token')
  expectNotIncludes(path, source, legacyBorderToken, 'legacy yellow-tinted border token')
  expectNotIncludes(path, source, legacyDarkBlueToken, 'legacy dark Scholarly Blue token')
  expectNotIncludes(path, source, legacyGrayPageToken, 'legacy neutral-gray light page token')
  expectNotIncludes(path, source, legacyDarkPageToken, 'legacy near-black dark page token')
  expectNotIncludes(path, source, legacyDarkInkToken, 'legacy cool dark ink token')
  expectNotIncludes(path, source, legacyScholarlyBlueToken, 'legacy light Scholarly Blue token')
  expectNotIncludes(path, source, legacyDarkScholarlyBlueToken, 'legacy dark Scholarly Blue token')
  expectNotIncludes(path, source, legacyFsusBackdropSaturate, `unregistered ${legacyFsusBackdropSaturate} alias`)
  expectNotIncludes(path, source, legacyFsusBackdropBlurSoft, `unregistered ${legacyFsusBackdropBlurSoft} alias`)
}

expectIncludes(publicPagePath, publicPage, '--fsusblog-backdrop-saturate: 100%;')
expectIncludes(publicShellPath, publicShell, '--fsusblog-backdrop-saturate: 100%;')
expectIncludes(publicShellPath, publicShell, '--fsusblog-backdrop-blur-soft: 0px;')
expectIncludes(publicShellPath, publicShell, 'blur(var(--fsusblog-backdrop-blur-soft)) saturate(var(--fsusblog-backdrop-saturate))')

for (const token of [
  '--blog-motion-fast: var(--fsus-motion-control-fast, 140ms);',
  '--blog-motion-control: var(--fsus-motion-control, 220ms);',
  '--blog-motion-panel: var(--fsus-motion-panel, 360ms);',
  '--blog-motion-overlay: var(--fsus-motion-overlay, 300ms);',
  '--blog-motion-ease: var(--fsus-motion-standard, cubic-bezier(0.4, 0, 0.2, 1));',
  '--blog-motion-ease-emphasized: var(--fsus-motion-emphasized, var(--fsus-motion-standard, cubic-bezier(0.4, 0, 0.2, 1)));'
]) {
  expectIncludes(motionPath, motion, token)
}
for (const forbidden of ['120ms', '180ms', 'var(--fsus-motion-panel, 220ms)', '--blog-motion-ease: var(--fsus-motion-standard, ease)']) {
  expectNotIncludes(motionPath, motion, forbidden)
}

expectIncludes(
  tailwindPath,
  tailwind,
  '--font-sans: "Google Sans", \'Noto Sans SC\', \'Noto Sans TC\', \'Noto Sans JP\', \'PingFang SC\', \'Microsoft YaHei\', \'Helvetica Neue\', Arial, sans-serif;'
)
expectIncludes(
  tailwindPath,
  tailwind,
  '--font-mono: "JetBrains Mono", \'PingFang SC\', \'Microsoft YaHei\', "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Helvetica Neue", Arial, monospace;'
)
expectIncludes(markdownPath, markdown, canonicalCodeMonoStack, 'canonical Markdown code font stack')
expectIncludes(moderationAuditPath, moderationAudit, canonicalCodeMonoStack, 'canonical moderation audit code font stack')

expectNotIncludes(messagesPath, messages, legacyTabularNumsVar)
expectIncludes(messagesPath, messages, 'font-variant-numeric: tabular-nums;')
expectNotIncludes(identityPath, identity, legacyFsusFontMonoVar)
expectIncludes(identityPath, identity, 'font-family: var(--font-mono);')

expectIncludes(publicShellPath, publicShell, '--fsusblog-public-overlay-radius: var(--fsus-radius-popover, 10px);')
expectIncludes(markdownPath, markdown, 'border-radius: var(--fsus-radius-panel, 12px);')
expectIncludes(markdownPath, markdown, 'border-radius: var(--fsus-radius-control-small, 4px)')
expectIncludes(markdownPath, markdown, 'border-radius: var(--fsus-radius-control, 6px);')
expectIncludes(accountShellPath, accountShell, 'border-radius: var(--fsus-radius-control, 6px);')

expectIncludes(complianceFooterPath, complianceFooter, 'transition-transform group-hover:-translate-y-px')

const scripts = packageJson.scripts ?? {}
expectIncludes(packagePath, String(scripts['check:foundation-token-governance'] ?? ''), 'check-foundation-token-governance.mjs')
expectIncludes(packagePath, String(scripts['check:views-constraints'] ?? ''), 'check:foundation-token-governance')

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[foundation-token-governance] ${error}`)
  }
  process.exit(1)
}

console.log('[foundation-token-governance] ok')
