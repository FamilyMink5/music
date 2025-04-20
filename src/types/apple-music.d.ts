declare module '@yujinakayama/apple-music' {
  // 기본 구성 옵션 인터페이스
  export interface ClientConfiguration {
    developerToken: string;
  }

  // HTTP 요청 옵션 인터페이스
  export interface RequestOptions {
    storefront: string;
    [key: string]: any;
  }

  // API 응답 인터페이스
  export interface ApiResponse<T> {
    data: T[];
    next?: string;
    [key: string]: any;
  }

  // API 대상 인터페이스
  export interface ApiTarget {
    get(id: string, options?: RequestOptions): Promise<ApiResponse<any>>;
    axiosInstance: any;
  }

  // 클라이언트 클래스
  export class Client {
    constructor(configuration: ClientConfiguration);
    configuration: ClientConfiguration;
    songs: ApiTarget;
    albums: ApiTarget;
    artists: ApiTarget;
    playlists: ApiTarget;
  }
}

declare module 'got' {
  function got(url: string): {
    text(): Promise<string>;
  };
  
  export default got;
}

declare module 'node-cache' {
  interface NodeCacheOptions {
    stdTTL?: number;
    checkperiod?: number;
    useClones?: boolean;
    [key: string]: any;
  }

  class NodeCache {
    constructor(options?: NodeCacheOptions);
    set<T>(key: string, value: T, ttl?: number): boolean;
    get<T>(key: string): T | undefined;
    del(key: string | string[]): number;
    has(key: string): boolean;
    keys(): string[];
    ttl(key: string, ttl: number): boolean;
    close(): void;
  }

  export default NodeCache;
} 