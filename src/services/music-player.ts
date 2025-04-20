import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  getVoiceConnection
} from '@discordjs/voice';
import { Buffer } from 'buffer';
import { VoiceChannel, TextChannel, Guild, GuildMember, Message } from 'discord.js';
import { YtdlpService, DownloadResult } from './ytdlp-service';
import { db } from '../database';
import fs from 'fs';
import { logger } from '../utils/logger';
import { SpotifyService, SpotifyTrack, SpotifyResult } from './spotify-service';
import { AppleMusicService, AppleMusicTrack, AppleMusicResult } from './apple-music-service';
import { MelonService, MelonTrack, MelonResult } from './melon-service';
import path from 'path';
import { config } from '../config';
import { CacheService, ServiceType } from './cache-service';

// Node.js의 글로벌 영역에 Buffer를 추가합니다
(global as any).Buffer = Buffer;

export interface QueueItem {
  url: string;
  title: string;
  requestedBy: string;
  requestedById: string;
  filePath?: string; // 파일 경로 캐싱을 위한 속성 추가
  videoId?: string;  // 비디오 ID (캐싱 및 메타데이터용)
  serviceType?: ServiceType; // 서비스 타입 (YouTube, Spotify, 애플뮤직 등)
  youtubeUrl?: string; // 추가된 YouTube URL 속성
}

export class MusicPlayer {
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer;
  private queue: QueueItem[] = [];
  private currentTrack: QueueItem | null = null;
  private textChannel: TextChannel | null = null;
  private ytdlpService: YtdlpService;
  private spotifyService: SpotifyService;
  private appleMusicService: AppleMusicService;
  private melonService: MelonService;
  private isPlaying = false;
  private loopMode = false;
  private guildId: string | null = null;
  private currentFilePath: string | null = null;
  private lastSentMessage: Message | null = null; // 마지막으로 보낸 메시지 추적
  private deleteLastMessage: boolean = true;
  private cacheService: CacheService;
  
  constructor() {
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
    this.ytdlpService = YtdlpService.getInstance();
    this.spotifyService = SpotifyService.getInstance();
    this.appleMusicService = AppleMusicService.getInstance();
    this.melonService = MelonService.getInstance();
    this.cacheService = CacheService.getInstance();
    
    this.player.on(AudioPlayerStatus.Idle, () => {
      // 현재 트랙 복사본 저장 (반복 모드용)
      const trackToRepeat = this.currentTrack ? { ...this.currentTrack } : null;
      
      // 이전 트랙의 로컬 파일 삭제
      this.cleanupCurrentFile();
      
      if (this.loopMode && trackToRepeat) {
        // 깊은 복사본을 만들어 대기열 앞에 다시 추가
        logger.music.info(`반복 모드: 트랙 다시 추가 - ${trackToRepeat.title}`);
        this.queue.unshift(trackToRepeat);
      }
      
      this.playNext();
    });
    
    this.player.on('error', error => {
      logger.music.error('Error in audio player:', error);
      this.sendMessage(`❌ 오류가 발생했습니다: ${error.message}`);
      
      // 에러 발생 시에도 파일 정리
      this.cleanupCurrentFile();
      this.playNext();
    });
  }
  
  /**
   * 현재 재생 중인 로컬 파일 정리
   */
  private cleanupCurrentFile(): void {
    if (!this.currentFilePath) {
      return;
    }
    
    // currentTrack에서 videoId와 serviceType 추출 시도
    const videoId = this.currentTrack?.videoId;
    const serviceType = this.currentTrack?.serviceType;
    const url = this.currentTrack?.url;

    if (url && videoId && serviceType) {
      // 임시 파일 여부 확인 (temp_ 접두사)
      const isTemporaryFile = path.basename(this.currentFilePath).startsWith('temp_');

      if (isTemporaryFile) {
        this.deleteLocalFile(this.currentFilePath);
      } else {
        // videoId와 serviceType 사용하여 캐시 정리 요청
        this.cacheService.cleanupAfterPlayback(url, videoId)
          .then(() => logger.music.info(`재생 후 캐시 정리 요청 완료: videoId=${videoId}, service=${serviceType}`))
          .catch(err => logger.music.error('재생 후 캐시 정리 요청 실패:', err));
      }
    } else if (this.currentFilePath) {
      // 정보 부족 시 일단 로컬 파일 삭제 시도
      logger.music.warn(`videoId 또는 serviceType 정보 부족으로 cleanupAfterPlayback 건너<0xEB><0x9C><0x84>. 로컬 파일 직접 삭제 시도: ${this.currentFilePath}`);
      this.deleteLocalFile(this.currentFilePath);
    }
    
    this.currentFilePath = null;
  }
  
