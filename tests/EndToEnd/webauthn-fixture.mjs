export function addAuthenticator(cdp) {
  return cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } })
}

export async function enableAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await addAuthenticator(cdp)
  return { cdp, authenticatorId }
}
