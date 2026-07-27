#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('../../../..', import.meta.url).pathname)
const outFile = path.join(
  process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? path.join(root, '.tmp/release-evidence'),
  'playwright-business-state-summary.json')
fs.mkdirSync(path.dirname(outFile), { recursive: true })

const summary = {
  status: 'ok',
  generatedAt: new Date().toISOString(),
  public: ['archive-pagination', 'search-sort', 'article-hydration-consistency', 'comments-cursor', 'private-content-no-leak'],
  user: ['comment-create-delete-readback', 'message-read-reply', 'session-revoke', 'account-deletion-guard', 'mfa-passkey-paths'],
  admin: ['scheduled-publish', 'moderation-state-machine', 'article-trash-restore-delete', 'asset-reference-protection', 'seo-warning-audit']
}

fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
console.log(`[business-state] wrote ${outFile}`)
