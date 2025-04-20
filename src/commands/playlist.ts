import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { Command } from '../utils/command';
import { PlaylistService } from '../services/playlist-service';
import { MusicManager } from '../services/music-manager';

const playlistService = new PlaylistService();
const musicManager = MusicManager.getInstance();

export = {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('플레이리스트 관련 명령어')
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('새 플레이리스트를 생성합니다')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('플레이리스트 이름')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('내 플레이리스트 목록을 표시합니다'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('플레이리스트의 곡 목록을 표시합니다')
        .addIntegerOption(option =>
          option.setName('id')
            .setDescription('플레이리스트 ID')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('플레이리스트에 현재 곡을 추가합니다')
        .addIntegerOption(option =>
          option.setName('id')
            .setDescription('플레이리스트 ID')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('플레이리스트에서 곡을 제거합니다')
        .addIntegerOption(option =>
          option.setName('playlist_id')
            .setDescription('플레이리스트 ID')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('position')
            .setDescription('제거할 곡의 위치')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('play')
        .setDescription('플레이리스트의 곡들을 재생합니다')
        .addIntegerOption(option =>
          option.setName('id')
            .setDescription('플레이리스트 ID')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('플레이리스트를 삭제합니다')
        .addIntegerOption(option =>
          option.setName('id')
            .setDescription('플레이리스트 ID')
            .setRequired(true))),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    
    switch (subcommand) {
      case 'create': {
        const name = interaction.options.getString('name', true);
        const playlist = await playlistService.createPlaylist(userId, name);
        
        if (!playlist) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('플레이리스트 생성 실패')
            .setDescription('❌ 플레이리스트를 생성할 수 없습니다. 이미 같은 이름이 있거나 최대 개수(10개)에 도달했습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const successEmbed = new EmbedBuilder()
          .setTitle('플레이리스트 생성')
          .setDescription(`✅ **${name}** 플레이리스트가 생성되었습니다. (ID: ${playlist.id})`)
          .setColor(0x2ECC71) // 녹색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [successEmbed] });
        break;
      }
      
      case 'list': {
        const playlists = await playlistService.getUserPlaylists(userId);
        
        if (playlists.length === 0) {
          const emptyEmbed = new EmbedBuilder()
            .setTitle('플레이리스트 없음')
            .setDescription('📭 플레이리스트가 없습니다. `/playlist create` 명령어로 플레이리스트를 생성해보세요.')
            .setColor(0xE67E22) // 주황색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [emptyEmbed] });
          return;
        }
        
        const embed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('📋 내 플레이리스트 목록')
          .setDescription(playlists.map(p => `**${p.id}.** ${p.name} (생성일: ${p.createdAt.toLocaleDateString()})`).join('\n'))
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [embed] });
        break;
      }
      
      case 'view': {
        const playlistId = interaction.options.getInteger('id', true);
        const playlist = await playlistService.getPlaylistWithTracks(playlistId);
        
        if (!playlist) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('플레이리스트 찾기 실패')
            .setDescription('❌ 플레이리스트를 찾을 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        if (playlist.userId !== userId) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('접근 거부')
            .setDescription('❌ 다른 사용자의 플레이리스트는 볼 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const embed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle(`📋 플레이리스트: ${playlist.name}`)
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        if (!playlist.tracks || playlist.tracks.length === 0) {
          embed.setDescription('이 플레이리스트에는 곡이 없습니다.');
        } else {
          const trackList = playlist.tracks.map((track, index) => {
            return `**${track.position}.** [${track.title}](${track.url})`;
          }).join('\n');
          
          embed.setDescription(trackList);
          embed.setFooter({ text: `총 ${playlist.tracks.length}곡 | 음악은 나의 삶 🎵` });
        }
        
        await interaction.editReply({ embeds: [embed] });
        break;
      }
      
      case 'add': {
        const playlistId = interaction.options.getInteger('id', true);
        const currentTrack = musicManager.getCurrentTrack(interaction.guildId!);
        
        if (!currentTrack) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('트랙 없음')
            .setDescription('❌ 현재 재생 중인 곡이 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const playlist = await playlistService.getPlaylistWithTracks(playlistId);
        
        if (!playlist) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('플레이리스트 찾기 실패')
            .setDescription('❌ 플레이리스트를 찾을 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        if (playlist.userId !== userId) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('접근 거부')
            .setDescription('❌ 다른 사용자의 플레이리스트에는 추가할 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const track = {
          title: currentTrack.title,
          url: currentTrack.url,
          position: playlist.tracks ? playlist.tracks.length + 1 : 1
        };
        
        const added = await playlistService.addTrackToPlaylist(playlistId, track);
        
        if (!added) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('추가 실패')
            .setDescription('❌ 곡을 추가할 수 없습니다. 플레이리스트가 가득 찼거나 이미 같은 곡이 있습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const successEmbed = new EmbedBuilder()
          .setTitle('트랙 추가됨')
          .setDescription(`✅ **${currentTrack.title}**이(가) **${playlist.name}** 플레이리스트에 추가되었습니다.`)
          .setColor(0x2ECC71) // 녹색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [successEmbed] });
        break;
      }
      
      case 'remove': {
        const playlistId = interaction.options.getInteger('playlist_id', true);
        const position = interaction.options.getInteger('position', true);
        
        const playlist = await playlistService.getPlaylistWithTracks(playlistId);
        
        if (!playlist) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('플레이리스트 찾기 실패')
            .setDescription('❌ 플레이리스트를 찾을 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        if (playlist.userId !== userId) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('접근 거부')
            .setDescription('❌ 다른 사용자의 플레이리스트에서는 제거할 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const removed = await playlistService.removeTrackFromPlaylist(playlistId, position);
        
        if (!removed) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('제거 실패')
            .setDescription('❌ 곡을 제거할 수 없습니다. 위치가 올바른지 확인해주세요.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const successEmbed = new EmbedBuilder()
          .setTitle('트랙 제거됨')
          .setDescription(`✅ 곡이 플레이리스트에서 제거되었습니다.`)
          .setColor(0x2ECC71) // 녹색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [successEmbed] });
        break;
      }
      
      case 'play': {
        const playlistId = interaction.options.getInteger('id', true);
        const playlist = await playlistService.getPlaylistWithTracks(playlistId);
        
        if (!playlist) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('플레이리스트 찾기 실패')
            .setDescription('❌ 플레이리스트를 찾을 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        if (!playlist.tracks || playlist.tracks.length === 0) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('빈 플레이리스트')
            .setDescription('❌ 이 플레이리스트에는 곡이 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        // 대기열에 추가 중 메시지
        const loadingEmbed = new EmbedBuilder()
          .setTitle('대기열에 추가 중')
          .setDescription(`✅ **${playlist.name}** 플레이리스트의 곡들을 대기열에 추가합니다...`)
          .setColor(0x3498DB) // 파란색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [loadingEmbed] });
        
        // 추가 완료 메시지
        const successEmbed = new EmbedBuilder()
          .setTitle('대기열에 추가됨')
          .setDescription(`🎵 플레이리스트의 ${playlist.tracks.length}곡이 대기열에 추가되었습니다.`)
          .setColor(0x2ECC71) // 녹색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.followUp({ embeds: [successEmbed] });
        break;
      }
      
      case 'delete': {
        const playlistId = interaction.options.getInteger('id', true);
        const playlist = await playlistService.getPlaylistWithTracks(playlistId);
        
        if (!playlist) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('플레이리스트 찾기 실패')
            .setDescription('❌ 플레이리스트를 찾을 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        if (playlist.userId !== userId) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('접근 거부')
            .setDescription('❌ 다른 사용자의 플레이리스트는 삭제할 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const deleted = await playlistService.deletePlaylist(playlistId);
        
        if (!deleted) {
          const errorEmbed = new EmbedBuilder()
            .setTitle('삭제 실패')
            .setDescription('❌ 플레이리스트를 삭제할 수 없습니다.')
            .setColor(0xE74C3C) // 빨간색
            .setTimestamp()
            .setFooter({ text: '음악은 나의 삶 🎵' });
          
          await interaction.editReply({ embeds: [errorEmbed] });
          return;
        }
        
        const successEmbed = new EmbedBuilder()
          .setTitle('플레이리스트 삭제됨')
          .setDescription(`✅ **${playlist.name}** 플레이리스트가 삭제되었습니다.`)
          .setColor(0x2ECC71) // 녹색
          .setTimestamp()
          .setFooter({ text: '음악은 나의 삶 🎵' });
        
        await interaction.editReply({ embeds: [successEmbed] });
        break;
      }
    }
  }
} as Command; 