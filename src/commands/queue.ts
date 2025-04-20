import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { Command } from '../utils/command';
import { MusicManager } from '../services/music-manager';

// Get the music manager singleton instance
const musicManager = MusicManager.getInstance();

export = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('현재 재생 대기열을 표시합니다'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    // Get the current track and queue
    const currentTrack = musicManager.getCurrentTrack(interaction.guildId!);
    const queue = musicManager.getQueue(interaction.guildId!);
    
    if (!currentTrack && queue.length === 0) {
      // 임베드 형식으로 변경
      const emptyEmbed = new EmbedBuilder()
        .setColor(0xE67E22) // 주황색
        .setTitle('📭 대기열')
        .setDescription('대기열이 비어 있습니다. `/play`로 음악을 추가해 보세요!')
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [emptyEmbed] });
      return;
    }
    
    // Create an embed
    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('🎵 재생 대기열')
      .setTimestamp();
    
    // Add current track
    if (currentTrack) {
      embed.addFields({
        name: '🔊 현재 재생 중',
        value: `[${currentTrack.title}](${currentTrack.url})\n요청자: ${currentTrack.requestedBy}`
      });
    }
    
    // Add queued tracks
    if (queue.length > 0) {
      const queueList = queue.slice(0, 10).map((track, index) => {
        return `${index + 1}. [${track.title}](${track.url}) - 요청자: ${track.requestedBy}`;
      });
      
      embed.addFields({
        name: '📋 대기 중인 곡',
        value: queueList.join('\n')
      });
      
      // Add remaining count if more than 10 tracks
      if (queue.length > 10) {
        embed.setFooter({ text: `그 외 ${queue.length - 10}곡이 더 있습니다.` });
      }
    }
    
    await interaction.editReply({ embeds: [embed] });
  }
} as Command; 