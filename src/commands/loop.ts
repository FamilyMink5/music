import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, EmbedBuilder, MessageFlags } from 'discord.js';
import { Command } from '../utils/command';
import { MusicManager } from '../services/music-manager';

// Get the music manager singleton instance
const musicManager = MusicManager.getInstance();

export = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('현재 곡 반복 재생 모드를 켜거나 끕니다'),
  
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
    
    // Toggle loop mode - MusicPlayer에서 채널에 메시지 전송 
    const loopEnabled = musicManager.toggleLoop(interaction.guildId!);
    
    // 명령어 실행 확인 메시지만 간단히 표시 (ephemeral)
    await interaction.editReply({ 
      content: `✅ 반복 모드가 ${loopEnabled ? '활성화' : '비활성화'}되었습니다.` 
    });
  }
} as Command; 