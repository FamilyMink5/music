import SpotifyWebApi from 'spotify-web-api-node';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ServiceType } from './cache-service';
import { YtdlpService } from './ytdlp-service';

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: string[];
  album: string;
  albumArt?: string;
  duration: number;
  url: string;
  youtubeUrl?: string;  // YouTube URL for the track (if found)
  spotifyId?: string;   // Original Spotify ID
  filePath?: string;    // Local cache file path
}

export interface SpotifyResult {
  type: 'track' | 'album' | 'playlist';
  tracks: SpotifyTrack[];
}

export class SpotifyService {
  private static instance: SpotifyService;
  private spotifyApi: SpotifyWebApi;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): SpotifyService {
    if (!SpotifyService.instance) {
      SpotifyService.instance = new SpotifyService();
    }
    return SpotifyService.instance;
  }
  
  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {
    this.spotifyApi = new SpotifyWebApi({
      clientId: config.spotify.clientId,
      clientSecret: config.spotify.clientSecret,
    });
  }
  
  /**
   * Check if a URL is a Spotify URL
   */
  public isSpotifyUrl(url: string): boolean {
    return url.includes('spotify.com') || url.includes('open.spotify.com');
  }
  
  /**
   * Extract Spotify resource type and ID from URL
   */
  private extractSpotifyId(url: string): { type: 'track' | 'playlist' | 'album' | 'artist' | 'unknown', id: string } {
    try {
      const urlObj = new URL(url);
      
      // Handle mobile and web URLs
      const pathParts = urlObj.pathname.split('/').filter(part => part);
      
      if (pathParts.length < 2) {
        return { type: 'unknown', id: '' };
      }
      
      // Check if the path contains a valid type
      const type = pathParts[0] as 'track' | 'playlist' | 'album' | 'artist' | 'unknown';
      if (!['track', 'playlist', 'album', 'artist'].includes(type)) {
        return { type: 'unknown', id: '' };
      }
      
      // Extract the ID
      return { 
        type, 
        id: pathParts[1].split('?')[0] // Remove query parameters if any
      };
    } catch (error) {
      logger.music.error('스포티파이 URL 분석 오류:', error);
      return { type: 'unknown', id: '' };
    }
  }
  
  /**
   * Authenticate with Spotify API
   */
  private async authenticate(): Promise<boolean> {
    try {
      // Check if we already have a valid token
      const now = Date.now();
      if (this.accessToken && now < this.tokenExpiresAt - 60000) {
        // Token is still valid (with 1-minute buffer)
        return true;
      }
      
      logger.music.info('스포티파이 API 인증 중...');
      
      // Request new token
      const response = await this.spotifyApi.clientCredentialsGrant();
      this.accessToken = response.body.access_token;
      
      // Calculate when the token expires (subtract 1 minute for safety)
      this.tokenExpiresAt = now + (response.body.expires_in * 1000) - 60000;
      
      // Set the access token
      this.spotifyApi.setAccessToken(this.accessToken);
      
      logger.music.success('스포티파이 API 인증 성공');
      return true;
    } catch (error) {
      logger.music.error('스포티파이 API 인증 실패:', error);
      return false;
    }
  }
  
  /**
   * Get track information from Spotify
   */
  public async getTrack(url: string): Promise<SpotifyTrack | null> {
    try {
      // Authenticate first
      const authenticated = await this.authenticate();
      if (!authenticated) {
        throw new Error('스포티파이 API 인증에 실패했습니다.');
      }
      
      // Extract track ID from URL
      const { type, id } = this.extractSpotifyId(url);
      
      if (type !== 'track' || !id) {
        throw new Error('유효한 스포티파이 트랙 URL이 아닙니다.');
      }
      
      // Get track data
      const response = await this.spotifyApi.getTrack(id);
      const track = response.body;
      
      return {
        id: track.id,
        name: track.name,
        artists: track.artists.map(artist => artist.name),
        album: track.album.name,
        albumArt: track.album.images[0]?.url,
        duration: track.duration_ms,
        url: track.external_urls.spotify
      };
    } catch (error) {
      logger.music.error('스포티파이 트랙 정보 가져오기 실패:', error);
      return null;
    }
  }
  
  /**
   * Get tracks from a Spotify playlist
   */
  public async getPlaylistTracks(url: string): Promise<SpotifyTrack[]> {
    try {
      // Authenticate first
      const authenticated = await this.authenticate();
      if (!authenticated) {
        throw new Error('스포티파이 API 인증에 실패했습니다.');
      }
      
      // Extract playlist ID from URL
      const { type, id } = this.extractSpotifyId(url);
      
      if (type !== 'playlist' || !id) {
        throw new Error('유효한 스포티파이 플레이리스트 URL이 아닙니다.');
      }
      
      const tracks: SpotifyTrack[] = [];
      let offset = 0;
      const limit = 100; // Maximum allowed by Spotify API
      let total = Infinity;
      
      // Paginate through all tracks
      while (offset < total) {
        const response = await this.spotifyApi.getPlaylistTracks(id, { limit, offset });
        total = response.body.total;
        
        for (const item of response.body.items) {
          if (item.track) {
            tracks.push({
              id: item.track.id,
              name: item.track.name,
              artists: item.track.artists.map(artist => artist.name),
              album: item.track.album.name,
              albumArt: item.track.album.images[0]?.url,
              duration: item.track.duration_ms,
              url: item.track.external_urls.spotify
            });
          }
        }
        
        offset += limit;
      }
      
      return tracks;
    } catch (error) {
      logger.music.error('스포티파이 플레이리스트 정보 가져오기 실패:', error);
      return [];
    }
  }
  
  /**
   * Get tracks from a Spotify album
   */
  public async getAlbumTracks(url: string): Promise<SpotifyTrack[]> {
    try {
      // Authenticate first
      const authenticated = await this.authenticate();
      if (!authenticated) {
        throw new Error('스포티파이 API 인증에 실패했습니다.');
      }
      
      // Extract album ID from URL
      const { type, id } = this.extractSpotifyId(url);
      
      if (type !== 'album' || !id) {
        throw new Error('유효한 스포티파이 앨범 URL이 아닙니다.');
      }
      
      // Get album data first to get cover art and other metadata
      const albumResponse = await this.spotifyApi.getAlbum(id);
      const album = albumResponse.body;
      const albumName = album.name;
      const albumArt = album.images[0]?.url;
      
      const tracks: SpotifyTrack[] = [];
      let offset = 0;
      const limit = 50; // Maximum allowed by Spotify API
      let total = Infinity;
      
      // Paginate through all tracks
      while (offset < total) {
        const response = await this.spotifyApi.getAlbumTracks(id, { limit, offset });
        total = response.body.total;
        
        for (const track of response.body.items) {
          tracks.push({
            id: track.id,
            name: track.name,
            artists: track.artists.map(artist => artist.name),
            album: albumName,
            albumArt,
            duration: track.duration_ms,
            url: track.external_urls.spotify
          });
        }
        
        offset += limit;
      }
      
      return tracks;
    } catch (error) {
      logger.music.error('스포티파이 앨범 정보 가져오기 실패:', error);
      return [];
    }
  }
  
  /**
   * Convert a Spotify track to a search query for YouTube
   */
  public createSearchQuery(track: SpotifyTrack): string {
    // Create a search string that will work well for YouTube
    const artistsStr = track.artists.join(' ');
    return `${artistsStr} - ${track.name}`;
  }
  
  /**
   * Process Spotify URL and extract tracks
   */
  public async processSpotifyUrl(url: string): Promise<SpotifyResult> {
    try {
      const { type, id } = this.extractSpotifyId(url);
      
      if (type === 'unknown' || !id) {
        throw new Error('유효한 스포티파이 URL이 아닙니다.');
      }
      
      let tracks: SpotifyTrack[] = [];
      let resultType: 'track' | 'album' | 'playlist' = 'track';
      
      // 리소스 타입에 따라 다른 방식으로 처리
      if (type === 'track') {
        const track = await this.getTrack(url);
        if (track) {
          tracks = [track];
        }
        resultType = 'track';
      } 
      else if (type === 'playlist') {
        tracks = await this.getPlaylistTracks(url);
        resultType = 'playlist';
      } 
      else if (type === 'album') {
        tracks = await this.getAlbumTracks(url);
        resultType = 'album';
      }
      
      logger.music.info(`스포티파이 URL에서 ${tracks.length}개의 트랙을 추출했습니다.`);
      
      // 각 트랙에 대해 YouTube URL 찾기
      const ytdlpService = YtdlpService.getInstance();
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        
        // 원래 Spotify ID 저장
        track.spotifyId = track.id;
        
        const searchQuery = this.createSearchQuery(track);
        logger.music.info(`트랙 "${track.name}" YouTube 검색 중: "${searchQuery}"`);
        
        // YouTube에서 URL 찾기
        const youtubeUrl = await ytdlpService.findBestMatch(searchQuery);
        if (youtubeUrl) {
          logger.music.success(`트랙 "${track.name}"에 대한 YouTube 매치 찾음: ${youtubeUrl}`);
          // YouTube URL을 트랙 정보에 추가
          track.youtubeUrl = youtubeUrl;
          
          try {
            // YouTube 비디오 ID 추출
            const youtubeId = ytdlpService.extractVideoId(youtubeUrl);
            
            // 캐시 서비스를 통해 이미 YouTube ID로 저장된 파일이 있는지 확인
            const cacheService = ytdlpService.getCacheService();
            let cachedFilePath = null;
            
            if (youtubeId) {
              // 먼저 YouTube ID로 캐시 확인
              cachedFilePath = await cacheService.getFromCache(youtubeUrl, youtubeId);
              
              if (cachedFilePath) {
                logger.music.info(`YouTube ID(${youtubeId})로 캐시된 파일 사용: ${cachedFilePath}`);
                track.filePath = cachedFilePath;
                continue; // 이미 캐시된 파일이 있으면 다운로드 건너뜀
              }
            }
            
            // Spotify ID로도 캐시 확인
            cachedFilePath = await cacheService.getFromCache(track.url, track.spotifyId);
            if (cachedFilePath) {
              logger.music.info(`Spotify ID(${track.spotifyId})로 캐시된 파일 사용: ${cachedFilePath}`);
              track.filePath = cachedFilePath;
              continue; // 이미 캐시된 파일이 있으면 다운로드 건너뜀
            }
            
            // 캐시에 없으면 다운로드 시도
            logger.music.info(`캐시에 없음, 다운로드 시도: ${youtubeUrl}`);
            
            // 미리 캐시에 다운로드 시도 - YouTube ID와 Spotify ID 모두 연결
            const downloadResult = await ytdlpService.download(youtubeUrl, {
              serviceType: ServiceType.SPOTIFY,
              videoId: track.spotifyId,
              youtubeId: youtubeId // YouTube ID도 같이 전달
            });
            
            if (downloadResult.success && downloadResult.filePath) {
              // 파일 경로 저장
              track.filePath = downloadResult.filePath;
              logger.music.info(`트랙 "${track.name}" 다운로드 완료: ${downloadResult.filePath}`);
              
              // YouTube ID와 Spotify ID 간의 매핑 저장
              if (youtubeId) {
                const metadata = {
                  title: track.name,
                  url: track.url,
                  youtubeUrl: youtubeUrl,
                  downloadDate: new Date().toISOString(),
                  videoId: track.spotifyId,
                  youtubeId: youtubeId,
                  serviceType: ServiceType.SPOTIFY,
                  artists: track.artists,
                  album: track.album
                };
                
                // 메타데이터 업데이트 - YouTube ID로도 조회 가능하도록
                await cacheService.saveMetadata(youtubeUrl, metadata, youtubeId);
              }
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
        tracks,
        type: resultType
      };
    } catch (error) {
      logger.music.error('스포티파이 URL 처리 오류:', error);
      return {
        tracks: [],
        type: 'track'
      };
    }
  }
} 