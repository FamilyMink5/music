/**
 * Freyr 모듈에 대한 타입 정의
 */

// FreyrCore 인터페이스 정의
interface FreyrCore {
  parseURI(url: string): {
    uri: string;
    url: string;
    service: string;
  } | null;
  getServiceForMediaType(service: string): any;
  findYoutubeSource(query: string): Promise<string | null>;
}

// urifyUrl 함수 결과 타입 정의
interface UrifyResult {
  uri: string;
  url: string;
  youtubeUrl: string | null;
}

// urifyUrl 함수 타입 정의
type UrifyUrlFunction = (url: string) => Promise<UrifyResult | null>;

// 모듈에서 내보내는 것들을 정의
declare module '../../freyr-js/cli.js' {
  export const FreyrCore: FreyrCore;
  export const urifyUrl: UrifyUrlFunction;
} 