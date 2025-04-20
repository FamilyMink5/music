import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { Command } from '../utils/command';
import fs from 'fs';
import path from 'path';

export = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('명령어 도움말을 표시합니다'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const helpEmbed = new EmbedBuilder()
      .setTitle('🎵 디스코드 음악 봇 도움말')
      .setColor(0x3498DB)
      .setDescription('이 봇은 다양한 음악 서비스를 통해 음악을 재생할 수 있습니다.')
      .addFields(
        { name: '📋 음악 재생', value: 
          '`/play [url]` - YouTube, Spotify, Apple Music, 멜론 URL의 음악을 재생합니다\n' +
          '`/skip` - 현재 재생 중인 곡을 건너뜁니다\n' +
          '`/queue` - 현재 재생 대기열을 표시합니다\n' +
          '`/leave` - 봇을 음성 채널에서 내보냅니다'
        },
        { name: '🎵 플레이리스트', value: 
          '`/playlist create [name]` - 새 플레이리스트를 생성합니다\n' +
          '`/playlist list` - 내 플레이리스트 목록을 표시합니다\n' +
          '`/playlist view [id]` - 플레이리스트의 곡 목록을 표시합니다\n' +
          '`/playlist add [id]` - 현재 재생 중인 곡을 플레이리스트에 추가합니다\n' +
          '`/playlist remove [playlist_id] [position]` - 플레이리스트에서 곡을 제거합니다\n' +
          '`/playlist play [id]` - 플레이리스트의 곡들을 재생합니다\n' +
          '`/playlist delete [id]` - 플레이리스트를 삭제합니다'
        },
        { name: '🎵 멜론 URL 형식', value:
          '`melon:chart` - 멜론 실시간 차트 재생\n' +
          '`melon:track:12345678` - 멜론 곡 재생 (곡 ID 사용)\n' +
          '`melon:album:12345678` - 멜론 앨범 재생 (앨범 ID 사용)\n' +
          '`melon:playlist:12345678` - 멜론 플레이리스트 재생 (플레이리스트 ID 사용)\n' +
          '멜론 웹사이트 URL도 직접 사용 가능합니다'
        },
        { name: '⚙️ 유틸리티', value:
          '`/ping` - 봇 서버 상태, API 지연 시간 및 시스템 자원 사용량을 표시합니다\n' +
          '`/help` - 이 도움말을 표시합니다'
        }
      )
      .setTimestamp()
      .setFooter({ text: '음악은 나의 삶 🎵' });
    
    await interaction.editReply({ embeds: [helpEmbed] });
  }
} as Command; 