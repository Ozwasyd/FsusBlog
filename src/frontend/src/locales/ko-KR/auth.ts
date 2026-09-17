export const localeDomainIdentity = Object.freeze({ locale: 'ko-KR', domain: 'auth' } as const);

import type { LocaleSchema } from '../keys';
import type { auth as zhCNAuth } from '../zh-CN/auth';

export const auth = {
    register: {
        title: '익명 계정 생성',
        description: '이메일이나 전화번호를 사용하지 않습니다. 복구 키를 저장하고 패스키를 등록하세요.',
        publicHandleHeading: '공개 이름',
        publicHandleLabel: '공개 이름(선택)',
        publicHandleHint: '비워두면 익명 이름이 자동 생성됩니다. TOTP은 나중에 사용할 수 있으며, TOTP 복구 코드는 복구 키와 별도입니다.',
        publicHandlePlaceholder: '3–20자 영문, 숫자, 한중문자 또는 #',
        agreementPrefix: '다음 내용을 읽고 동의합니다',
        guidelinesLink: '사이트 가이드라인',
        submitButtonIdle: '계정 생성 및 복구 키 저장',
        submitButtonLoading: '계정 생성 중',
        passkeyEnrollmentTitle: '첫 패스키 추가',
        passkeyEnrollmentHint: '패스키 검증이 완료되어 전체 세션이 생성될 때까지 계정은 임시 상태로 유지됩니다.',
        recoveryKeyTitle: '복구 키 저장',
        recoveryKeyHint: '복구 키는 한 번만 표시됩니다. 복구 키나 동작하는 패스키가 없으면 계정을 복구할 수 없습니다.',
        recoveryKeyVersionPrefix: '복구 키 v',
        recoveryKeyCreatedAtPrefix: '생성: ',
        copyRecoveryKeyCta: '복구 키 복사',
        recoveryKeySavedCheckbox: '복구 키를 저장했습니다',
        registerPasskeyCta: '패스키 추가',
        passkeyBoundTitle: '패스키가 추가됨',
        passkeyBoundHint: '로그인에는 패스키를, 계정 복구에는 복구 키를 사용하세요.',
        enterAccountCta: '계정 열기',
        hasAccountLabel: '이미 등록됨',
        loginLink: '로그인',
        cancelLink: '홈'
    },
    login: {
        title: '로그인',
        description: '글쓰기, 댓글, 사이트 유지보수.',
        rememberMe: '이 기기 기억하기',
        passkeyButton: '패스키로 로그인',
        passkeyLoading: '기기 확인 대기 중',
        passkeyHint: '익명 계정은 이메일이나 전화번호가 없습니다. 등록된 기기 또는 보안 키를 사용하거나 복구 키로 액세스를 복구하세요.',
        passkeyFailureHint: '기기 검증이 실패하면 복구 키를 사용하세요.',
        recoverLink: '복구 키로 액세스 복구',
        mfaRequiredTitle: '2차 인증 필요',
        mfaRequiredHint: '인증기 코드 또는 복구 코드를 입력하세요.',
        mfaAriaLabel: '검증 방식 선택',
        mfaModeTOTP: '인증기 코드',
        mfaModeRecovery: '복구 코드',
        mfaCodeLabel: 'MFA 코드',
        mfaCodePlaceholder: '6자리 코드',
        mfaRecoveryLabel: '복구 코드',
        mfaRecoveryPlaceholder: '복구 코드',
        mfaSubmit: '확인',
        registerLink: '가입',
        cancelLink: '취소'
    },
    recover: {
        title: '액세스 복구',
        description: '복구 키를 확인하고 새 패스키를 추가하세요.',
        sectionTitle: '복구 키',
        sectionHint: '복구 키는 계정 복구용 자격 증명으로, TOTP 복구 코드와는 다릅니다.',
        keyLabel: '복구 키',
        keyPlaceholder: 'frk_로 시작하는 복구 키 붙여넣기',
        keyHelp: '복구 키 또는 사용할 수 있는 패스키가 없으면 계정을 복구할 수 없습니다.',
        revokePasskeys: '복구 후 기존 패스키 폐기',
        verifyCta: '복구 키 확인',
        sessionReadyHint: '복구 키가 확인되었습니다. 복구 세션은 {expiresAt}에 만료됩니다. 새 패스키를 등록하세요.',
        bindNewPasskeyCta: '새 패스키 추가',
        verifyFailedFallback: '복구 키 확인 실패',
        returnLoginLink: '로그인으로 돌아가기',
        cancelLink: '취소'
    },
    policyModal: {
        fallbackTitle: '정책 상세',
        privacyTitle: '개인정보 처리방침',
        guidelinesTitle: '사이트 가이드라인',
        loadingStatus: '내용 로드 중',
        loadError: '정책 내용을 사용할 수 없습니다',
        retryCta: '재시도',
        emptyStatePrefix: '현재',
        emptyStateSuffix: ' 콘텐츠가 구성되지 않았습니다.',
        acknowledgementCta: '읽음',
        bodyAriaLabel: '정책 본문'
    }
} as const satisfies LocaleSchema<typeof zhCNAuth>;
