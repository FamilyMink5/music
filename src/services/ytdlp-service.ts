import { exec } from 'child_process';
import { NodeSSH } from 'node-ssh';
import path from 'path';
import fs from 'fs';
import util from 'util';
import { config } from '../config';
import { CacheService, CacheMetadata, ServiceType } from './cache-service';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { Readable } from 'stream';
import os from 'os';

const execPromise = util.promisify(exec);

export interface DownloadResult {
  success: boolean;
  filePath?: string;
  error?: string;
  title?: string;
  videoId?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  duration: string;
  uploader: string;
  url: string;
}

export interface DownloadOptions {
  serviceType?: ServiceType;
  startPlayback?: boolean;
  videoId?: string;
  youtubeId?: string;
}

export class YtdlpService {
  private ssh: NodeSSH | null = null;
  private cacheService!: CacheService;
  
  // 싱글톤 인스턴스
  private static instance: YtdlpService;
  
  /**
   * 싱글톤 인스턴스 얻기
   */
  public static getInstance(): YtdlpService {
    if (!YtdlpService.instance) {
      YtdlpService.instance = new YtdlpService();
    }
    return YtdlpService.instance;
  }
  
  private constructor() {
    if (YtdlpService.instance) {
      return YtdlpService.instance;
    }
    
    this.cacheService = CacheService.getInstance();
    YtdlpService.instance = this;
  }
  
