import { createClient, WebDAVClient } from 'webdav';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import crypto from 'crypto';
import { logger, LogCategory } from '../utils/logger';
import { db } from '../database';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

// 캐시에 저장되는 메타데이터 타입
export interface CacheMetadata {
  title: string;
  url: string;
  downloadDate: string;
  videoId?: string;
  serviceType?: string;
  fileSize?: number;
  duration?: number;
  filePath?: string;
  nasPath?: string;
  [key: string]: any; // 기타 메타데이터
}

// 서비스 타입 상수
export enum ServiceType {
  YOUTUBE = 'youtube',
  SOUNDCLOUD = 'soundcloud',
  SPOTIFY = 'spotify',
  APPLE_MUSIC = 'apple-music',
  DEEZER = 'deezer',
  MELON = 'melon',
  OTHER = 'other'
}

export class CacheService {
  private client: WebDAVClient | null = null;
  private metadataCache: Map<string, CacheMetadata> = new Map();
  private isNasAvailable: boolean = false;
  private connectionAttempted: boolean = false;
  private retryCount: number = 0;
  private maxRetries: number = 5; // 재시도 횟수 증가
  private permanent: Set<string> = new Set(); // 영구 캐시 파일 추적
  private uploadQueue: Map<string, Promise<boolean>> = new Map(); // 업로드 큐
  private downloadStreams: Map<string, Promise<Readable | null>> = new Map(); // 다운로드 스트림 관리
  
  // 싱글톤 인스턴스
  private static instance: CacheService;
  
  // NAS 디렉토리 구조
  private readonly nasDirectories = {
    youtube: 'youtube',
    soundcloud: 'soundcloud',
    spotify: 'spotify',
    'apple-music': 'apple-music',
    deezer: 'deezer',
    melon: 'melon',
    other: 'other'
  };
  
  /**
   * 싱글톤 인스턴스 얻기
   */
  public static getInstance(): CacheService {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }
  
  constructor() {
    // 싱글톤 패턴 강제
    if (CacheService.instance) {
      return CacheService.instance;
    }
    
    CacheService.instance = this;
    
    this.initializeWebDAV();
    
    // 캐시 디렉토리 초기화 및 생성
    this.initializeCacheDirectory();
  }
  
  /**
   * 캐시 디렉토리 초기화 및 생성
   */
  private initializeCacheDirectory(): void {
    // 기존 캐시 디렉토리가 없으면 생성
    if (!fs.existsSync(config.localCacheDir)) {
      fs.mkdirSync(config.localCacheDir, { recursive: true });
      logger.cache.info(`캐시 디렉토리 생성됨: ${config.localCacheDir}`);
    }
    
    // 서비스별 캐시 디렉토리 생성
    this.createServiceDirectories();
    
    // 앱 시작 시 초기 캐시 정리 실행
    logger.cache.info('🧹 초기 캐시 정리 수행 중...');
    this.cleanupLocalCache(0); // 0일로 설정하여 영구 캐시가 아닌 모든 파일 정리
  }
  
  /**
   * 서비스별 로컬 캐시 디렉토리 생성
   */
  private createServiceDirectories(): void {
    Object.values(this.nasDirectories).forEach(dir => {
      const dirPath = path.join(config.localCacheDir, dir);
      if (!fs.existsSync(dirPath)) {
        logger.cache.info(`서비스 캐시 디렉토리 생성: ${dirPath}`);
        fs.mkdirSync(dirPath, { recursive: true });
      }
    });
  }
  
  /**
   * WebDAV 클라이언트 초기화
   */
  private async initializeWebDAV(): Promise<void> {
    if (this.connectionAttempted && this.isNasAvailable) {
      return; // 이미 연결 성공함
    }
    
    try {
      this.connectionAttempted = true;
      this.retryCount = 0; // 재시도 카운트 초기화
      
      logger.cache.info('WebDAV NAS 연결 시도 중...');
      this.client = createClient(config.nas.webdav.url, {
        username: config.nas.webdav.username,
        password: config.nas.webdav.password,
        maxBodyLength: 100 * 1024 * 1024, // 100MB
        maxContentLength: 100 * 1024 * 1024 // 100MB
      });
      
      // NAS 연결 테스트: 루트 디렉토리 조회 시도
      const exists = await this.client.exists(config.nas.cachePath);
      
      if (!exists) {
        // 캐시 디렉토리가 없으면 생성
        logger.cache.info(`NAS 캐시 디렉토리 생성 중: ${config.nas.cachePath}`);
        await this.client.createDirectory(config.nas.cachePath);
      }
      
      // 서비스별 디렉토리 확인 및 생성
      await this.createNasServiceDirectories();
      
      this.isNasAvailable = true;
      logger.cache.success('WebDAV NAS 연결 성공');
      
    } catch (error) {
      logger.cache.error('WebDAV NAS 연결 실패:', error);
      this.isNasAvailable = false;
      this.client = null;
      
      // 연결 실패 시 자동 재시도
      setTimeout(() => this.reconnectWebDAV(), 5000);
    }
  }
  
  /**
   * NAS에 서비스별 디렉토리 생성
   */
  private async createNasServiceDirectories(): Promise<void> {
    if (!this.client) return;
    
    try {
      for (const [service, dirName] of Object.entries(this.nasDirectories)) {
        const serviceDir = this.normalizePath(path.join(config.nas.cachePath, dirName));
        
        const exists = await this.client.exists(serviceDir);
        if (!exists) {
          logger.cache.info(`NAS 서비스 디렉토리 생성 중: ${serviceDir}`);
          await this.client.createDirectory(serviceDir);
        }
      }
    } catch (error) {
      logger.cache.error('NAS 서비스 디렉토리 생성 실패:', error);
    }
  }
  
  /**
   * WebDAV 클라이언트 재연결 시도
   */
  private async reconnectWebDAV(): Promise<boolean> {
    if (this.retryCount >= this.maxRetries) {
      logger.cache.warn(`최대 재시도 횟수(${this.maxRetries})를 초과했습니다. NAS 연결을 포기합니다.`);
      this.isNasAvailable = false;
      return false;
    }
    
    this.retryCount++;
    logger.cache.info(`WebDAV NAS 재연결 시도 #${this.retryCount}/${this.maxRetries}...`);
    
    try {
      this.client = createClient(config.nas.webdav.url, {
        username: config.nas.webdav.username,
        password: config.nas.webdav.password,
        maxBodyLength: 100 * 1024 * 1024,
        maxContentLength: 100 * 1024 * 1024
      });
      
      // 간단한 연결 테스트
      await this.client.getDirectoryContents(config.nas.cachePath);
      
      this.isNasAvailable = true;
      logger.cache.success('WebDAV NAS 재연결 성공');
      
      // 재연결 성공 시 서비스 디렉토리 확인
      await this.createNasServiceDirectories();
      
      return true;
    } catch (error) {
      logger.cache.error('WebDAV NAS 재연결 실패:', error);
      this.isNasAvailable = false;
      
      // 잠시 대기 후 자동으로 다시 시도
      setTimeout(() => this.reconnectWebDAV(), 5000 * this.retryCount);
      return false;
    }
  }
  
  /**
   * URL에서 비디오/트랙 ID 추출 시도
   */
  private extractVideoId(url: string): string | null {
    const serviceType = this.getServiceType(url);
    
    // YouTube URL 패턴에서 ID 추출
    if (serviceType === ServiceType.YOUTUBE) {
      const youtubeRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
      const match = url.match(youtubeRegex);
      return match ? match[1] : null;
    }
    
    // SoundCloud URL에서 트랙 ID 추출
    if (serviceType === ServiceType.SOUNDCLOUD) {
      const parts = url.split('/');
      if (parts.length >= 5) {
        // 트랙명을 ID로 사용
        const trackName = parts[parts.length - 1].split('?')[0];
        if (trackName) {
          return `sc_${trackName}`;
        }
      }
      return `sc_${this.hashString(url).substring(0, 10)}`;
    }
    
    // Spotify URL에서 트랙/앨범/플레이리스트 ID 추출
    if (serviceType === ServiceType.SPOTIFY) {
      const spotifyRegex = /spotify\.com\/(?:track|album|playlist|artist)\/([a-zA-Z0-9]+)/;
      const match = url.match(spotifyRegex);
      return match ? `sp_${match[1]}` : `sp_${this.hashString(url).substring(0, 10)}`;
    }
    
    // Apple Music URL에서 ID 추출
    if (serviceType === ServiceType.APPLE_MUSIC) {
      const appleMusicRegex = /music\.apple\.com\/(?:[a-z]{2}\/)(?:album|song|playlist)(?:\/[^\/]+)?\/(?:id)?([0-9]+)/;
      const match = url.match(appleMusicRegex);
      return match ? `am_${match[1]}` : `am_${this.hashString(url).substring(0, 10)}`;
    }
    
    // Deezer URL에서 트랙/앨범 ID 추출
    if (serviceType === ServiceType.DEEZER) {
      const deezerRegex = /deezer\.com\/(?:[a-z]{2}\/)(?:track|album|playlist)\/([0-9]+)/;
      const match = url.match(deezerRegex);
      return match ? `dz_${match[1]}` : `dz_${this.hashString(url).substring(0, 10)}`;
    }
    
    // 다른 서비스의 URL은 해시 사용
    return `other_${this.hashString(url).substring(0, 10)}`;
  }
  
