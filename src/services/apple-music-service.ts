import { Client } from '@yujinakayama/apple-music';
import got from 'got';
import NodeCache from 'node-cache';
import { URL } from 'url';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ServiceType } from './cache-service';
import { YtdlpService } from './ytdlp-service';

export interface AppleMusicTrack {
  id: string;
  name: string;
  artists: string[];
  album: string;
  albumArt?: string;
  duration: number;
  url: string;
  youtubeUrl?: string;
  appleMusicId?: string;
  filePath?: string;
}

export interface AppleMusicResult {
  type: 'track' | 'album' | 'playlist';
  tracks: AppleMusicTrack[];
}

export class AppleMusicService {
  private static instance: AppleMusicService;
  private client: Client | null = null;
  private cache: NodeCache;
  private developerToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private defaultStorefront: string = 'us';
  private isAuthenticated: boolean = false;

  /**
   * 싱글톤 인스턴스 얻기
   */
  public static getInstance(): AppleMusicService {
    if (!AppleMusicService.instance) {
      AppleMusicService.instance = new AppleMusicService();
    }
    return AppleMusicService.instance;
  }

  /**
   * 싱글톤 패턴을 강제하기 위한 private 생성자
   */
  private constructor() {
    this.cache = new NodeCache();
    
    // 설정에서 개발자 토큰 가져오기 (있는 경우)
    if (config.appleMusic?.developerToken) {
      this.developerToken = config.appleMusic.developerToken;
      this.tokenExpiresAt = this.getExpiryTimestamp(config.appleMusic.developerToken);
      this.initClient();
    }
    
    if (config.appleMusic?.storefront) {
      this.defaultStorefront = config.appleMusic.storefront;
    }
  }

  /**
   * 클라이언트 초기화
   */
  private initClient(): void {
    if (!this.developerToken) return;
    
    try {
      this.client = new Client({ developerToken: this.developerToken });
      
      // 모든 API 인스턴스에 동일한 axios 인스턴스 설정
      if (this.client) {
        const axiosInstance = this.client.songs.axiosInstance;
        axiosInstance.defaults.headers['Origin'] = 'https://music.apple.com';
        axiosInstance.defaults.headers['Authorization'] = `Bearer ${this.developerToken}`;
        
        for (const instance of [this.client.albums, this.client.artists, this.client.playlists]) {
          instance.axiosInstance = axiosInstance;
        }
      }
    } catch (error) {
      logger.music.error('Apple Music 클라이언트 초기화 실패:', error);
    }
  }

  /**
   * 개발자 토큰의 만료 시간을 타임스탬프로 반환
   */
  private getExpiryTimestamp(token: string): number {
    try {
      const segments = token.split('.');
      const payload = Buffer.from(segments[1] || '', 'base64');
      const parsed = JSON.parse(payload.toString());
      return parsed.exp * 1000;
    } catch (error) {
      logger.music.error('토큰 만료 시간 파싱 실패:', error);
      return 0;
    }
  }

  /**
   * 인증이 필요한지 확인
   */
  public async checkAuth(): Promise<boolean> {
    // 토큰이 유효한 경우
    if (this.developerToken && Date.now() < this.tokenExpiresAt) {
      try {
        // 테스트 API 호출
        const testId = '1626195797'; // 샘플 트랙 ID
        const response = await this.client?.songs.get(testId, { storefront: 'us' });
        return response?.data?.[0]?.id === testId;
      } catch (error) {
        logger.music.error('Apple Music 인증 테스트 실패:', error);
        return false;
      }
    }
    return false;
  }

