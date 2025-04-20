import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, EmbedBuilder, MessageFlags } from 'discord.js';
import { Command } from '../utils/command';
import { MusicManager } from '../services/music-manager';

// Get the music manager singleton instance
const musicManager = MusicManager.getInstance();

export = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('재생 대기열을 비웁니다'),
  
  async execute(interaction: ChatInputCommandInteraction) {
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
    
    // Clear the queue
    musicManager.clearQueue(interaction.guildId!);
    
    const successEmbed = new EmbedBuilder()
      .setTitle('대기열 비움')
      .setDescription('🧹 대기열이 비워졌습니다.')
      .setColor(0x3498DB) // 파란색
      .setTimestamp()
      .setFooter({ text: '음악은 나의 삶 🎵' });
    
    await interaction.editReply({ embeds: [successEmbed] });
  }
} as Command; 