import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const requireText = (text, token, label) => {
  if (!text.includes(token)) throw new Error(`${label} missing ${token}`)
}
const forbidText = (text, token, label) => {
  if (text.includes(token)) throw new Error(`${label} still contains ${token}`)
}

const policy = read('src/backend/Services/Security/AnonymousCommentPolicyService.cs')
const resolver = read('src/backend/Services/Security/CommentActorResolver.cs')
const endpoints = read('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs')
const migration = read('src/migration/Definitions/CommentAuthorModeRetirementMigrationDefinitions.cs')
const frontend = read('src/frontend/src/composables/useArticleDetailView.ts')
const composer = read('src/frontend/src/components/article/ArticleCommentComposer.vue')
const matrix = read('security/matrices/privacy-zk-comment.yml')

requireText(policy, 'anonymous_author_mode_retired', 'policy')
requireText(policy, 'public_opt_in_required', 'policy')
requireText(policy, 'zk_anonymous_disabled', 'policy')
forbidText(resolver, 'DeriveEngineeringNullifierHash', 'actor resolver')
forbidText(resolver, 'fsus.anonymous.nullifier.v2', 'actor resolver')
requireText(endpoints, 'RequireStrongAnonymousRequest()', 'strong anonymous endpoints')
requireText(migration, "author_mode = 'legacy_server_visible_pseudonymous'", 'migration')
requireText(migration, 'DELETE FROM comment_anonymous_nullifier', 'migration')
requireText(migration, 'anonymous_nullifier_hash = NULL', 'migration')
forbidText(frontend, 'submitOrdinaryAnonymousComment', 'frontend')
forbidText(frontend, "authorMode: 'anonymous'", 'frontend')
forbidText(composer, "value=\"anonymous\"", 'composer')
requireText(matrix, 'PRIVACY-ZK-AUTHOR-MODE-RETIREMENT', 'privacy matrix')

console.log('[comment-author-mode-retirement] production modes, migration and no-downgrade contract OK')
