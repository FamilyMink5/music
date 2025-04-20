import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, EmbedBuilder, MessageFlags } from 'discord.js';
import { Command } from '../utils/command';
import { MusicManager } from '../services/music-manager';
import { logger } from '../utils/logger';

// Get the music manager singleton instance
const musicManager = MusicManager.getInstance();

export = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('현재 재생 중인 곡을 건너뜁니다'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    try {
      // 즉시 응답하여 Unknown Interaction 오류 방지
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const member = interaction.member as GuildMember;
      
      // Check if the member is in a voice channel
      if (!member.voice.channel) {
        const errorEmbed = new EmbedBuilder()
          .setTitle('음성 채널 필요')
          .setDescription('❌ 음성 채널에 먼저 참여해주세요!')
          .setColor(0xE74C3C) // 빨간색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [errorEmbed] });
        return;
      }
      
      // Skip 명령 실행
      const skipped = musicManager.skip(interaction.guildId!);
      
      if (!skipped) {
        const errorEmbed = new EmbedBuilder()
          .setTitle('건너뛰기 실패')
          .setDescription('❌ 현재 재생 중인 곡이 없습니다.')
          .setColor(0xE74C3C) // 빨간색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        // 오류 응답
        await interaction.editReply({ embeds: [errorEmbed] });
        return;
      }
      
      // 현재 재생 중인 트랙 정보 가져오기
      const currentTrack = musicManager.getCurrentTrack(interaction.guildId!);
      const trackTitle = currentTrack ? currentTrack.title : '현재 트랙';
      
      const successEmbed = new EmbedBuilder()
        .setTitle('곡 건너뛰기')
        .setDescription(`⏭️ **${trackTitle}**을(를) 건너뛰었습니다.`)
        .setColor(0x3498DB) // 파란색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      // 성공 응답
      await interaction.editReply({ embeds: [successEmbed] });
    
    } catch (error) {
      logger.command.error('스킵 명령 처리 중 오류:', error);
      
      // 오류 발생 시 응답 시도
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ 
            content: '명령어 처리 중 오류가 발생했습니다.', 
            ephemeral: true 
          });
        } else if (interaction.deferred) {
          await interaction.editReply('명령어 처리 중 오류가 발생했습니다.');
        }
      } catch (replyError) {
        logger.command.error('오류 응답 실패:', replyError);
      }
    }
  }
} as Command; 