export const localeDomainIdentity = Object.freeze({ locale: 'ko-KR', domain: 'messages' } as const)

import type { LocaleSchema } from '../keys';
import type { messages as zhCNMessages } from '../zh-CN/messages';

export const messages = {
    conversationList: {
        titleAccount: '메시지',
        titleAdmin: '활성 대화',
        newTicketCta: '티켓 제출',
        emptyTitleAccount: '사이트 메시지가 없습니다',
        emptyTitleAdmin: '대기 중인 대화 없음',
        emptyDescriptionAccount: '알림, 시스템 메시지, 이의신청 티켓입니다.',
        emptyDescriptionAdmin: '현재 필터에서 조치가 필요한 메시지가 없습니다.',
        noContentAdmin: '내용 없음',
        noContentAccount: '메시지 내용 없음',
        systemTag: '시스템',
        listAriaLabel: '대화 목록',
        showMoreLabel: '대화 더 보기 ({n})'
    },
    threadPanel: {
        backAriaLabel: '대화 목록으로 돌아가기',
        backCta: '대화 목록으로 돌아가기',
        titleFallback: '대화 선택',
        titleFallbackAccount: '대화 선택 또는 티켓 제출',
        titleFallbackAdmin: '대화 선택',
        systemTag: '시스템',
        statusChangeWillNotify: '상태 변경 시 사용자에게 알림이 발송됩니다.',
        markOpen: '처리중으로 표시',
        moveToPending: '대기 중으로 이동',
        closeConversation: '대화 종료',
        emptyDescriptionAccount: '대화 상세와 답장 섹션.',
        emptyDescriptionAdmin: '대기 중인 대화입니다.',
        newTicketCta: '티켓 제출',
        replyingToPrefix: '답변 대상',
        accountContext: '현재 대화',
        accountContextAdmin: '계정 {id}',
        statusPrefix: '상태',
        showOlder: '이전 메시지 불러오기',
        replyHeader: '현재 대화에 답장',
        replyLabel: '답장',
        replyLabelAccount: '관리자에게 답장',
        replyPlaceholder: '답장 내용을 입력하세요',
        replyCta: '답장 보내기'
    },
    composePanel: {
        titleAdmin: '시스템 메시지 보내기',
        titleAccount: '이의신청 티켓 제출',
        targetAccountIdLabel: '대상 계정 ID',
        targetAccountIdPlaceholder: '계정 ID를 입력하세요',
        subjectLabel: '제목',
        systemSubjectPlaceholder: '예: 시스템 알림',
        accountSubjectPlaceholder: '예: 계정 이의신청',
        bodyLabel: '내용',
        bodyPlaceholderAdmin: '메시지 본문 입력',
        bodyPlaceholderAccount: '문제와 요청 내용을 적어주세요',
        submitAdminCta: '시스템 메시지 보내기',
        submitAccountCta: '티켓 제출'
    },
    emptyState: {
        titleFallback: '표시할 대화가 없습니다'
    },
    filter: {
        open: '활성',
        pending: '대기',
        closed: '종료',
        system: '시스템',
        all: '전체',
        unread: '안읽음',
        systemMessages: '시스템 메시지'
    },
    status: {
        systemTag: '시스템'
    },
    errors: {
        loadFailed: '메시지 로드 실패',
        sendFailed: '메시지 전송 실패'
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>;
