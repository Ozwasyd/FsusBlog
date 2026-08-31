export const localeDomainIdentity = Object.freeze({ locale: 'de-DE', domain: 'identity' } as const)

import type { LocaleSchema } from '../keys'
import type { identity as zhCNIdentity } from '../zh-CN/identity'

export const identity = {
    overview: {
        passkeyLabel: 'Passkey',
        passkeyEnabled: 'Aktiviert',
        passkeyDisabled: 'Nicht hinzugefügt',
        passkeyDeviceCount: {
            kind: 'plural',
            forms: {
                one: '{count} Anmeldegerät',
                other: '{count} Anmeldegeräte'
            }
        },
        recoveryKeyLabel: 'Recovery Key',
        recoveryKeyReady: 'Generiert',
        recoveryKeyRequired: 'Nicht erstellt',
        recoveryKeyHint: 'Wird nach Erstellung oder Rotation nur einmal angezeigt.',
        mfaLabel: 'TOTP MFA',
        mfaEnabled: 'Aktiviert',
        mfaDisabled: 'Deaktiviert',
        mfaHint: 'Wird für sensible Vorgänge verwendet; nicht zur Kontowiederherstellung.',
        anonymousLabel: 'Anonyme Kommentare',
        anonymousCardAvailable: 'Verfügbar',
        anonymousCardClosed: 'Geschlossen',
        zkAvailable: 'Erweiterte Anonymität verfügbar',
        zkUnavailable: 'Erweiterte Anonymität geschlossen',
        sectionTitle: 'Aktuelle Einstellungen',
        sectionDescription: '',
        publicHandleLabel: 'Öffentlicher Name',
        publicHandleEmpty: 'Kein öffentlicher Name festgelegt',
        anonymousPolicyLabel: 'Anonyme Kommentare',
        anonymousPolicyAllowed: 'Standardmäßig anonym; öffentliches Senden erfordert explizite Auswahl.',
        anonymousPolicyClosed: 'Anonyme Kommentare sind auf dieser Site geschlossen.',
        publicSendOptionLabel: 'Öffentliches Senden',
        publicSendOptionAllowed: 'Option, den öffentlichen Namen beim Kommentieren anzuzeigen.',
        publicSendOptionClosed: 'Öffentliches Senden ist auf dieser Site deaktiviert.',
        lifecycleTitle: 'Kontolebenszyklus',
        lifecycleDescription: 'Vor der Kontolöschung ist eine Überprüfung sensibler Vorgänge erforderlich.',
        lifecycleWarning: 'Die Kontolöschung konvertiert das Konto in gelöscht und entfernt den öffentlichen Namen, Sitzungen, Passkeys, Recovery Key, anonyme Anmeldedaten und TOTP-Daten. Veröffentlichte Inhalte werden nicht automatisch gelöscht.',
        deleteAccountCta: 'Konto löschen'
    },
    passkeys: {
        sectionTitle: 'Passkey-Geräte',
        sectionDescription: 'Mit diesem Konto verknüpfte Passkey-Geräte.',
        loading: 'Passkeys werden geladen',
        emptyTitle: 'Keine Passkeys hinzugefügt',
        emptyContent: 'Registrieren Sie Passkeys zur Geräteauthentifizierung.',
        addCta: 'Passkey hinzufügen',
        nameInputAriaLabel: 'Passkey-Gerätename',
        saveCta: 'Speichern',
        cancelCta: 'Abbrechen',
        editCta: 'Bearbeiten',
        deleteCta: 'Löschen',
        nameEmpty: 'Unbenannter Passkey',
        createdAtLabel: 'Erstellt',
        activeAtLabel: 'Zuletzt aktiv',
        activeNeverRecorded: 'Nie aufgezeichnet',
        backupModeLabel: 'Backup',
        backupEligible: 'Sync-Backup unterstützt',
        backupIneligible: 'Nur dieses Gerät',
        recoverySuggestion: 'Es ist nur ein nicht gesicherter Passkey registriert. Erwägen Sie, einen weiteren Passkey hinzuzufügen oder einen Recovery Key zu erstellen.'
    },
    recoveryKey: {
        sectionTitle: 'Recovery Key',
        sectionDescription: 'Kontowiederherstellungsnachweis; wird einmalig angezeigt.',
        sectionHint: 'Sofort nach Erstellung oder Rotation speichern; er wird nicht erneut angezeigt. Wenn er ohne funktionierenden Passkey verloren geht, kann das Konto nicht wiederhergestellt werden.',
        loading: 'Wird verarbeitet',
        panelVersionPrefix: 'Recovery Key v',
        panelCreatedAtPrefix: 'Generiert: ',
        savedCheckbox: 'Ich habe meinen Recovery Key gespeichert',
        closeOnceCta: 'Schließen',
        createCta: 'Recovery Key erstellen',
        rotateCta: 'Recovery Key rotieren'
    },
    mfa: {
        sectionTitle: 'TOTP MFA',
        sectionDescription: 'Überprüfung sensibler Vorgänge; Kontowiederherstellung verwendet Recovery Key.',
        loading: 'Status der Zwei-Faktor-Authentifizierung wird geladen',
        enabled: 'TOTP aktiviert',
        disabled: 'TOTP deaktiviert',
        lastVerifiedPrefix: 'Zuletzt überprüft',
        lastVerifiedEmpty: 'Keine aktuelle Überprüfung aufgezeichnet',
        enableCta: 'TOTP MFA aktivieren',
        disableCta: 'TOTP MFA deaktivieren',
        disableConfirmTitle: 'TOTP MFA deaktivieren',
        disableConfirmBody: 'Nach der Deaktivierung benötigen sensible Vorgänge keine TOTP-Überprüfung mehr.',
        disableConfirmCta: 'Deaktivierung bestätigen',
        disabledSuccess: 'TOTP MFA deaktiviert',
        setupChallengeRequired: 'TOTP MFA erforderlich. TOTP-Wiederherstellungscodes sind vom Recovery Key getrennt.',
        disableChallengeRequired: 'TOTP MFA erforderlich.',
        initFailedFallback: 'Initialisierung von TOTP MFA fehlgeschlagen',
        verifyFailedFallback: 'TOTP-Überprüfung fehlgeschlagen',
        disableFailedFallback: 'Deaktivierung von TOTP MFA fehlgeschlagen',
        enabledSuccess: 'TOTP MFA aktiviert',
        setupModalTitle: 'TOTP MFA binden',
        loadFailedFallback: 'Laden des MFA-Status fehlgeschlagen'
    },
    anonymous: {
        sectionTitle: 'Anonyme Identität',
        sectionDescription: 'Anonymitätsfähigkeiten, öffentliches Senden und Status der erweiterten Anonymität.',
        readOnlyBody: 'Anonyme Beiträge geben keine Kontoidentität preis.',
        publicChoiceBody: 'Öffentliches Senden erfordert explizite Auswahl auf der Beitragsseite.',
        governanceHeading: 'Ausnahmebehandlung',
        zkStatusHeading: 'Erweiterte Anonymität',
        cardEnabled: 'Verfügbar',
        cardDisabled: 'Geschlossen',
        cardAvailable: 'Umsetzbar',
        cardUnavailable: 'Geschlossen',
        cardZkAvailable: 'Verfügbar',
        cardZkUnavailable: 'Geschlossen',
        cardZkConfigVisible: 'Standardmäßige anonyme Kommentare verfügbar.',
        cardZkConfigHidden: 'Auf dieser Site geschlossen.',
        defaultModeHint: 'Wählen Sie, ob der öffentliche Name auf der Beitragsseite angezeigt wird.',
        governanceHint: 'Verstoßende Kommentare werden gemäß den Site-Richtlinien behandelt.'
    },
    publicProfile: {
        sectionTitle: 'Öffentliches Profil',
        sectionDescription: 'Der öffentliche Name wird nur für öffentliches Senden verwendet.',
        draftLabel: 'Öffentlicher Name',
        draftPlaceholder: 'Beim Senden öffentlicher Kommentare ausfüllen',
        optInCheckbox: 'Nur beim öffentlichen Senden anzeigen',
        summaryAriaLabel: 'Status des öffentlichen Profils',
        publicSendOptionLabel: 'Option für öffentliches Senden',
        publicSendOptionAvailable: 'Verfügbar',
        publicSendOptionUnavailable: 'Nicht verfügbar',
        saveCta: 'Öffentlichen Namen speichern',
        savedSuccess: 'Öffentlicher Name gespeichert',
        clearedSuccess: 'Öffentlicher Name entfernt',
        saveFailedFallback: 'Speichern des öffentlichen Namens fehlgeschlagen'
    },
    sessions: {
        sectionTitle: 'Gerätesitzungen',
        sectionDescription: 'Aktive Gerätesitzungen für dieses Konto.',
        loading: 'Gerätesitzungen werden geladen',
        activeCount: {
            kind: 'plural',
            forms: {
                one: '{count} aktive Sitzung',
                other: '{count} aktive Sitzungen'
            }
        },
        revokeOthersCta: 'Andere Geräte widerrufen',
        currentDevice: 'Aktuelles Gerät',
        otherDevice: 'Anderes Gerät',
        activeAtPrefix: 'Aktiv: ',
        activeAtLabel: 'Zuletzt aktiv',
        createdAtLabel: 'Erstellt am',
        loginMethodLabel: 'Authentifizierungsmethode',
        credentialLabel: 'Passkey',
        authenticationPasskey: 'Passkey',
        authenticationRecoveryKey: 'Recovery Key',
        authenticationEnrollment: 'Erstregistrierung',
        authenticationOther: 'Andere Methode',
        durationLabel: 'Sitzungsdauer',
        durationPersistent: 'Angemeldet bleiben (30 Tage)',
        durationBrowserSession: 'Beim Schließen des Browsers abmelden',
        sessionTypeLabel: 'Sitzung',
        revokeCta: 'Widerrufen',
        emptyTitle: 'Keine aktiven Sitzungen',
        emptyContent: 'Keine Gerätesitzungen.',
        revokeSuccess: 'Gerätesitzung widerrufen',
        revokeOthersSuccess: 'Andere Gerätesitzungen widerrufen',
        deviceFallback: 'Keine Geräteinformationen aufgezeichnet',
        loadFailedFallback: 'Laden der Gerätesitzungen fehlgeschlagen'
    },
    commentRecords: {
        sectionTitle: 'Öffentliche Kommentaraufzeichnungen',
        sectionDescription: 'Kontoaufzeichnungen enthalten nur öffentliche Beiträge.',
        loading: 'Öffentliche Kommentaraufzeichnungen werden geladen.',
        emptyTitle: 'Keine öffentlichen Kommentaraufzeichnungen',
        emptyDescription: 'Öffentlich gesendete Kommentare erscheinen hier; anonyme Beiträge gehen nicht in die Kontoaufzeichnungen ein.',
        policyAriaLabel: 'Aktuelle Kommentarrichtlinie',
        policyPublicSendLabel: 'Öffentliches Senden',
        policyAnonymousLabel: 'Anonyme Kommentare',
        policyZkLabel: 'Erweiterte Anonymität',
        policyGovernanceLabel: 'Behandlung anonymer Kommentare',
        policyOpen: 'Offen',
        policyClosed: 'Geschlossen',
        policyActive: 'Gemäß Regeln behandelt',
        policyUnavailable: 'Geschlossen'
    },
    placeholder: {
        cardTitle: 'Identitätseinstellungen',
        sections: {
            UserIdentityOverview: {
                title: 'Identitätsübersicht',
                description: '',
                caption: 'Sicherheitsstatus und öffentliche Identitätseinstellungen.',
                body: 'Passkeys, Recovery Key, TOTP, öffentlicher Name und Kommentarrichtlinien.',
                items: '["Passkey-Status", "Recovery-Key-Status", "Anonyme Identität & öffentliches Profil", "Sitzungszusammenfassung"]'
            },
            UserIdentityPasskeys: {
                title: 'Passkeys',
                description: 'Anmeldegeräte.',
                caption: 'Mit diesem Konto verknüpfte Passkey-Geräte.',
                body: 'Registrierte Geräte, Geräteumbenennung und Entfernung.',
                items: '["Registrierte Geräte", "Gerät umbenennen", "Letzter Passkey-Löschschutz"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Recovery Key',
                description: 'Kontowiederherstellungsnachweis.',
                caption: 'Unabhängig von TOTP-Wiederherstellungscodes.',
                body: 'Wird bei Erstellung oder Rotation einmalig angezeigt.',
                items: '["Recovery Key erstellen", "Wiederherstellungsnachweis rotieren", "Sitzung zum Binden eines neuen Passkeys wiederherstellen"]'
            },
            UserIdentityAnonymous: {
                title: 'Anonyme Identität',
                description: 'Anonyme Kommentare, öffentliche Beiträge, Site-Regeln.',
                caption: 'Echte Kontoidentität ist ausgeblendet.',
                body: 'Anonymer Identitätsstatus wird gemäß Site-Richtlinie angezeigt.',
                items: '["Standardmäßiger anonymer Modus", "Sprache des Anzeigenamens", "Anmeldedatenstatus & Reputationsgruppe"]'
            },
            UserIdentityPublicProfile: {
                title: 'Öffentliches Profil',
                description: 'Öffentliche Identitätsinformationen.',
                caption: 'Wird nur beim öffentlichen Senden angezeigt.',
                body: 'Öffentlicher Name, Anzeigehinweise und Bestätigung vor dem Senden.',
                items: '["Öffentlicher Name", "Bestätigung des öffentlichen Sendens", "Vorschau des Kommentarautors"]'
            },
            UserIdentitySessions: {
                title: 'Gerätesitzungen',
                description: 'Aktive Gerätesitzungen.',
                caption: 'Anmeldegeräte für das aktuelle Konto.',
                body: 'Aktuelles Gerät, andere aktive Sitzungen und Widerrufen von Geräten.',
                items: '["Aktuelles Gerät", "Andere aktive Sitzungen", "Andere Geräte widerrufen"]'
            },
            UserIdentityMfa: {
                title: 'Zwei-Faktor-Authentifizierung',
                description: 'TOTP-Status.',
                caption: 'Überprüfung sensibler Vorgänge; nicht zur Kontowiederherstellung.',
                body: 'Aktivieren/Deaktivieren von MFA, Generieren von TOTP-Wiederherstellungscodes.',
                items: '["MFA aktivieren", "MFA deaktivieren", "TOTP-Wiederherstellungscodes neu generieren"]'
            }
        }
    },
    profile: {
        pageTitle: 'Identitätscenter',
        pageDescription: 'Kontosicherheit, Wiederherstellungsnachweise, öffentliches Profil, anonyme Kommentare.',
        emptyTitle: 'Zum Identitätscenter',
        emptyContent: 'Passkeys, Recovery Key, TOTP, Gerätesitzungen, öffentlicher Name, anonyme Kommentare.',
        openIdentityCta: 'Identitätscenter öffnen'
    },
    confirm: {
        deletePasskeyTitle: 'Passkey löschen',
        deletePasskeyBody: 'Nach dem Löschen kann dieses Gerät nicht mehr mit diesem Passkey angemeldet werden.',
        rotateRecoveryKeyTitle: 'Recovery Key rotieren',
        rotateRecoveryKeyBody: 'Nach der Rotation wird der alte Recovery Key ungültig.',
        deleteAccountTitle: 'Konto löschen',
        deleteAccountBody: 'Die Kontolöschung konvertiert das Konto in gelöscht und entfernt den öffentlichen Namen, Sitzungen, Passkeys, Recovery Key, anonyme Anmeldedaten und TOTP-Daten. Veröffentlichte Inhalte werden nicht automatisch gelöscht.',
        confirmButton: 'Bestätigen',
        cancelButton: 'Abbrechen'
    },
    meta: {
        UserIdentityOverview: {
            title: 'Identitätsübersicht',
            description: ''
        },
        UserIdentityPasskeys: {
            title: 'Passkeys',
            description: '',
        },
        UserIdentityRecoveryKey: {
            title: 'Recovery Key',
            description: '',
        },
        UserIdentityAnonymous: {
            title: 'Anonyme Identität',
            description: '',
        },
        UserIdentityPublicProfile: {
            title: 'Öffentliches Profil',
            description: '',
        },
        UserIdentitySessions: {
            title: 'Gerätesitzungen',
            description: '',
        },
        UserIdentityMfa: {
            title: 'Zwei-Faktor-Authentifizierung',
            description: '',
        },
        UserIdentityCommentRecords: {
            title: 'Öffentliche Kommentaraufzeichnungen',
            description: 'Kontoaufzeichnungen enthalten nur öffentliche Beiträge.'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: 'Keine Überprüfung sensibler Vorgänge für dieses Konto verfügbar. Fügen Sie zuerst einen Passkey hinzu oder aktivieren Sie TOTP.',
        passkeySensitiveOperationRequired: 'Keine Überprüfung sensibler Vorgänge für dieses Konto verfügbar. Fügen Sie zuerst einen Passkey hinzu oder aktivieren Sie TOTP.',
        accountDeleteSensitiveOperationRequired: 'Keine Überprüfung sensibler Vorgänge für dieses Konto verfügbar. Fügen Sie zuerst einen Passkey hinzu oder aktivieren Sie TOTP.',
        renameFailedFallback: 'Umbenennung des Passkeys fehlgeschlagen',
        deleteFailedFallback: 'Löschen des Passkeys fehlgeschlagen',
        recoveryKeyFailedFallback: 'Recovery-Key-Vorgang fehlgeschlagen',
        accountDeleteFailedFallback: 'Kontolöschung fehlgeschlagen',
        accountDeletedSuccess: 'Konto gelöscht',
        recoveryKeyCreatedSuccess: 'Recovery Key erstellt',
        recoveryKeyRotatedSuccess: 'Recovery Key rotiert'
    }
} as const satisfies LocaleSchema<typeof zhCNIdentity>