  /**
   * 로컬 파일 안전하게 삭제
   */
  private deleteLocalFile(filePath: string): void {
    try {
      logger.music.debug(`로컬 파일 삭제 시도: ${filePath}`);
      
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.music.success(`로컬 파일 삭제 성공: ${filePath}`);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // EBUSY 에러는 파일이 아직 다른 프로세스에서 사용중이라는 의미
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        logger.music.warn(`파일이 사용 중입니다. 삭제를 나중에 시도합니다: ${filePath}`);
        
        // 파일 경로 복사
        const filePathCopy: string = filePath;
        
        // 약간의 지연 후 삭제 재시도
        setTimeout(() => {
          try {
            if (filePathCopy && fs.existsSync(filePathCopy)) {
              fs.unlinkSync(filePathCopy);
              logger.music.success(`파일 삭제 재시도 성공: ${filePathCopy}`);
            }
          } catch (retryError) {
            logger.music.error('로컬 파일 재시도 삭제 실패:', retryError);
            
            // 마지막 시도로 비동기 삭제
            fs.unlink(filePathCopy, (unlinkErr) => {
              if (unlinkErr) {
                logger.music.error('비동기 파일 삭제 실패:', unlinkErr);
              } else {
                logger.music.success(`비동기 파일 삭제 성공: ${filePathCopy}`);
              }
            });
          }
        }, 500); // 500ms 후 재시도
      } else {
        logger.music.error('로컬 파일 삭제 실패:', error);
      }
    }
  }
  
  /**
   * Connect to a voice channel
   */
  public connect(voiceChannel: VoiceChannel, textChannel: TextChannel): boolean {
    try {
      this.textChannel = textChannel;
      this.guildId = voiceChannel.guild.id;
      
      // 이미 연결되어 있으면 새로 연결하지 않음
      if (this.connection) {
        return true;
      }
      
      logger.music.info(`음성 채널 연결 시도: ${voiceChannel.id}`);
      
      // 채널 ID만 사용하여 연결
      this.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });
      
      logger.music.info('음성 채널 연결 성공, 상태 이벤트 설정 중...');
      
      // 연결 상태 변경 이벤트 처리
      this.connection.on(VoiceConnectionStatus.Ready, () => {
        logger.music.info('음성 채널에 성공적으로 연결되었습니다.');
      });
      
      this.connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
        try {
          logger.music.info('음성 채널 연결이 끊겼습니다. 재연결 시도 중...');
          
          // 최신 버전의 Discord.js에서는 destroy()된 상태에서 재연결 시도 방지
          if (this.connection?.state.status === VoiceConnectionStatus.Destroyed) {
            logger.music.info('연결이 이미 파괴되었습니다. 재연결을 시도하지 않습니다.');
            this.connection = null;
            return;
          }
          
          // 5초 동안 재연결 시도
          await Promise.race([
            entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
            entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          
          logger.music.info('음성 채널 재연결 시도 중...');
        } catch (error) {
          logger.music.error('음성 채널 재연결 실패:', error);
          
          // 재연결 실패시 다시 연결 시도
          if (this.guildId) {
            logger.music.info('연결 다시 시도 중...');
            this.connection?.destroy();
            this.connection = null;
            
            // 5초 후 다시 시도
            setTimeout(() => {
              if (voiceChannel.members.size > 0) {
                logger.music.info('5초 후 다시 연결 시도 중...');
                this.connection = joinVoiceChannel({
                  channelId: voiceChannel.id,
                  guildId: voiceChannel.guild.id,
                  adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                  selfDeaf: true,
                  selfMute: false
                });
                
                if (this.connection) {
                  this.connection.subscribe(this.player);
                }
              } else {
                this.disconnect();
              }
            }, 5000);
          } else {
            this.disconnect();
          }
        }
      });
      
      // 에러 이벤트 처리
      this.connection.on('error', (error) => {
        logger.music.error('음성 연결 오류:', error);
        this.sendMessage(`❌ 음성 연결 오류가 발생했습니다: ${error.message}`);
      });
      
      logger.music.info('플레이어 구독 설정 중...');
      this.connection.subscribe(this.player);
      logger.music.info('음성 채널 연결 설정 완료');
      
      return true;
    } catch (error) {
      logger.music.error('음성 채널 연결 실패:', error);
      this.sendMessage(`❌ 음성 채널 연결 실패: ${error instanceof Error ? error.message : '알 수 없는 오류'}`);
      return false;
    }
  }
  
  /**
   * Disconnect from voice channel
   */
  public disconnect(): void {
    if (this.connection) {
      logger.music.info('음성 채널에서 연결 해제 중...');
      this.connection.destroy();
      this.connection = null;
      logger.music.info('음성 채널 연결 해제 완료');
    }
    
    this.queue = [];
    this.currentTrack = null;
    this.isPlaying = false;
    this.textChannel = null;
    this.guildId = null;
  }
  
  /**
   * Send a message to the text channel
   */
  private async sendMessage(content: string, options?: any, deleteLastMessage: boolean = true): Promise<void> {
    if (!this.textChannel) {
      logger.music.warn('텍스트 채널 없음: 메시지를 보낼 수 없습니다.');
      return;
    }
    
    try {
      // 메시지 삭제 기능 비활성화 (에러 발생 방지)
      deleteLastMessage = false;
      
      // 이전 메시지 삭제가 활성화된 경우에만 이전 메시지 삭제 시도
      if (deleteLastMessage && this.lastSentMessage && this.deleteLastMessage) {
        try {
          await this.lastSentMessage.delete();
        } catch (deleteError) {
          logger.music.warn('이전 메시지 삭제 실패:', deleteError);
          // 삭제 실패해도 계속 진행
        }
      }
      
      // 새 메시지 전송
      let message;
      
      if (typeof options === 'object' && !Array.isArray(options)) {
        // 임베드 또는 MessageOptions 객체
        if (options.embeds || options.content || options.components) {
          // 이미 MessageOptions 형식
          message = await this.textChannel.send(options);
        } else {
          // 임베드 객체를 MessageOptions로 변환
          message = await this.textChannel.send({
            content: content || undefined,
            embeds: [options]
          });
        }
      } else if (Array.isArray(options)) {
        // 임베드 배열
        message = await this.textChannel.send({
          content: content || undefined,
          embeds: options
        });
      } else {
        // 일반 텍스트 메시지
        message = await this.textChannel.send(content);
      }
      
      // 메시지 참조 저장
      this.lastSentMessage = message;
    } catch (error) {
      logger.music.error('메시지 전송 실패:', error);
    }
  }
  
  /**
   * 임베드 메시지 생성 헬퍼 함수
   */
  private createEmbed(title: string, description: string, color: number = 0x3498db, fields: any[] = []): any {
    const embed = {
      title: title,
      description: description,
      color: color,
      timestamp: new Date().toISOString(),
      fields: fields,
      footer: {
        text: '음악은 나의 삶 🎵'
      }
    };
    
    return embed;
  }
  
  /**
   * Add a song to the queue
   */
  public async addToQueue(url: string, member: GuildMember, trackInfo?: QueueItem): Promise<boolean> {
    try {
      // 대기열에 노래 추가 중 알림
      this.sendMessage(`🔍 요청한 노래를 찾는 중...`, {
        embeds: [{
          title: '음악 검색 중...',
          description: `🔍 **<@${member.id}>**님이 요청한 음악을 검색 중입니다...`,
          color: 0x3498db
        }]
      });
      
      // 이미 처리된 트랙 정보가 있는 경우
      if (trackInfo) {
        // 대기열에 추가
        const queueItem: QueueItem = {
          url: trackInfo.url,
          title: trackInfo.title,
          requestedBy: member.displayName,
          requestedById: member.id,
          filePath: trackInfo.filePath,
          videoId: trackInfo.videoId,
          serviceType: trackInfo.serviceType,
          youtubeUrl: trackInfo.youtubeUrl
        };
        
        this.queue.push(queueItem);
        logger.music.info(`대기열에 추가됨: ${queueItem.title}`);
        
        // 현재 재생 중이 아니면 재생 시작
        if (!this.isPlaying) {
          this.playNext();
        } else {
          const addedEmbed = this.createEmbed(
            '트랙 추가됨',
            `✅ **${queueItem.title}** 대기열에 추가됨`,
            0x1DB954, // 초록색
            [
              {
                name: '요청자',
                value: `<@${queueItem.requestedById}>`
              }
            ]
          );
          this.sendMessage("", { embeds: [addedEmbed] });
        }
        
        return true;
      }
      // Spotify URL 처리
      else if (this.spotifyService.isSpotifyUrl(url)) {
        logger.music.info(`Spotify URL 감지됨: ${url}`);
        return this.processSpotifyUrl(url, member);
      }
      // Apple Music URL 처리
      else if (this.appleMusicService.isAppleMusicUrl(url)) {
        logger.music.info(`Apple Music URL 감지됨: ${url}`);
        return this.processAppleMusicUrl(url, member);
      }
      // 멜론 URL 처리
      else if (this.melonService.isMelonUrl(url)) {
        return await this.processMelonUrl(url, member);
      }
      // YouTube 검색어 처리 (URL이 아닌 경우)
      else {
        logger.music.info(`검색어 감지됨: ${url}`);
        
        // YouTube에서 최적의 일치 항목 찾기
        const bestMatch = await this.ytdlpService.findBestMatch(url);
        if (!bestMatch) {
          // 검색 실패 임베드로 변경
          const errorEmbed = this.createEmbed(
            '검색 실패',
            `❌ "${url}"에 대한 검색 결과를 찾을 수 없습니다.`,
            0xE74C3C, // 빨간색
            [
              {
                name: '요청자',
                value: `<@${member.id}>`
              }
            ]
          );
          this.sendMessage("", { embeds: [errorEmbed] });
          return false;
        }
        
        url = bestMatch;
        logger.music.info(`검색어에 대한 URL 찾음: ${url}`);
      }
      
      // ytdlp로 음악 다운로드
      const downloadResult = await this.ytdlpService.download(url);
      
      if (!downloadResult.success || !downloadResult.filePath || !downloadResult.title) {
        // 다운로드 실패 임베드로 변경
        const errorEmbed = this.createEmbed(
          '다운로드 실패',
          `❌ ${downloadResult.error || '알 수 없는 오류가 발생했습니다.'}`,
          0xE74C3C, // 빨간색
          [
            {
              name: '요청자',
              value: `<@${member.id}>`
            }
          ]
        );
        this.sendMessage("", { embeds: [errorEmbed] });
        return false;
      }
      
      // 대기열에 추가
      const queueItem: QueueItem = {
        url,
        title: downloadResult.title,
        requestedBy: member.displayName,
        requestedById: member.id,
        filePath: downloadResult.filePath
      };
      
      this.queue.push(queueItem);
      logger.music.info(`대기열에 추가됨: ${queueItem.title}`);
      
      // 현재 재생 중이 아니면 재생 시작
      if (!this.isPlaying) {
        this.playNext();
      } else {
        const addedEmbed = this.createEmbed(
          '트랙 추가됨',
          `✅ **${queueItem.title}** 대기열에 추가됨`,
          0x1DB954, // 초록색
          [
            {
              name: '요청자',
              value: `<@${queueItem.requestedById}>`
            }
          ]
        );
        this.sendMessage("", { embeds: [addedEmbed] });
      }
      
      return true;
    } catch (error) {
      logger.music.error('대기열 추가 오류:', error);
      // 임베드로 에러 메시지 변경
      const errorEmbed = this.createEmbed(
        '오류 발생',
        `❌ 대기열 추가 중 오류가 발생했습니다: ${error}`,
        0xE74C3C, // 빨간색
        [
          {
            name: '요청자',
            value: `<@${member.id}>`
          }
        ]
      );
      this.sendMessage("", { embeds: [errorEmbed] });
      return false;
    }
  }
  
  /**
   * Process Spotify URL and add tracks to queue
   */
  private async processSpotifyUrl(url: string, member: GuildMember): Promise<boolean> {
    try {
      const result: SpotifyResult = await this.spotifyService.processSpotifyUrl(url);
      const { type, tracks } = result;
      
      if (!tracks.length) {
        // 트랙 없음 임베드로 변경
        const errorEmbed = this.createEmbed(
          '트랙 없음',
          `❌ Spotify ${type}에서 트랙을 찾을 수 없습니다.`,
          0xE74C3C, // 빨간색
          [
            {
              name: '요청자',
              value: `<@${member.id}>`
            }
          ]
        );
        this.sendMessage("", { embeds: [errorEmbed] });
        return false;
      }
      
      // 첫 번째 트랙 처리
      let addedCount = 0;
      const firstTrack = tracks[0];
      const searchQuery = this.spotifyService.createSearchQuery(firstTrack);
      
      // 첫 번째 트랙 다운로드 시도
      logger.music.info(`Spotify 트랙 다운로드 시도: ${searchQuery}`);
      const downloadResult = await this.ytdlpService.download(searchQuery);
      
      if (!downloadResult.success || !downloadResult.filePath || !downloadResult.title) {
        // 다운로드 실패 임베드로 변경
        const errorEmbed = this.createEmbed(
          '다운로드 실패',
          `❌ ${downloadResult.error || '알 수 없는 오류가 발생했습니다.'}`,
          0xE74C3C, // 빨간색
          [
            {
              name: '요청자',
              value: `<@${member.id}>`
            }
          ]
        );
        this.sendMessage("", { embeds: [errorEmbed] });
        return false;
      }
      
      // 대기열에 추가
      const queueItem: QueueItem = {
        url: firstTrack.url,
        title: `${firstTrack.name} - ${firstTrack.artists.join(', ')}`,
        requestedBy: member.displayName,
        requestedById: member.id,
        filePath: downloadResult.filePath
      };
      
      this.queue.push(queueItem);
      addedCount++;
      
      logger.music.info(`Spotify 트랙 대기열에 추가됨: ${queueItem.title}`);
      
      // 현재 재생 중이 아니면 재생 시작
      if (!this.isPlaying) {
        this.playNext();
      } else {
        const addedEmbed = this.createEmbed(
          '트랙 추가됨',
          `✅ **${queueItem.title}** 대기열에 추가됨`,
          0x1DB954, // 초록색
          [
            {
              name: '요청자',
              value: `<@${queueItem.requestedById}>`
            }
          ]
        );
        this.sendMessage("", { embeds: [addedEmbed] });
      }
      
      // 만약 앨범이나 플레이리스트인 경우 나머지 트랙도 다운로드
      if (type !== 'track' && tracks.length > 1) {
        this.sendMessage(`🎵 Spotify ${type}의 나머지 트랙 ${tracks.length - 1}개를 대기열에 추가하는 중...`);
        
        for (let i = 1; i < tracks.length; i++) {
          const track = tracks[i];
          const query = this.spotifyService.createSearchQuery(track);
          
          try {
            const result = await this.ytdlpService.download(query);
            
            if (result.success && result.filePath && result.title) {
              const item: QueueItem = {
                url: track.url,
                title: `${track.name} - ${track.artists.join(', ')}`,
                requestedBy: member.displayName,
                requestedById: member.id,
                filePath: result.filePath
              };
              
              this.queue.push(item);
              addedCount++;
            }
          } catch (err) {
            logger.music.error(`Spotify 트랙 다운로드 실패: ${query}`, err);
            // 개별 트랙 오류는 무시하고 계속 진행
          }
        }
        
        // 플레이리스트/앨범 추가 완료 임베드
        const completedEmbed = this.createEmbed(
          '대기열에 추가됨',
          `✅ Spotify ${type}에서 총 ${addedCount}개의 트랙이 대기열에 추가되었습니다.`,
          0x1DB954, // 초록색
          [
            {
              name: '요청자',
              value: `<@${member.id}>`
            }
          ]
        );
        this.sendMessage("", { embeds: [completedEmbed] });
      }
      
      return addedCount > 0;
    } catch (error) {
      logger.music.error('Spotify URL 처리 오류:', error);
      // 임베드로 에러 메시지 변경
      const errorEmbed = this.createEmbed(
        '오류 발생',
        `❌ Spotify URL 처리 중 오류가 발생했습니다: ${error}`,
        0xE74C3C, // 빨간색
        [
          {
            name: '요청자',
            value: `<@${member.id}>`
          }
        ]
      );
      this.sendMessage("", { embeds: [errorEmbed] });
      return false;
    }
  }

  /**
   * Process Apple Music URL and add tracks to queue
   */
  private async processAppleMusicUrl(url: string, member: GuildMember): Promise<boolean> {
    try {
      // 처리 중 임베드로 변경
      const processingEmbed = this.createEmbed(
        'Apple Music 처리 중',
        '🎵 Apple Music 링크를 처리하는 중...',
        0xFF2F54, // Apple Music 색상
        [
          {
            name: '요청자',
            value: `<@${member.id}>`
          }
        ]
      );
      await this.sendMessage("", { embeds: [processingEmbed] });
      
      // Apple Music 로그인 (매 호출마다 갱신)
      const isLoggedIn = await this.appleMusicService.ensureAuthenticated();
      
      if (!isLoggedIn) {
        logger.music.error('Apple Music 인증 실패');
        // 인증 실패 임베드로 변경
        const errorEmbed = this.createEmbed(
          '인증 실패',
          '❌ Apple Music 인증에 실패했습니다. 다시 시도해주세요.',
          0xE74C3C, // 빨간색
          [
            {
              name: '요청자',
              value: `<@${member.id}>`
            }
          ]
        );
        await this.sendMessage("", { embeds: [errorEmbed] });
        return false;
      }
      
      // Apple Music URL 처리
      logger.music.info(`Apple Music URL 처리 중: ${url}`);
      const result = await this.appleMusicService.processAppleMusicUrl(url);
      
      if (!result || result.tracks.length === 0) {
        logger.music.error('Apple Music URL에서 트랙을 추출할 수 없습니다.');
        // 트랙 없음 임베드로 변경
        const errorEmbed = this.createEmbed(
          '트랙 없음',
          '❌ Apple Music 트랙을 찾을 수 없습니다.',
          0xE74C3C, // 빨간색
          [
            {
              name: '요청자',
              value: `<@${member.id}>`
            }
          ]
        );
        await this.sendMessage("", { embeds: [errorEmbed] });
        return false;
      }
      
      const tracks = result.tracks;
      
      // 단일 트랙인 경우
      if (result.type === 'track') {
        const track = tracks[0];
        logger.music.info(`단일 트랙 처리: "${track.name}" - ${track.artists.join(', ')}`);
        
        // YouTube 매치 찾기
        if (!track.youtubeUrl) {
          // 검색어 생성
          const searchQuery = this.appleMusicService.createSearchQuery(track);
          logger.music.info(`트랙 "${track.name}" YouTube 검색 중: "${searchQuery}"`);
          
          // YouTube에서 검색
          const youtubeUrl = await this.ytdlpService.findBestMatch(searchQuery);
          
          if (!youtubeUrl) {
            logger.music.error(`트랙 "${track.name}"에 대한 YouTube 매치를 찾을 수 없습니다.`);
            // YouTube 매치 없음 임베드로 변경
            const errorEmbed = this.createEmbed(
              'YouTube 매치 없음',
              `❌ 트랙 "${track.name}"에 대한 YouTube 매치를 찾을 수 없습니다.`,
              0xE74C3C, // 빨간색
              [
                {
                  name: '요청자',
                  value: `<@${member.id}>`
                }
              ]
            );
            await this.sendMessage("", { embeds: [errorEmbed] });
            return false;
          }
          
          logger.music.success(`트랙 "${track.name}"에 대한 YouTube 매치 찾음: ${youtubeUrl}`);
          track.youtubeUrl = youtubeUrl;
        }
        
        // 다운로드 시도
        if (!track.youtubeUrl) {
          logger.music.error(`트랙 "${track.name}"에 대한 YouTube URL이 없습니다.`);
          // YouTube URL 없음 임베드
          const errorEmbed = this.createEmbed(
            'YouTube URL 없음',
            `❌ 트랙 "${track.name}"에 대한 YouTube URL이 없습니다.`,
            0xE74C3C, // 빨간색
            [
              {
                name: '요청자',
                value: `<@${member.id}>`
              }
            ]
          );
          await this.sendMessage("", { embeds: [errorEmbed] });
          return false;
        }
        
        const downloadResult = await this.ytdlpService.download(track.youtubeUrl, {
          serviceType: ServiceType.APPLE_MUSIC,
          videoId: track.id
        });
        
        if (!downloadResult.success || !downloadResult.filePath) {
          logger.music.error(`트랙 다운로드 실패: ${downloadResult.error || '알 수 없는 오류'}`);
          // 다운로드 실패 임베드로 변경
          const errorEmbed = this.createEmbed(
            '다운로드 실패',
            `❌ 트랙 다운로드 실패: ${downloadResult.error || '알 수 없는 오류'}`,
            0xE74C3C, // 빨간색
            [
              {
                name: '요청자',
                value: `<@${member.id}>`
              }
            ]
          );
          await this.sendMessage("", { embeds: [errorEmbed] });
          return false;
        }
        
        // 큐 아이템 생성
        const queueItem: QueueItem = {
          url: track.url,
          title: `${track.name} - ${track.artists.join(', ')}`,
          requestedBy: member.displayName,
          requestedById: member.id,
          filePath: downloadResult.filePath,
          videoId: track.id,
          serviceType: ServiceType.APPLE_MUSIC,
          youtubeUrl: track.youtubeUrl // 유튜브 URL 저장
        };
        
        // 큐에 추가
        this.queue.push(queueItem);
        logger.music.info(`Apple Music 트랙 대기열에 추가됨: ${queueItem.title}`);
        
        // 현재 재생 중이 아니면 재생 시작
        if (!this.isPlaying) {
          this.playNext();
        } else {
          const addedEmbed = this.createEmbed(
            '트랙 추가됨',
            `✅ **${queueItem.title}** 대기열에 추가됨`,
            0x1DB954, // 초록색
            [
              {
                name: '요청자',
                value: `<@${queueItem.requestedById}>`
              }
            ]
          );
          this.sendMessage("", { embeds: [addedEmbed] });
        }
        
        return true;
      }
      
      // 앨범 또는 플레이리스트인 경우
      else if (result.type === 'album' || result.type === 'playlist') {
        let addedCount = 0;
        const firstTrack = tracks[0];
        
        // 첫 번째 트랙에 YouTube URL이 없으면 검색
        if (!firstTrack.youtubeUrl) {
          const searchQuery = this.appleMusicService.createSearchQuery(firstTrack);
          logger.music.info(`첫 번째 트랙 "${firstTrack.name}" YouTube 검색 중: "${searchQuery}"`);
          
          const youtubeUrl = await this.ytdlpService.findBestMatch(searchQuery);
          
          if (!youtubeUrl) {
            logger.music.error(`첫 번째 트랙 "${firstTrack.name}"에 대한 YouTube 매치를 찾을 수 없습니다.`);
            // YouTube 매치 없음 임베드로 변경
            const errorEmbed = this.createEmbed(
              'YouTube 매치 없음',
              `❌ 첫 번째 트랙에 대한 YouTube 매치를 찾을 수 없습니다.`,
              0xE74C3C, // 빨간색
              [
                {
                  name: '요청자',
                  value: `<@${member.id}>`
                }
              ]
            );
            await this.sendMessage("", { embeds: [errorEmbed] });
            return false;
          }
          
          logger.music.success(`첫 번째 트랙 "${firstTrack.name}"에 대한 YouTube 매치 찾음: ${youtubeUrl}`);
          firstTrack.youtubeUrl = youtubeUrl;
        }
        
        // 첫 번째 트랙 다운로드
        const downloadResult = await this.ytdlpService.download(firstTrack.youtubeUrl, {
          serviceType: ServiceType.APPLE_MUSIC,
          videoId: firstTrack.id
        });
        
        if (!downloadResult.success || !downloadResult.filePath) {
          logger.music.error(`첫 번째 트랙 다운로드 실패: ${downloadResult.error || '알 수 없는 오류'}`);
          // 다운로드 실패 임베드로 변경
          const errorEmbed = this.createEmbed(
            '다운로드 실패',
            `❌ 첫 번째 트랙 다운로드 실패: ${downloadResult.error || '알 수 없는 오류'}`,
            0xE74C3C, // 빨간색
            [
              {
                name: '요청자',
                value: `<@${member.id}>`
              }
            ]
          );
          await this.sendMessage("", { embeds: [errorEmbed] });
          return false;
        }
        
        // 첫 번째 트랙 대기열에 추가
        const queueItem: QueueItem = {
          url: firstTrack.url,
          title: `${firstTrack.name} - ${firstTrack.artists.join(', ')}`,
          requestedBy: member.displayName,
          requestedById: member.id,
          filePath: downloadResult.filePath,
          videoId: firstTrack.id,
          serviceType: ServiceType.APPLE_MUSIC,
          youtubeUrl: firstTrack.youtubeUrl // 유튜브 URL 저장
        };
        
        this.queue.push(queueItem);
        addedCount++;
        
        // 현재 재생 중이 아니면 재생 시작
        if (!this.isPlaying) {
          this.playNext();
        } else {
          const addedEmbed = this.createEmbed(
            '대기열에 추가됨',
            `✅ **${queueItem.title}**`,
            0x3498DB, // 파란색
            [
              { name: '요청자', value: `<@${queueItem.requestedById}>`, inline: true }
            ]
          );
          this.sendMessage('', addedEmbed);
        }
        
        // 나머지 트랙 처리를 알림
        if (tracks.length > 1) {
          this.sendMessage(`🎵 Apple Music ${result.type}의 나머지 트랙 ${tracks.length - 1}개를 대기열에 추가하는 중...`);
          
          // 나머지 트랙 처리
          for (let i = 1; i < tracks.length; i++) {
            const track = tracks[i];
            
            // YouTube URL이 없으면 검색
            if (!track.youtubeUrl) {
              try {
                const searchQuery = this.appleMusicService.createSearchQuery(track);
                logger.music.info(`트랙 "${track.name}" YouTube 검색 중: "${searchQuery}"`);
                
                const youtubeUrl = await this.ytdlpService.findBestMatch(searchQuery);
                
                if (!youtubeUrl) {
                  logger.music.warn(`트랙 "${track.name}"에 대한 YouTube 매치를 찾을 수 없어 건너뜁니다.`);
                  continue;
                }
                
                track.youtubeUrl = youtubeUrl;
              } catch (err) {
                logger.music.warn(`트랙 "${track.name}" 검색 중 오류 발생, 건너뜁니다:`, err);
                continue;
              }
            }
            
            try {
              const result = await this.ytdlpService.download(track.youtubeUrl!, {
                serviceType: ServiceType.APPLE_MUSIC,
                videoId: track.id
              });
              
              if (result.success && result.filePath) {
                const item: QueueItem = {
                  url: track.url,
                  title: `${track.name} - ${track.artists.join(', ')}`,
                  requestedBy: member.displayName,
                  requestedById: member.id,
                  filePath: result.filePath,
                  videoId: track.id,
                  serviceType: ServiceType.APPLE_MUSIC,
                  youtubeUrl: track.youtubeUrl // 유튜브 URL 저장
                };
                
                this.queue.push(item);
                addedCount++;
              }
            } catch (err) {
              logger.music.error(`Apple Music 트랙 다운로드 실패: ${track.name}`, err);
              // 개별 트랙 오류는 무시하고 계속 진행
            }
          }
          
          // 플레이리스트/앨범 추가 완료 임베드
          const completedEmbed = this.createEmbed(
            '대기열에 추가됨',
            `✅ Apple Music ${result.type}에서 총 ${addedCount}개의 트랙이 대기열에 추가되었습니다.`,
            0xFF2F54, // Apple Music 색상
            [
              {
                name: '요청자',
                value: `<@${member.id}>`
              }
            ]
          );
          this.sendMessage("", { embeds: [completedEmbed] });
        }
        
        return addedCount > 0;
      }
      
      return false;
    } catch (error) {
      logger.music.error('Apple Music URL 처리 오류:', error);
      // 임베드로 에러 메시지 변경
      const errorEmbed = this.createEmbed(
        '오류 발생',
        `❌ Apple Music URL 처리 중 오류가 발생했습니다: ${error}`,
        0xE74C3C, // 빨간색
        [
          {
            name: '요청자',
            value: `<@${member.id}>`
          }
        ]
      );
      this.sendMessage("", { embeds: [errorEmbed] });
      return false;
    }
  }
  
  /**
   * 멜론 URL을 처리하여 대기열에 추가
   */
  private async processMelonUrl(url: string, member: GuildMember): Promise<boolean> {
    try {
      logger.music.info(`멜론 URL 처리 중: ${url}`);
      
      // 멜론 URL에서 트랙 정보 가져오기
      const melonResult: MelonResult = await this.melonService.processMelonUrl(url);
      
      if (melonResult.tracks.length === 0) {
        logger.music.warn(`멜론 URL에서 트랙을 찾을 수 없습니다: ${url}`);
        await this.sendMessage(`❌ 멜론 URL에서 트랙을 찾을 수 없습니다: ${url}`);
        return false;
      }
      
      // 트랙별 YouTube URL 찾기
      const tracksWithYouTubeUrl = await this.melonService.findYouTubeUrls(melonResult.tracks);
      
      // 대기열에 트랙 추가
      let addedCount = 0;
      
      for (const track of tracksWithYouTubeUrl) {
        if (!track.youtubeUrl) {
          logger.music.warn(`멜론 트랙 "${track.name}"의 YouTube URL을 찾을 수 없습니다.`);
          continue;
        }
        
        // 대기열에 추가
        this.queue.push({
          url: track.youtubeUrl,
          title: `${track.name} - ${track.artists.join(', ')}`,
          requestedBy: member.displayName,
          requestedById: member.id,
          serviceType: ServiceType.MELON,
          videoId: track.youtubeUrl.includes('watch?v=') 
            ? track.youtubeUrl.split('watch?v=')[1].split('&')[0] 
            : undefined
        });
        
        addedCount++;
      }
      
      // 결과 메시지 전송
      if (addedCount > 0) {
        const typeText = melonResult.type === 'track' ? '곡' 
                       : melonResult.type === 'album' ? '앨범' 
                       : melonResult.type === 'playlist' ? '플레이리스트' 
                       : '차트';
        
        const title = addedCount === 1
          ? `🎵 멜론 ${typeText} 추가됨: ${tracksWithYouTubeUrl[0].name}`
          : `🎵 멜론 ${typeText}에서 ${addedCount}개의 트랙이 대기열에 추가됨`;
        
        const description = addedCount === 1
          ? `${tracksWithYouTubeUrl[0].artists.join(', ')} - ${tracksWithYouTubeUrl[0].album || ''}`
          : `총 ${melonResult.tracks.length}개 중 ${addedCount}개의 트랙이 추가되었습니다.`;
        
        const embed = this.createEmbed(
          title,
          description,
          0x00CD3C, // 멜론 색상 (녹색)
          [
            {
              name: '요청자',
              value: `<@${member.id}>`
            }
          ]
        );
        
        await this.sendMessage('', { embeds: [embed] });
      } else {
        await this.sendMessage(`❌ 멜론 URL에서 재생 가능한 트랙을 찾을 수 없습니다: ${url}`);
        return false;
      }
      
      // 첫 번째 트랙 재생 시작
      if (!this.isPlaying) {
        this.playNext();
      }
      
      return true;
    } catch (error: any) {
      logger.music.error('멜론 URL 처리 중 오류:', error);
      await this.sendMessage(`❌ 멜론 URL 처리 중 오류가 발생했습니다: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Skip the current track
   */
  public skip(): boolean {
    if (!this.isPlaying) {
      logger.music.info('재생 중인 트랙이 없어 건너뛰기 불가');
      
      // 건너뛰기 실패 임베드 제거 (응답은 명령어 핸들러에서 처리)
      return false;
    }
    
    logger.music.info('현재 트랙 건너뛰기');
    
    // 건너뛰기 임베드는 명령어 핸들러에서 처리하도록 제거
    
    this.player.stop();
    return true;
  }
  
  /**
   * Play the next track in the queue
   */
  private async playNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentTrack = null;
      this.sendMessage('⏹️ 재생 목록이 비어 재생을 중지합니다.');
      return;
    }

    this.isPlaying = true;
    const nextTrack = this.queue.shift();
    if (!nextTrack) {
      this.isPlaying = false;
      return;
    }
    this.currentTrack = nextTrack;

    logger.music.info(`다음 곡 재생 시작: ${nextTrack.title} (요청: ${nextTrack.requestedBy})`);

    let resource: AudioResource | null = null;
    let filePath: string | null = null;

    try {
      // 1. videoId와 serviceType으로 캐시 확인 (getFromCache 사용)
      if (nextTrack.videoId && nextTrack.serviceType) {
        logger.music.info(`캐시 확인 중: videoId=${nextTrack.videoId}, service=${nextTrack.serviceType}`);
        // getFromCache는 로컬 경로 반환 또는 NAS에서 다운로드 후 로컬 경로 반환
        filePath = await this.cacheService.getFromCache(nextTrack.url, nextTrack.videoId, nextTrack.serviceType);
        if (filePath) {
          logger.music.success(`캐시 히트! 파일 경로 확보: ${filePath}`);
        } else {
            logger.music.info(`캐시 미스 (videoId=${nextTrack.videoId}, service=${nextTrack.serviceType}). 다운로드 시도...`);
        }
      } else {
          logger.music.warn('videoId 또는 serviceType 정보 부족. URL 기반 다운로드 시도...');
      }

      // 2. 캐시 미스 시 다운로드 (ytdlpService.download 사용, 옵션 없이 호출)
      if (!filePath) {
        const downloadUrl = nextTrack.youtubeUrl || nextTrack.url; // YouTube URL 우선 사용
        logger.music.info(`yt-dlp 다운로드 요청: ${downloadUrl}`);
        
        // ytdlpService.download는 내부적으로 캐시 확인 후 없으면 다운로드 진행
        const downloadResult: DownloadResult | null = await this.ytdlpService.download(downloadUrl);

        if (!downloadResult || !downloadResult.success || !downloadResult.filePath) {
           const errorTitle = downloadResult?.title || nextTrack.title;
           const errorMsg = downloadResult?.error || '알 수 없는 이유로 파일을 다운로드할 수 없습니다.';
           logger.music.error(`파일 다운로드 실패 (${errorTitle}): ${errorMsg}`);
           throw new Error(`'${errorTitle}' 재생 실패: ${errorMsg}`);
        }
        filePath = downloadResult.filePath;
        logger.music.success(`다운로드 완료: ${filePath}`);
        
        // 다운로드 성공 시 트랙 정보 업데이트 (만약 누락되었다면)
        if (!nextTrack.videoId && downloadResult.videoId) {
             nextTrack.videoId = downloadResult.videoId;
             logger.music.info(`다운로드 결과에서 videoId 업데이트: ${nextTrack.videoId}`);
        }
        // serviceType은 downloadResult에 없으므로 여기서 업데이트 불가
      }

      // 3. 오디오 리소스 생성 및 재생 (파일 경로 확보 후)
      if (!filePath) { // filePath가 여전히 null이면 치명적 오류
         throw new Error('최종적으로 유효한 파일 경로를 얻지 못했습니다.');
      }

      this.currentFilePath = filePath; // 현재 파일 경로 저장 (정리용)
      
      logger.music.debug(`오디오 리소스 생성 시도: ${filePath}`);
      resource = createAudioResource(filePath); 

      logger.music.debug(`오디오 플레이어에 리소스 재생 요청`);
      this.player.play(resource); 
      
      await entersState(this.player, AudioPlayerStatus.Playing, 5_000);
      logger.music.success(`오디오 플레이어 상태 'Playing' 전환 확인`);

      this.sendNowPlayingEmbed(); 

    } catch (error: any) {
      logger.music.error(`재생 오류 발생 (${nextTrack.title}):`, error);
      this.sendMessage(`❌ 다음 곡 재생 중 오류 발생: ${error.message}`);
      
      if (filePath) { 
        this.currentFilePath = filePath; 
        this.cleanupCurrentFile(); 
      }
      this.currentTrack = null; 
      
      logger.music.info('오류 발생으로 1초 후 다음 곡 재생 시도');
      setTimeout(() => this.playNext(), 1000); 
    }
  }
  
  /**
   * 현재 재생 중인 트랙 정보를 임베드로 표시하고 이전 메시지를 삭제
   */
  private sendNowPlayingEmbed(deleteLastMessage: boolean = false): void {
    if (!this.currentTrack) return;
    
    const embed = this.createEmbed(
      '현재 재생 중',
      `🎵 **${this.currentTrack.title}**`,
      0x2ECC71
    );
    
    embed.fields = [
      { name: '요청자', value: `<@${this.currentTrack.requestedById}>`, inline: true }
    ];
    
    if (this.loopMode) {
      embed.fields.push({ name: '반복 재생', value: '활성화됨 🔁', inline: true });
    }
    
    if (this.queue.length > 0) {
      embed.fields.push({ name: '대기열', value: `${this.queue.length}개의 트랙 대기 중`, inline: true });
    }
    
    this.sendMessage('', embed, deleteLastMessage);
  }
  
  /**
   * Get the current queue
   */
  public getQueue(): QueueItem[] {
    return [...this.queue];
  }
  
  /**
   * Get the currently playing track
   */
  public getCurrentTrack(): QueueItem | null {
    return this.currentTrack;
  }
  
  /**
   * Toggle loop mode
   */
  public toggleLoop(guildId: string, userId?: string): boolean {
    this.loopMode = !this.loopMode;
    logger.music.info(`반복 재생 모드 ${this.loopMode ? '활성화' : '비활성화'} (현재 트랙: ${this.currentTrack?.title || 'None'})`);
    
    // 맨션 텍스트 생성
    const mention = userId ? `<@${userId}> ` : '';
    
    // 반복 모드 전환 임베드
    const embed = this.createEmbed(
      '반복 모드',
      `${mention}${this.loopMode ? 
        '🔁 반복 모드가 **활성화**되었습니다. 현재 트랙이 끝나면 대기열 앞에 다시 추가됩니다.' : 
        '⏹️ 반복 모드가 **비활성화**되었습니다.'}`,
      this.loopMode ? 0x9B59B6 : 0x3498DB // 보라색 or 파란색
    );
    
    // 텍스트 채널에 일반 메시지로 전송
    this.sendMessage('', embed);
    
    return this.loopMode;
  }
  
  /**
   * Clear the queue
   */
  public clearQueue(): void {
    logger.music.info('대기열 비우기');
    
    const queueSize = this.queue.length;
    this.queue = [];
    
    // 대기열 비우기 임베드
    const embed = this.createEmbed(
      '대기열 비움',
      queueSize > 0 ?
        `${queueSize}개의 트랙이 대기열에서 제거되었습니다.` :
        '대기열이 이미 비어 있습니다.',
      0x3498DB // 파란색
    );
    this.sendMessage('', embed);
  }
  
  /**
   * Get the queue and return it as an embed message
   */
  public getQueueEmbed(): any {
    if (this.queue.length === 0 && !this.currentTrack) {
      // 대기열이 비어있고 현재 재생 중인 트랙이 없을 때
      return this.createEmbed(
        '대기열',
        '대기열이 비어 있습니다. `/play`로 음악을 추가해 보세요!',
        0xE67E22 // 주황색
      );
    }
    
    // 현재 재생 중인 트랙 정보
    const fields = [];
    
    if (this.currentTrack) {
      fields.push({
        name: '🎵 현재 재생 중',
        value: `**${this.currentTrack.title}** (요청자: <@${this.currentTrack.requestedById}>)`
      });
    }
    
    // 대기열 정보 (최대 10개만 표시)
    if (this.queue.length > 0) {
      const queueList = this.queue.slice(0, 10).map((track, index) => 
        `${index + 1}. **${track.title}** (요청자: <@${track.requestedById}>)`
      ).join('\n');
      
      fields.push({
        name: '📋 대기열',
        value: queueList
      });
      
      // 더 많은 트랙이 있는 경우
      if (this.queue.length > 10) {
        fields.push({
          name: '🔄 더 많은 트랙',
          value: `...그리고 ${this.queue.length - 10}개의 트랙이 더 있습니다.`
        });
      }
    }
    
    return this.createEmbed(
      '음악 대기열',
      `총 ${this.queue.length}개의 트랙이 대기 중입니다.`,
      0x3498DB, // 파란색
      fields
    );
  }
  
  /**
   * Clean up resources
   */
  public async destroy(): Promise<void> {
    logger.music.info('리소스 정리 중...');
    this.cleanupCurrentFile();
    this.disconnect();
    await this.ytdlpService.close();
    logger.music.info('리소스 정리 완료');
  }

  /**
   * Get the last sent message
   */
  public getLastSentMessage(): Message | null {
    return this.lastSentMessage;
  }

  /**
   * Set whether to delete the last message when sending a new one
   * @param deleteLastMessage Whether to delete the last message when sending a new one
   */
  public setDeleteLastMessage(deleteLastMessage: boolean): void {
    // 메시지 삭제 기능을 항상 비활성화 (에러 발생 방지)
    this.deleteLastMessage = false;
  }
} 