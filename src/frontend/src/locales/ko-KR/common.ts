export const localeDomainIdentity = Object.freeze({ locale: 'ko-KR', domain: 'common' } as const)

import type { LocaleSchema } from '../keys';
import type { common as zhCNCommon } from '../zh-CN/common';

export const common = {
    actions: {
        save: '저장',
        cancel: '취소',
        confirm: '확인',
        retry: '재시도',
        delete: '삭제',
        refresh: '새로고침',
        publish: '게시',
        close: '닫기',
        backHome: '홈'
    },
    time: {
        unknown: '시간 알 수 없음',
        invalid: '시간 형식이 올바르지 않습니다',
        justNow: '방금'
    },
    routeTitles: {
        home: '홈',
        article: '글',
        archive: '아카이브',
        about: '소개',
        privacy: '개인정보 처리방침',
        guidelines: '이용 가이드라인',
        copyright: '저작권',
        search: '검색 결과',
        login: '로그인',
        register: '가입',
        recover: '액세스 복구',
        account: '신원 센터',
        messages: '메시지',
        dashboard: '대시보드',
        writeArticle: '작성',
        moderateComments: '댓글 모더레이션',
        settings: '설정',
        forbidden: '접근 거부',
        notFound: '페이지를 찾을 수 없음'
    }
} as const satisfies LocaleSchema<typeof zhCNCommon>;
