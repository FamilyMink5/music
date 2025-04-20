import { logger } from '../utils/logger';
import { YtdlpService } from './ytdlp-service';
import got from 'got';
import { JSDOM } from 'jsdom';
import { ServiceType } from './cache-service';
import NodeCache from 'node-cache';

export interface MelonTrack {
  id: string;
  name: string;
  artists: string[];
  album: string;
  albumArt?: string;
  duration: number; // 밀리초
  url: string;
  youtubeUrl?: string; // YouTube 검색 결과 URL
  filePath?: string;   // 로컬 캐시 파일 경로
}

export interface MelonResult {
  type: 'track' | 'album' | 'playlist' | 'chart';
  tracks: MelonTrack[];
}

export class MelonService {
  private static instance: MelonService;
  private ytdlpService: YtdlpService;
  private cache: NodeCache;
  private userAgent: string = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): MelonService {
    if (!MelonService.instance) {
      MelonService.instance = new MelonService();
    }
    return MelonService.instance;
  }
  
  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {
    this.ytdlpService = YtdlpService.getInstance();
    this.cache = new NodeCache();
  }
  
  /**
   * Check if a URL is a Melon URL
   */
  public isMelonUrl(url: string): boolean {
    return url.includes('melon.com') || url.startsWith('melon:');
  }
  
  /**
   * Extract Melon resource type and ID from URL
   */
  private extractMelonId(url: string): { type: 'track' | 'album' | 'playlist' | 'chart' | 'unknown', id: string } {
    try {
      // 커스텀 URL 스킴 처리 (melon:chart, melon:album:123456, etc)
      if (url.startsWith('melon:')) {
        const parts = url.substring(6).split(':');
        const type = parts[0] as 'track' | 'album' | 'playlist' | 'chart' | 'unknown';
        const id = parts[1] || '';
        
        if (type === 'chart') {
          return { type, id: 'realtime' }; // 차트는 ID가 없어도 됨
        }
        
        return { type, id };
      }
      
      // 실제 멜론 URL 처리
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(part => part);
      
      if (pathParts.length < 2) {
        return { type: 'unknown', id: '' };
      }
      
      // URL 패턴 확인
      // song/detail.htm?songId=12345
      if (pathParts[0] === 'song' && urlObj.searchParams.has('songId')) {
        return { 
          type: 'track', 
          id: urlObj.searchParams.get('songId') as string
        };
      }
      
      // album/detail.htm?albumId=12345
      if (pathParts[0] === 'album' && urlObj.searchParams.has('albumId')) {
        return { 
          type: 'album', 
          id: urlObj.searchParams.get('albumId') as string
        };
      }
      
      // playlist/detail.htm?plylstSeq=12345
      if (pathParts[0] === 'playlist' && urlObj.searchParams.has('plylstSeq')) {
        return { 
          type: 'playlist', 
          id: urlObj.searchParams.get('plylstSeq') as string
        };
      }
      
      // 실시간 차트 URL
      if (pathParts[0] === 'chart' && pathParts[1] === 'index.htm') {
        return { type: 'chart', id: 'realtime' };
      }
      
      return { type: 'unknown', id: '' };
    } catch (error) {
      logger.music.error('멜론 URL 분석 오류:', error);
      return { type: 'unknown', id: '' };
    }
  }
  
  /**
   * Fetch HTML from a URL
   */
  private async fetchHtml(url: string): Promise<string> {
    try {
      // got 라이브러리 사용
      // @ts-ignore - got의 타입 문제 때문에 무시하고 사용
      return await got(url, {
        headers: {
          'User-Agent': this.userAgent
        }
      }).text();
    } catch (error) {
      logger.music.error(`HTML 가져오기 실패 (${url}):`, error);
      throw error;
    }
  }
  
  /**
   * Get track information from Melon
   */
  public async getTrack(url: string): Promise<MelonTrack | null> {
    try {
      // URL에서 ID 추출
      const { type, id } = this.extractMelonId(url);
      
      if (type !== 'track' || !id) {
        throw new Error('유효한 멜론 트랙 URL이 아닙니다.');
      }
      
      // 캐시 확인
      const cacheKey = `melon_track_${id}`;
      const cachedTrack = this.cache.get<MelonTrack>(cacheKey);
      if (cachedTrack) {
        logger.music.info(`캐시에서 멜론 트랙 정보 가져옴: ${cachedTrack.name}`);
        return cachedTrack;
      }
      
      // 멜론 웹페이지에서 트랙 정보 파싱
      const songUrl = `https://www.melon.com/song/detail.htm?songId=${id}`;
      const html = await this.fetchHtml(songUrl);
      
      const dom = new JSDOM(html);
      const document = dom.window.document;
      
      // 곡 제목 (업데이트된 selector)
      const titleElement = document.querySelector('.wrap_info .song_name');
      const title = titleElement ? titleElement.textContent?.replace('곡명', '').trim() : '';
      
      if (!title) {
        throw new Error('트랙 정보를 찾을 수 없습니다.');
      }
      
      // 아티스트 정보 (업데이트된 selector)
      const artistElements = document.querySelectorAll('.wrap_info .artist a');
      const artists: string[] = [];
      artistElements.forEach((el: Element) => {
        const artist = el.textContent?.trim();
        if (artist) artists.push(artist);
      });
      
      // 앨범 정보 (업데이트된 selector)
      const albumElement = document.querySelector('.wrap_info .meta dd:nth-child(2) a');
      const album = albumElement ? albumElement.textContent?.trim() : '';
      
      // 앨범 아트 (업데이트된 selector)
      const albumArtElement = document.querySelector('.wrap_info .thumb img');
      const albumArt = albumArtElement ? albumArtElement.getAttribute('src') : '';
      
      // 재생 시간 (밀리초로 변환) (업데이트된 selector)
      const durationElement = document.querySelector('.wrap_info .meta dd:nth-child(4)');
      let duration = 0;
      
      if (durationElement) {
        const durationText = durationElement.textContent?.trim() || '';
        const durationMatch = durationText.match(/(\d+):(\d+)/);
        if (durationMatch) {
          const minutes = parseInt(durationMatch[1], 10);
          const seconds = parseInt(durationMatch[2], 10);
          duration = (minutes * 60 + seconds) * 1000; // 밀리초로 변환
        }
      }
      
      const track: MelonTrack = {
        id,
        name: title,
        artists,
        album: album || '',
        albumArt: albumArt || '',
        duration,
        url: songUrl
      };
      
      // 캐시에 저장 (1시간)
      this.cache.set(cacheKey, track, 3600);
      
      return track;
    } catch (error) {
      logger.music.error('멜론 트랙 정보 가져오기 실패:', error);
      return null;
    }
  }
  
  /**
   * Get tracks from a Melon album
   */
  public async getAlbumTracks(url: string): Promise<MelonTrack[]> {
    try {
      // URL에서 ID 추출
      const { type, id } = this.extractMelonId(url);
      
      if (type !== 'album' || !id) {
        throw new Error('유효한 멜론 앨범 URL이 아닙니다.');
      }
      
      // 캐시 확인
      const cacheKey = `melon_album_tracks_${id}`;
      const cachedTracks = this.cache.get<MelonTrack[]>(cacheKey);
      if (cachedTracks) {
        logger.music.info(`캐시에서 멜론 앨범 트랙 정보 가져옴: ${cachedTracks.length}개 트랙`);
        return cachedTracks;
      }
      
      // 멜론 웹페이지에서 앨범 정보 파싱
      const albumUrl = `https://www.melon.com/album/detail.htm?albumId=${id}`;
      const html = await this.fetchHtml(albumUrl);
      
      const dom = new JSDOM(html);
      const document = dom.window.document;
      
      // 앨범 타이틀 (업데이트된 selector)
      const albumTitleElement = document.querySelector('div.wrap_info div.song_name');
      const albumTitle = albumTitleElement ? albumTitleElement.textContent?.trim() : '';
      
      // 앨범 커버 (업데이트된 selector)
      const albumCoverElement = document.querySelector('div.thumb img');
      let albumCover = '';
      if (albumCoverElement) {
        albumCover = albumCoverElement.getAttribute('src') || '';
      }
      
      // 트랙 리스트
      const tracks: MelonTrack[] = [];
      
      // 트랙 테이블에서 곡 정보 추출 (업데이트된 selector)
      const trackRows = document.querySelectorAll('div.service_list_song table tbody tr');
      
      trackRows.forEach((row: Element) => {
        // 트랙 ID 추출
        const checkbox = row.querySelector('input[type="checkbox"]');
        let trackId = '';
        if (checkbox) {
          trackId = checkbox.getAttribute('value') || '';
        }
        
        if (!trackId) return;
        
        // 트랙 제목
        const titleElement = row.querySelector('div.wrap_song_info div.ellipsis a');
        const title = titleElement ? titleElement.textContent?.trim() : '';
        
        if (!title) return;
        
        // 아티스트
        const artistElements = row.querySelectorAll('div.wrap_song_info div.ellipsis.rank02 a');
        const artists: string[] = [];
        artistElements.forEach((el: Element) => {
          const artist = el.textContent?.trim();
          if (artist) artists.push(artist);
        });
        
        // 재생 시간
        const durationElement = row.querySelector('td:nth-of-type(4)');
        let duration = 0;
        
        if (durationElement) {
          const durationText = durationElement.textContent?.trim() || '';
          const durationMatch = durationText.match(/(\d+):(\d+)/);
          if (durationMatch) {
            const minutes = parseInt(durationMatch[1], 10);
            const seconds = parseInt(durationMatch[2], 10);
            duration = (minutes * 60 + seconds) * 1000; // 밀리초로 변환
          }
        }
        
        tracks.push({
          id: trackId,
          name: title,
          artists,
          album: albumTitle || '',
          albumArt: albumCover || '',
          duration,
          url: `https://www.melon.com/song/detail.htm?songId=${trackId}`
        });
      });
      
      // 캐시에 저장 (1시간)
      this.cache.set(cacheKey, tracks, 3600);
      
      return tracks;
    } catch (error) {
      logger.music.error('멜론 앨범 정보 가져오기 실패:', error);
      return [];
    }
  }
  
  /**
   * Get tracks from a Melon playlist
   */
  public async getPlaylistTracks(url: string): Promise<MelonTrack[]> {
    try {
      // URL에서 ID 추출
      const { type, id } = this.extractMelonId(url);
      
      if (type !== 'playlist' || !id) {
        throw new Error('유효한 멜론 플레이리스트 URL이 아닙니다.');
      }
      
      // 캐시 확인
      const cacheKey = `melon_playlist_tracks_${id}`;
      const cachedTracks = this.cache.get<MelonTrack[]>(cacheKey);
      if (cachedTracks) {
        logger.music.info(`캐시에서 멜론 플레이리스트 트랙 정보 가져옴: ${cachedTracks.length}개 트랙`);
        return cachedTracks;
      }
      
      // 멜론 웹페이지에서 플레이리스트 정보 파싱
      const playlistUrl = `https://www.melon.com/playlist/detail.htm?plylstSeq=${id}`;
      const html = await this.fetchHtml(playlistUrl);
      
      const dom = new JSDOM(html);
      const document = dom.window.document;
      
      // 트랙 리스트
      const tracks: MelonTrack[] = [];
      
      // 업데이트된 선택자로 트랙 요소 가져오기
      const trackRows = document.querySelectorAll('div.service_list_song table tbody tr');
      
      trackRows.forEach((row: Element) => {
        // 트랙 ID 추출
        const checkbox = row.querySelector('input[type="checkbox"]');
        let trackId = '';
        if (checkbox) {
          trackId = checkbox.getAttribute('value') || '';
        }
        
        if (!trackId) return;
        
        // 트랙 제목
        const titleElement = row.querySelector('div.wrap_song_info div.ellipsis a');
        const title = titleElement ? titleElement.textContent?.trim() : '';
        
        if (!title) return;
        
        // 아티스트
        const artistElements = row.querySelectorAll('div.wrap_song_info div.ellipsis.rank02 a');
        const artists: string[] = [];
        artistElements.forEach((el: Element) => {
          const artist = el.textContent?.trim();
          if (artist) artists.push(artist);
        });
        
        // 앨범
        const albumElement = row.querySelector('div.wrap_song_info div:nth-child(3) a');
        const album = albumElement ? albumElement.textContent?.trim() : '';
        
        // 재생 시간
        const durationElement = row.querySelector('td:nth-of-type(4)');
        let duration = 0;
        
        if (durationElement) {
          const durationText = durationElement.textContent?.trim() || '';
          const durationMatch = durationText.match(/(\d+):(\d+)/);
          if (durationMatch) {
            const minutes = parseInt(durationMatch[1], 10);
            const seconds = parseInt(durationMatch[2], 10);
            duration = (minutes * 60 + seconds) * 1000; // 밀리초로 변환
          }
        }
        
        // 앨범 커버
        const albumCoverElement = row.querySelector('a.image_typeAll img');
        let albumArt = '';
        if (albumCoverElement) {
          albumArt = albumCoverElement.getAttribute('src') || '';
        }
        
        tracks.push({
          id: trackId,
          name: title,
          artists,
          album: album || '',
          albumArt: albumArt,
          duration,
          url: `https://www.melon.com/song/detail.htm?songId=${trackId}`
        });
      });
      
      // 캐시에 저장 (1시간)
      this.cache.set(cacheKey, tracks, 3600);
      
      return tracks;
    } catch (error) {
      logger.music.error('멜론 플레이리스트 정보 가져오기 실패:', error);
      return [];
    }
  }
  
  /**
   * Get Melon charts (Top 100)
   */
  public async getChartTracks(): Promise<MelonTrack[]> {
    try {
      // 캐시 확인
      const cacheKey = `melon_chart_tracks`;
      const cachedTracks = this.cache.get<MelonTrack[]>(cacheKey);
      if (cachedTracks) {
        logger.music.info(`캐시에서 멜론 차트 정보 가져옴: ${cachedTracks.length}개 트랙`);
        return cachedTracks;
      }
      
      // 멜론 실시간 차트 페이지
      const chartUrl = 'https://www.melon.com/chart/index.htm';
      const html = await this.fetchHtml(chartUrl);
      
      const dom = new JSDOM(html);
      const document = dom.window.document;
      
      // 차트 트랙 리스트
      const tracks: MelonTrack[] = [];
      // 업데이트된 선택자로 트랙 요소 가져오기
      const trackElements = document.querySelectorAll('div.service_list_song table tbody tr');
      
      trackElements.forEach((element: Element) => {
        // 트랙 ID
        const checkbox = element.querySelector('input[type="checkbox"]');
        let trackId = '';
        if (checkbox) {
          trackId = checkbox.getAttribute('value') || '';
        }
        
        if (!trackId) return;
        
        // 트랙 제목
        const titleElement = element.querySelector('div.wrap_song_info div.ellipsis a');
        const title = titleElement ? titleElement.textContent?.trim() : '';
        
        if (!title) return;
        
        // 아티스트
        const artistElements = element.querySelectorAll('div.wrap_song_info div.ellipsis.rank02 a');
        const artists: string[] = [];
        artistElements.forEach((el: Element) => {
          const artist = el.textContent?.trim();
          if (artist) artists.push(artist);
        });
        
        // 앨범
        const albumElement = element.querySelector('div.wrap_song_info div:nth-child(3) a');
        const album = albumElement ? albumElement.textContent?.trim() : '';
        
        // 앨범 커버
        const albumCoverElement = element.querySelector('a.image_typeAll img');
        let albumArt = '';
        if (albumCoverElement) {
          albumArt = albumCoverElement.getAttribute('src') || '';
        }
        
        tracks.push({
          id: trackId,
          name: title,
          artists,
          album: album || '',
          albumArt: albumArt,
          duration: 0, // 차트에는 재생 시간 정보가 없음
          url: `https://www.melon.com/song/detail.htm?songId=${trackId}`
        });
      });
      
      // 캐시에 저장 (30분 - 차트는 자주 업데이트됨)
      this.cache.set(cacheKey, tracks, 1800);
      
      return tracks;
    } catch (error) {
      logger.music.error('멜론 차트 정보 가져오기 실패:', error);
      return [];
    }
  }
  
  /**
   * Create a YouTube search query for a Melon track
   */
  public createSearchQuery(track: MelonTrack): string {
    const artistsStr = track.artists.join(' ');
    return `${track.name} ${artistsStr} audio`;
  }
  
  /**
   * Process a Melon URL to get tracks
   */
  public async processMelonUrl(url: string): Promise<MelonResult> {
    try {
      // URL에서 ID 추출
      const { type, id } = this.extractMelonId(url);
      
      let tracks: MelonTrack[] = [];
      
      logger.music.info(`멜론 ${type} 메타데이터 추출 중: ${url}`);
      
      switch (type) {
        case 'track':
          const track = await this.getTrack(url);
          if (track) {
            tracks = [track];
            logger.music.info(`멜론 트랙 정보 추출 성공: ${track.name} - ${track.artists.join(', ')}`);
          }
          break;
        case 'album':
          tracks = await this.getAlbumTracks(url);
          logger.music.info(`멜론 앨범에서 ${tracks.length}개 트랙 정보 추출 성공`);
          break;
        case 'playlist':
          tracks = await this.getPlaylistTracks(url);
          logger.music.info(`멜론 플레이리스트에서 ${tracks.length}개 트랙 정보 추출 성공`);
          break;
        case 'chart':
          tracks = await this.getChartTracks();
          logger.music.info(`멜론 차트에서 ${tracks.length}개 트랙 정보 추출 성공`);
          break;
        default:
          throw new Error('지원되지 않는 멜론 URL 유형입니다.');
      }
      
      // 각 트랙에 대해 YouTube URL 찾기 및 캐싱
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        
        // 원래 멜론 ID 저장
        const melonId = track.id;
        
        const searchQuery = this.createSearchQuery(track);
        logger.music.info(`트랙 "${track.name}" YouTube 검색 중: "${searchQuery}"`);
        
        // YouTube에서 URL 찾기
        const youtubeUrl = await this.ytdlpService.findBestMatch(searchQuery);
        if (youtubeUrl) {
          logger.music.success(`트랙 "${track.name}"에 대한 YouTube 매치 찾음: ${youtubeUrl}`);
          // YouTube URL을 트랙 정보에 추가
          track.youtubeUrl = youtubeUrl;
          
          try {
            // 미리 캐시에 다운로드 시도 - 멜론 ID를 사용
            const downloadResult = await this.ytdlpService.download(youtubeUrl, {
              serviceType: ServiceType.MELON,
              videoId: melonId // 멜론 ID 사용
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
        type,
        tracks
      };
    } catch (error) {
      logger.music.error('멜론 URL 처리 실패:', error);
      throw error;
    }
  }
  
  /**
   * Find YouTube URLs for Melon tracks
   */
  public async findYouTubeUrls(tracks: MelonTrack[]): Promise<MelonTrack[]> {
    const updatedTracks: MelonTrack[] = [];
    
    // 트랙을 하나씩 처리하며 유튜브 URL 찾기
    for (const track of tracks) {
      try {
        const searchQuery = this.createSearchQuery(track);
        const youtubeUrl = await this.ytdlpService.findBestMatch(searchQuery);
        
        // 유튜브 URL 추가
        if (youtubeUrl) {
          // 원래 멜론 ID 저장
          const melonId = track.id;
          
          // 캐시에 다운로드 시도
          try {
            const downloadResult = await this.ytdlpService.download(youtubeUrl, {
              serviceType: ServiceType.MELON,
              videoId: melonId // 멜론 ID 사용
            });
            
            if (downloadResult.success && downloadResult.filePath) {
              updatedTracks.push({
                ...track,
                youtubeUrl,
                filePath: downloadResult.filePath
              });
            } else {
              updatedTracks.push({
                ...track,
                youtubeUrl
              });
            }
          } catch (downloadError) {
            updatedTracks.push({
              ...track,
              youtubeUrl
            });
          }
          
          logger.music.info(`멜론 트랙 "${track.name}" 유튜브 매치: ${youtubeUrl}`);
        } else {
          updatedTracks.push(track); // 유튜브 URL을 찾지 못한 경우 원래 트랙 추가
          logger.music.warn(`멜론 트랙 "${track.name}"의 유튜브 매치를 찾지 못했습니다.`);
        }
      } catch (error) {
        logger.music.error(`멜론 트랙 "${track.name}"의 유튜브 매치 찾기 실패:`, error);
        updatedTracks.push(track); // 원래 트랙 추가
      }
    }
    
    return updatedTracks;
  }
  
  /**
   * 캐시에서 트랙 정보 가져오기
   */
  public getTrackFromCache(id: string): MelonTrack | null {
    const cacheKey = `melon_track_${id}`;
    return this.cache.get<MelonTrack>(cacheKey) || null;
  }
  
  /**
   * 캐시 무효화
   */
  public invalidateCache(): void {
    this.cache = new NodeCache();
    logger.music.info('멜론 서비스 캐시가 초기화되었습니다.');
  }
} 