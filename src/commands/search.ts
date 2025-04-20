import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  GuildMember, 
  EmbedBuilder, 
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  VoiceChannel,
  TextChannel,
  ChannelType
} from 'discord.js';
import { Command } from '../utils/command';
import { MusicManager } from '../services/music-manager';
import { YtdlpService, SearchResult } from '../services/ytdlp-service';
import { logger } from '../utils/logger';

// 서비스 인스턴스 가져오기
const musicManager = MusicManager.getInstance();
const ytdlpService = YtdlpService.getInstance();

export = {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('YouTube에서 음악을 검색하여 선택 후 재생합니다')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('검색어')
        .setRequired(true)),
  
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const query = interaction.options.getString('query', true);
    const member = interaction.member as GuildMember;
    
    // 음성 채널 체크
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
    
    // 음성 채널 타입 체크
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
    
    // 텍스트 채널 체크
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
    
    // 검색 중 임베드
    const searchingEmbed = new EmbedBuilder()
      .setTitle('검색 중')
      .setDescription(`🔎 **"${query}"** 검색 중...`)
      .setColor(0xF1C40F) // 노란색
      .setTimestamp()
      .setFooter({ text: '음악은 나의 삶 🎵' });
    
    await interaction.editReply({ embeds: [searchingEmbed] });
    
    try {
      // YouTube에서 검색 결과 가져오기 (최대 5개)
      const searchResults = await ytdlpService.search(query, 5);
      
      if (!searchResults || searchResults.length === 0) {
        const noResultsEmbed = new EmbedBuilder()
          .setTitle('검색 결과 없음')
          .setDescription(`❌ "${query}"에 대한 검색 결과를 찾을 수 없습니다.`)
          .setColor(0xE74C3C) // 빨간색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [noResultsEmbed] });
        return;
      }
      
      // 결과 임베드 생성
      const resultsEmbed = new EmbedBuilder()
        .setTitle(`🔎 "${query}" 검색 결과`)
        .setColor(0x3498DB) // 파란색
        .setTimestamp()
        .setFooter({ text: '아래 버튼을 눌러 선택하세요 | 음악은 나의 삶 🎵' });
      
      // 검색 결과 필드 추가
      searchResults.forEach((result: SearchResult, index: number) => {
        resultsEmbed.addFields({
          name: `${index + 1}. ${result.title}`,
          value: `**채널**: ${result.uploader || 'Unknown'}\n**길이**: ${result.duration || 'Unknown'}`
        });
      });
      
      // 버튼 배치를 위한 컴포넌트 배열 생성
      const components: ActionRowBuilder<ButtonBuilder>[] = [];
      
      // 한 행당 최대 5개 버튼으로 제한하여 검색 결과 버튼 생성
      const searchButtons: ButtonBuilder[] = searchResults.map((_: SearchResult, index: number) => 
        new ButtonBuilder()
          .setCustomId(`search_${index}`)
          .setLabel(`${index + 1}`)
          .setStyle(ButtonStyle.Primary)
      );
      
      // 5개 이하의 버튼마다 새 행 생성
      for (let i = 0; i < searchButtons.length; i += 5) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          searchButtons.slice(i, Math.min(i + 5, searchButtons.length))
        );
        components.push(row);
      }
      
      // 취소 버튼을 별도의 행에 추가
      const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('search_cancel')
          .setLabel('취소')
          .setStyle(ButtonStyle.Danger)
      );
      components.push(cancelRow);
      
      // 결과와 버튼 전송
      const reply = await interaction.editReply({ 
        embeds: [resultsEmbed], 
        components: components 
      });
      
      // 버튼 컬렉터 설정
      const collector = reply.createMessageComponentCollector({ 
        componentType: ComponentType.Button,
        time: 60000, // 1분 타임아웃
        filter: (i) => i.user.id === interaction.user.id
      });
      
      // 버튼 클릭 이벤트 처리
      collector.on('collect', async (i) => {
        await i.deferUpdate();
        
        if (i.customId === 'search_cancel') {
          const cancelEmbed = new EmbedBuilder()
            .setTitle('검색 취소됨')
            .setDescription('❌ 검색이 취소되었습니다.')
            .setColor(0xE67E22) // 주황색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [cancelEmbed], components: [] });
          collector.stop();
          return;
        }
        
        // 선택한 트랙 인덱스 가져오기
        const selectedIndex = parseInt(i.customId.split('_')[1]);
        
        if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= searchResults.length) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('오류 발생')
            .setDescription('❌ 잘못된 선택입니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed], components: [] });
          collector.stop();
          return;
        }
        
        const selectedTrack = searchResults[selectedIndex];
        
        // 음성 채널에 참가
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
          
          await interaction.editReply({ embeds: [errorEmbed], components: [] });
          collector.stop();
          return;
        }
        
        // 선택 임베드 표시
        const selectedEmbed = new EmbedBuilder()
          .setTitle('트랙 선택됨')
          .setDescription(`✅ **${selectedTrack.title}** 곡이 선택되었습니다.`)
          .setColor(0x2ECC71) // 녹색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [selectedEmbed], components: [] });
        
        // 트랙 재생
        const success = await musicManager.play(
          interaction.guildId!,
          selectedTrack.url,
          member
        );
        
        if (!success) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('재생 실패')
            .setDescription('❌ 선택한 곡을 재생할 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
        }
        
        collector.stop();
      });
      
      // 시간 초과 시 처리
      collector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
          const timeoutEmbed = new EmbedBuilder()
            .setTitle('시간 초과')
            .setDescription('⏱️ 응답 시간이 초과되었습니다.')
            .setColor(0xE67E22) // 주황색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
        }
      });
    } catch (error) {
      logger.command.error('검색 명령어 처리 중 오류:', error);
      
      const errorEmbed = new EmbedBuilder()
        .setTitle('검색 실패')
        .setDescription('❌ 검색 중 오류가 발생했습니다.')
        .setColor(0xE74C3C) // 빨간색
        .setTimestamp()
        .setFooter({ text: '음악은 나의 삶 🎵' });
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  }
} as Command; 