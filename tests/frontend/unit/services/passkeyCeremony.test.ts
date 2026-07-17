import { describe, expect, it, vi } from 'vitest'

import { startPasskeyRegistration } from '@/services/passkeyCeremony'

describe('passkeyCeremony adapter', () => {
  it('passes server options through the audited optionsJSON boundary', async () => {
    const attestation = { id: 'credential-7' }
    const startRegistration = vi.fn().mockResolvedValue(attestation)
    const options = { challenge: 'challenge-7', rp: { name: 'FsusBlog' } }

    await expect(startPasskeyRegistration(options, startRegistration)).resolves.toBe(attestation)
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: options })
  })
})
