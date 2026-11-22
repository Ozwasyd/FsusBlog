import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { exactButton, exactLabel, exactText, roleWithExactName } from './role-locators.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { waitForPathResponse } from './response-wait-fixture.mjs'

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

export async function signInFreshAdmin(page, origin, bootstrap, onAccess) {
  await enableAuthenticator(page.context(), page)
  await page.context().addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
  await page.goto(origin + '/admin/identity')
  await roleWithExactName(page, 'heading', 'Administrator access').waitFor()
  await onAccess?.(page)
  await exactButton(page, 'Set up administrator Passkey').click()
  await exactLabel(page, 'One-time administrator bootstrap key').fill(bootstrap)
  const registration = waitForPathResponse(page, () => WireRoutes.AdminBootstrapComplete, 'POST')
  await exactButton(page, 'Create administrator Passkey').click()
  assertStatus(await registration, 200)
  await exactText(page, 'Administrator Passkey created. Log in with it to continue.').waitFor()
  const signIn = waitForPathResponse(page, () => WireRoutes.AdminPasskeyComplete, 'POST')
  await exactButton(page, 'Log in as administrator').click()
  assertStatus(await signIn, 200)
  await roleWithExactName(page, 'heading', 'Administrator session').waitFor()
}

export async function signInFreshSite(page, origin, ticket) {
  await enableAuthenticator(page.context(), page)
  await page.context().addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
  assertStatus(await page.goto(origin + '/login'), 200)
  await exactButton(page, 'Set up your first Passkey').click()
  await exactLabel(page, 'One-time setup ticket').fill(ticket)
  const registration = waitForPathResponse(page, () => WireRoutes.PasskeyProvisionComplete, 'POST')
  await exactButton(page, 'Create Passkey').click()
  assertStatus(await registration, 200)
  await exactText(page, 'Passkey created. Log in with your Passkey.').waitFor()
  const signIn = waitForPathResponse(page, () => WireRoutes.PasskeyLoginComplete, 'POST')
  await exactButton(page, 'Log in with Passkey').click()
  assertStatus(await signIn, 200)
  await page.waitForURL(origin + '/user/identity/mfa')
}
