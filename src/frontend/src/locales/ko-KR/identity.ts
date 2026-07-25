import type { DeepStringShape } from '../keys';
import type { identity as zhCNIdentity } from '../zh-CN/identity';

export const identity = {
    overview: {
        passkeyLabel: '패스키',
        passkeyEnabled: '활성화됨',
        passkeyDisabled: '미등록',
        passkeyDeviceCount: '{n}개 로그인 기기',
        recoveryKeyLabel: '복구 키',
        recoveryKeyReady: '생성됨',
        recoveryKeyRequired: '미생성',
        recoveryKeyHint: '생성 또는 교체 후 한 번만 표시됩니다.',
        mfaLabel: 'TOTP MFA',
        mfaEnabled: '활성화됨',
        mfaDisabled: '비활성화됨',
        mfaHint: '민감 작업 검증에 사용되며 계정 복구에는 사용되지 않습니다.',
        anonymousLabel: '익명 댓글',
        anonymousCardAvailable: '사용 가능',
        anonymousCardClosed: '닫힘',
        zkAvailable: '향상된 익명성 사용 가능',
        zkUnavailable: '향상된 익명성 닫힘',
        sectionTitle: '현재 설정',
        sectionDescription: '',
        publicHandleLabel: '공개 이름',
        publicHandleEmpty: '공개 이름이 설정되지 않음',
        anonymousPolicyLabel: '익명 댓글',
        anonymousPolicyAllowed: '기본적으로 익명입니다. 공개 전송은 명시적으로 선택해야 합니다.',
        anonymousPolicyClosed: '이 사이트에서는 익명 댓글이 닫혀 있습니다.',
        publicSendOptionLabel: '공개 전송',
        publicSendOptionAllowed: '댓글 작성 시 공개 이름을 표시할 수 있습니다.',
        publicSendOptionClosed: '이 사이트에서는 공개 전송이 비활성화되어 있습니다.',
        lifecycleTitle: '계정 라이프사이클',
        lifecycleDescription: '계정 삭제 전 민감 작업 검증이 필요합니다.',
        lifecycleWarning: '계정 삭제 시 계정이 삭제 상태로 전환되며 공개 이름, 세션, 패스키, 복구 키, 익명 자격 증명 및 TOTP 데이터가 제거됩니다. 공개된 콘텐츠는 자동으로 삭제되지 않습니다.',
        deleteAccountCta: '계정 삭제'
    },
    passkeys: {
        sectionTitle: '패스키 기기',
        sectionDescription: '이 계정에 연결된 패스키 기기입니다.',
        loading: '패스키 로딩 중',
        emptyTitle: '등록된 패스키 없음',
        emptyContent: '기기 인증용 패스키를 등록하세요.',
        addCta: '패스키 추가',
        nameInputAriaLabel: '패스키 기기명',
        saveCta: '저장',
        cancelCta: '취소',
        editCta: '편집',
        deleteCta: '삭제',
        nameEmpty: '이름 없는 패스키',
        createdAtLabel: '생성',
        activeAtLabel: '마지막 활동',
        activeNeverRecorded: '기록 없음',
        backupModeLabel: '백업',
        backupEligible: '백업 동기화 지원',
        backupIneligible: '이 기기만',
        recoverySuggestion: '백업되지 않은 패스키가 하나만 등록되어 있습니다. 다른 패스키를 추가하거나 복구 키를 생성해 주세요.'
    },
    recoveryKey: {
        sectionTitle: '복구 키',
        sectionDescription: '계정 복구용 자격 증명으로, 한 번만 표시됩니다.',
        sectionHint: '생성 또는 교체 즉시 저장하세요. 다시 표시되지 않습니다. 사용 가능한 패스키가 없다면 계정을 복구할 수 없습니다.',
        loading: '처리 중',
        panelVersionPrefix: '복구 키 v',
        panelCreatedAtPrefix: '생성: ',
        savedCheckbox: '복구 키를 저장했습니다',
        closeOnceCta: '닫기',
        createCta: '복구 키 생성',
        rotateCta: '복구 키 회전'
    },
    mfa: {
        sectionTitle: 'TOTP MFA',
        sectionDescription: '민감 작업 검증. 계정 복구는 복구 키를 사용합니다.',
        loading: '이중 인증 상태 로딩 중',
        enabled: 'TOTP 활성화',
        disabled: 'TOTP 비활성화',
        lastVerifiedPrefix: '마지막 검증',
        lastVerifiedEmpty: '최근 검증 기록 없음',
        enableCta: 'TOTP MFA 활성화',
        disableCta: 'TOTP MFA 비활성화',
        disableConfirmTitle: 'TOTP MFA 비활성화',
        disableConfirmBody: '비활성화하면 민감 작업에서 더 이상 TOTP 검증이 필요하지 않습니다.',
        disableConfirmCta: '비활성화 확인',
        disabledSuccess: 'TOTP MFA 비활성화됨',
        setupChallengeRequired: 'TOTP MFA가 필요합니다. TOTP 복구 코드는 복구 키와 다릅니다.',
        disableChallengeRequired: 'TOTP MFA가 필요합니다.',
        initFailedFallback: 'TOTP MFA 초기화 실패',
        verifyFailedFallback: 'TOTP 검증 실패',
        disableFailedFallback: 'TOTP MFA 비활성화 실패',
        enabledSuccess: 'TOTP MFA가 활성화됨',
        setupModalTitle: 'TOTP MFA 바인딩',
        loadFailedFallback: 'MFA 상태 로드 실패'
    },
    anonymous: {
        sectionTitle: '익명 신원',
        sectionDescription: '익명 기능, 공개 전송, 향상된 익명성 상태입니다.',
        readOnlyBody: '익명 게시물은 계정 신원을 공개하지 않습니다.',
        publicChoiceBody: '공개 전송은 글 작성 페이지에서 직접 선택해야 합니다.',
        governanceHeading: '예외 처리',
        zkStatusHeading: '향상된 익명성',
        cardEnabled: '사용 가능',
        cardDisabled: '닫힘',
        cardAvailable: '처리 가능',
        cardUnavailable: '닫힘',
        cardZkAvailable: '사용 가능',
        cardZkUnavailable: '닫힘',
        cardZkConfigVisible: '일반 익명 댓글 사용 가능.',
        cardZkConfigHidden: '이 사이트에서는 닫힘.',
        defaultModeHint: '글 작성 페이지에서 공개 이름 표시 여부를 선택하세요.',
        governanceHint: '규칙을 위반한 댓글은 사이트 정책에 따라 처리됩니다.'
    },
    publicProfile: {
        sectionTitle: '공개 프로필',
        sectionDescription: '공개 이름은 공개 전송에만 사용됩니다.',
        draftLabel: '공개 이름',
        draftPlaceholder: '공개 댓글을 작성할 때 입력하세요',
        optInCheckbox: '공개 전송 시에만 표시',
        summaryAriaLabel: '공개 프로필 상태',
        publicSendOptionLabel: '공개 전송 옵션',
        publicSendOptionAvailable: '사용 가능',
        publicSendOptionUnavailable: '사용 불가',
        saveCta: '공개 이름 저장',
        savedSuccess: '공개 이름이 저장되었습니다',
        clearedSuccess: '공개 이름이 제거되었습니다',
        saveFailedFallback: '공개 이름 저장 실패'
    },
    sessions: {
        sectionTitle: '기기 세션',
        sectionDescription: '이 계정의 활성 기기 세션입니다.',
        loading: '기기 세션 로딩 중',
        activeCountPrefix: '활성 세션 {n}개',
        revokeOthersCta: '기타 기기 세션 해제',
        currentDevice: '현재 기기',
        otherDevice: '기타 기기',
        activeAtPrefix: '활성: ',
        activeAtLabel: '최근 활동',
        createdAtLabel: '생성',
        loginMethodLabel: '인증 방식',
        credentialLabel: '패스키',
        authenticationPasskey: '패스키',
        authenticationRecoveryKey: '복구 키',
        authenticationEnrollment: '최초 등록',
        authenticationOther: '기타 방식',
        durationLabel: '세션 기간',
        durationPersistent: '로그인 유지(30일)',
        durationBrowserSession: '브라우저 종료 시 로그아웃',
        sessionTypeLabel: '세션',
        revokeCta: '해제',
        emptyTitle: '활성 세션 없음',
        emptyContent: '기기 세션이 없습니다.',
        revokeSuccess: '기기 세션 해제됨',
        revokeOthersSuccess: '다른 기기 세션이 해제됨',
        deviceFallback: '기기 정보가 없습니다',
        loadFailedFallback: '기기 세션을 로드하지 못했습니다'
    },
    commentRecords: {
        sectionTitle: '공개 댓글 기록',
        sectionDescription: '계정 기록에는 공개 게시물만 포함됩니다.',
        loading: '공개 댓글 기록 로딩 중.',
        emptyTitle: '공개 댓글 기록 없음',
        emptyDescription: '공개로 작성한 댓글은 여기에 표시됩니다. 익명 댓글은 계정 기록에 반영되지 않습니다.',
        policyAriaLabel: '현재 댓글 정책',
        policyPublicSendLabel: '공개 전송',
        policyAnonymousLabel: '익명 댓글',
        policyZkLabel: '향상된 익명성',
        policyGovernanceLabel: '익명 댓글 처리',
        policyOpen: '열림',
        policyClosed: '닫힘',
        policyActive: '규칙에 따라 처리됨',
        policyUnavailable: '닫힘'
    },
    placeholder: {
        cardTitle: '신원 설정',
        sections: {
            UserIdentityOverview: {
                title: '신원 개요',
                description: '',
                caption: '보안 상태와 공개 신원 설정.',
                body: '패스키, 복구 키, TOTP, 공개 이름, 댓글 정책.',
                items: '["패스키 상태", "복구 키 상태", "익명 신원 및 공개 프로필", "세션 요약"]'
            },
            UserIdentityPasskeys: {
                title: '패스키',
                description: '로그인 기기.',
                caption: '이 계정에 연결된 패스키 기기입니다.',
                body: '등록 기기, 기기명 변경, 그리고 제거.',
                items: '["등록된 기기", "기기명 변경", "마지막 패스키 삭제 보호"]'
            },
            UserIdentityRecoveryKey: {
                title: '복구 키',
                description: '계정 복구 자격 증명.',
                caption: 'TOTP 복구 코드와는 독립적.',
                body: '생성 또는 교체 시 한 번만 표시됩니다.',
                items: '["복구 키 생성", "복구 자격 증명 회전", "복구 세션으로 새 패스키 바인딩"]'
            },
            UserIdentityAnonymous: {
                title: '익명 신원',
                description: '익명 댓글, 공개 게시물, 사이트 규칙.',
                caption: '실제 계정 신원은 숨겨집니다.',
                body: '익명 신원 상태는 사이트 정책에 따라 표시됩니다.',
                items: '["기본 익명 모드", "이름 표시 언어", "자격 증명 상태 및 평판 그룹"]'
            },
            UserIdentityPublicProfile: {
                title: '공개 프로필',
                description: '공개 신원 정보.',
                caption: '공개 전송 시에만 표시됩니다.',
                body: '공개 이름, 표시 문구, 전송 전 확인.',
                items: '["공개 이름", "공개 전송 확인", "댓글 작성자 미리보기"]'
            },
            UserIdentitySessions: {
                title: '기기 세션',
                description: '활성 기기 세션.',
                caption: '현재 계정의 로그인 기기.',
                body: '현재 기기, 다른 활성 세션, 기기 해제.',
                items: '["현재 기기", "기타 활성 세션", "다른 기기 해제"]'
            },
            UserIdentityMfa: {
                title: '2차 인증',
                description: 'TOTP 상태.',
                caption: '민감 작업 검증이며, 계정 복구에는 사용되지 않습니다.',
                body: 'MFA 활성화/비활성화, TOTP 복구 코드 생성.',
                items: '["MFA 활성화", "MFA 비활성화", "TOTP 복구 코드 재발급"]'
            }
        }
    },
    profile: {
        pageTitle: '신원 센터',
        pageDescription: '계정 보안, 복구 자격 증명, 공개 프로필, 익명 댓글.',
        emptyTitle: '신원 센터로 이동',
        emptyContent: '패스키, 복구 키, TOTP, 기기 세션, 공개 이름, 익명 댓글.',
        openIdentityCta: '신원 센터 열기'
    },
    confirm: {
        deletePasskeyTitle: '패스키 삭제',
        deletePasskeyBody: '삭제 후 이 기기로는 해당 패스키를 사용해 로그인할 수 없습니다.',
        rotateRecoveryKeyTitle: '복구 키 회전',
        rotateRecoveryKeyBody: '회전 후 기존 복구 키는 무효가 됩니다.',
        deleteAccountTitle: '계정 삭제',
        deleteAccountBody: '계정 삭제 시 계정이 삭제 상태로 전환되며 공개 이름, 세션, 패스키, 복구 키, 익명 자격 증명 및 TOTP 데이터가 제거됩니다. 발행한 콘텐츠는 자동으로 삭제되지 않습니다.',
        confirmButton: '확인',
        cancelButton: '취소'
    },
    meta: {
        UserIdentityOverview: {
            title: '신원 개요',
            description: ''
        },
        UserIdentityPasskeys: {
            title: '패스키',
            description: '로그인 기기.'
        },
        UserIdentityRecoveryKey: {
            title: '복구 키',
            description: '계정 복구 자격 증명.'
        },
        UserIdentityAnonymous: {
            title: '익명 신원',
            description: '익명 댓글, 공개 게시물, 사이트 규칙.'
        },
        UserIdentityPublicProfile: {
            title: '공개 프로필',
            description: '공개 신원 정보.'
        },
        UserIdentitySessions: {
            title: '기기 세션',
            description: '활성 기기 세션.'
        },
        UserIdentityMfa: {
            title: '2차 인증',
            description: 'TOTP 상태.'
        },
        UserIdentityCommentRecords: {
            title: '공개 댓글 기록',
            description: '계정 기록에는 공개 게시물만 포함됩니다.'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: '현재 계정에는 사용 가능한 민감 작업 검증이 없습니다. 먼저 패스키를 등록하거나 TOTP를 활성화하세요.',
        passkeySensitiveOperationRequired: '현재 계정에는 사용 가능한 민감 작업 검증이 없습니다. 먼저 패스키를 등록하거나 TOTP를 활성화하세요.',
        accountDeleteSensitiveOperationRequired: '현재 계정에는 사용 가능한 민감 작업 검증이 없습니다. 먼저 패스키를 등록하거나 TOTP를 활성화하세요.',
        renameFailedFallback: '패스키 이름 변경 실패',
        deleteFailedFallback: '패스키 삭제 실패',
        recoveryKeyFailedFallback: '복구 키 작업 실패',
        accountDeleteFailedFallback: '계정 삭제 실패',
        accountDeletedSuccess: '계정이 삭제됨',
        recoveryKeyCreatedSuccess: '복구 키 생성됨',
        recoveryKeyRotatedSuccess: '복구 키가 회전됨'
    }
} as const satisfies DeepStringShape<typeof zhCNIdentity>;
