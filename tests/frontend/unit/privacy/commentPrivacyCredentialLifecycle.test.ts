import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  purgeCommentPrivacyCredentialState,
  registerCommentPrivacyCredentialPurgeHandler,
  resetCommentPrivacyCredentialLifecycleForTests
} from '@/privacy/commentPrivacyCredentialLifecycle'

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []
  readonly messages: unknown[] = []
  private readonly listeners = new Set<(event: MessageEvent) => void>()

  readonly name: string

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }

  close(): void {}

  dispatch(message: unknown): void {
    for (const listener of this.listeners) {
      listener(new MessageEvent('message', { data: message }))
    }
  }
}

describe('comment privacy credential lifecycle', () => {
  beforeEach(() => {
    resetCommentPrivacyCredentialLifecycleForTests()
    MockBroadcastChannel.instances = []
    Object.defineProperty(window, 'BroadcastChannel', {
      value: MockBroadcastChannel,
      configurable: true
    })
  })

  afterEach(() => {
    resetCommentPrivacyCredentialLifecycleForTests()
  })

  it('purges both the sending and receiving tab without rebroadcast loops or identity payloads', async () => {
    const purgeHandler = vi.fn()
    registerCommentPrivacyCredentialPurgeHandler(purgeHandler)

    await purgeCommentPrivacyCredentialState('logout')
    const channel = MockBroadcastChannel.instances[0]
    const [message] = channel.messages

    expect(purgeHandler).toHaveBeenCalledWith('logout')
    expect(JSON.stringify(message)).not.toMatch(/userId|accountId|sessionId|generation/i)

    channel.dispatch(message)
    await vi.waitFor(() => expect(purgeHandler).toHaveBeenCalledTimes(2))
    expect(channel.messages).toHaveLength(1)
  })

  it('falls back safely when BroadcastChannel construction fails', async () => {
    Object.defineProperty(window, 'BroadcastChannel', {
      value: class BrokenBroadcastChannel {
        constructor() {
          throw new Error('blocked')
        }
      },
      configurable: true
    })
    const handler = vi.fn()

    expect(() => registerCommentPrivacyCredentialPurgeHandler(handler)).not.toThrow()
    await expect(purgeCommentPrivacyCredentialState('panic')).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalledWith('panic')
  })

  it('runs every purge handler and exposes incomplete cleanup to the caller', async () => {
    const completed = vi.fn()
    registerCommentPrivacyCredentialPurgeHandler(() => {
      throw new Error('worker cleanup failed')
    })
    registerCommentPrivacyCredentialPurgeHandler(completed)

    await expect(purgeCommentPrivacyCredentialState('panic', { broadcast: false }))
      .rejects.toThrow('comment_privacy_credential_purge_incomplete')
    expect(completed).toHaveBeenCalledWith('panic')
  })
})
