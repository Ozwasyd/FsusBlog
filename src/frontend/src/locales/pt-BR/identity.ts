export const localeDomainIdentity = Object.freeze({ locale: 'pt-BR', domain: 'identity' } as const)

import type { LocaleSchema } from '../keys'
import type { identity as zhCNIdentity } from '../zh-CN/identity'

export const identity = {
    overview: {
        passkeyLabel: 'Passkey',
        passkeyEnabled: 'Ativada',
        passkeyDisabled: 'Não adicionada',
        passkeyDeviceCount: {
            kind: 'plural',
            forms: {
                one: '{count} dispositivo de login',
                many: '{count} dispositivos de login',
                other: '{count} dispositivos de login'
            }
        },
        recoveryKeyLabel: 'Recovery Key',
        recoveryKeyReady: 'Gerada nesta sessão',
        recoveryKeyRequired: 'Não criada',
        recoveryKeyHint: 'Exibida apenas uma vez após a criação ou rotação.',
        mfaLabel: 'TOTP (verificação em duas etapas)',
        mfaEnabled: 'Ativado',
        mfaDisabled: 'Desativado',
        mfaHint: 'Usado para operações sensíveis; não para recuperação de conta.',
        anonymousLabel: 'Comentários anônimos',
        anonymousCardAvailable: 'Disponível',
        anonymousCardClosed: 'Fechado',
        zkAvailable: 'Anonimato aprimorado disponível',
        zkUnavailable: 'Anonimato aprimorado indisponível',
        sectionTitle: 'Configurações atuais',
        sectionDescription: '',
        publicHandleLabel: 'Nome público',
        publicHandleEmpty: 'Nome público não definido',
        anonymousPolicyLabel: 'Comentários anônimos',
        anonymousPolicyAllowed: 'Anônimo por padrão; envio público requer seleção explícita.',
        anonymousPolicyClosed: 'Comentários anônimos estão fechados neste site.',
        publicSendOptionLabel: 'Envio público',
        publicSendOptionAllowed: 'É possível exibir o nome público ao comentar.',
        publicSendOptionClosed: 'Envio público está desativado neste site.',
        lifecycleTitle: 'Ciclo de vida da conta',
        lifecycleDescription: 'Verificação de operação sensível necessária antes de excluir a conta.',
        lifecycleWarning: 'A exclusão converterá a conta para o estado excluído, removendo nome público, sessões, passkeys, Recovery Key, credenciais anônimas e dados TOTP. O conteúdo publicado não será excluído automaticamente.',
        deleteAccountCta: 'Excluir conta'
    },
    passkeys: {
        sectionTitle: 'Dispositivos com passkey',
        sectionDescription: 'Dispositivos com passkey associados a esta conta.',
        loading: 'Carregando passkeys',
        emptyTitle: 'Nenhuma passkey adicionada',
        emptyContent: 'Registre passkeys para autenticação de dispositivos.',
        addCta: 'Adicionar passkey',
        nameInputAriaLabel: 'Nome do dispositivo da passkey',
        saveCta: 'Salvar',
        cancelCta: 'Cancelar',
        editCta: 'Editar',
        deleteCta: 'Excluir',
        nameEmpty: 'Passkey sem nome',
        createdAtLabel: 'Criada em',
        activeAtLabel: 'Ativa em',
        activeNeverRecorded: 'Não registrado',
        backupModeLabel: 'Backup',
        backupEligible: 'Backup por sincronização suportado',
        backupIneligible: 'Apenas este dispositivo',
        recoverySuggestion: 'Há apenas uma passkey sem backup registrada. Considere adicionar outra passkey ou criar uma Recovery Key.'
    },
    recoveryKey: {
        sectionTitle: 'Recovery Key',
        sectionDescription: 'Credencial de recuperação da conta; exibida uma única vez.',
        sectionHint: 'Salve imediatamente após a criação ou rotação; ela não será exibida novamente. Se perdida e sem uma passkey funcional, a conta não poderá ser recuperada.',
        loading: 'Processando',
        panelVersionPrefix: 'Recovery Key v',
        panelCreatedAtPrefix: 'Gerada em: ',
        savedCheckbox: 'Eu salvei minha Recovery Key',
        closeOnceCta: 'Fechar',
        createCta: 'Criar Recovery Key',
        rotateCta: 'Rotacionar Recovery Key'
    },
    mfa: {
        sectionTitle: 'TOTP (verificação em duas etapas)',
        sectionDescription: 'Verificação de operações sensíveis; a recuperação da conta usa a Recovery Key.',
        loading: 'Carregando status da verificação em duas etapas',
        enabled: 'TOTP ativado',
        disabled: 'TOTP desativado',
        lastVerifiedPrefix: 'Última verificação',
        lastVerifiedEmpty: 'Nenhuma verificação recente registrada',
        enableCta: 'Ativar TOTP',
        disableCta: 'Desativar TOTP',
        disableConfirmTitle: 'Desativar TOTP',
        disableConfirmBody: 'Após desativar, operações sensíveis não exigirão mais verificação TOTP.',
        disableConfirmCta: 'Confirmar desativação',
        disabledSuccess: 'TOTP desativado',
        setupChallengeRequired: 'É necessário concluir a verificação TOTP primeiro. Os códigos de recuperação TOTP são diferentes da Recovery Key.',
        disableChallengeRequired: 'É necessário concluir a verificação TOTP primeiro.',
        initFailedFallback: 'Falha ao inicializar TOTP',
        verifyFailedFallback: 'Falha na verificação TOTP',
        disableFailedFallback: 'Falha ao desativar TOTP',
        enabledSuccess: 'TOTP ativado',
        setupModalTitle: 'Configurar TOTP',
        loadFailedFallback: 'Falha ao carregar status da verificação em duas etapas'
    },
    anonymous: {
        sectionTitle: 'Identidade anônima',
        sectionDescription: 'Recursos de anonimato, envio público e status de anonimato aprimorado.',
        readOnlyBody: 'Comentários anônimos não revelam a identidade da conta.',
        publicChoiceBody: 'O envio público requer escolha explícita na página de comentários.',
        governanceHeading: 'Tratamento de exceções',
        zkStatusHeading: 'Anonimato aprimorado',
        cardEnabled: 'Disponível',
        cardDisabled: 'Fechado',
        cardAvailable: 'Acionável',
        cardUnavailable: 'Indisponível',
        cardZkAvailable: 'Disponível',
        cardZkUnavailable: 'Indisponível',
        cardZkConfigVisible: 'Comentários anônimos comuns disponíveis.',
        cardZkConfigHidden: 'Indisponível neste site.',
        defaultModeHint: 'Escolha se deseja exibir o nome público na página de comentários.',
        governanceHint: 'Comentários irregulares são tratados conforme as regras do site.'
    },
    publicProfile: {
        sectionTitle: 'Perfil público',
        sectionDescription: 'O nome público é usado apenas para envio público.',
        draftLabel: 'Nome público',
        draftPlaceholder: 'Preencha ao enviar comentários públicos',
        optInCheckbox: 'Exibir apenas ao enviar publicamente',
        summaryAriaLabel: 'Status do perfil público',
        publicSendOptionLabel: 'Opção de envio público',
        publicSendOptionAvailable: 'Disponível',
        publicSendOptionUnavailable: 'Indisponível',
        saveCta: 'Salvar nome público',
        savedSuccess: 'Nome público salvo',
        clearedSuccess: 'Nome público removido',
        saveFailedFallback: 'Falha ao salvar nome público'
    },
    sessions: {
        sectionTitle: 'Sessões de dispositivos',
        sectionDescription: 'Sessões ativas de dispositivos para esta conta.',
        loading: 'Carregando sessões de dispositivos',
        activeCount: {
            kind: 'plural',
            forms: {
                one: '{count} sessão ativa',
                many: '{count} sessões ativas',
                other: '{count} sessões ativas'
            }
        },
        revokeOthersCta: 'Desconectar outros dispositivos',
        currentDevice: 'Dispositivo atual',
        otherDevice: 'Outro dispositivo',
        activeAtPrefix: 'Ativo em: ',
        activeAtLabel: 'Ativo pela última vez',
        createdAtLabel: 'Criado em',
        loginMethodLabel: 'Método de autenticação',
        credentialLabel: 'Passkey',
        authenticationPasskey: 'Passkey',
        authenticationRecoveryKey: 'Recovery Key',
        authenticationEnrollment: 'Registro inicial',
        authenticationOther: 'Outro método',
        durationLabel: 'Duração da sessão',
        durationPersistent: 'Manter conectado (30 dias)',
        durationBrowserSession: 'Sair ao fechar o navegador',
        sessionTypeLabel: 'Sessão',
        revokeCta: 'Desconectar',
        emptyTitle: 'Nenhuma sessão ativa',
        emptyContent: 'Nenhuma sessão de dispositivo.',
        revokeSuccess: 'Sessão do dispositivo desconectada',
        revokeOthersSuccess: 'Outros dispositivos desconectados',
        deviceFallback: 'Informações do dispositivo não registradas',
        loadFailedFallback: 'Falha ao carregar sessões de dispositivos'
    },
    commentRecords: {
        sectionTitle: 'Registros de comentários públicos',
        sectionDescription: 'Os registros da conta contêm apenas comentários públicos.',
        loading: 'Carregando registros de comentários públicos.',
        emptyTitle: 'Nenhum registro de comentário público',
        emptyDescription: 'Comentários enviados publicamente aparecerão aqui; comentários anônimos não entram nos registros da conta.',
        policyAriaLabel: 'Política de comentários atual',
        policyPublicSendLabel: 'Envio público',
        policyAnonymousLabel: 'Comentários anônimos',
        policyZkLabel: 'Anonimato aprimorado',
        policyGovernanceLabel: 'Tratamento de comentários anônimos',
        policyOpen: 'Aberto',
        policyClosed: 'Fechado',
        policyActive: 'Tratado conforme regras',
        policyUnavailable: 'Indisponível'
    },
    placeholder: {
        cardTitle: 'Configurações de identidade',
        sections: {
            UserIdentityOverview: {
                title: 'Visão geral da identidade',
                description: '',
                caption: 'Status de segurança e configurações de identidade pública.',
                body: 'Passkeys, Recovery Key, TOTP, nome público e políticas de comentários.',
                items: '["Status das passkeys", "Status da Recovery Key", "Identidade anônima e perfil público", "Resumo das sessões"]'
            },
            UserIdentityPasskeys: {
                title: 'Passkeys',
                description: 'Dispositivos de login.',
                caption: 'Dispositivos com passkey associados a esta conta.',
                body: 'Dispositivos registrados, renomeação e remoção.',
                items: '["Dispositivos registrados", "Renomear dispositivo", "Proteção contra exclusão da última passkey"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Recovery Key',
                description: 'Credencial de recuperação da conta.',
                caption: 'Independente dos códigos de recuperação TOTP.',
                body: 'Exibida apenas uma vez na criação ou rotação.',
                items: '["Criar Recovery Key", "Rotacionar credencial de recuperação", "Sessão de recuperação para vincular nova passkey"]'
            },
            UserIdentityAnonymous: {
                title: 'Identidade anônima',
                description: 'Comentários anônimos, envio público, regras do site.',
                caption: 'A identidade real da conta fica oculta.',
                body: 'Status de identidade anônima exibido conforme a política do site.',
                items: '["Modo anônimo padrão", "Idioma do nome de exibição", "Status da credencial e grupo de reputação"]'
            },
            UserIdentityPublicProfile: {
                title: 'Perfil público',
                description: 'Informações de identidade pública.',
                caption: 'Exibido apenas ao enviar publicamente.',
                body: 'Nome público, notas de exibição e confirmação antes do envio.',
                items: '["Nome público", "Confirmação de envio público", "Prévia do autor do comentário"]'
            },
            UserIdentitySessions: {
                title: 'Sessões de dispositivos',
                description: 'Sessões ativas de dispositivos.',
                caption: 'Dispositivos de login da conta atual.',
                body: 'Dispositivo atual, outras sessões ativas e desconexão de dispositivos.',
                items: '["Dispositivo atual", "Outras sessões ativas", "Desconectar outros dispositivos"]'
            },
            UserIdentityMfa: {
                title: 'Verificação em duas etapas',
                description: 'Status do TOTP.',
                caption: 'Verificação de operações sensíveis; não para recuperação de conta.',
                body: 'Ativar/desativar MFA, gerar códigos de recuperação TOTP.',
                items: '["Ativar MFA", "Desativar MFA", "Gerar novos códigos de recuperação TOTP"]'
            }
        }
    },
    profile: {
        pageTitle: 'Central de identidade',
        pageDescription: 'Segurança da conta, credenciais de recuperação, perfil público, comentários anônimos.',
        emptyTitle: 'Ir para a central de identidade',
        emptyContent: 'Passkeys, Recovery Key, TOTP, sessões de dispositivos, nome público, comentários anônimos.',
        openIdentityCta: 'Abrir central de identidade'
    },
    confirm: {
        deletePasskeyTitle: 'Excluir passkey',
        deletePasskeyBody: 'Após a exclusão, este dispositivo não poderá usar esta passkey para login.',
        rotateRecoveryKeyTitle: 'Rotacionar Recovery Key',
        rotateRecoveryKeyBody: 'Após a rotação, a Recovery Key antiga será invalidada.',
        deleteAccountTitle: 'Excluir conta',
        deleteAccountBody: 'A exclusão converterá a conta para o estado excluído, removendo nome público, sessões, passkeys, Recovery Key, credenciais anônimas e dados TOTP. O conteúdo publicado não será excluído automaticamente.',
        confirmButton: 'Confirmar',
        cancelButton: 'Cancelar'
    },
    meta: {
        UserIdentityOverview: {
            title: 'Visão geral da identidade',
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
            title: 'Identidade anônima',
            description: '',
        },
        UserIdentityPublicProfile: {
            title: 'Perfil público',
            description: '',
        },
        UserIdentitySessions: {
            title: 'Sessões de dispositivos',
            description: '',
        },
        UserIdentityMfa: {
            title: 'Verificação em duas etapas',
            description: '',
        },
        UserIdentityCommentRecords: {
            title: 'Registros de comentários públicos',
            description: 'Os registros da conta contêm apenas comentários públicos.'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: 'Nenhuma verificação de operação sensível disponível para esta conta. Adicione uma passkey ou ative o TOTP primeiro.',
        passkeySensitiveOperationRequired: 'Nenhuma verificação de operação sensível disponível para esta conta. Adicione uma passkey ou ative o TOTP primeiro.',
        accountDeleteSensitiveOperationRequired: 'Nenhuma verificação de operação sensível disponível para esta conta. Adicione uma passkey ou ative o TOTP primeiro.',
        renameFailedFallback: 'Falha ao renomear passkey',
        deleteFailedFallback: 'Falha ao excluir passkey',
        recoveryKeyFailedFallback: 'Falha na operação da Recovery Key',
        accountDeleteFailedFallback: 'Falha ao excluir conta',
        accountDeletedSuccess: 'Conta excluída',
        recoveryKeyCreatedSuccess: 'Recovery Key criada',
        recoveryKeyRotatedSuccess: 'Recovery Key rotacionada'
    }
} as const satisfies LocaleSchema<typeof zhCNIdentity>
