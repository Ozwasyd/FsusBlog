import { describe, expect, it } from 'vitest'
import {
  createCommentPrivacyWorkerClient,
  resetCommentPrivacyWorkerClientForTests,
  getCommentPrivacyWorkerClient
} from '@/privacy/commentPrivacyWorkerClient'

describe('commentPrivacyWorkerClient', () => {
  it('uses one lazy worker instance and transfers proof input buffers', async () => {
    const created: FakePrivacyWorker[] = []
    const client = createCommentPrivacyWorkerClient({
      timeoutMs: 1_000,
      workerFactory: () => {
        const worker = new FakePrivacyWorker()
        created.push(worker)
        return worker as unknown as Worker
      }
    })

    await client.prewarm()
    const proof = await client.prepareProof({
      scope: 'article:42',
      rootVersion: 'root-v1',
      metadataBytes: new Uint8Array([1, 2, 3]),
      credentialEpoch: 20260618,
      circuitNumericId: 7,
      publicInputLayoutVersion: 6,
      circuitId: 'fsus.anonymous.comment.v5',
      verifyingKeyHash: 'a'.repeat(64),
      issuerPublicKeyHash: 'b'.repeat(64),
      policyHash: '9'.repeat(64),
      credentialCommitment: new Uint8Array([3]),
      credentialRoot: new Uint8Array([4]),
      revocationRoot: new Uint8Array([5]),
      circuitMetadata: new Uint8Array([6]),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low'
    })

    expect(created).toHaveLength(1)
    expect(proof.proofBytes).toEqual(new Uint8Array([7, 8, 9]))
    expect(proof.publicInputs).toEqual(new Uint8Array([10, 11]))
    expect(proof.nullifierHash).toEqual(new Uint8Array([12, 13]))
    expect(created[0].messages).toHaveLength(2)
    expect(created[0].messages[1].transfer).toHaveLength(5)
    const transferred = created[0].messages[1].transfer.map((buffer) => {
      expect(buffer).toBeInstanceOf(ArrayBuffer)
      if (!(buffer instanceof ArrayBuffer)) throw new Error('proof inputs must use owned transferable buffers')
      return buffer
    })
    expect(transferred[0].byteLength).toBe(3)
    expect(transferred[1].byteLength).toBe(1)
    expect(transferred[2].byteLength).toBe(1)
    expect(transferred[3].byteLength).toBe(1)
    expect(transferred[4].byteLength).toBe(1)
    expect(created[0].messages[1].message.verifyingKeyHash).toBe('a'.repeat(64))
    expect(created[0].messages[1].message.policyHash).toBe('9'.repeat(64))
    expect(created[0].messages[1].message.credentialLevel).toBe('strong_anonymous')
    expect(Object.keys(proof).sort()).toEqual(['nullifierHash', 'proofBytes', 'publicInputs'])

    client.dispose()
    expect(created[0].terminated).toBe(true)
  })

  it('exposes a resettable lazy singleton for article pages', () => {
    resetCommentPrivacyWorkerClientForTests()
    const first = getCommentPrivacyWorkerClient()
    const second = getCommentPrivacyWorkerClient()

    expect(first).toBe(second)
    resetCommentPrivacyWorkerClientForTests()
  })
})

type FakeMessageHandler = ((event: MessageEvent) => void) | null

class FakePrivacyWorker {
  onmessage: FakeMessageHandler = null
  onerror: ((event: ErrorEvent) => void) | null = null
  messages: Array<{ message: Record<string, unknown>; transfer: Transferable[] }> = []
  terminated = false

  postMessage(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    this.messages.push({ message, transfer })
    const response = message.type === 'prewarm'
      ? {
          v: 1,
          type: 'prewarmed',
          requestId: message.requestId,
          ok: true
        }
      : {
          v: 1,
          type: 'proof',
          requestId: message.requestId,
          ok: true,
          proofBytes: new Uint8Array([7, 8, 9]),
          publicInputs: new Uint8Array([10, 11]),
          nullifierHash: new Uint8Array([12, 13]),
          witness: new Uint8Array([14, 15]),
          credentialSecret: new Uint8Array([16, 17]),
          issuerSignature: new Uint8Array([18, 19]),
          revocationWitness: new Uint8Array([20, 21])
        }
    queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent))
  }

  terminate(): void {
    this.terminated = true
  }
}
