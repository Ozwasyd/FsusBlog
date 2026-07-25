#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const endpoints = read('src/backend/Modules/Endpoints/SubscriptionEndpoints.cs')
const entities = read('src/backend/Entities/Article.cs')
const contracts = read('docs/api/contracts.md')
const security = read('docs/security.md')
const entityMatch = entities.match(/public class SiteSubscription[\s\S]*?^}/m)
assert(entityMatch, 'SiteSubscription entity block not found')
const entityBlock = entityMatch[0]

assert(entities.includes('HashVersion'), 'SiteSubscription must store HashVersion')
assert(entities.includes('"hmac-v1"'), 'SiteSubscription HashVersion must be hmac-v1')
assert(endpoints.includes('SiteSubscriptionIdentity.HashEmail'), 'subscription endpoint must delegate to canonical keyed HMAC helper')
assert(!endpoints.includes('SHA256.HashData'), 'subscription endpoint must not use bare SHA256 without HMAC key')
assert(!endpoints.includes('SmtpClient'), 'subscription endpoint must not send email directly')
assert(!endpoints.includes('WebPush'), 'subscription endpoint must not send Web Push directly')
assert(!endpoints.includes('SendGrid'), 'subscription endpoint must not depend on external email provider')
assert(!endpoints.includes('Results.Ok(JsonApiResponse<object>.Ok(new { subscribed = true, channel = NormalizeChannel(request.Channel), email'), 'subscription response must not echo raw email')
assert(contracts.includes('不保存明文 email'), 'contracts must document no raw email storage')
assert(security.includes('不保存明文 email'), 'security doc must document no raw email storage')
assert(security.includes('不构建读者画像或社交关系链'), 'security doc must reject reader profiling/social graph')

console.log('[check-subscription-privacy] ok')
