import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, VoiceChannel, ChannelType, TextChannel, EmbedBuilder, MessageFlags } from 'discord.js';
import { Command } from '../utils/command';
import { MusicManager } from '../services/music-manager';
import { SpotifyService } from '../services/spotify-service';
import { AppleMusicService } from '../services/apple-music-service';
import { MelonService } from '../services/melon-service';
import { YtdlpService } from '../services/ytdlp-service';
import { logger } from '../utils/logger';

// Get the service singleton instances
const musicManager = MusicManager.getInstance();
const spotifyService = SpotifyService.getInstance();
const appleMusicService = AppleMusicService.getInstance();
const melonService = MelonService.getInstance();
const ytdlpService = YtdlpService.getInstance();

export = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('노래를 재생합니다')
    .addStringOption(option =>
      option.setName('url')
        .setDescription('재생할 YouTube/Spotify/Apple Music/멜론 URL')
        .setRequired(true)),
  
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const input = interaction.options.getString('url', true);
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
    
    // Check if it's a voice channel (not stage channel)
    if (member.voice.channel.type !== ChannelType.GuildVoice) {
      const errorEmbed = new EmbedBuilder()
        .setTitle('음성 채널 필요')
        .setDescription('❌ 음성 채널에 참여해주세요. (스테이지 채널은 지원하지 않습니다)')
        .setColor(0xE74C3C) // 빨간색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [errorEmbed] });
      return;
    }
    
    // Check if the interaction channel is a text channel
    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      const errorEmbed = new EmbedBuilder()
        .setTitle('채널 오류')
        .setDescription('❌ 이 명령어는 서버 텍스트 채널에서만 사용할 수 있습니다.')
        .setColor(0xE74C3C) // 빨간색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [errorEmbed] });
      return;
    }
    
    // Join the voice channel
    const joined = musicManager.joinVoiceChannel(
      member.voice.channel as VoiceChannel,
      interaction.channel as TextChannel
    );
    
    if (!joined) {
      const errorEmbed = new EmbedBuilder()
        .setTitle('연결 실패')
        .setDescription('❌ 음성 채널에 참여할 수 없습니다.')
        .setColor(0xE74C3C) // 빨간색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [errorEmbed] });
      return;
    }
    
    // Check if input is a URL or search query
    let url = input;
    const isUrl = input.startsWith('http://') || input.startsWith('https://') || input.startsWith('melon:');
    
    // Handle non-URL input as a search query
    if (!isUrl) {
      // 검색 중 임베드
      const searchEmbed = new EmbedBuilder()
        .setTitle('검색 중')
        .setDescription(`🔎 **"${input}"** 검색 중...`)
        .setColor(0xF1C40F) // 노란색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [searchEmbed] });
      
      const searchResult = await ytdlpService.findBestMatch(input);
      
      if (!searchResult) {
        // 검색 실패 임베드
        const failEmbed = new EmbedBuilder()
          .setTitle('검색 실패')
          .setDescription(`❌ "${input}"에 대한 검색 결과를 찾을 수 없습니다.`)
          .setColor(0xE74C3C) // 빨간색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [failEmbed] });
        return;
      }
      
      url = searchResult;
    } else if (spotifyService.isSpotifyUrl(input)) {
      // Spotify URL 처리 임베드
      const spotifyEmbed = new EmbedBuilder()
        .setTitle('Spotify 처리 중')
        .setDescription('🎵 Spotify 트랙을 처리하는 중...')
        .setColor(0x1DB954) // Spotify 녹색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [spotifyEmbed] });
    } else if (appleMusicService.isAppleMusicUrl(input)) {
      // Apple Music URL 처리 임베드
      const appleMusicEmbed = new EmbedBuilder()
        .setTitle('Apple Music 처리 중')
        .setDescription('🎵 Apple Music 트랙을 처리하는 중...')
        .setColor(0xFF2F54) // Apple Music 빨간색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [appleMusicEmbed] });
    } else if (melonService.isMelonUrl(input)) {
      // 멜론 URL 처리 임베드
      const melonEmbed = new EmbedBuilder()
        .setTitle('멜론 처리 중')
        .setDescription('🎵 멜론 트랙을 처리하는 중...')
        .setColor(0x00CD3C) // 멜론 녹색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [melonEmbed] });
    } else {
      // YouTube/일반 URL 처리 임베드
      const processingEmbed = new EmbedBuilder()
        .setTitle('처리 중')
        .setDescription('🎵 트랙을 처리하는 중...')
        .setColor(0x3498DB) // 파란색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [processingEmbed] });
    }
    
    // Play the track
    const success = await musicManager.play(
      interaction.guildId!,
      url,
      member
    );
    
    if (!success) {
      // 재생 실패 임베드
      const errorEmbed = new EmbedBuilder()
        .setTitle('재생 실패')
        .setDescription('❌ 노래를 재생할 수 없습니다.')
        .setColor(0xE74C3C) // 빨간색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [errorEmbed] });
      return;
    }
    
    // 대기열 상태 가져오기
    const currentTrack = musicManager.getCurrentTrack(interaction.guildId!);
    const queue = musicManager.getQueue(interaction.guildId!);
    
    // 이미 다른 서비스에서 처리된 메시지가 있으므로 여기서는 업데이트하지 않음
    if (!spotifyService.isSpotifyUrl(input) && !appleMusicService.isAppleMusicUrl(input) && !melonService.isMelonUrl(input)) {
      // 성공 임베드 (대기열에 트랙 추가됨)
      const successEmbed = new EmbedBuilder()
        .setTitle('대기열에 추가됨')
        .setDescription(`🎵 노래를 대기열에 추가했습니다.`)
        .setColor(0x2ECC71) // 녹색
        .addFields(
          { name: '대기열 상태', value: `대기 중인 트랙: ${queue.length}개` }
        )
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      if (currentTrack) {
        successEmbed.addFields(
          { name: '현재 재생 중', value: currentTrack.title }
        );
      } else {
        successEmbed.addFields(
          { name: '상태', value: '재생을 시작합니다...' }
        );
      }
      
      await interaction.editReply({ embeds: [successEmbed] });
    }
  }
} as Command; 