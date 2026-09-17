export const localeDomainIdentity = Object.freeze({ locale: 'ko-KR', domain: 'public' } as const);

import type { LocaleSchema } from '../keys';
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public';

export const publicMessages = {
    shell: {
        skipToMain: '본문으로 건너뛰기',
        navigation: '사이트 탐색',
        primaryNavigation: '주요 탐색',
        mobileMenu: '메뉴',
        mobileUtilities: '표시 및 계정',
        search: '검색',
        searchCancel: '취소',
        searchAria: '콘텐츠 검색',
        searchPlaceholder: '게시글, 태그 또는 키워드 검색',
        searchPlaceholderShortcut: '게시글, 태그 또는 키워드 검색 (Ctrl+K)',
        login: '로그인',
        account: '계정',
        dashboard: '대시보드',
        home: '홈',
        archive: '아카이브',
        about: '소개',
        light: '밝음',
        dark: '어두움',
        system: '시스템',
        lightShort: '밝음',
        darkShort: '어두움',
        systemShort: '시스템'
    },
    footer: {
        rssAria: 'RSS 피드 열기',
        licensePrefix: '별도 안내가 없는 경우 콘텐츠는',
        licenseSuffix: '에 따라 라이선스됩니다.',
        licenseAria: '콘텐츠 라이선스 열기',
        policiesAria: '사이트 정책',
        privacy: '개인정보',
        guidelines: '가이드라인',
        copyright: '저작권',
        recordsAria: '사이트 등록',
        policeBadgeAlt: '공공안전 등록',
        icpAria: 'ICP 등록 서비스 열기',
        policeAria: '공공안전 등록 서비스 열기',
        backToTop: '맨 위로',
        backToTopAria: '맨 위로 이동',
        ownerSeparator: '. ',
        allRightsReserved: '모든 권한이 보유됩니다.'
    },
    home: {
        loading: '게시글 로딩 중',
        emptyTitle: '공개 글이 없습니다',
        emptyDescription: '발행된 글은 여기에 표시됩니다.',
        errorTitle: '게시글을 사용할 수 없습니다',
        retry: '다시 불러오기'
    },
    archive: {
        title: '아카이브',
        publishedCount: {
            kind: 'plural',
            forms: {
                other: '{count}개 게시글이 게시되었습니다'
            }
        },
        yearNavigation: '연도별 탐색',
        emptyDescription: '발행된 글은 여기에 표시됩니다.'
    },
    filter: {
        scope: '범위: 글, 태그, 키워드',
        result: '결과: {state}',
        sort: '정렬',
        sortAria: '검색 결과 정렬',
        relevance: '관련성',
        latest: '최신',
        hot: '인기',
        previous: '이전',
        next: '다음',
        searching: '검색 중',
        unavailable: '검색 대상을 사용할 수 없습니다',
        backHome: '홈'
    }
} as const satisfies LocaleSchema<typeof zhCNPublicMessages>;