  /**
   * URL에서 서비스 타입 판별
   */
  private getServiceType(url: string): ServiceType {
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      return ServiceType.YOUTUBE;
    } else if (url.includes('soundcloud.com')) {
      return ServiceType.SOUNDCLOUD;
    } else if (url.includes('spotify.com') || url.includes('open.spotify.com')) {
      return ServiceType.SPOTIFY;
    } else if (url.includes('apple.com') || url.includes('music.apple.com')) {
      return ServiceType.APPLE_MUSIC;
    } else if (url.includes('deezer.com')) {
      return ServiceType.DEEZER;
    } else {
      return ServiceType.OTHER;
    }
  }
  
  /**
   * 서비스별 캐시 디렉토리 경로 반환
   */
  private getServiceDirectory(serviceType: ServiceType): string {
    switch (serviceType) {
      case ServiceType.YOUTUBE:
        return this.nasDirectories.youtube;
      case ServiceType.SOUNDCLOUD:
        return this.nasDirectories.soundcloud;
      case ServiceType.SPOTIFY:
        return this.nasDirectories.spotify;
      case ServiceType.APPLE_MUSIC:
        return this.nasDirectories['apple-music'];
      case ServiceType.DEEZER:
        return this.nasDirectories.deezer;
      case ServiceType.MELON:
        return this.nasDirectories.melon;
      default:
        return this.nasDirectories.other;
    }
  }
  
  /**
   * 문자열 해싱 (ID 생성용)
   */
  private hashString(str: string): string {
    return crypto.createHash('md5').update(str).digest('hex');
  }
  
  /**
   * Generate a unique filename for a URL
   */
  private generateCacheFilename(url: string, videoId?: string, serviceType?: ServiceType): string {
    // 서비스 타입 결정
    const service = serviceType || this.getServiceType(url);
    
    // 1. 명시적으로 제공된 비디오 ID가 있으면 사용
    if (videoId) {
      return `${videoId}.mp3`;
    }
    
    // 2. URL에서 비디오 ID 추출 시도
    const extractedId = this.extractVideoId(url);
    if (extractedId) {
      return `${extractedId}.mp3`;
    }
    
    // 3. 그 외의 경우에는 URL의 해시값 사용
    const hash = this.hashString(url);
    return `${hash}.mp3`;
  }
  
  /**
   * Generate filename for the metadata file
   */
  private generateMetadataFilename(url: string, videoId?: string, serviceType?: ServiceType): string {
    // 기본 파일명 얻기 (확장자만 변경)
    const baseFilename = this.generateCacheFilename(url, videoId, serviceType);
    return baseFilename.replace('.mp3', '.meta.json');
  }
  
  /**
   * Get cache key for internal cache
   */
  private getCacheKey(url: string, videoId?: string): string {
    // 1. 명시적으로 제공된 비디오 ID가 있으면 사용
    if (videoId) {
      return videoId;
    }
    
    // 2. URL에서 비디오 ID 추출 시도
    const extractedId = this.extractVideoId(url);
    if (extractedId) {
      return extractedId;
    }
    
    // 3. 그 외의 경우에는 URL 자체를 키로 사용
    return url;
  }
  
  /**
   * 영구 캐시 파일로 표시
   */
  markAsPermanent(filename: string): void {
    this.permanent.add(filename);
    
    // 확장자 제거한 파일명으로도 추가 (mp3와 meta.json 모두 보존)
    const baseName = path.basename(filename, path.extname(filename));
    this.permanent.add(baseName);
  }
  
  /**
   * 영구 캐시 파일인지 확인
   */
  isPermanent(filename: string): boolean {
    // 파일 이름 자체가 영구 목록에 있는지 확인
    if (this.permanent.has(filename)) {
      return true;
    }
    
    // 확장자 제거한 파일명으로 확인 (mp3와 meta.json 모두 보존)
    const baseName = path.basename(filename, path.extname(filename));
    return this.permanent.has(baseName);
  }
  
  /**
   * Normalize path for WebDAV (ensure forward slashes)
   */
  private normalizePath(p: string): string {
    // Replace all backslashes with forward slashes for WebDAV
    return p.replace(/\\/g, '/');
  }
  
  /**
   * Check if a file exists in cache (local, DB, or NAS)
   * @param videoId 서비스 고유 ID (우선 사용)
   * @param serviceType 서비스 타입 (videoId와 함께 사용)
   * @returns 캐시 존재 여부 (boolean)
   */
  async existsInCache(
    url: string, 
    videoId?: string, 
    serviceType?: ServiceType
  ): Promise<boolean> {
    const logPrefix = `[Cache Check ${videoId || url}]:`;
    logger.cache.debug(`${logPrefix} 캐시 확인 시작... Video ID: ${videoId}, Service Type: ${serviceType}`);

    // 1. videoId와 serviceType이 있으면 DB 우선 조회
    if (videoId && serviceType) {
      try {
        const dbCache = await this.getCacheFromDb(videoId, serviceType);
        if (dbCache) {
          logger.cache.debug(`${logPrefix} DB에서 캐시 발견. NAS 경로: ${dbCache.nasPath}`);
          // NAS 경로가 있거나, NAS 연결 불가 상태여도 DB에 기록이 있으면 캐시된 것으로 간주
          // (NAS 연결 실패 시 로컬 파일 사용 가능성 염두)
          if (dbCache.nasPath || !this.isNasAvailable) {
              await this.updateCacheAccess(videoId, serviceType); // 접근 시간 업데이트
              return true;
          } 
          // DB에는 있지만 NAS 경로가 없는 경우 -> NAS 확인 필요
          logger.cache.debug(`${logPrefix} DB에 기록은 있으나 NAS 경로 없음. NAS 확인 진행...`);
        } else {
           logger.cache.debug(`${logPrefix} DB에서 캐시 찾지 못함.`);
           // DB에 없으면 NAS/로컬에도 없을 가능성이 높지만, 혹시 모를 불일치 대비 아래 로직 계속 진행
        }
      } catch (dbError) {
        logger.cache.error(`${logPrefix} DB 조회 중 오류 발생:`, dbError);
        // DB 오류 시 NAS/로컬 확인으로 폴백
      }
    } else {
      logger.cache.warn(`${logPrefix} Video ID 또는 Service Type 누락. URL 기반 확인 시도.`);
      // videoId나 serviceType 없으면 기존 로직대로 URL 기반 확인 시도 (정확도 낮음)
      // ID 추출 재시도
      const extractedId = this.extractVideoId(url);
      const inferredServiceType = this.getServiceType(url);
      if (extractedId && inferredServiceType !== ServiceType.OTHER) {
         logger.cache.debug(`${logPrefix} URL에서 ID(${extractedId}) 및 Type(${inferredServiceType}) 재추출 성공. DB 재확인 시도.`);
         // 추출 성공 시 DB 다시 확인
         return this.existsInCache(url, extractedId, inferredServiceType);
      } else {
         logger.cache.warn(`${logPrefix} URL에서 ID/Type 추출 실패. 파일명 기반 확인 진행.`);
      }
    }

    // --- DB 조회 후 또는 videoId 없을 경우 NAS/로컬 확인 ---
    
    // videoId 기반 파일명 생성 시도
    let cacheFilename: string | null = null;
    let metadataFilename: string | null = null;
    const effectiveVideoId = videoId || this.extractVideoId(url); // Fallback ID 추출
    const effectiveServiceType = serviceType || this.getServiceType(url); // Fallback 타입

    if (effectiveVideoId && effectiveServiceType !== ServiceType.OTHER) {
        cacheFilename = this.generateCacheFilename(url, effectiveVideoId, effectiveServiceType);
        metadataFilename = this.generateMetadataFilename(url, effectiveVideoId, effectiveServiceType);
        logger.cache.debug(`${logPrefix} ID 기반 파일명 생성: ${cacheFilename}`);
    } else {
        // ID 기반 생성 실패 시 URL 해시 기반 파일명 사용 (기존 방식)
        cacheFilename = this.generateCacheFilename(url);
        metadataFilename = this.generateMetadataFilename(url);
        logger.cache.debug(`${logPrefix} URL 해시 기반 파일명 생성: ${cacheFilename}`);
    }
    
    // Ensure cacheFilename is not null before proceeding
    if (!cacheFilename || !metadataFilename) {
        logger.cache.error(`${logPrefix} Cache filename could not be generated.`);
        return false; 
    }

    const localFilePath = path.join(config.localCacheDir, effectiveServiceType, cacheFilename);
    const localMetadataPath = path.join(config.localCacheDir, effectiveServiceType, metadataFilename);

    // 2. NAS 확인 (NAS 연결 가능하고, videoId/serviceType 기반으로 DB 조회 후 NAS 경로 없던 경우)
    if (this.isNasAvailable && videoId && serviceType && cacheFilename) {
        const nasPath = this.normalizePath(path.join(config.nas.cachePath, this.getServiceDirectory(serviceType), cacheFilename));
        logger.cache.debug(`${logPrefix} NAS 확인 시도: ${nasPath}`);
        try {
            const nasExists = await this.client!.exists(nasPath);
            if (nasExists) {
                logger.cache.debug(`${logPrefix} NAS에서 캐시 발견.`);
                // NAS에 존재하면 DB 정보 업데이트 시도 (만약 DB에 nasPath가 누락된 경우)
                const dbCache = await this.getCacheFromDb(videoId, serviceType);
                if (dbCache && !dbCache.nasPath) {
                   logger.cache.info(`${logPrefix} DB의 NAS 경로 누락 확인. 업데이트 시도...`);
                   // 파일 크기, 재생 시간 등 추가 정보 가져오기 시도 (선택 사항)
                   let fileSize: number | undefined;
                   try {
                       const stats = await this.client!.stat(nasPath);
                       // stats 객체 타입 확인 및 size 속성 안전하게 접근
                       if (stats && typeof stats === 'object') {
                           if ('size' in stats && typeof stats.size === 'number') {
                               fileSize = stats.size; // FileStat 타입의 경우
                           } else if ('data' in stats && typeof stats.data === 'object' && stats.data && 'size' in stats.data && typeof stats.data.size === 'number') {
                               fileSize = stats.data.size; // ResponseDataDetailed<FileStat> 타입의 경우 (추정)
                           }
                       }
                       if (fileSize !== undefined) {
                            logger.cache.debug(`${logPrefix} NAS 파일 크기 확인: ${fileSize} bytes`);
                       } else {
                           logger.cache.warn(`${logPrefix} NAS 파일 정보에서 크기 속성을 찾을 수 없습니다.`);
                       }
                   } catch (statError) {
                       logger.cache.warn(`${logPrefix} NAS 파일 정보 조회 실패:`, statError);
                   }
                   // DB 저장 시 확인된 fileSize 사용
                   await this.saveCacheToDb(
                       videoId, 
                       dbCache.title || 'N/A', 
                       dbCache.url || url,     
                       serviceType,
                       nasPath,                
                       fileSize, // 안전하게 접근한 파일 크기 사용
                       dbCache.duration        
                   );
                }
                await this.updateCacheAccess(videoId, serviceType); 
                return true;
            }
             logger.cache.debug(`${logPrefix} NAS에서 캐시 찾지 못함.`);
        } catch (nasError) {
            logger.cache.error(`${logPrefix} NAS 확인 중 오류 발생:`, nasError);
            // NAS 오류 시 로컬 확인으로 폴백
        }
    } else if (!this.isNasAvailable) {
        logger.cache.debug(`${logPrefix} NAS 사용 불가. 로컬 캐시 확인 진행.`);
    }

    // 3. 로컬 캐시 확인 (위 조건에서 찾지 못한 경우)
    logger.cache.debug(`${logPrefix} 로컬 캐시 확인 시도: ${localFilePath}`);
    if (fs.existsSync(localFilePath)) {
      logger.cache.debug(`${logPrefix} 로컬 캐시에서 파일 발견.`);
      // 로컬 파일 발견 시, DB에 있는지 확인하고 없으면 등록 시도 (정합성 유지 목적)
       if (videoId && serviceType) {
          try {
             const dbCache = await this.getCacheFromDb(videoId, serviceType);
             if (!dbCache) {
                 logger.cache.warn(`${logPrefix} 로컬 파일은 있으나 DB 기록 없음. 메타데이터 로드 및 DB 저장 시도...`);
                 const localMetadata = await this.loadMetadataFromFile(localMetadataPath);
                 if (localMetadata) {
                     // Get file size using fs.statSync as it's guaranteed to exist here
                     let fileSize: number | undefined;
                     try {
                         fileSize = fs.statSync(localFilePath).size;
                     } catch (statError) {
                         logger.cache.warn(`${logPrefix} 로컬 파일 크기 조회 실패:`, statError);
                     }

                     await this.saveCacheToDb(
                         videoId, 
                         localMetadata.title || 'N/A', 
                         localMetadata.url || url, 
                         serviceType, 
                         undefined, // 로컬 파일이므로 NAS 경로는 없음
                         localMetadata.fileSize || fileSize, // Use metadata first, then stat
                         localMetadata.duration
                     );
                 } else {
                      logger.cache.warn(`${logPrefix} 로컬 메타데이터 파일(${localMetadataPath}) 로드 실패. DB 저장 불가.`);
                 }
             }
             await this.updateCacheAccess(videoId, serviceType); // 접근 시간 업데이트
          } catch (dbError) {
              logger.cache.error(`${logPrefix} 로컬 파일 확인 중 DB 오류 발생:`, dbError);
          }
       }
      return true;
    }

    logger.cache.debug(`${logPrefix} 로컬 캐시에서 파일 찾지 못함. 최종 결과: 캐시 없음.`);
    return false;
  }

  // loadMetadataFromFile 헬퍼 함수 추가
  private async loadMetadataFromFile(metadataPath: string): Promise<CacheMetadata | null> {
      if (!fs.existsSync(metadataPath)) {
          return null;
      }
      try {
          const data = await fs.promises.readFile(metadataPath, 'utf-8');
          return JSON.parse(data) as CacheMetadata;
      } catch (error) {
          logger.cache.error(`로컬 메타데이터 파일 로드 실패 (${metadataPath}):`, error);
          // Attempt to delete corrupted metadata file? Or just return null.
          // Consider adding deletion logic here if corrupted files are problematic.
          // try { await fs.promises.unlink(metadataPath); } catch (unlinkError) { /* ignore */ }
          return null;
      }
  }
  
  /**
   * Save a file to the cache (both local and NAS)
   * 주의: 로컬에 즉시 저장하고, NAS에는 비동기적으로 업로드
   */
  async saveToCache(url: string, localFilePath: string, metadata?: CacheMetadata, videoId?: string): Promise<boolean> {
    const serviceType = metadata?.serviceType ? 
      metadata.serviceType as ServiceType : 
      this.getServiceType(url);
      
    const finalVideoId = videoId || metadata?.videoId || this.extractVideoId(url) || this.hashString(url);
    const filename = this.generateCacheFilename(url, finalVideoId, serviceType as ServiceType);
    const serviceDir = this.getServiceDirectory(serviceType as ServiceType);
    
    // 캐시 파일을 영구 보존 대상으로 표시
    this.markAsPermanent(filename);
    
    // 메타데이터 준비
    const finalMetadata: CacheMetadata = metadata || {
      title: path.basename(filename, '.mp3'),
      url,
      downloadDate: new Date().toISOString(),
      videoId: finalVideoId,
      serviceType
    };
    
    // 로컬 캐시 경로
    const localCacheDir = path.join(config.localCacheDir, serviceDir);
    if (!fs.existsSync(localCacheDir)) {
      fs.mkdirSync(localCacheDir, { recursive: true });
    }
    
    const localCachePath = path.join(localCacheDir, filename);
    
    try {
      // 파일이 이미 로컬 캐시 경로에 있는지 확인
      if (localFilePath !== localCachePath && fs.existsSync(localFilePath)) {
        // 파일 복사
        fs.copyFileSync(localFilePath, localCachePath);
        logger.cache.info(`파일을 로컬 캐시로 복사: ${localCachePath}`);
      }
      
      // 파일 크기 확인
      const stats = fs.statSync(localCachePath);
      finalMetadata.fileSize = stats.size;
      
      // NAS 경로 생성 (향후 업로드 시 사용)
      const nasPath = this.normalizePath(path.join(
        config.nas.cachePath, 
        serviceDir, 
        filename
      ));
      
      // DB에 저장 (NAS 경로 포함)
      await this.saveCacheToDb(
        finalVideoId,
        finalMetadata.title,
        url,
        serviceType as ServiceType,
        nasPath, // NAS 경로 추가하여 메타데이터 DB에 저장
        stats.size,
        finalMetadata.duration
      );
      
      // 메모리 캐시에도 저장 (NAS 경로 추가)
      finalMetadata.nasPath = nasPath;
      const cacheKey = this.getCacheKey(url, videoId);
      this.metadataCache.set(cacheKey, finalMetadata);
      
      // NAS에 비동기적으로 업로드 (백그라운드에서 실행)
      this.uploadToNasAsync(localCachePath, url, finalMetadata, finalVideoId);
      
      return true;
    } catch (error) {
      logger.cache.error('로컬 캐시 저장 실패:', error);
      return false;
    }
  }
  
  /**
   * Save metadata to the NAS cache
   */
  async saveMetadata(url: string, metadata: CacheMetadata, videoId?: string): Promise<boolean> {
    const serviceType = metadata.serviceType ? 
      metadata.serviceType as ServiceType : 
      this.getServiceType(url);
      
    // 비디오 ID가 메타데이터에 없고 매개변수로 제공되었으면 추가
    const finalVideoId = videoId || metadata.videoId || this.extractVideoId(url) || this.hashString(url);
    if (!metadata.videoId) {
      metadata.videoId = finalVideoId;
    }
    
    // 서비스 타입 추가
    if (!metadata.serviceType) {
      metadata.serviceType = serviceType;
    }
    
    // 캐시 키 결정
    const cacheKey = this.getCacheKey(url, finalVideoId);
    this.markAsPermanent(cacheKey);
    
    // 메모리 캐시에는 항상 저장
    this.metadataCache.set(cacheKey, metadata);
    
    // 메타데이터 파일명
    const metaFilename = this.generateMetadataFilename(url, finalVideoId, serviceType as ServiceType);
    const serviceDir = this.getServiceDirectory(serviceType as ServiceType);
    this.markAsPermanent(metaFilename);
    
    // 로컬에 메타데이터 저장
    try {
      const localMetaDir = path.join(config.localCacheDir, serviceDir);
      if (!fs.existsSync(localMetaDir)) {
        fs.mkdirSync(localMetaDir, { recursive: true });
      }
      
      const localMetaPath = path.join(localMetaDir, metaFilename);
      fs.writeFileSync(localMetaPath, JSON.stringify(metadata, null, 2));
    } catch (error) {
      logger.cache.error('로컬 메타데이터 저장 실패:', error);
    }
    
    // NAS 사용 불가능하면 연결 시도
    if (!this.isNasAvailable || !this.client) {
      await this.initializeWebDAV();
      if (!this.isNasAvailable || !this.client) {
        logger.cache.info('NAS를 사용할 수 없어 메타데이터 NAS 저장을 건너뜁니다.');
        return true; // 메모리와 로컬에는 저장되었으므로 true 반환
      }
    }
    
    // WebDAV 경로는 항상 정규화 (forward slash 사용)
    const remoteMetaPath = this.normalizePath(path.join(
      config.nas.cachePath, 
      serviceDir, 
      metaFilename
    ));
    
    try {
      // NAS에 저장
      const metaContent = JSON.stringify(metadata, null, 2);
      await this.client.putFileContents(remoteMetaPath, metaContent, { 
        overwrite: true 
      });
      return true;
    } catch (error) {
      logger.cache.error('Error saving metadata to NAS:', error);
      
      // 다시 시도
      if (await this.reconnectWebDAV()) {
        try {
          const metaContent = JSON.stringify(metadata, null, 2);
          await this.client.putFileContents(remoteMetaPath, metaContent, { 
            overwrite: true 
          });
          return true;
        } catch {
          return false;
        }
      }
      
      return false;
    }
  }
  
  /**
   * Get metadata from the cache
   */
  async getMetadata(
    url: string, 
    videoId?: string, 
    serviceType?: ServiceType
  ): Promise<CacheMetadata | null> {
    const logPrefix = `[Metadata Get ${videoId || url}]:`;
    logger.cache.debug(`${logPrefix} 메타데이터 조회 시작... Video ID: ${videoId}, Service Type: ${serviceType}`);
    
    // 1. videoId와 serviceType이 있으면 DB 우선 조회
    if (videoId && serviceType) {
      try {
        const dbMetadata = await this.getCacheFromDb(videoId, serviceType);
        if (dbMetadata) {
          logger.cache.debug(`${logPrefix} DB에서 메타데이터 발견.`);
          // DB에서 가져온 메타데이터가 CacheMetadata 인터페이스를 따르도록 변환
          // (DB 스키마와 CacheMetadata 인터페이스가 다를 수 있음을 가정)
          const formattedMetadata: CacheMetadata = {
            title: dbMetadata.title || '',
            url: dbMetadata.url || url, // DB에 URL 없으면 fallback
            downloadDate: dbMetadata.downloadDate || new Date(0).toISOString(), // 날짜 없으면 기본값
            videoId: videoId,
            serviceType: serviceType.toString(), // Enum을 string으로 변환
            fileSize: dbMetadata.fileSize,
            duration: dbMetadata.duration,
            filePath: undefined, // DB에는 로컬 경로 저장 안 함 (NAS 우선)
            nasPath: dbMetadata.nasPath,
            // 필요시 dbMetadata의 다른 필드 추가
          };
          await this.updateCacheAccess(videoId, serviceType); // 접근 시간 업데이트
          return formattedMetadata;
        }
         logger.cache.debug(`${logPrefix} DB에서 메타데이터 찾지 못함.`);
      } catch (dbError) {
        logger.cache.error(`${logPrefix} DB 메타데이터 조회 중 오류 발생:`, dbError);
        // DB 오류 시 NAS/로컬 확인으로 폴백
      }
    } else {
       logger.cache.warn(`${logPrefix} Video ID 또는 Service Type 누락. URL 기반 확인 시도.`);
        // videoId나 serviceType 없으면 기존 로직대로 URL 기반 확인 시도
        const extractedId = this.extractVideoId(url);
        const inferredServiceType = this.getServiceType(url);
        if (extractedId && inferredServiceType !== ServiceType.OTHER) {
            logger.cache.debug(`${logPrefix} URL에서 ID(${extractedId}) 및 Type(${inferredServiceType}) 재추출 성공. 메타데이터 재확인 시도.`);
            return this.getMetadata(url, extractedId, inferredServiceType); // 재귀 호출
        } else {
            logger.cache.warn(`${logPrefix} URL에서 ID/Type 추출 실패. 파일명 기반 확인 진행.`);
        }
    }

    // --- DB 조회 후 또는 videoId 없을 경우 파일 기반 확인 ---

    // 파일명 생성 (videoId 우선 사용)
    const effectiveVideoId = videoId || this.extractVideoId(url);
    const effectiveServiceType = serviceType || this.getServiceType(url);
    let metadataFilename: string | null = null;

    if (effectiveVideoId && effectiveServiceType !== ServiceType.OTHER) {
        metadataFilename = this.generateMetadataFilename(url, effectiveVideoId, effectiveServiceType);
        logger.cache.debug(`${logPrefix} ID 기반 메타데이터 파일명 생성: ${metadataFilename}`);
    } else {
        metadataFilename = this.generateMetadataFilename(url); // Fallback: URL 해시 기반
        logger.cache.debug(`${logPrefix} URL 해시 기반 메타데이터 파일명 생성: ${metadataFilename}`);
    }

    if (!metadataFilename) {
        logger.cache.error(`${logPrefix} 메타데이터 파일명을 생성할 수 없습니다.`);
        return null;
    }

    const localMetadataPath = path.join(config.localCacheDir, effectiveServiceType, metadataFilename);

    // 2. NAS 메타데이터 확인 (NAS 연결 가능 시)
    if (this.isNasAvailable && this.client && effectiveServiceType !== ServiceType.OTHER) {
      const nasMetadataPath = this.normalizePath(path.join(config.nas.cachePath, this.getServiceDirectory(effectiveServiceType), metadataFilename));
      logger.cache.debug(`${logPrefix} NAS 메타데이터 확인 시도: ${nasMetadataPath}`);
      try {
        const nasMetadataExists = await this.client.exists(nasMetadataPath);
        if (nasMetadataExists) {
          logger.cache.debug(`${logPrefix} NAS에서 메타데이터 파일 발견. 내용 로드 시도...`);
          const content = await this.client.getFileContents(nasMetadataPath, { format: 'text' });
          if (typeof content === 'string') {
              const metadata = JSON.parse(content) as CacheMetadata;
              logger.cache.debug(`${logPrefix} NAS 메타데이터 로드 성공.`);
               // NAS 메타데이터 발견 시 DB 업데이트 시도 (일관성 유지)
               if (videoId && serviceType) {
                   const dbData = await this.getCacheFromDb(videoId, serviceType);
                   if (!dbData) {
                       logger.cache.info(`${logPrefix} DB 기록 없음. NAS 메타데이터 기반으로 DB 저장 시도...`);
                       await this.saveCacheToDb(
                           videoId,
                           metadata.title,
                           metadata.url || url,
                           serviceType,
                           metadata.nasPath || nasMetadataPath, // Use metadata path if available, otherwise constructed path
                           metadata.fileSize,
                           metadata.duration
                       );
                   } else if (dbData && !dbData.nasPath) {
                        // DB는 있는데 NAS 경로가 없을 경우 업데이트
                        logger.cache.info(`${logPrefix} DB에 NAS 경로 없음. NAS 메타데이터 기반으로 업데이트 시도...`);
                        await this.saveCacheToDb(
                           videoId,
                           metadata.title || dbData.title, // Prefer loaded metadata title
                           metadata.url || dbData.url || url,
                           serviceType,
                           metadata.nasPath || nasMetadataPath,
                           metadata.fileSize || dbData.fileSize,
                           metadata.duration || dbData.duration
                       );
                   }
                  await this.updateCacheAccess(videoId, serviceType);
               }
              return metadata;
          } else {
              logger.cache.warn(`${logPrefix} NAS 메타데이터 파일 내용이 문자열이 아님: ${typeof content}`);
          }
        }
         logger.cache.debug(`${logPrefix} NAS에서 메타데이터 파일 찾지 못함.`);
      } catch (nasError) {
        logger.cache.error(`${logPrefix} NAS 메타데이터 확인/로드 중 오류 발생:`, nasError);
        // NAS 오류 시 로컬 확인으로 폴백
      }
    } else if (!this.isNasAvailable) {
         logger.cache.debug(`${logPrefix} NAS 사용 불가. 로컬 메타데이터 확인 진행.`);
    }

    // 3. 로컬 메타데이터 확인
    logger.cache.debug(`${logPrefix} 로컬 메타데이터 확인 시도: ${localMetadataPath}`);
    const localMetadata = await this.loadMetadataFromFile(localMetadataPath);
    if (localMetadata) {
         logger.cache.debug(`${logPrefix} 로컬 메타데이터 로드 성공.`);
         // 로컬 메타데이터 발견 시 DB 업데이트 시도 (일관성 유지)
         if (videoId && serviceType) {
             const dbData = await this.getCacheFromDb(videoId, serviceType);
             if (!dbData) {
                  logger.cache.warn(`${logPrefix} DB 기록 없음. 로컬 메타데이터 기반으로 DB 저장 시도...`);
                  await this.saveCacheToDb(
                      videoId,
                      localMetadata.title,
                      localMetadata.url || url,
                      serviceType,
                      undefined, // 로컬 파일이므로 NAS 경로 없음
                      localMetadata.fileSize,
                      localMetadata.duration
                  );
             } // 로컬 파일은 NAS 경로가 없으므로, DB에 이미 있더라도 NAS 경로 업데이트는 불필요.
             await this.updateCacheAccess(videoId, serviceType);
         }
         return localMetadata;
    }

    logger.cache.debug(`${logPrefix} 로컬 메타데이터 파일 찾지 못함. 최종 결과: 메타데이터 없음.`);
    return null;
  }
  
  /**
   * Get a file from the cache and save it locally (optimized for streaming)
   */
  async getFromCache(
    url: string, 
    videoId?: string, 
    serviceType?: ServiceType
  ): Promise<string | null> {
    const logPrefix = `[Cache Get ${videoId || url}]:`;
     logger.cache.debug(`${logPrefix} 캐시 파일 경로 조회 시작... Video ID: ${videoId}, Service Type: ${serviceType}`);

    // 1. videoId와 serviceType이 있으면 DB 우선 조회
    if (videoId && serviceType) {
      try {
        const dbCache = await this.getCacheFromDb(videoId, serviceType);
        if (dbCache) {
          logger.cache.debug(`${logPrefix} DB에서 캐시 정보 발견.`);
          await this.updateCacheAccess(videoId, serviceType); // 접근 시간 업데이트

          // NAS 경로가 있으면 NAS에서 스트리밍하여 로컬에 저장 후 경로 반환
          if (dbCache.nasPath && this.isNasAvailable) {
             logger.cache.debug(`${logPrefix} NAS 경로(${dbCache.nasPath}) 발견. NAS에서 스트리밍 시도...`);
             try {
                 // streamAndSaveFromNas 내부에서 로컬 파일 존재 여부도 확인하므로 중복 확인 불필요
                 const localNasStreamPath = await this.streamAndSaveFromNas(url, videoId, serviceType);
                 if (localNasStreamPath) {
                     logger.cache.success(`${logPrefix} NAS 스트리밍 및 로컬 저장 성공: ${localNasStreamPath}`);
                     return localNasStreamPath;
                 } else {
                     logger.cache.warn(`${logPrefix} NAS 스트리밍 또는 로컬 저장 실패.`);
                     // 실패 시 아래 로컬 파일 직접 확인 로직으로 폴백
                 }
             } catch (streamError) {
                  logger.cache.error(`${logPrefix} NAS 스트리밍 중 오류 발생:`, streamError);
                  // 오류 발생 시 로컬 확인으로 폴백
             }
          } else if (dbCache.nasPath && !this.isNasAvailable) {
              logger.cache.warn(`${logPrefix} DB에 NAS 경로(${dbCache.nasPath})는 있으나 NAS 사용 불가. 로컬 파일 확인 시도.`);
          } else {
               logger.cache.debug(`${logPrefix} DB에 NAS 경로 없음. 로컬 파일 확인 진행.`);
          }
          // NAS 경로가 없거나 NAS 사용 불가 시 로컬 파일 확인 로직으로 넘어감
        } else {
           logger.cache.debug(`${logPrefix} DB에서 캐시 정보 찾지 못함. 로컬 파일 확인 진행.`);
        }
      } catch (dbError) {
        logger.cache.error(`${logPrefix} DB 조회 중 오류 발생:`, dbError);
        // DB 오류 시 로컬 파일 확인으로 폴백
      }
    } else {
        logger.cache.warn(`${logPrefix} Video ID 또는 Service Type 누락. URL 기반 확인 시도.`);
        // videoId나 serviceType 없으면 기존 로직대로 URL 기반 확인 시도
        const extractedId = this.extractVideoId(url);
        const inferredServiceType = this.getServiceType(url);
        if (extractedId && inferredServiceType !== ServiceType.OTHER) {
            logger.cache.debug(`${logPrefix} URL에서 ID(${extractedId}) 및 Type(${inferredServiceType}) 재추출 성공. 캐시 경로 재확인 시도.`);
            return this.getFromCache(url, extractedId, inferredServiceType); // 재귀 호출
        } else {
            logger.cache.warn(`${logPrefix} URL에서 ID/Type 추출 실패. 파일명 기반 로컬 확인 진행.`);
        }
    }

    // --- DB 조회 후 (NAS 스트리밍 실패 포함) 또는 videoId 없을 경우 로컬 파일 확인 ---
    
    // 파일명 생성 (videoId 우선 사용)
    const effectiveVideoId = videoId || this.extractVideoId(url);
    const effectiveServiceType = serviceType || this.getServiceType(url);
    let cacheFilename: string | null = null;

    if (effectiveVideoId && effectiveServiceType !== ServiceType.OTHER) {
        cacheFilename = this.generateCacheFilename(url, effectiveVideoId, effectiveServiceType);
         logger.cache.debug(`${logPrefix} ID 기반 캐시 파일명 생성: ${cacheFilename}`);
    } else {
        cacheFilename = this.generateCacheFilename(url); // Fallback: URL 해시 기반
        logger.cache.debug(`${logPrefix} URL 해시 기반 캐시 파일명 생성: ${cacheFilename}`);
    }
    
    if (!cacheFilename) {
        logger.cache.error(`${logPrefix} 캐시 파일명을 생성할 수 없습니다.`);
        return null;
    }

    const localFilePath = path.join(config.localCacheDir, effectiveServiceType, cacheFilename);
    logger.cache.debug(`${logPrefix} 로컬 캐시 파일 확인 시도: ${localFilePath}`);

    if (fs.existsSync(localFilePath)) {
      logger.cache.success(`${logPrefix} 로컬 캐시 파일 발견: ${localFilePath}`);
       // 로컬 파일 발견 시 DB 접근 시간 업데이트 (이미 DB 우선 조회를 거쳤으므로 존재 여부 재확인 불필요)
       if (videoId && serviceType) {
           try {
               await this.updateCacheAccess(videoId, serviceType);
           } catch (updateError) {
                logger.cache.warn(`${logPrefix} 로컬 파일 접근 시간 업데이트 실패:`, updateError);
           }
       }
      return localFilePath;
    }

    logger.cache.debug(`${logPrefix} 로컬 캐시 파일 찾지 못함. 최종 결과: 캐시 없음.`);
    return null;
  }
  
  /**
   * NAS에서 파일을 스트리밍하여 로컬에 저장하고 해당 경로를 반환합니다.
   * 이미 로컬에 파일이 존재하면 그 경로를 즉시 반환합니다.
   * 
   * @param url 원본 URL (파일명 생성에 필요)
   * @param videoId 비디오 ID
   * @param serviceType 서비스 타입
   * @returns 저장된 로컬 파일 경로 또는 null
   */
  public async streamAndSaveFromNas(
      url: string, 
      videoId: string, 
      serviceType: ServiceType
  ): Promise<string | null> {
      const logPrefix = `[NAS Stream ${videoId}]:`;
      if (!this.isNasAvailable || !this.client) {
          logger.cache.warn(`${logPrefix} NAS 사용 불가. 스트리밍 불가.`);
          return null;
      }

      const cacheFilename = this.generateCacheFilename(url, videoId, serviceType);
      if (!cacheFilename) {
          logger.cache.error(`${logPrefix} 캐시 파일명 생성 실패.`);
          return null;
      }
      
      const serviceDir = this.getServiceDirectory(serviceType);
      const localPath = path.join(config.localCacheDir, serviceDir, cacheFilename);
      const nasPath = this.normalizePath(path.join(config.nas.cachePath, serviceDir, cacheFilename));

      // 1. 로컬에 이미 파일이 있는지 확인
      if (fs.existsSync(localPath)) {
          logger.cache.debug(`${logPrefix} 로컬에 이미 파일 존재: ${localPath}`);
          return localPath;
      }

      // 2. NAS에 파일이 있는지 확인
      logger.cache.debug(`${logPrefix} NAS 파일 확인: ${nasPath}`);
      try {
          const nasExists = await this.client.exists(nasPath);
          if (!nasExists) {
              logger.cache.warn(`${logPrefix} NAS에 파일 없음.`);
              // DB 정보와 불일치 가능성 -> DB 재확인 또는 삭제 로직 고려? (현재는 그냥 null 반환)
              return null; 
          }
      } catch (error) {
           logger.cache.error(`${logPrefix} NAS 파일 존재 확인 중 오류:`, error);
           return null;
      }

      // 3. NAS에서 로컬로 스트리밍 및 저장
      logger.cache.info(`${logPrefix} NAS(${nasPath}) -> 로컬(${localPath}) 스트리밍 시작...`);
      let downloadStream: Readable | null = null;
      let writeStream: fs.WriteStream | null = null;
      try {
          // 로컬 디렉토리 생성 확인
          const localDir = path.dirname(localPath);
          if (!fs.existsSync(localDir)) {
              fs.mkdirSync(localDir, { recursive: true });
          }

          downloadStream = await this.client.createReadStream(nasPath);
          writeStream = createWriteStream(localPath);

          await pipeline(downloadStream, writeStream);

          logger.cache.success(`${logPrefix} 스트리밍 및 저장 완료: ${localPath}`);
          // 저장 후 메타데이터도 로컬에 저장? (선택 사항)
          // await this.saveMetadataFromNas(nasPath, localPath);
          return localPath;

      } catch (error) {
          logger.cache.error(`${logPrefix} 스트리밍 중 오류 발생:`, error);
          // 오류 발생 시 불완전하게 생성된 로컬 파일 삭제
          if (fs.existsSync(localPath)) {
              try {
                  await fs.promises.unlink(localPath);
                  logger.cache.info(`${logPrefix} 오류 발생으로 로컬 파일 삭제: ${localPath}`);
              } catch (unlinkError) {
                   logger.cache.error(`${logPrefix} 오류 발생 후 로컬 파일 삭제 실패:`, unlinkError);
              }
          }
          return null;
      } finally {
          // 스트림 닫기 (오류 발생 여부와 관계없이)
          if (downloadStream && typeof downloadStream.destroy === 'function') {
              downloadStream.destroy();
          }
          if (writeStream && !writeStream.closed) {
              writeStream.close();
          }
      }
  }
  
  /**
   * Clean up temporary local cache files
   * 중요: 영구 캐시 파일은 삭제하지 않음
   */
  cleanupLocalCache(maxAgeDays = 1): void {
    try {
      logger.cache.info('로컬 캐시 파일 정리 중...');
      
      // 영구 캐시 파일 정보 조회
      if (this.permanent.size === 0) {
        // DB에서 기존 영구 캐시 파일 정보 가져오기
        this.loadPermanentCacheList().catch(err => 
          logger.cache.error('영구 캐시 목록 로드 실패:', err)
        );
      }
      
      // 각 서비스 디렉토리 순회
      Object.values(this.nasDirectories).forEach(serviceDir => {
        const serviceCacheDir = path.join(config.localCacheDir, serviceDir);
        
        // 디렉토리가 없으면 생성
        if (!fs.existsSync(serviceCacheDir)) {
          fs.mkdirSync(serviceCacheDir, { recursive: true });
          logger.cache.info(`서비스 캐시 디렉토리 생성: ${serviceCacheDir}`);
          return;
        }
        
        try {
          const stats = fs.statSync(serviceCacheDir);
          // 디렉토리가 아니면 건너뛰기
          if (!stats.isDirectory()) {
            return;
          }
          
          const files = fs.readdirSync(serviceCacheDir);
      const now = new Date().getTime();
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      
      for (const file of files) {
        // 영구 캐시 파일은 삭제하지 않음
        if (this.isPermanent(file)) {
              logger.cache.debug(`영구 캐시 파일 보존: ${serviceDir}/${file}`);
          continue;
        }
        
            const filePath = path.join(serviceCacheDir, file);
            try {
              // 파일 존재 여부 확인
              if (!fs.existsSync(filePath)) {
                continue;
              }
              
              const fileStats = fs.statSync(filePath);
              
              // 디렉토리는 건너뛰기
              if (fileStats.isDirectory()) {
                continue;
              }
              
              // maxAgeDays가 0이면 모든 영구 캐시가 아닌 파일 삭제
              // 그렇지 않으면 나이를 확인
              const age = now - fileStats.mtime.getTime();
              
              if (maxAgeDays === 0 || age > maxAgeMs) {
                try {
            fs.unlinkSync(filePath);
                  logger.cache.info(`임시 캐시 파일 삭제: ${serviceDir}/${file}`);
                } catch (unlinkError) {
                  logger.cache.error(`파일 삭제 실패: ${serviceDir}/${file}`, unlinkError);
                }
              }
            } catch (statError) {
              logger.cache.error(`파일 정보 읽기 실패: ${serviceDir}/${file}`, statError);
            }
          }
        } catch (dirError) {
          logger.cache.error(`디렉토리 읽기 실패: ${serviceCacheDir}`, dirError);
        }
      });
      
      // 루트 캐시 디렉토리도 정리 (예전 파일)
      if (!fs.existsSync(config.localCacheDir)) {
        return;
      }
      
      try {
        const rootFiles = fs.readdirSync(config.localCacheDir);
        const now = new Date().getTime();
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        
        for (const file of rootFiles) {
          // 서비스 디렉토리는 건너뛰기
          if (Object.values(this.nasDirectories).includes(file)) {
            continue;
          }
          
          const rootFilePath = path.join(config.localCacheDir, file);
          
          // 파일 존재 여부 확인
          if (!fs.existsSync(rootFilePath)) {
            continue;
          }
          
          try {
            const stats = fs.statSync(rootFilePath);
            
            // 디렉토리는 건너뛰기
            if (stats.isDirectory()) {
              continue;
            }
            
            // 영구 캐시 파일은 삭제하지 않음
            if (this.isPermanent(file)) {
              logger.cache.debug(`영구 캐시 파일 보존: ${file}`);
              continue;
            }
            
            // maxAgeDays가 0이면 모든 영구 캐시가 아닌 파일 삭제
            // 그렇지 않으면 나이를 확인
            const age = now - stats.mtime.getTime();
            
            if (maxAgeDays === 0 || age > maxAgeMs) {
              try {
                fs.unlinkSync(rootFilePath);
            logger.cache.info(`임시 캐시 파일 삭제: ${file}`);
              } catch (unlinkError) {
                logger.cache.error(`파일 삭제 실패: ${file}`, unlinkError);
              }
          }
        } catch (statError) {
          logger.cache.error(`파일 정보 읽기 실패: ${file}`, statError);
        }
        }
      } catch (readError) {
        logger.cache.error(`캐시 디렉토리 읽기 실패: ${config.localCacheDir}`, readError);
      }
    } catch (error) {
      logger.cache.error('로컬 캐시 정리 실패:', error);
    }
  }
  
  /**
   * DB에서 영구 캐시 파일 목록 로드
   */
  private async loadPermanentCacheList(): Promise<void> {
    try {
      // 캐시 DB에서 정보 가져오기
      const result = await db.query(`
        SELECT video_id, service_type 
        FROM music_cache 
        WHERE file_path_nas IS NOT NULL
      `);
      
      // 영구 캐시 목록에 추가
      for (const row of result.rows) {
        const videoId = row.video_id;
        const serviceType = row.service_type as ServiceType;
        
        // 파일명 생성 및 등록
        const filename = this.generateCacheFilename('', videoId, serviceType);
        this.markAsPermanent(filename);
        
        // 메타데이터 파일명도 등록
        const metaFilename = filename.replace(/\.mp3$/, '.meta.json');
        this.markAsPermanent(metaFilename);
      }
      
      logger.cache.info(`영구 캐시 파일 ${this.permanent.size}개 로드됨`);
    } catch (error) {
      logger.cache.error('DB에서 영구 캐시 목록 불러오기 실패:', error);
    }
  }
  
  /**
   * 데이터베이스에서 캐시 정보 검색
   */
  private async getCacheFromDb(videoId: string, serviceType: ServiceType): Promise<CacheMetadata | null> {
    try {
      const result = await db.query(
        `SELECT * FROM music_cache WHERE video_id = $1 AND service_type = $2`,
        [videoId, serviceType]
      );
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      
      // 메모리 캐시에도 저장
      const metadata: CacheMetadata = {
        title: row.title,
        url: row.original_url,
        downloadDate: new Date(row.added_at).toISOString(),
        videoId: row.video_id,
        serviceType: row.service_type,
        fileSize: row.file_size,
        duration: row.duration,
        nasPath: row.file_path_nas
      };
      
      const cacheKey = this.getCacheKey(row.original_url, row.video_id);
      this.metadataCache.set(cacheKey, metadata);
      
      return metadata;
    } catch (error) {
      logger.cache.error('데이터베이스에서 캐시 정보 검색 실패:', error);
      return null;
    }
  }
  
  /**
   * 데이터베이스에 캐시 정보 저장
   */
  private async saveCacheToDb(
    videoId: string, 
    title: string, 
    url: string, 
    serviceType: ServiceType, 
    nasPath?: string,
    fileSize?: number,
    duration?: number
  ): Promise<boolean> {
    try {
      const query = `
        INSERT INTO music_cache 
          (video_id, title, original_url, service_type, file_path_nas, file_size, duration)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (video_id, service_type) DO UPDATE SET
          last_accessed = CURRENT_TIMESTAMP,
          access_count = music_cache.access_count + 1,
          title = COALESCE($2, music_cache.title),
          file_path_nas = COALESCE($5, music_cache.file_path_nas),
          file_size = COALESCE($6, music_cache.file_size),
          duration = COALESCE($7, music_cache.duration)
      `;
      
      await db.query(query, [
        videoId, 
        title, 
        url, 
        serviceType, 
        nasPath || null, 
        fileSize || null, 
        duration || null
      ]);
      
      return true;
    } catch (error) {
      logger.cache.error('데이터베이스에 캐시 정보 저장 실패:', error);
      return false;
    }
  }
  
  /**
   * 데이터베이스에서 캐시 항목을 처리 중으로 표시
   */
  private async markAsProcessing(videoId: string, serviceType: ServiceType, isProcessing: boolean): Promise<void> {
    try {
      await db.query(
        `UPDATE music_cache SET is_processing = $3 WHERE video_id = $1 AND service_type = $2`,
        [videoId, serviceType, isProcessing]
      );
    } catch (error) {
      logger.cache.error('캐시 처리 상태 업데이트 실패:', error);
    }
  }
  
  /**
   * 캐시 항목의 접근 시간 및 카운트 업데이트
   */
  private async updateCacheAccess(videoId: string, serviceType: ServiceType): Promise<void> {
    try {
      await db.query(
        `UPDATE music_cache 
         SET last_accessed = CURRENT_TIMESTAMP, access_count = access_count + 1 
         WHERE video_id = $1 AND service_type = $2`,
        [videoId, serviceType]
      );
    } catch (error) {
      logger.cache.error('캐시 접근 정보 업데이트 실패:', error);
    }
  }
  
  /**
   * NAS에 파일 비동기 업로드 (재생이 시작된 후 백그라운드에서 실행)
   */
  public async uploadToNasAsync(
    localFilePath: string, 
    url: string, 
    metadata: CacheMetadata, 
    videoId?: string
  ): Promise<void> {
    const serviceType = metadata.serviceType ? 
      metadata.serviceType as ServiceType : 
      this.getServiceType(url);
      
    const filename = this.generateCacheFilename(url, videoId, serviceType as ServiceType);
    const cacheKey = this.getCacheKey(url, videoId);
    
    // 이미 업로드 중인지 확인
    if (this.uploadQueue.has(cacheKey)) {
      logger.cache.info(`이미 업로드 중인 파일: ${filename}`);
      return;
    }
    
    // 업로드 큐에 추가
    logger.cache.info(`NAS 비동기 업로드 큐에 추가: ${filename}`);
    
    const uploadPromise = (async () => {
      try {
        // 비디오 ID 확정
        const finalVideoId = videoId || metadata.videoId || this.extractVideoId(url) || this.hashString(url);
        
        // NAS 연결 확인 및 시도
        if (!this.isNasAvailable || !this.client) {
          await this.initializeWebDAV();
          if (!this.isNasAvailable || !this.client) {
            logger.cache.info('NAS를 사용할 수 없어 업로드를 건너뜁니다.');
            return false;
          }
        }
        
        // 서비스 디렉토리 확인
        const serviceDir = this.getServiceDirectory(serviceType as ServiceType);
        
        // 원격 경로 생성
        const remotePath = this.normalizePath(path.join(
          config.nas.cachePath, 
          serviceDir, 
          filename
        ));
        
        // DB에 처리 중으로 표시
        await this.markAsProcessing(finalVideoId, serviceType as ServiceType, true);
        
        // 파일 크기 확인
        const stats = fs.statSync(localFilePath);
        logger.cache.info(`NAS에 파일 업로드 중: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
        
        // 파일 업로드 (5번까지 재시도)
        let uploadSuccess = false;
        let attempts = 0;
        
        while (!uploadSuccess && attempts < 5) {
          attempts++;
          try {
            // 파일 읽기
            const fileContent = fs.readFileSync(localFilePath);
            
            // 업로드
            await this.client.putFileContents(remotePath, fileContent, {
              overwrite: true
            });
            
            uploadSuccess = true;
          } catch (uploadError) {
            logger.cache.error(`NAS 업로드 시도 #${attempts} 실패:`, uploadError);
            
            if (attempts < 5) {
              // 잠시 대기 후 재시도
              logger.cache.info(`잠시 후 재시도합니다...`);
              await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
              
              // 재연결 시도
              if (attempts === 3) {
                await this.reconnectWebDAV();
              }
            }
          }
        }
        
        if (!uploadSuccess) {
          logger.cache.error(`파일 업로드 실패: ${filename}`);
          await this.markAsProcessing(finalVideoId, serviceType as ServiceType, false);
          return false;
        }
        
        // 메타데이터가 있으면 함께 저장
        if (metadata) {
          // 비디오 ID가 있으면 추가
          if (!metadata.videoId) {
            metadata.videoId = finalVideoId;
          }
          
          // 메타데이터에 서비스 타입과 NAS 경로 추가
          metadata.serviceType = serviceType;
          metadata.nasPath = remotePath;
          metadata.fileSize = stats.size;
          
          // 메타데이터 NAS에 저장
          await this.saveMetadata(url, metadata, finalVideoId);
          
          // DB에 저장
          await this.saveCacheToDb(
            finalVideoId,
            metadata.title,
            url,
            serviceType as ServiceType,
            remotePath,
            stats.size,
            metadata.duration
          );
        }
        
        // 처리 완료로 표시
        await this.markAsProcessing(finalVideoId, serviceType as ServiceType, false);
        
        logger.cache.success(`NAS에 파일 캐싱 완료: ${filename}`);
        return true;
      } catch (error) {
        logger.cache.error('비동기 NAS 업로드 오류:', error);
        return false;
      } finally {
        // 완료되면 큐에서 제거
        this.uploadQueue.delete(cacheKey);
      }
    })();
    
    this.uploadQueue.set(cacheKey, uploadPromise);
    
    // 큐에 추가하고 반환 (비동기적으로 실행)
    uploadPromise.catch(err => {
      logger.cache.error('비동기 업로드 실패:', err);
    });
  }
  
  /**
   * 스트리밍 방식으로 NAS에서 파일 다운로드
   */
  public async getStreamFromNas(url: string, videoId?: string): Promise<Readable | null> {
    const serviceType = this.getServiceType(url);
    const cacheKey = this.getCacheKey(url, videoId);
    
    // 이미 다운로드 중인 스트림이 있으면 재사용
    if (this.downloadStreams.has(cacheKey)) {
      try {
        return await this.downloadStreams.get(cacheKey)!;
      } catch (error) {
        logger.cache.error('기존 스트림 재사용 실패:', error);
        this.downloadStreams.delete(cacheKey);
      }
    }
    
    // DB에서 캐시 정보 확인
    const finalVideoId = videoId || this.extractVideoId(url) || this.hashString(url);
    const dbCache = await this.getCacheFromDb(finalVideoId, serviceType);
    
    if (!dbCache || !dbCache.nasPath) {
      logger.cache.info('DB에 캐시 정보가 없거나 경로가 없습니다.');
      return null;
    }
    
    // NAS 연결 확인
    if (!this.isNasAvailable || !this.client) {
      await this.initializeWebDAV();
      if (!this.isNasAvailable || !this.client) {
        logger.cache.info('NAS 연결 실패로 스트리밍이 불가능합니다.');
        return null;
      }
    }
    
    // 다운로드 스트림 생성 프로미스
    const streamPromise = (async () => {
      try {
        // 원격 파일 존재 확인
        if (!dbCache.nasPath) {
          logger.cache.error('NAS 파일 경로가 없습니다.');
          return null;
        }
        
        const exists = await this.client!.exists(dbCache.nasPath);
        if (!exists) {
          logger.cache.error(`NAS에 파일이 존재하지 않습니다: ${dbCache.nasPath}`);
          return null;
        }
        
        // 스트림 생성
        const stream = await this.client!.createReadStream(dbCache.nasPath);
        
        // 캐시 접근 업데이트
        await this.updateCacheAccess(finalVideoId, serviceType);
        
        return stream;
      } catch (error) {
        logger.cache.error('NAS 스트림 생성 실패:', error);
        return null;
      }
    })();
    
    // 다운로드 스트림 맵에 저장
    this.downloadStreams.set(cacheKey, streamPromise);
    
    // 5분 후 맵에서 제거 (스트림 참조 정리)
    setTimeout(() => {
      this.downloadStreams.delete(cacheKey);
    }, 5 * 60 * 1000);
    
    try {
      return await streamPromise;
    } catch (error) {
      logger.cache.error('스트림 생성 실패:', error);
      this.downloadStreams.delete(cacheKey);
      return null;
    }
  }
  
  /**
   * 재생 완료 후 로컬 캐시 파일 삭제 (NAS에는 유지)
   * 캐싱 상태를 확인하고 적절히 처리합니다
   */
  async cleanupAfterPlayback(url: string, videoId?: string): Promise<boolean> {
    try {
      const serviceType = this.getServiceType(url);
      const finalVideoId = videoId || this.extractVideoId(url) || this.hashString(url);
      const filename = this.generateCacheFilename(url, finalVideoId, serviceType);
      const serviceDir = this.getServiceDirectory(serviceType);
      const localPath = path.join(config.localCacheDir, serviceDir, filename);
      
      // 파일이 존재하지 않으면 바로 성공 반환
      if (!fs.existsSync(localPath)) {
        logger.cache.debug(`파일이 이미 삭제됨: ${localPath}`);
        return true;
      }
      
      // DB에서 캐시 정보 확인
      const dbCache = await this.getCacheFromDb(finalVideoId, serviceType);
      
      // 1. 처리 중인 파일은 삭제하지 않음
      if (dbCache?.is_processing) {
        logger.cache.info(`파일이 처리 중이므로 로컬 파일 보존: ${filename}`);
        return false;
      }
      
      // 2. NAS에 캐시되지 않은 파일 확인
      let nasExists = false;
      
      // DB에 NAS 경로가 있으면 존재 여부 확인
      if (dbCache?.nasPath && this.isNasAvailable && this.client) {
        try {
          nasExists = await this.client.exists(dbCache.nasPath);
        } catch (nasError) {
          logger.cache.error(`NAS 파일 존재 확인 실패: ${dbCache.nasPath}`, nasError);
        }
      }
      
      // 설정에서 파일 유지 옵션 확인
      const keepFiles = config.cache?.keepFiles || false;
      
      // NAS에 파일이 없으면 업로드 시도
      if (!nasExists && !keepFiles) {
        // DB에 캐시 정보가 없거나 NAS 경로가 없는 경우 
        if (!dbCache || !dbCache.nasPath) {
          logger.cache.info(`NAS 경로 없음, 캐싱 필요: ${filename}`);
          
          // 메타데이터 확인하여 업로드 진행
          const metadata = await this.getMetadata(url, finalVideoId) || {
            title: path.basename(filename, '.mp3'),
            url,
            downloadDate: new Date().toISOString(),
            videoId: finalVideoId,
            serviceType
          };
          
          // 파일 사이즈 확인
          const stats = fs.statSync(localPath);
          metadata.fileSize = stats.size;
          
          // NAS로 업로드 시도 (비동기)
          this.uploadToNasAsync(localPath, url, metadata, finalVideoId)
            .catch(err => logger.cache.error(`업로드 큐 추가 실패: ${filename}`, err));
          
          logger.cache.info(`NAS 업로드 큐에 추가됨, 로컬 파일 보존: ${filename}`);
          return false;
        } else {
          logger.cache.info(`NAS에 파일이 없어 로컬 파일 보존: ${filename}`);
          return false;
        }
      }
      
      // 3. NAS에 캐시되었거나 파일 유지 설정이 꺼져 있으면 로컬 삭제 진행
      if (nasExists || !keepFiles) {
      try {
          // 파일이 사용 중인지 확인 (Windows에서 특히 중요)
          try {
            // 읽기 모드로 파일 열기 시도 (파일이 사용 중인지 확인)
            const fd = fs.openSync(localPath, 'r');
            fs.closeSync(fd); // 파일 사용 가능하면 닫기
          } catch (err) {
            // 파일이 사용 중이면 삭제를 연기
            const error = err as NodeJS.ErrnoException;
            if (error.code === 'EBUSY' || error.code === 'EPERM') {
              logger.cache.warn(`파일이 사용 중이므로 지금 삭제할 수 없음: ${filename}`);
              
              // 나중에 삭제하기 위해 큐에 추가
              setTimeout(() => {
                try {
                  if (fs.existsSync(localPath)) {
                    fs.unlinkSync(localPath);
                    logger.cache.info(`지연된 로컬 캐시 파일 삭제 성공: ${filename}`);
                  }
                } catch (delayedError) {
                  logger.cache.error(`지연된 로컬 캐시 파일 삭제 실패: ${filename}`, delayedError);
                }
              }, 2000); // 2초 후 다시 시도
              
              return false;
            }
          }
          
        // 파일 삭제
        fs.unlinkSync(localPath);
        logger.cache.info(`재생 후 로컬 캐시 파일 삭제: ${filename}`);
        
        // 동일한 파일명의 메타데이터 파일이 있으면 함께 삭제
        const metaPath = localPath.replace(/\.mp3$/, '.meta.json');
        if (fs.existsSync(metaPath)) {
          fs.unlinkSync(metaPath);
          logger.cache.info(`재생 후 로컬 메타데이터 파일 삭제: ${path.basename(metaPath)}`);
        }
        
        return true;
      } catch (error) {
        logger.cache.error(`로컬 캐시 파일 삭제 실패: ${filename}`, error);
          return false;
        }
      } else {
        logger.cache.info(`파일 유지 설정으로 로컬 파일 보존: ${filename}`);
        return false;
      }
    } catch (error) {
      logger.cache.error('캐시 정리 중 오류 발생:', error);
      return false;
    }
  }
} 