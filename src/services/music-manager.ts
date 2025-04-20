import { Guild, TextChannel, VoiceChannel, GuildMember } from 'discord.js';
import { MusicPlayer, QueueItem } from './music-player';
import { logger } from '../utils/logger';

export class MusicManager {
  private static instance: MusicManager;
  private players: Map<string, MusicPlayer> = new Map();
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): MusicManager {
    if (!MusicManager.instance) {
      MusicManager.instance = new MusicManager();
    }
    return MusicManager.instance;
  }
  
  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {}
  
  /**
   * Get or create a music player for a guild
   */
  private getPlayer(guildId: string): MusicPlayer {
    let player = this.players.get(guildId);
    
    if (!player) {
      player = new MusicPlayer();
      this.players.set(guildId, player);
    }
    
    return player;
  }
  
  /**
   * Join a voice channel
   */
  public joinVoiceChannel(
    voiceChannel: VoiceChannel,
    textChannel: TextChannel
  ): boolean {
    try {
      const player = this.getPlayer(voiceChannel.guild.id);
      return player.connect(voiceChannel, textChannel);
    } catch (error) {
      logger.music.error('Failed to join voice channel:', error);
      return false;
    }
  }
  
  /**
   * Leave a voice channel
   */
  public leaveVoiceChannel(guildId: string): void {
    const player = this.players.get(guildId);
    
    if (player) {
      player.disconnect();
      this.players.delete(guildId);
    }
  }
  
  /**
   * Play a track in a guild
   */
  public async play(
    guildId: string,
    url: string,
    member: GuildMember
  ): Promise<boolean> {
    const player = this.getPlayer(guildId);
    return player.addToQueue(url, member);
  }
  
  /**
   * Skip the current track in a guild
   */
  public skip(guildId: string): boolean {
    const player = this.players.get(guildId);
    
    if (!player) {
      return false;
    }
    
    return player.skip();
  }
  
  /**
   * Toggle loop mode for a guild
   */
  public toggleLoop(guildId: string): boolean {
    const player = this.players.get(guildId);
    
    if (!player) {
      return false;
    }
    
    return player.toggleLoop(guildId);
  }
  
  /**
   * Clear the queue for a guild
   */
  public clearQueue(guildId: string): void {
    const player = this.players.get(guildId);
    
    if (player) {
      player.clearQueue();
    }
  }
  
  /**
   * Get the queue for a guild
   */
  public getQueue(guildId: string): QueueItem[] {
    const player = this.players.get(guildId);
    
    if (!player) {
      return [];
    }
    
    return player.getQueue();
  }
  
  /**
   * Get the queue embed for a guild
   */
  public getQueueEmbed(guildId: string): any {
    const player = this.players.get(guildId);
    
    if (!player) {
      // 기본 빈 대기열 임베드 반환
      return {
        title: '대기열',
        description: '현재 음악 플레이어가 활성화되어 있지 않습니다.',
        color: 0xE67E22,
        timestamp: new Date().toISOString(),
        footer: {
          text: '음악은 나의 삶 🎵'
        }
      };
    }
    
    return player.getQueueEmbed();
  }
  
  /**
   * Get the currently playing track for a guild
   */
  public getCurrentTrack(guildId: string): QueueItem | null {
    const player = this.players.get(guildId);
    
    if (!player) {
      return null;
    }
    
    return player.getCurrentTrack();
  }
  
  /**
   * Clean up all players
   */
  public async destroy(): Promise<void> {
    for (const player of this.players.values()) {
      await player.destroy();
    }
    
    this.players.clear();
  }
} 