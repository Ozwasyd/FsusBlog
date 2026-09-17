import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { validateCancellationTokenSourceOwnership } from '../../tools/governance/check-cancellation-token-source-ownership.mjs'

test('CTS ownership governance rejects all known owner-loss fixtures', () => {
    assert.match(validateCancellationTokenSourceOwnership('return new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token;')[0], /discards/u)
    assert.match(validateCancellationTokenSourceOwnership(`
        private CancellationToken TimeoutToken
            => new CancellationTokenSource(
                TimeSpan.FromSeconds(5)).Token;
    `)[0], /discards/u)
    assert.match(validateCancellationTokenSourceOwnership('return CancellationTokenSource.CreateLinkedTokenSource(parent).Token;')[0], /linked/u)
    assert.match(validateCancellationTokenSourceOwnership('private static readonly CancellationToken token = new CancellationTokenSource();')[0], /static/u)
    assert.match(validateCancellationTokenSourceOwnership('private static readonly List<CancellationTokenSource> owners = [];')[0], /collection/u)
})

test('production source has no CTS token owner-loss path', () => {
    const root = path.resolve('src')
    const files = fs.readdirSync(root, { recursive: true }).filter((entry) => String(entry).endsWith('.cs'))
    const failures = files.flatMap((entry) => {
        const file = path.join(root, entry)
        return validateCancellationTokenSourceOwnership(fs.readFileSync(file, 'utf8'), file)
    })
    assert.deepEqual(failures, [])
})

test('bounded production timeouts retain their existing five-second behavior and never fall back to None', () => {
    const commentService = fs.readFileSync(path.resolve('src/backend/Services/CommentService.cs'), 'utf8')
    assert.match(commentService, /s_shortOperationTimeout\s*=\s*TimeSpan\.FromSeconds\(5\)/u)
    assert.doesNotMatch(commentService, /ShortCancellationToken|TimeoutCancellationScope\.Create\(CancellationToken\.None/u)

    const notificationStream = fs.readFileSync(
        path.resolve('src/backend/Infrastructure/NotificationStream/NotificationStreamSessionService.cs'),
        'utf8')
    assert.match(notificationStream, /s_closeTimeout\s*=\s*TimeSpan\.FromSeconds\(5\)/u)
    assert.match(notificationStream, /TimeoutCancellationScope\.Create\(s_closeTimeout\)/u)
    assert.doesNotMatch(notificationStream, /WaitAsync\(CancellationToken\.None\)/u)
})
