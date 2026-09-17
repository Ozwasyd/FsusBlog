import { startRegistration } from '@simplewebauthn/browser';

export type PasskeyRegistrationResult = Awaited<ReturnType<typeof startRegistration>>;
export type PasskeyRegistrationStarter = typeof startRegistration;

export async function startPasskeyRegistration(
    options: unknown,
    register: PasskeyRegistrationStarter = startRegistration
): Promise<PasskeyRegistrationResult>
{
    return await register({
        optionsJSON: options
    } as Parameters<typeof startRegistration>[0]);
}