  /**
   * 명령줄 인수 이스케이프 (Windows 및 Linux 환경 모두 지원)
   */
  private escapeShellArg(arg: string): string {
    // Windows에서는 따옴표로 감싸고 내부 따옴표를 이스케이프
    if (process.platform === 'win32') {
      // 따옴표가 없는 경우 그대로 반환 (단, 공백이 있으면 따옴표로 감싸기)
      if (!arg.includes('"') && !arg.includes(' ') && !arg.includes('&') && 
          !arg.includes('|') && !arg.includes('<') && !arg.includes('>') && 
          !arg.includes('(') && !arg.includes(')') && !arg.includes('^')) {
        return arg;
      }
      
      // Windows에서 명령줄 인수를 이스케이프하는 방법:
      // 1. 모든 " 를 "" 로 변경
      // 2. 전체 문자열을 "로 감싸기
      return `"${arg.replace(/"/g, '""')}"`;
    } 
    
    // Linux/Unix 환경에서는 작은따옴표로 감싸기
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  
  /**
   * URL에서 불필요한 매개변수를 제거하고 기본 URL만 반환합니다.
   */
  sanitizeUrl(url: string): string {
    try {
      // SoundCloud URL 처리
      if (this.isSoundCloudUrl(url)) {
        // SoundCloud URL은 일반적으로 깨끗하게 유지
        // 쿼리 파라미터 제거 (있다면)
        const baseUrl = url.split('?')[0];
        return baseUrl;
      }
      
      // YouTube URL 처리
      if (this.isYouTubeUrl(url)) {
        // URL에서 비디오 ID만 추출
        const videoId = this.extractVideoId(url);
        if (!videoId) return url; // 비디오 ID가 추출되지 않으면 원래 URL 반환
        
        // 정규화된 URL 생성 (기본 형식 사용)
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
      
      // 그 외 URL은 그대로 반환
      return url;
    } catch (error) {
      logger.download.warn(`URL 정규화 실패: ${url}`, error);
      return url; // 오류 발생 시 원래 URL 반환
    }
  }

  /**
   * URL에서 비디오 ID 또는 트랙 ID를 추출합니다.
   * @returns 비디오/트랙 ID 또는 undefined(추출 실패 시)
   */
  extractVideoId(url: string): string | undefined {
    try {
      // 서비스 타입 확인
      const serviceType = this.getServiceType(url);
      
      // 스포티파이 URL 처리
      if (serviceType === ServiceType.SPOTIFY) {
        // Spotify URL에서 ID 추출
        // 예: https://open.spotify.com/track/1234567890abcdef
        const spotifyRegex = /spotify\.com\/(?:track|album|playlist|artist)\/([a-zA-Z0-9]+)/;
        const spotifyMatch = url.match(spotifyRegex);
        if (spotifyMatch && spotifyMatch[1]) {
          return `sp_${spotifyMatch[1]}`;
        }
        // 추출 실패 시 URL 해시 사용
        return `sp_${this.hashString(url)}`;
      }
      
      // 애플 뮤직 URL 처리
      if (serviceType === ServiceType.APPLE_MUSIC) {
        // Apple Music URL에서 ID 추출
        // 예: https://music.apple.com/us/album/song/id1234567890
        const appleRegex = /music\.apple\.com\/(?:[a-z]{2}\/)(?:album|song|playlist)(?:\/[^\/]+)?\/(?:id)?([0-9]+)/;
        const appleMatch = url.match(appleRegex);
        if (appleMatch && appleMatch[1]) {
          return appleMatch[1]; // 이미 숫자 ID가 있으므로 접두사 없이 반환
        }
        // 추출 실패 시 URL 해시 사용
        return this.hashString(url);
      }
      
      // SoundCloud URL 처리
      if (this.isSoundCloudUrl(url)) {
        // SoundCloud URL에서 트랙 ID 추출 시도
        // 일반적으로 SoundCloud URL 형식은:
        // https://soundcloud.com/artist-name/track-name
        const parts = url.split('/');
        if (parts.length >= 5) {
          // 트랙명을 ID로 사용 (마지막 부분)
          const trackName = parts[parts.length - 1].split('?')[0]; // 쿼리 파라미터 제거
          if (trackName) {
            return `sc_${trackName}`;
          }
        }
        
        // 트랙명 추출 실패 시 전체 URL의 해시 값 사용
        return `sc_${this.hashString(url)}`;
      }
      
      // YouTube URL 처리
      // 여러 YouTube URL 형식 지원
      const patterns = [
        /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i,
        /^[^"&?\/\s]{11}$/ // 직접 ID만 입력한 경우
      ];
      
      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
          return match[1];
        }
      }
      
      // 직접 ID 패턴에서 전체 문자열을 확인
      if (patterns[1].test(url)) {
        return url;
      }
      
      return undefined;
    } catch (error) {
      logger.download.error('ID 추출 실패:', error);
      return undefined;
    }
  }
  
  /**
   * 지정된 URL이 YouTube URL인지 확인합니다.
   */
  isYouTubeUrl(url: string): boolean {
    return url.includes('youtube.com') || url.includes('youtu.be');
  }
  
  /**
   * 지정된 URL이 SoundCloud URL인지 확인합니다.
   */
  isSoundCloudUrl(url: string): boolean {
    return url.includes('soundcloud.com');
  }
  
  /**
   * 지정된 URL이 Spotify URL인지 확인합니다.
   */
  isSpotifyUrl(url: string): boolean {
    return url.includes('spotify.com') || url.includes('open.spotify.com');
  }
  
  /**
   * 지정된 URL이 Apple Music URL인지 확인합니다.
   */
  isAppleMusicUrl(url: string): boolean {
    return url.includes('music.apple.com') || url.includes('apple.com/music');
  }
  
  /**
   * 지정된 URL이 Melon URL인지 확인합니다.
   */
  isMelonUrl(url: string): boolean {
    return url.includes('melon.com') || url.startsWith('melon:');
  }
  
  /**
   * URL에 기반하여 서비스 타입을 판단합니다.
   */
  getServiceType(url: string): ServiceType {
    if (this.isYouTubeUrl(url)) return ServiceType.YOUTUBE;
    if (this.isSoundCloudUrl(url)) return ServiceType.SOUNDCLOUD;
    if (this.isSpotifyUrl(url)) return ServiceType.SPOTIFY;
    if (this.isAppleMusicUrl(url)) return ServiceType.APPLE_MUSIC;
    if (this.isMelonUrl(url)) return ServiceType.MELON;
    return ServiceType.OTHER;
  }
  
  /**
   * 서비스 타입에 따른 캐시 디렉토리 경로를 반환합니다.
   */
  getServiceDirectory(serviceType: ServiceType): string {
    switch (serviceType) {
      case ServiceType.YOUTUBE:
        return 'youtube';
      case ServiceType.SOUNDCLOUD:
        return 'soundcloud';
      case ServiceType.SPOTIFY:
        return 'spotify';
      case ServiceType.APPLE_MUSIC:
        return 'apple-music';
      case ServiceType.DEEZER:
        return 'deezer';
      case ServiceType.MELON:
        return 'melon';
      default:
        return 'other';
    }
  }
  
  /**
   * Check if a file is already in cache
   */
  async isInCache(url: string): Promise<boolean> {
    const sanitizedUrl = this.sanitizeUrl(url);
    // SoundCloud 식별자 생성
    const isSoundCloud = this.isSoundCloudUrl(url);
    const isAppleMusic = this.isAppleMusicUrl(url);
    
    // 서비스별 접두사 설정
    let prefix = '';
    if (isSoundCloud) {
      prefix = 'soundcloud_';
    } else if (isAppleMusic) {
      prefix = 'applemusic_';
    }
    
    const videoId = this.extractVideoId(sanitizedUrl);
    return await this.cacheService.existsInCache(sanitizedUrl, isSoundCloud || isAppleMusic ? `${prefix}${videoId}` : videoId);
  }
  
  /**
   * Initialize SSH connection
   */
  async initSSH(): Promise<boolean> {
    try {
      this.ssh = new NodeSSH();
      await this.ssh.connect({
        host: config.ssh.host,
        port: config.ssh.port,
        username: config.ssh.username,
        privateKey: fs.readFileSync(config.ssh.privateKeyPath, 'utf8')
      });
      return true;
    } catch (error) {
      logger.network.error('Failed to connect to SSH server:', error);
      this.ssh = null;
      return false;
    }
  }
  
  /**
   * Download audio using local yt-dlp
   */
  async downloadLocal(url: string, startPlayback: boolean = true): Promise<DownloadResult> {
    try {
      // URL 정규화 - 불필요한 매개변수 제거
      const sanitizedUrl = this.sanitizeUrl(url);
      
      // SoundCloud 여부 확인 및 접두사 설정
      const isSoundCloud = this.isSoundCloudUrl(url);
      const prefix = isSoundCloud ? 'soundcloud_' : '';
      
      // 비디오 ID 추출
      const videoId = this.extractVideoId(sanitizedUrl);
      
      // 캐시에 저장될 ID 생성 (SoundCloud는 접두사 포함)
      const cacheId = isSoundCloud && videoId ? `${prefix}${videoId}` : videoId;
      
      // Check if the file is already in cache
      const cachedFilePath = await this.cacheService.getFromCache(sanitizedUrl, cacheId);
      if (cachedFilePath) {
        // 캐시된 파일의 메타데이터를 로드하여 제목 가져오기
        const metadata = await this.cacheService.getMetadata(sanitizedUrl, cacheId);
        logger.download.info(`캐시에서 파일 찾음: ${cachedFilePath}`);
        return {
          success: true,
          filePath: cachedFilePath,
          // 제목과 비디오 ID가 동일한 경우 다른 형식으로 제목 제공
          title: this.getDistinctTitle(metadata?.title, videoId),
          videoId
        };
      }
      
      // 먼저 동영상 정보만 가져와서 제목 추출
      // 절대 경로 사용 확인
      const safeYtdlpPath = this.escapeShellArg(config.localYtdlpPath.replace(/\\/g, '/'));
      const safeUrl = this.escapeShellArg(sanitizedUrl);
      const infoCommand = `${safeYtdlpPath} -j ${safeUrl}`;
      logger.download.debug(`정보 가져오기 명령어: ${infoCommand}`);
      
      let videoTitle = "";
      let extractedVideoId = videoId;
      
      try {
        const { stdout } = await execPromise(infoCommand);
        const info = JSON.parse(stdout);
        videoTitle = info.title || "";
        
        // 비디오 ID가 정보에서 추출된 경우 사용
        if (info.id) {
          extractedVideoId = info.id;
        }
        
        logger.download.info(`비디오 제목: ${videoTitle}, ID: ${extractedVideoId}`);
      } catch (infoError) {
        logger.download.error('비디오 정보 가져오기 실패:', infoError);
        // 정보 가져오기 실패시 그냥 계속 진행
      }
      
      // 비디오 ID를 기준으로 파일명 생성
      // SoundCloud URL인 경우 접두사 추가
      const filename = extractedVideoId ? `${prefix}${extractedVideoId}.mp3` : `${prefix}temp_${Date.now()}.mp3`;
      const tempOutputFile = path.join(config.localCacheDir, filename);
      
      // 이미 존재하는 파일 확인 및 제거
      if (fs.existsSync(tempOutputFile)) {
        logger.download.info(`이미 존재하는 파일 제거: ${tempOutputFile}`);
        fs.unlinkSync(tempOutputFile);
      }
      
      // 안전하게 이스케이프된 경로와 URL 생성
      const safeOutputFile = this.escapeShellArg(tempOutputFile.replace(/\\/g, '/'));
      
      // 다운로드 명령 실행 - 모든 인수 이스케이프 처리
      const downloadCommand = `${safeYtdlpPath} -x --audio-format mp3 --audio-quality 0 -o ${safeOutputFile} ${safeUrl}`;
      logger.download.debug(`다운로드 명령어: ${downloadCommand}`);
      
      await execPromise(downloadCommand);
      
      // 파일이 존재하는지 확인
      if (!fs.existsSync(tempOutputFile)) {
        logger.download.error(`다운로드된 파일이 존재하지 않음: ${tempOutputFile}`);
        return { success: false, error: '파일 다운로드 실패' };
      }
      
      logger.download.success(`다운로드 완료: ${tempOutputFile}`);
      
      // 제목과 비디오 ID가 동일한 경우 다른 형식으로 제목 제공
      const distinctTitle = this.getDistinctTitle(videoTitle || path.basename(tempOutputFile, path.extname(tempOutputFile)), extractedVideoId);
      
      // 캐시용 ID 설정 (SoundCloud는 접두사 포함)
      const idForCache = isSoundCloud && extractedVideoId ? `${prefix}${extractedVideoId}` : extractedVideoId;
      
      // 파일을 캐시에 저장
      const metadata: CacheMetadata = {
        title: distinctTitle,
        url: sanitizedUrl,
        downloadDate: new Date().toISOString(),
        videoId: idForCache // SoundCloud ID는 접두사를 포함하여 저장
      };
      
      // 이 파일은 캐시에 저장되는 중요한 파일이므로 영구 캐시 표시
      this.cacheService.markAsPermanent(filename);
      // 캐시에 저장 (비동기 작업이므로 완료를 기다리지 않고 반환)
      this.cacheService.saveToCache(sanitizedUrl, tempOutputFile, metadata, idForCache)
        .then(cached => {
          logger.download.info(`캐시 저장 ${cached ? '성공' : '실패'}: ${sanitizedUrl}`);
        })
        .catch(err => {
          logger.download.error('캐시 저장 중 오류:', err);
        });
      
      return {
        success: true,
        filePath: tempOutputFile,
        title: distinctTitle,
        videoId: extractedVideoId
      };
      
    } catch (error) {
      logger.download.error('Local download error:', error);
      return { success: false, error: `다운로드 실패: ${error}` };
    }
  }
  
  /**
   * Download audio using remote yt-dlp via SSH
   */
  async downloadRemote(url: string): Promise<DownloadResult> {
    try {
      // URL 정규화 - 불필요한 매개변수 제거
      const sanitizedUrl = this.sanitizeUrl(url);
      
      // SoundCloud 여부 확인 및 접두사 설정
      const isSoundCloud = this.isSoundCloudUrl(url);
      const prefix = isSoundCloud ? 'soundcloud_' : '';
      
      // 비디오 ID 추출
      const videoId = this.extractVideoId(sanitizedUrl);
      
      // 캐시에 저장될 ID 생성 (SoundCloud는 접두사 포함)
      const cacheId = isSoundCloud && videoId ? `${prefix}${videoId}` : videoId;
      
      // Check if the file is already in cache
      const cachedFilePath = await this.cacheService.getFromCache(sanitizedUrl, cacheId);
      if (cachedFilePath) {
        // 캐시된 파일의 메타데이터를 로드하여 제목 가져오기
        const metadata = await this.cacheService.getMetadata(sanitizedUrl, cacheId);
        logger.download.info(`캐시에서 파일 찾음: ${cachedFilePath}`);
        return {
          success: true,
          filePath: cachedFilePath,
          // 제목과 비디오 ID가 동일한 경우 다른 형식으로 제목 제공
          title: this.getDistinctTitle(metadata?.title, videoId),
          videoId
        };
      }
      
      // SSH 연결 확인
      if (!this.ssh) {
        const connected = await this.initSSH();
        if (!connected) {
          return { success: false, error: 'SSH 연결 실패' };
        }
      }
      
      // 원격 임시 디렉토리
      const tempDir = '/tmp';
      // SoundCloud URL인 경우 접두사 추가
      const remoteFilename = `${prefix}video_${Date.now()}.mp3`;
      const remotePath = `${tempDir}/${remoteFilename}`;
      
      // 먼저 동영상 정보만 가져와서 제목 추출
      let videoTitle = "";
      let extractedVideoId = videoId;
      
      // SSH는 Linux 환경이므로 이스케이프 방식이 다름
      const safeUrl = sanitizedUrl.replace(/'/g, "'\\''"); // 작은따옴표 이스케이프
      const infoCommand = `${config.ssh.ytdlpPath} -j '${safeUrl}'`;
      
      try {
        const infoResult = await this.ssh!.execCommand(infoCommand);
        if (!infoResult.stderr) {
          const info = JSON.parse(infoResult.stdout);
          videoTitle = info.title || "";
          if (info.id) {
            extractedVideoId = info.id;
          }
          logger.download.info(`비디오 제목: ${videoTitle}, ID: ${extractedVideoId}`);
        }
      } catch (infoError) {
        logger.download.error('비디오 정보 가져오기 실패:', infoError);
        // 정보 가져오기 실패시 그냥 계속 진행
      }
      
      // yt-dlp 명령어 실행 - 원격 환경(Linux)에 맞는 방식으로 이스케이프
      const safeRemotePath = remotePath.replace(/'/g, "'\\''");
      const downloadCommand = `${config.ssh.ytdlpPath} -x --audio-format mp3 --audio-quality 0 -o '${safeRemotePath}' '${safeUrl}'`;
      logger.download.debug('원격 다운로드 명령어 실행:', downloadCommand);
      
      const result = await this.ssh!.execCommand(downloadCommand);
      if (result.stderr && !result.stdout.includes('has already been downloaded')) {
        logger.download.error('원격 다운로드 오류:', result.stderr);
        return { success: false, error: result.stderr };
      }
      
      // 로컬 파일 경로
      // SoundCloud URL인 경우 접두사 추가
      const localFilename = extractedVideoId ? `${prefix}${extractedVideoId}.mp3` : remoteFilename;
      const localPath = path.join(config.localCacheDir, localFilename);
      
      // 원격 파일을 로컬로 다운로드
      try {
        logger.download.info(`원격 파일 다운로드 중: ${remotePath} -> ${localPath}`);
        await this.ssh!.getFile(localPath, remotePath);
        
        // 파일이 존재하는지 확인
        if (!fs.existsSync(localPath)) {
          logger.download.error(`다운로드된 파일이 존재하지 않음: ${localPath}`);
          return { success: false, error: '파일 다운로드 실패' };
        }
        
        logger.download.success(`원격 파일 다운로드 완료: ${localPath}`);
        
        // 원격 파일 삭제
        await this.ssh!.execCommand(`rm -f '${safeRemotePath}'`);
        
        // 제목과 비디오 ID가 동일한 경우 다른 형식으로 제목 제공
        const distinctTitle = this.getDistinctTitle(videoTitle || path.basename(localPath, path.extname(localPath)), extractedVideoId);
        
        // 캐시용 ID 설정 (SoundCloud는 접두사 포함)
        const idForCache = isSoundCloud && extractedVideoId ? `${prefix}${extractedVideoId}` : extractedVideoId;
        
        // 파일을 캐시에 저장
        const metadata: CacheMetadata = {
          title: distinctTitle,
          url: sanitizedUrl,
          downloadDate: new Date().toISOString(),
          videoId: idForCache // SoundCloud ID는 접두사를 포함하여 저장
        };
        
        // 이 파일은 캐시에 저장되는 중요한 파일이므로 영구 캐시 표시
        this.cacheService.markAsPermanent(localFilename);
        // 캐시에 저장 (비동기 작업이므로 완료를 기다리지 않고 반환)
        this.cacheService.saveToCache(sanitizedUrl, localPath, metadata, idForCache)
          .then(cached => {
            logger.download.info(`캐시 저장 ${cached ? '성공' : '실패'}: ${sanitizedUrl}`);
          })
          .catch(err => {
            logger.download.error('캐시 저장 중 오류:', err);
          });
        
        return {
          success: true,
          filePath: localPath,
          title: distinctTitle,
          videoId: extractedVideoId
        };
      } catch (copyError) {
        logger.download.error('파일 복사 오류:', copyError);
        return { success: false, error: `파일 복사 실패: ${copyError}` };
      }
    } catch (error) {
      logger.download.error('Remote download error:', error);
      return { success: false, error: `원격 다운로드 실패: ${error}` };
    }
  }
  
  /**
   * 경로가 유효한 yt-dlp 실행 파일 경로를 반환합니다.
   * 설정된 경로에 파일이 없으면 대체 경로를 찾아서 반환합니다.
   */
  private async findYtdlpExe(): Promise<string> {
    // 설정된 경로 확인
    if (fs.existsSync(config.localYtdlpPath)) {
      return config.localYtdlpPath;
    }
    
    logger.download.warn(`설정된 yt-dlp 경로에 파일이 없음: ${config.localYtdlpPath}`);
    
    // 현재 작업 디렉토리에서 검색
    const curDirYtdlp = path.join(process.cwd(), 'yt-dlp.exe');
    if (fs.existsSync(curDirYtdlp)) {
      logger.download.info(`현재 디렉토리에서 yt-dlp.exe 찾음: ${curDirYtdlp}`);
      return curDirYtdlp;
    }
    
    // 상위 디렉토리에서 검색
    const parentDirYtdlp = path.join(process.cwd(), '..', 'yt-dlp.exe');
    if (fs.existsSync(parentDirYtdlp)) {
      logger.download.info(`상위 디렉토리에서 yt-dlp.exe 찾음: ${parentDirYtdlp}`);
      return parentDirYtdlp;
    }
    
    // 환경 변수 PATH에서 yt-dlp.exe 찾기
    try {
      const { stdout } = await execPromise('where yt-dlp.exe');
      const paths = stdout.trim().split('\n');
      if (paths.length > 0 && fs.existsSync(paths[0])) {
        logger.download.info(`PATH에서 yt-dlp.exe 찾음: ${paths[0]}`);
        return paths[0];
      }
    } catch (error) {
      logger.download.debug('PATH에서 yt-dlp.exe를 찾을 수 없습니다.');
    }
    
    throw new Error('유효한 yt-dlp.exe 경로를 찾을 수 없습니다.');
  }
  
  /**
   * Download a file from URL
   */
  public async download(
    url: string,
    options?: DownloadOptions
  ): Promise<DownloadResult> {
    const serviceType = options?.serviceType || this.getServiceType(url);
    const videoId = options?.videoId || this.extractVideoId(url) || this.hashString(url);
    const youtubeId = options?.youtubeId || (this.isYouTubeUrl(url) ? this.extractVideoId(url) : null);
    const sanitizedUrl = this.sanitizeUrl(url);
    
    // 서비스 타입에 맞는 캐시 디렉토리 결정
    const serviceDir = this.getServiceDirectory(serviceType);
    const cachePath = path.join(config.localCacheDir, serviceDir);
    
    // 캐시 디렉토리가 없으면 생성
    if (!fs.existsSync(cachePath)) {
      logger.download.info(`캐시 디렉토리 생성: ${cachePath}`);
      fs.mkdirSync(cachePath, { recursive: true });
    }
    
    // 캐시 파일 경로 결정
    const cacheFileName = `${videoId}.mp3`;
    const cacheDirFileName = path.join(cachePath, cacheFileName);
    
    logger.download.info(`다운로드 전 검사, 서비스: ${serviceType}, 캐시경로: ${cachePath}`);
    
    // 이미 캐시된 파일이 있는지 확인
    if (fs.existsSync(cacheDirFileName)) {
      logger.download.info(`캐시에서 파일 찾음: ${cacheDirFileName}`);
      
      return {
        success: true,
        filePath: cacheDirFileName,
        title: path.basename(cacheDirFileName, '.mp3'),
        videoId
      };
    }
    
    // YouTube ID가 있으면 YouTube 캐시에서도 확인
    if (youtubeId && serviceType !== ServiceType.YOUTUBE && this.isYouTubeUrl(url)) {
      const youtubeCachePath = path.join(config.localCacheDir, this.getServiceDirectory(ServiceType.YOUTUBE));
      const youtubeCacheFileName = `${youtubeId}.mp3`;
      const youtubeCacheDirFileName = path.join(youtubeCachePath, youtubeCacheFileName);
      
      if (fs.existsSync(youtubeCacheDirFileName)) {
        logger.download.info(`YouTube 캐시에서 파일 찾음: ${youtubeCacheDirFileName}`);
        
        // 원래 서비스 디렉토리에 복사 (중복 저장이지만 조회 시간 절약)
        fs.copyFileSync(youtubeCacheDirFileName, cacheDirFileName);
        
        // 메타데이터 생성
        const metadata: CacheMetadata = {
          title: videoId, // 혹은 다른 제목 정보
          url: sanitizedUrl,
          downloadDate: new Date().toISOString(),
          videoId: videoId,
          youtubeId: youtubeId,
          serviceType: serviceType,
          sourceFilePath: youtubeCacheDirFileName // 원본 파일 경로
        };
        
        // 캐시 메타데이터 저장
        try {
          await this.cacheService.saveMetadata(sanitizedUrl, metadata, videoId);
          
          // YouTube 메타데이터에도 상호 참조 추가
          if (serviceType === ServiceType.APPLE_MUSIC || serviceType === ServiceType.SPOTIFY) {
            const youtubeMetadata = await this.cacheService.getMetadata(url, youtubeId);
            if (youtubeMetadata) {
              // 기존 YouTube 메타데이터에 스트리밍 서비스 정보 추가
              youtubeMetadata[serviceType === ServiceType.APPLE_MUSIC ? 'appleMusicId' : 'spotifyId'] = videoId;
              await this.cacheService.saveMetadata(url, youtubeMetadata, youtubeId);
            }
          }
        } catch (error) {
          logger.download.error(`캐시 메타데이터 저장 실패 (계속 진행): ${error}`);
        }
        
        return {
          success: true,
          filePath: cacheDirFileName,
          title: youtubeId,
          videoId: videoId
        };
      }
    }
    
    // 스트리밍 서비스 (Apple Music, Spotify) URL은 YouTube URL로 변환 필요
    const isStreamingService = serviceType === ServiceType.APPLE_MUSIC || 
                             serviceType === ServiceType.SPOTIFY;
    
    if (isStreamingService && !this.isYouTubeUrl(url)) {
      logger.download.info(`${serviceType} URL은 직접 다운로드할 수 없음: ${url}`);
      
      return {
        success: false,
        error: `${serviceType} URL은 직접 다운로드할 수 없습니다. YouTube 검색이 필요합니다.`
      };
    }
    
    try {
      // yt-dlp 경로 검증
      let ytdlpPath;
      try {
        ytdlpPath = await this.findYtdlpExe();
      } catch (error) {
        logger.download.error('yt-dlp.exe를 찾을 수 없습니다.');
        return {
          success: false,
          error: '유효한 yt-dlp.exe 경로를 찾을 수 없습니다.'
        };
      }
      
      // 명령 인자 구성
      const safeYtdlpPath = ytdlpPath.includes(' ') ? `"${ytdlpPath}"` : ytdlpPath;
      const safeUrl = `"${sanitizedUrl.replace(/"/g, '\\"')}"`;
      
      // yt-dlp로 비디오 정보 얻기
      const infoCmd = `${safeYtdlpPath} -j ${safeUrl} --no-playlist`;
      logger.download.debug(`정보 가져오기 명령어: ${infoCmd}`);
      
      const { stdout } = await execPromise(infoCmd).catch((error) => {
        logger.download.error(`정보 가져오기 실패 (${infoCmd}): ${error.message}`);
        if (error.stderr) logger.download.error(`stderr: ${error.stderr}`);
        throw error;
      });
      
      const info = JSON.parse(stdout);
      
      // 제목 및 영상 길이 추출
      const title = info.title || `Unknown-${videoId}`;
      const duration = parseInt(info.duration || '0', 10);
      
      logger.download.info(`비디오 정보: 제목="${title}", 길이=${duration}초`);
      
      // 다운로드 명령어 준비 - 서비스 타입별 파일명으로 저장
      const tempOutputFile = path.join(os.tmpdir(), `temp_${Date.now()}_${videoId}.mp3`);
      const downloadCmd = `${safeYtdlpPath} -x --audio-format mp3 --audio-quality 0 -o "${tempOutputFile}" ${safeUrl}`;
      
      logger.download.debug(`다운로드 명령어: ${downloadCmd}`);
      
      // 다운로드 실행
      await execPromise(downloadCmd).catch((error) => {
        logger.download.error(`다운로드 실패 (${downloadCmd}): ${error.message}`);
        if (error.stderr) logger.download.error(`stderr: ${error.stderr}`);
        throw error;
      });
      
      // 다운로드된 파일 확인
      if (!fs.existsSync(tempOutputFile)) {
        logger.download.error(`다운로드된 임시 파일이 존재하지 않음: ${tempOutputFile}`);
        return {
          success: false,
          error: '다운로드된 파일을 찾을 수 없습니다.'
        };
      }
      
      // 메타데이터 생성
      const metadata: CacheMetadata = {
        title: title,
        url: sanitizedUrl,
        downloadDate: new Date().toISOString(),
        videoId: videoId,
        serviceType: serviceType,
        duration: duration
      };
      
      // YouTube ID가 있고 원래 서비스와 다른 경우 메타데이터에 추가
      if (youtubeId && serviceType !== ServiceType.YOUTUBE) {
        metadata.youtubeId = youtubeId;
      }
      
      // 파일 크기 구하기
      const stats = fs.statSync(tempOutputFile);
      metadata.fileSize = stats.size;
      
      // 임시 파일을 캐시 디렉토리로 이동
      logger.download.info(`파일 복사: ${tempOutputFile} → ${cacheDirFileName}`);
      fs.copyFileSync(tempOutputFile, cacheDirFileName);
      
      // 유튜브 ID가 있고 다른 서비스인 경우, 유튜브 캐시에도 저장
      if (youtubeId && serviceType !== ServiceType.YOUTUBE) {
        const youtubeCachePath = path.join(config.localCacheDir, this.getServiceDirectory(ServiceType.YOUTUBE));
        
        // 유튜브 캐시 디렉토리 확인
        if (!fs.existsSync(youtubeCachePath)) {
          fs.mkdirSync(youtubeCachePath, { recursive: true });
        }
        
        const youtubeCacheFileName = `${youtubeId}.mp3`;
        const youtubeCacheDirFileName = path.join(youtubeCachePath, youtubeCacheFileName);
        
        // 유튜브 캐시에 복사
        if (!fs.existsSync(youtubeCacheDirFileName)) {
          logger.download.info(`YouTube 캐시에도 저장: ${youtubeCacheDirFileName}`);
          fs.copyFileSync(tempOutputFile, youtubeCacheDirFileName);
          
          // YouTube 메타데이터 생성
          const youtubeMetadata: CacheMetadata = {
            title: title,
            url: this.isYouTubeUrl(sanitizedUrl) ? sanitizedUrl : `https://www.youtube.com/watch?v=${youtubeId}`,
            downloadDate: new Date().toISOString(),
            videoId: youtubeId,
            serviceType: ServiceType.YOUTUBE,
            duration: duration,
            fileSize: stats.size
          };
          
          // 원래 서비스 ID 추가 (교차 참조용)
          if (serviceType === ServiceType.APPLE_MUSIC) {
            youtubeMetadata.appleMusicId = videoId;
          } else if (serviceType === ServiceType.SPOTIFY) {
            youtubeMetadata.spotifyId = videoId;
          }
          
          // YouTube 메타데이터 저장
          try {
            await this.cacheService.saveMetadata(
              this.isYouTubeUrl(sanitizedUrl) ? sanitizedUrl : `https://www.youtube.com/watch?v=${youtubeId}`,
              youtubeMetadata,
              youtubeId
            );
          } catch (error) {
            logger.download.error(`YouTube 메타데이터 저장 실패 (계속 진행): ${error}`);
          }
        }
      }
      
      try {
        // 임시 파일 삭제
        fs.unlinkSync(tempOutputFile);
      } catch (error) {
        const unlinkError = error as Error;
        logger.download.warn(`임시 파일 삭제 실패 (무시됨): ${unlinkError.message}`);
      }
      
      // 캐시 서비스에 메타데이터 저장
      try {
        await this.cacheService.saveToCache(sanitizedUrl, cacheDirFileName, metadata, videoId);
        logger.download.success(`캐시에 저장 완료: ${cacheDirFileName}`);
      } catch (error) {
        const cacheError = error as Error;
        logger.download.error(`캐시 메타데이터 저장 실패 (계속 진행): ${cacheError.message}`);
      }
      
      return {
        success: true,
        filePath: cacheDirFileName,
        title: title,
        videoId: videoId
      };
    } catch (error) {
      logger.download.error('다운로드 실패:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  
  /**
   * Clean up local files that are not needed anymore
   */
  cleanupLocalFiles(): void {
    try {
      logger.download.info('불필요한 로컬 파일 정리 중...');
      // CacheService의 정리 메서드 호출 - 이제 영구 캐시 파일은 보존됨
      this.cacheService.cleanupLocalCache(1);
    } catch (error) {
      logger.download.error('파일 정리 실패:', error);
    }
  }
  
  /**
   * Close SSH connection when done
   */
  async close(): Promise<void> {
    if (this.ssh) {
      this.ssh.dispose();
      this.ssh = null;
    }
    
    // 불필요한 로컬 파일 정리
    this.cleanupLocalFiles();
  }

  /**
   * 제목과 비디오 ID가 동일한 경우 구분된 제목을 제공합니다.
   * @param title 원본 제목 (undefined일 수 있음)
   * @param videoId 비디오 ID (undefined일 수 있음)
   * @returns 구분된 제목 또는 원본 제목
   */
  private getDistinctTitle(title?: string | undefined, videoId?: string | undefined): string {
    // title이나 videoId가 정의되지 않은 경우
    if (!title) return 'Unknown Title';
    if (!videoId) return title;
    
    // 제목과 비디오 ID가 동일한 경우 구분을 위해 '(YouTube Video)' 추가
    if (title === videoId) {
      return title + ' (YouTube Video)';
    }
    return title;
  }

  /**
   * 문자열의 단순 해시 값을 생성합니다.
   * ID 생성에 사용합니다.
   */
  private hashString(str: string): string {
    const hash = crypto.createHash('md5').update(str).digest('hex');
    return hash.substring(0, 10); // 10자리로 제한하여 ID로 활용
  }

  /**
   * YouTube에서 검색하여 최상의 결과를 반환합니다
   */
  async searchYouTube(query: string, limit: number = 5): Promise<SearchResult[]> {
    try {
      logger.download.info(`검색 수행 중: "${query}"`);
      
      // yt-dlp 경로 검증
      let ytdlpPath;
      try {
        ytdlpPath = await this.findYtdlpExe();
      } catch (error) {
        logger.download.error('yt-dlp.exe를 찾을 수 없습니다.');
        return [];
      }
      
      // 명령 인자 구성
      const safeYtdlpPath = ytdlpPath.includes(' ') ? `"${ytdlpPath}"` : ytdlpPath;
      const safeQuery = `"${query.replace(/"/g, '\\"')}"`;
      
      // 검색 명령 실행
      const cmd = `${safeYtdlpPath} ytsearch${limit}:${safeQuery} --flat-playlist --dump-json`;
      logger.download.debug(`검색 명령어: ${cmd}`);
      
      // 명령 실행
      const { stdout, stderr } = await execPromise(cmd).catch((error) => {
        logger.download.error(`명령 실행 실패 (${cmd}): ${error.message}`);
        // 디버깅을 위해 stderr 출력
        if (error.stderr) logger.download.error(`stderr: ${error.stderr}`);
        throw error;
      });
      
      if (stderr && !stdout) {
        logger.download.error('검색 오류:', stderr);
        return [];
      }
      
      // 결과 처리
      const results: SearchResult[] = [];
      const lines = stdout.trim().split('\n');
      
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          logger.download.debug(`검색 결과 ID: ${data.id}, 제목: ${data.title}`);
          
          const fullURL = data.webpage_url || `https://www.youtube.com/watch?v=${data.id}`;
          
          results.push({
            id: data.id,
            title: data.title,
            duration: this.formatDuration(data.duration || 0),
            uploader: data.uploader || '',
            url: fullURL
          });
        } catch (err) {
          logger.download.warn('검색 결과 구문 분석 오류:', err);
        }
      }
      
      logger.download.success(`${results.length}개의 검색 결과를 찾았습니다.`);
      return results;
    } catch (error) {
      logger.download.error('YouTube 검색 중 오류 발생:', error);
      return [];
    }
  }
  
  /**
   * YouTube에서 가장 일치하는 결과 URL을 반환합니다
   */
  async findBestMatch(query: string): Promise<string | null> {
    try {
      // 단일 가장 일치하는 항목만 검색
      const results = await this.searchYouTube(query, 1);
      
      if (results.length > 0) {
        const result = results[0];
        logger.download.success(`"${query}"에 대한 가장 일치하는 항목 찾음: ${result.title}`);
        logger.download.debug(`검색된 ID: ${result.id}, URL: ${result.url}`);
        return result.url;
      } else {
        logger.download.warn(`"${query}"에 대한 검색 결과가 없습니다.`);
        return null;
      }
    } catch (error) {
      logger.download.error('최상의 일치 항목을 찾는 중 오류 발생:', error);
      return null;
    }
  }
  
  /**
   * 초 단위의 시간을 MM:SS 형식으로 변환합니다
   */
  private formatDuration(seconds: number): string {
    if (!seconds) return 'Unknown';
    
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * 다운로드 진행 상황을 스트림으로 시작하고, 완료 시 파일로 저장
   */
  async downloadWithProgress(url: string): Promise<{ stream: Readable; result: Promise<DownloadResult> }> {
    const sanitizedUrl = this.sanitizeUrl(url);
    const videoId = this.extractVideoId(sanitizedUrl);
    
    // 임시 파일 경로 생성 (고유 ID 추가)
    const uniqueId = videoId || this.hashString(sanitizedUrl);
    const timestamp = Date.now();
    const tempFilePath = path.join(
      config.localCacheDir,
      `temp_${uniqueId}_${timestamp}.mp3`
    );
    
    // 디렉토리 존재 확인
    if (!fs.existsSync(config.localCacheDir)) {
      try {
        fs.mkdirSync(config.localCacheDir, { recursive: true });
        logger.download.info(`캐시 디렉토리 생성됨: ${config.localCacheDir}`);
      } catch (dirError) {
        logger.download.error(`캐시 디렉토리 생성 실패: ${config.localCacheDir}`, dirError);
      }
    }
    
    // 진행 상황 전달을 위한 스트림 생성
    const progressStream = new Readable({
      read() {} // 필수 구현
    });
    
    // 다운로드 작업 시작
    const resultPromise = (async () => {
      try {
        // 경로 정규화 (백슬래시를 포워드 슬래시로 변환)
        const ytdlpPath = config.localYtdlpPath.replace(/\\/g, '/');
        const outputTemplate = tempFilePath.replace(/\\/g, '/');
        
        // yt-dlp 실행 파일 존재 확인
        if (!fs.existsSync(config.localYtdlpPath)) {
          logger.download.error(`yt-dlp 실행 파일이 존재하지 않습니다: ${config.localYtdlpPath}`);
          throw new Error(`yt-dlp 실행 파일을 찾을 수 없습니다: ${config.localYtdlpPath}`);
        }
        
        logger.download.info(`yt-dlp 실행 파일 확인됨: ${config.localYtdlpPath} (크기: ${fs.statSync(config.localYtdlpPath).size} 바이트)`);
        
        // 명령 구성 - 기존 명령어 구조 유지 (재생에 영향 주지 않도록)
        const command = `"${ytdlpPath}" -f "bestaudio[ext=m4a]/bestaudio" -o "${outputTemplate}" --no-playlist --no-warnings --quiet "${sanitizedUrl}"`;
        
        logger.download.info(`로컬 다운로드 명령: ${command}`);
        
        // 자식 프로세스 실행 - 분리된 변수로 추적
        const childProcess = exec(command);
        
        // 표준 출력 캡처
        let stdoutData = '';
        childProcess.stdout?.on('data', (data) => {
          stdoutData += data;
          logger.download.debug(`yt-dlp 출력: ${data}`);
        });
        
        // 오류 스트림 캡처
        let errorOutput = '';
        childProcess.stderr?.on('data', (data) => {
          errorOutput += data;
          logger.download.error(`yt-dlp 오류: ${data}`);
        });
        
        // 프로세스 완료 대기
        await new Promise<void>((resolve, reject) => {
          childProcess.on('close', (code) => {
            logger.download.info(`yt-dlp 프로세스 종료 (코드: ${code})`);
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`다운로드 실패 (코드: ${code}): ${errorOutput || '원인 불명'}`));
            }
          });
          
          // 타임아웃 설정
          setTimeout(() => {
            reject(new Error('다운로드 타임아웃 (30초)'));
          }, 30000);
        });
        
        // 다운로드 완료 확인
        if (fs.existsSync(tempFilePath)) {
          const fileStats = fs.statSync(tempFilePath);
          logger.download.info(`다운로드된 파일: ${tempFilePath} (크기: ${fileStats.size} 바이트)`);
          
          if (fileStats.size > 0) {
            // 다운로드 완료 신호 전송
            progressStream.push(null); // 스트림 종료
            
            return {
              success: true,
              filePath: tempFilePath,
              title: this.getDistinctTitle(undefined, videoId),
              videoId
            };
          } else {
            logger.download.error(`다운로드된 파일이 비어 있습니다: ${tempFilePath}`);
            throw new Error('다운로드된 파일이 비어 있습니다');
          }
        } else {
          logger.download.error(`다운로드된 파일이 존재하지 않습니다: ${tempFilePath}`);
          throw new Error(`다운로드된 파일이 존재하지 않습니다: ${tempFilePath}`);
        }
      } catch (error) {
        // 오류 발생 시 스트림 종료
        progressStream.push(null);
        
        const errorMessage = error instanceof Error ? error.message : '알 수 없는 오류';
        logger.download.error('진행 중 다운로드 오류:', error);
        
        // 간단한 대체 다운로드 시도
        try {
          logger.download.info('대체 다운로드 방법 시도 중...');
          const ytdlpPath = config.localYtdlpPath;
          const simpleCommand = `"${ytdlpPath}" -f bestaudio -o "${tempFilePath}" "${sanitizedUrl}"`;
          
          logger.download.info(`대체 다운로드 명령: ${simpleCommand}`);
          await execPromise(simpleCommand);
          
          if (fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 0) {
            logger.download.info(`대체 방법으로 다운로드 성공: ${tempFilePath}`);
            return {
              success: true,
              filePath: tempFilePath,
              title: this.getDistinctTitle(undefined, videoId),
              videoId
            };
          }
        } catch (fallbackError) {
          logger.download.error('대체 다운로드 방법도 실패:', fallbackError);
        }
        
        return {
          success: false,
          error: errorMessage
        };
      }
    })();
    
    return { stream: progressStream, result: resultPromise };
  }

  /**
   * 캐시 서비스 인스턴스 반환
   */
  getCacheService(): CacheService {
    return this.cacheService;
  }

  /**
   * 주어진 검색어로 YouTube를 검색하고 결과를 반환합니다.
   * @param query 검색어
   * @param limit 최대 결과 개수 (기본값: 5)
   * @returns 검색 결과 배열
   */
  async search(query: string, limit: number = 5): Promise<SearchResult[]> {
    return await this.searchYouTube(query, limit);
  }
} 