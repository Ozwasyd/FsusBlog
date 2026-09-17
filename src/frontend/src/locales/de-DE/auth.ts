export const localeDomainIdentity = Object.freeze({ locale: 'de-DE', domain: 'auth' } as const);

import type { LocaleSchema } from '../keys';
import type { auth as zhCNAuth } from '../zh-CN/auth';

export const auth = {
    register: {
        title: 'Anonymes Konto erstellen',
        description: 'Keine E-Mail oder Telefonnummer. Speichern Sie den Recovery Key und fügen Sie einen Passkey hinzu.',
        publicHandleHeading: 'Öffentlicher Name',
        publicHandleLabel: 'Öffentlicher Name (optional)',
        publicHandleHint: 'Leer lassen, um einen anonymen Namen zu generieren. TOTP kann später aktiviert werden; TOTP-Wiederherstellungscodes sind vom Recovery Key getrennt.',
        publicHandlePlaceholder: '3–20 Buchstaben, Zahlen, CJK-Zeichen oder #',
        agreementPrefix: 'Ich habe die',
        guidelinesLink: 'Nutzungsrichtlinien',
        submitButtonIdle: 'Konto erstellen und Recovery Key generieren',
        submitButtonLoading: 'Konto wird erstellt',
        passkeyEnrollmentTitle: 'Ersten Passkey hinzufügen',
        passkeyEnrollmentHint: 'Das Konto bleibt vorläufig, bis die Passkey-Verifizierung es aktiviert und die vollständige Sitzung erstellt.',
        recoveryKeyTitle: 'Recovery Key speichern',
        recoveryKeyHint: 'Der Recovery Key wird nur einmal angezeigt. Ohne ihn oder einen funktionierenden Passkey kann das Konto möglicherweise nicht wiederhergestellt werden.',
        recoveryKeyVersionPrefix: 'Recovery Key v',
        recoveryKeyCreatedAtPrefix: 'Erstellt: ',
        copyRecoveryKeyCta: 'Recovery Key kopieren',
        recoveryKeySavedCheckbox: 'Ich habe den Recovery Key gespeichert',
        registerPasskeyCta: 'Passkey hinzufügen',
        passkeyBoundTitle: 'Passkey hinzugefügt',
        passkeyBoundHint: 'Verwenden Sie den Passkey zum Anmelden und den Recovery Key zur Kontowiederherstellung.',
        enterAccountCta: 'Konto öffnen',
        hasAccountLabel: 'Bereits registriert',
        loginLink: 'Anmelden',
        cancelLink: 'Zur Startseite'
    },
    login: {
        title: 'Anmelden',
        description: 'Schreiben, Kommentieren und Site-Wartung.',
        rememberMe: 'Dieses Gerät merken',
        passkeyButton: 'Mit Passkey anmelden',
        passkeyLoading: 'Warte auf Gerät',
        passkeyHint: 'Anonyme Konten haben keine E-Mail oder Telefonnummer. Verwenden Sie ein registriertes Gerät oder einen Sicherheitsschlüssel, oder stellen Sie den Zugriff mit dem Recovery Key wieder her.',
        passkeyFailureHint: 'Verwenden Sie den Recovery Key, falls die Geräteverifizierung fehlschlägt.',
        recoverLink: 'Zugriff mit Recovery Key wiederherstellen',
        mfaRequiredTitle: 'Zweiter Faktor erforderlich',
        mfaRequiredHint: 'Geben Sie einen Authenticator-Code oder Wiederherstellungscode ein.',
        mfaAriaLabel: 'Verifizierungsmethode auswählen',
        mfaModeTOTP: 'Authenticator-Code',
        mfaModeRecovery: 'Wiederherstellungscode',
        mfaCodeLabel: 'MFA-Code',
        mfaCodePlaceholder: '6-stelliger Code',
        mfaRecoveryLabel: 'Wiederherstellungscode',
        mfaRecoveryPlaceholder: 'Wiederherstellungscode',
        mfaSubmit: 'Verifizieren',
        registerLink: 'Registrieren',
        cancelLink: 'Abbrechen'
    },
    recover: {
        title: 'Zugriff wiederherstellen',
        description: 'Überprüfen Sie den Recovery Key und fügen Sie einen neuen Passkey hinzu.',
        sectionTitle: 'Recovery Key',
        sectionHint: 'Der Recovery Key stellt das Konto wieder her und ist kein TOTP-Wiederherstellungscode.',
        keyLabel: 'Recovery Key',
        keyPlaceholder: 'Fügen Sie den Recovery Key ein, der mit frk_ beginnt',
        keyHelp: 'Ohne den Recovery Key oder einen funktionierenden Passkey kann das Konto möglicherweise nicht wiederhergestellt werden.',
        revokePasskeys: 'Alte Passkeys nach Wiederherstellung widerrufen',
        verifyCta: 'Recovery Key überprüfen',
        sessionReadyHint: 'Recovery Key verifiziert. Die Wiederherstellungssitzung läuft um {expiresAt} ab. Fügen Sie einen neuen Passkey hinzu.',
        bindNewPasskeyCta: 'Neuen Passkey hinzufügen',
        verifyFailedFallback: 'Recovery Key-Überprüfung fehlgeschlagen.',
        returnLoginLink: 'Zurück zur Anmeldung',
        cancelLink: 'Abbrechen'
    },
    policyModal: {
        fallbackTitle: 'Richtliniendetails',
        privacyTitle: 'Datenschutzerklärung',
        guidelinesTitle: 'Nutzungsrichtlinien',
        loadingStatus: 'Inhalt wird geladen',
        loadError: 'Richtlinieninhalt ist nicht verfügbar',
        retryCta: 'Wiederholen',
        emptyStatePrefix: 'Kein ',
        emptyStateSuffix: '-Inhalt konfiguriert.',
        acknowledgementCta: 'Ich habe dies gelesen',
        bodyAriaLabel: 'Richtlinieninhalt'
    }
} as const satisfies LocaleSchema<typeof zhCNAuth>;