  /**
   * Apple Music 웹사이트에서 개발자 토큰을 추출하여 로그인
   * freyr-js에서 가져온 방식 그대로 사용
   */
  public async login(): Promise<boolean> {
    try {
      logger.music.info('Apple Music 로그인 시도 중...');
      
      // Apple Music 웹사이트에서 토큰 추출
      const browsePage = await got('https://music.apple.com/us/browse').text();
      const scriptUri = browsePage.match(/assets\/index-[a-z0-9]{8}\.js/)?.[0];
      
      if (!scriptUri) {
        throw new Error('Apple Music 코어 스크립트를 찾을 수 없습니다.');
      }
      
      const script = await got(`https://music.apple.com/${scriptUri}`).text();
      const developerToken = script.match(/eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IldlYlBsYXlLaWQifQ[^"]+/)?.[0];
      
      if (!developerToken) {
        throw new Error('Apple Music 코어 스크립트에서 개발자 토큰을 찾을 수 없습니다.');
      }
      
      // 토큰 업데이트
      this.developerToken = developerToken;
      this.tokenExpiresAt = this.getExpiryTimestamp(developerToken);
      
      // 클라이언트가 이미 있으면 토큰만 업데이트
      if (this.client) {
        this.client.configuration.developerToken = developerToken;
        this.client.songs.axiosInstance.defaults.headers['Authorization'] = `Bearer ${developerToken}`;
      } else {
        // 클라이언트 새로 초기화
        this.initClient();
      }
      
      this.isAuthenticated = true;
      logger.music.success('Apple Music 로그인 성공');
      return true;
    } catch (error) {
      logger.music.error('Apple Music 로그인 실패:', error);
      return false;
    }
  }

  /**
   * 인증 상태 확인 및 필요시 로그인 시도
   * JWT 토큰은 지속적으로 갱신되므로 매번 새로 로그인을 시도합니다.
   */
  public async ensureAuthenticated(): Promise<boolean> {
    // JWT는 지속적으로 갱신되므로 항상 새로 로그인을 시도합니다.
    logger.music.info('Apple Music JWT 갱신을 위해 로그인 시도 중...');
    return await this.login();
  }

  /**
   * URL이 Apple Music URL인지 확인
   */
  public isAppleMusicUrl(url: string): boolean {
    return url.includes('music.apple.com') || url.includes('apple.com/music');
  }

  /**
   * Apple Music URI 파싱
   */
  private parseUri(uri: string): { 
    id: string; 
    type: 'track' | 'album' | 'artist' | 'playlist' | 'unknown'; 
    key: string | null;
    uri: string;
    url: string;
    storefront: string;
    collection_type: string;
  } | null {
    // URI 유효성 검사 정규식
    const regex = /(?:(?:(?:(?:https?:\/\/)?(?:www\.)?)(?:(?:music|(?:geo\.itunes))\.apple.com)\/([a-z]{2})\/(song|album|artist|playlist)\/(?:([^/]+)\/)?\w+)|(?:apple_music:(track|album|artist|playlist):([\w.]+)))/;
    
    const match = uri.match(regex);
    if (!match) return null;
    
    const isURI = !!match[4];
    const parsedURL = new URL(uri);
    
    // 컬렉션 타입 결정 (song -> track으로 변환)
    const collection_type = isURI ? match[4] : match[2] === 'song' ? 'track' : match[2];
    
    // ID 추출
    const id = isURI 
      ? match[5] 
      : parsedURL.searchParams.get('i') || path.basename(parsedURL.pathname);
    
    // 최종 타입 결정
    let type: 'track' | 'album' | 'artist' | 'playlist' | 'unknown' = 'unknown';
    if (isURI) {
      type = match[4] as any;
    } else {
      if (collection_type === 'album' && parsedURL.searchParams.get('i')) {
        type = 'track';
      } else {
        type = collection_type as any;
      }
    }
    
    // 범위 결정
    const scope = collection_type === 'track' || 
      (collection_type === 'album' && parsedURL.searchParams.get('i')) 
        ? 'song' 
        : collection_type;
    
    // 스토어프론트 결정
    const storefront = match[1] || this.defaultStorefront;
    
    return {
      id,
      type,
      key: match[3] || null,
      uri: `apple_music:${type}:${id}`,
      url: `https://music.apple.com/${storefront}/${scope}/${id}`,
      storefront,
      collection_type,
    };
  }

  /**
   * URL에서 리소스 정보 추출
   */
  public extractAppleMusicInfo(url: string): { type: 'track' | 'album' | 'playlist' | 'artist' | 'unknown', id: string } {
    try {
      const parsedUri = this.parseUri(url);
      if (!parsedUri) {
        return { type: 'unknown', id: '' };
      }
      
      return {
        type: parsedUri.type,
        id: parsedUri.id
      };
    } catch (error) {
      logger.music.error('Apple Music URL 파싱 실패:', error);
      return { type: 'unknown', id: '' };
    }
  }

  /**
   * 트랙 정보 래핑
   */
  private wrapTrackData(track: any, album: any = {}): AppleMusicTrack {
    return {
      id: track.id,
      name: track.attributes.name,
      artists: [track.attributes.artistName],
      album: album.name || track.attributes.albumName || '',
      albumArt: album.getImage ? album.getImage(640, 640) : undefined,
      duration: track.attributes.durationInMillis,
      url: track.attributes.url,
    };
  }

  /**
   * 트랙 가져오기
   */
  public async getTrack(url: string): Promise<AppleMusicTrack | null> {
    try {
      // 인증 확인
      const isAuthed = await this.ensureAuthenticated();
      if (!isAuthed) {
        throw new Error('Apple Music API 인증에 실패했습니다.');
      }
      
      // URL 정보 추출
      const { type, id } = this.extractAppleMusicInfo(url);
      
      if (type !== 'track' || !id) {
        throw new Error('유효한 Apple Music 트랙 URL이 아닙니다.');
      }
      
      // 캐시 확인
      const cacheKey = `apple_music_track_${id}`;
      const cachedTrack = this.cache.get<AppleMusicTrack>(cacheKey);
      if (cachedTrack) {
        return cachedTrack;
      }
      
      // API 요청
      const parsedUri = this.parseUri(url);
      if (!parsedUri) {
        throw new Error('URL을 파싱할 수 없습니다.');
      }
      
      const { storefront } = parsedUri;
      const response = await this.client?.songs.get(id, { storefront });
      
      if (!response?.data?.[0]) {
        throw new Error('트랙 데이터를 가져올 수 없습니다.');
      }
      
      const trackData = response.data[0];
      
      // 관련 앨범 정보 가져오기
      const albumId = trackData.relationships.albums.data[0]?.id;
      let albumData = null;
      
      if (albumId) {
        const albumResponse = await this.client?.albums.get(albumId, { storefront });
        if (albumResponse?.data?.[0]) {
          albumData = this.wrapAlbumData(albumResponse.data[0]);
        }
      }
      
      // 트랙 정보 변환
      const track = this.wrapTrackData(trackData, albumData);
      
      // 캐시에 저장
      this.cache.set(cacheKey, track, 3600); // 1시간 캐시
      
      return track;
    } catch (error) {
      logger.music.error('Apple Music 트랙 정보 가져오기 실패:', error);
      return null;
    }
  }

  /**
   * 앨범 데이터 래핑
   */
  private wrapAlbumData(albumObject: any): any {
    return {
      id: albumObject.id,
      uri: albumObject.attributes.url,
      name: albumObject.attributes.name.replace(/\s-\s(Single|EP)$/, ''),
      artists: [albumObject.attributes.artistName],
      type:
        albumObject.attributes.artistName === 'Various Artists' && albumObject.relationships.artists.data.length === 0
          ? 'compilation'
          : albumObject.attributes.isSingle
            ? 'single'
            : 'album',
      genres: albumObject.attributes.genreNames,
      copyrights: [{ type: 'P', text: albumObject.attributes.copyright }],
      images: albumObject.attributes.artwork,
      label: albumObject.attributes.recordLabel,
      release_date: this.formatReleaseDate(albumObject.attributes.releaseDate),
      tracks: albumObject.tracks || [],
      ntracks: albumObject.attributes.trackCount,
      getImage(width: number, height: number) {
        const min = (val: number, max: number) => Math.min(max, val) || max;
        const images = albumObject.attributes.artwork;
        return images.url.replace('{w}x{h}', `${min(width, images.width)}x${min(height, images.height)}`);
      },
    };
  }

  /**
   * 발매일 포맷팅
   */
  private formatReleaseDate(date: any): string {
    if (typeof date === 'string') {
      return date;
    }
    
    return [
      [date.year, 4],
      [date.month, 2],
      [date.day, 2],
    ]
      .map(([val, size]) => val.toString().padStart(size as number, '0'))
      .join('-');
  }

  /**
   * 앨범 트랙 가져오기
   */
  public async getAlbumTracks(url: string): Promise<AppleMusicTrack[]> {
    try {
      // 인증 확인
      const isAuthed = await this.ensureAuthenticated();
      if (!isAuthed) {
        throw new Error('Apple Music API 인증에 실패했습니다.');
      }
      
      // URL 정보 추출
      const { type, id } = this.extractAppleMusicInfo(url);
      
      if (type !== 'album' || !id) {
        throw new Error('유효한 Apple Music 앨범 URL이 아닙니다.');
      }
      
      // 캐시 확인
      const cacheKey = `apple_music_album_tracks_${id}`;
      const cachedTracks = this.cache.get<AppleMusicTrack[]>(cacheKey);
      if (cachedTracks) {
        return cachedTracks;
      }
      
      // API 요청
      const parsedUri = this.parseUri(url);
      if (!parsedUri) {
        throw new Error('URL을 파싱할 수 없습니다.');
      }
      
      const { storefront } = parsedUri;
      const response = await this.client?.albums.get(id, { storefront });
      
      if (!response?.data?.[0]) {
        throw new Error('앨범 데이터를 가져올 수 없습니다.');
      }
      
      const albumData = response.data[0];
      const albumInfo = this.wrapAlbumData(albumData);
      
      // 앨범의 모든 트랙 가져오기
      if (!albumData.relationships?.tracks?.data) {
        throw new Error('앨범 트랙 데이터를 가져올 수 없습니다.');
      }
      
      const tracks: AppleMusicTrack[] = [];
      
      for (const trackData of albumData.relationships.tracks.data) {
        tracks.push(this.wrapTrackData(trackData, albumInfo));
      }
      
      // 캐시에 저장
      this.cache.set(cacheKey, tracks, 3600); // 1시간 캐시
      
      return tracks;
    } catch (error) {
      logger.music.error('Apple Music 앨범 트랙 정보 가져오기 실패:', error);
      return [];
    }
  }

  /**
   * 플레이리스트 트랙 가져오기
   */
  public async getPlaylistTracks(url: string): Promise<AppleMusicTrack[]> {
    try {
      // 인증 확인
      const isAuthed = await this.ensureAuthenticated();
      if (!isAuthed) {
        throw new Error('Apple Music API 인증에 실패했습니다.');
      }
      
      // URL 정보 추출
      const { type, id } = this.extractAppleMusicInfo(url);
      
      if (type !== 'playlist' || !id) {
        throw new Error('유효한 Apple Music 플레이리스트 URL이 아닙니다.');
      }
      
      // 캐시 확인
      const cacheKey = `apple_music_playlist_tracks_${id}`;
      const cachedTracks = this.cache.get<AppleMusicTrack[]>(cacheKey);
      if (cachedTracks) {
        return cachedTracks;
      }
      
      // API 요청
      const parsedUri = this.parseUri(url);
      if (!parsedUri) {
        throw new Error('URL을 파싱할 수 없습니다.');
      }
      
      const { storefront } = parsedUri;
      const response = await this.client?.playlists.get(id, { storefront });
      
      if (!response?.data?.[0]) {
        throw new Error('플레이리스트 데이터를 가져올 수 없습니다.');
      }
      
      const playlistData = response.data[0];
      
      // 플레이리스트의 모든 트랙 가져오기
      if (!playlistData.relationships?.tracks?.data) {
        throw new Error('플레이리스트 트랙 데이터를 가져올 수 없습니다.');
      }
      
      const tracks: AppleMusicTrack[] = [];
      
      for (const trackData of playlistData.relationships.tracks.data) {
        // 트랙에 앨범 정보가 있는 경우
        let albumInfo = null;
        if (trackData.relationships?.albums?.data?.[0]) {
          const albumId = trackData.relationships.albums.data[0].id;
          const albumResponse = await this.client?.albums.get(albumId, { storefront });
          if (albumResponse?.data?.[0]) {
            albumInfo = this.wrapAlbumData(albumResponse.data[0]);
          }
        }
        
        tracks.push(this.wrapTrackData(trackData, albumInfo));
      }
      
      // 캐시에 저장
      this.cache.set(cacheKey, tracks, 3600); // 1시간 캐시
      
      return tracks;
    } catch (error) {
      logger.music.error('Apple Music 플레이리스트 트랙 정보 가져오기 실패:', error);
      return [];
    }
  }

  /**
   * Apple Music URL 처리
   * 요청된 음악 재생 구조에 맞게 애플 뮤직 링크에서 메타데이터를 추출하고,
   * 해당 메타데이터로 YouTube에서 실제 음악을 찾아 URL 반환
   */
  public async processAppleMusicUrl(url: string): Promise<AppleMusicResult> {
    try {
      // 먼저 인증 상태 확인 및 필요시 로그인
      const isAuthed = await this.ensureAuthenticated();
      if (!isAuthed) {
        throw new Error('Apple Music API 인증에 실패했습니다. 나중에 다시 시도해주세요.');
      }
      
      const { type, id } = this.extractAppleMusicInfo(url);
      let tracks: AppleMusicTrack[] = [];
      
      logger.music.info(`Apple Music ${type} 메타데이터 추출 중: ${url}`);
      
      switch (type) {
        case 'track':
          const track = await this.getTrack(url);
          if (track) {
            tracks = [track];
            logger.music.info(`Apple Music 트랙 정보 추출 성공: ${track.name} - ${track.artists.join(', ')}`);
          }
          break;
        case 'album':
          tracks = await this.getAlbumTracks(url);
          logger.music.info(`Apple Music 앨범에서 ${tracks.length}개 트랙 정보 추출 성공`);
          break;
        case 'playlist':
          tracks = await this.getPlaylistTracks(url);
          logger.music.info(`Apple Music 플레이리스트에서 ${tracks.length}개 트랙 정보 추출 성공`);
          break;
        default:
          throw new Error('지원되지 않는 Apple Music URL 타입입니다.');
      }
      
      // 각 트랙에 대해 YouTube URL 찾기
      const ytdlpService = YtdlpService.getInstance();
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        
        // 원래 Apple Music ID 저장
        track.appleMusicId = track.id;
        
        const searchQuery = this.createSearchQuery(track);
        logger.music.info(`트랙 "${track.name}" YouTube 검색 중: "${searchQuery}"`);
        
        // YouTube에서 URL 찾기
        const youtubeUrl = await ytdlpService.findBestMatch(searchQuery);
        if (youtubeUrl) {
          logger.music.success(`트랙 "${track.name}"에 대한 YouTube 매치 찾음: ${youtubeUrl}`);
          // YouTube URL을 트랙 정보에 추가
          track.youtubeUrl = youtubeUrl;
          
          try {
            // 미리 캐시에 다운로드 시도 - 스포티파이 스타일로 처리
            const downloadResult = await ytdlpService.download(youtubeUrl, {
              serviceType: ServiceType.APPLE_MUSIC,
              videoId: track.appleMusicId
            });
            
            if (downloadResult.success && downloadResult.filePath) {
              // 파일 경로 저장
              track.filePath = downloadResult.filePath;
              logger.music.info(`트랙 "${track.name}" 다운로드 완료: ${downloadResult.filePath}`);
            }
          } catch (downloadError) {
            logger.music.warn(`트랙 "${track.name}" 사전 다운로드 실패: ${downloadError}`);
            // 실패해도 계속 진행 - 나중에 필요할 때 다시 시도
          }
        } else {
          logger.music.warn(`트랙 "${track.name}"에 대한 YouTube 매치를 찾을 수 없습니다`);
        }
      }
      
      return {
        type: type === 'track' ? 'track' : type === 'album' ? 'album' : 'playlist',
        tracks
      };
    } catch (error) {
      logger.music.error('Apple Music URL 처리 실패:', error);
      throw error;
    }
  }

  /**
   * AppleMusic 트랙에서 검색 쿼리 생성
   * 이 쿼리는 yt-dlp에서 음악을 검색하는 데 사용됨
   */
  public createSearchQuery(track: AppleMusicTrack): string {
    // 아티스트와 트랙 제목 결합하여 검색 쿼리 생성
    const artist = track.artists[0] || '';
    const title = track.name || '';
    
    // 검색에 부적합한 내용 제거
    const cleanTitle = title
      .replace(/\(feat\..*?\)/gi, '')
      .replace(/\[.*?\]/gi, '')
      .replace(/\(.*?\)/gi, '')
      .trim();
    
    // 일본어 등 비영어권 곡은 제목 + 아티스트 순으로 검색이 더 효과적일 수 있음
    const query = `${cleanTitle} ${artist}`.trim();
    
    // 곡 전체 이름 로깅
    logger.music.debug(`생성된 검색 쿼리: "${query}" (원곡: "${artist} - ${title}")`);
    
    return query;
  }
} 