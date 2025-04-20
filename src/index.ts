import { Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config, validateConfig } from './config';
import { db } from './database';
import { Command } from './utils/command';
import { ensureDirectories } from './utils/setup';
import createDatabase from './scripts/setup-db';
import fs from 'fs';
import path from 'path';
import { MusicManager } from './services/music-manager';
import { CacheService } from './services/cache-service';
import { logger, LogCategory, LogLevel, parseLogLevel, setLogLevel } from './utils/logger';
import { YtdlpService } from './services/ytdlp-service';
import { AppleMusicService } from './services/apple-music-service';
import { REST } from 'discord.js';
import { Routes } from 'discord-api-types/v9';

// Initialize logger with configured log level
logger.system.info(`로그 레벨을 '${config.logging.level}'로 설정합니다.`);

// Check configuration
if (!validateConfig()) {
  logger.system.error('❌ 필수 설정이 누락되었습니다. .env 파일을 확인해주세요.');
  process.exit(1);
}

// Ensure required directories exist
ensureDirectories();

// Create cache service singleton
const cacheService = CacheService.getInstance();

// Create the client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// Create a collection to store commands
(client as any).commands = new Collection<string, Command>();

// Load command files
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  
  if ('data' in command && 'execute' in command) {
    (client as any).commands.set(command.data.name, command);
  } else {
    logger.system.warn(`⚠️ ${file}에 필요한 "data" 또는 "execute" 속성이 없습니다`);
  }
}

// Get music manager singleton instance
const musicManager = MusicManager.getInstance();

// Get Apple Music service singleton
const appleMusicService = AppleMusicService.getInstance();

// Set up scheduled cache cleanup (every 12 hours)
const setupCacheCleanup = () => {
  // Initial cleanup
  logger.cache.info('🧹 초기 캐시 정리 수행 중...');
  cacheService.cleanupLocalCache(1);
  
  // Schedule regular cleanups
  setInterval(() => {
    logger.cache.info('🧹 정기 캐시 정리 수행 중...');
    cacheService.cleanupLocalCache(1);
  }, 12 * 60 * 60 * 1000); // 12 hours in milliseconds
};

// Initialize Apple Music authentication
const initializeAppleMusic = async () => {
  logger.system.info('🎵 Apple Music 서비스 초기화 중...');
  
  try {
    // 최초 로그인 시도 (이후 요청부터는 매번 새로 토큰을 생성합니다)
    const loginSuccess = await appleMusicService.login();
    if (loginSuccess) {
      logger.system.success('✅ Apple Music 초기 로그인 성공 (이후 요청마다 새로 토큰이 갱신됨)');
    } else {
      logger.system.warn('⚠️ Apple Music 초기 로그인 실패. 각 요청 시 재시도합니다.');
    }
  } catch (error) {
    logger.system.error('❌ Apple Music 초기화 중 오류 발생:', error);
  }
};

// Event: Client ready
client.once(Events.ClientReady, async client => {
  logger.system.success(`✅ 준비 완료! ${client.user.tag} 계정으로 로그인됨`);
  
  // Ensure database exists
  try {
    await createDatabase();
    
    // Initialize database schema
    await db.initialize();
    logger.database.success('✅ 데이터베이스 초기화 완료');
  } catch (error) {
    logger.database.error('❌ 데이터베이스 초기화 실패:', error);
  }
  
  // Set up cache cleanup scheduler
  setupCacheCleanup();
  
  // Initialize Apple Music authentication
  await initializeAppleMusic();
  
  // 다양한 상태 메시지 설정
  const activities = [
    { name: '/play 명령어로 음악 재생', type: 2 }, // 2는 "Listening to"
    { name: `${client.guilds.cache.size}개의 서버에서 음악 재생중`, type: 0 }, // 0은 "Playing"
    { name: '개발자: @familymink5', type: 0 }, // Playing
    { name: '/help 명령어로 도움말 보기', type: 3 }, // 3은 "Watching"
    { name: '24/7 고품질 음악 스트리밍', type: 2 }, // Listening to
  ];
  
  let currentIndex = 0;
  
  // 초기 상태 설정
  client.user.setActivity(activities[0].name, { type: activities[0].type });
  
  // 정기적으로 상태 메시지 변경 (10초마다)
  setInterval(() => {
    currentIndex = (currentIndex + 1) % activities.length;
    const activity = { ...activities[currentIndex] }; // 객체 복사
    
    // 서버 수 업데이트 (두 번째 활동인 경우)
    if (currentIndex === 1) {
      activity.name = `${client.guilds.cache.size}개의 서버에서 음악 재생중`;
    }
    
    client.user.setActivity(activity.name, { type: activity.type });
    logger.discord.debug(`봇 상태 메시지 변경: ${activity.name}`);
  }, 10 * 1000); // 10초마다 변경
});

// 서버 참가 이벤트
client.on(Events.GuildCreate, guild => {
  const guildCount = client.guilds.cache.size;
  logger.discord.info(`✅ 새 서버에 참가했습니다: ${guild.name} (ID: ${guild.id}). 현재 ${guildCount}개의 서버에서 활동 중.`);
  
  // 현재 상태 메시지가 서버 수 표시 중이면 즉시 업데이트
  const currentActivity = client.user?.presence.activities[0];
  if (currentActivity && currentActivity.name.includes('서버에서 음악 재생중')) {
    client.user?.setActivity(`${guildCount}개의 서버에서 음악 재생중`, { type: 0 });
  }
});

// 서버 퇴장 이벤트
client.on(Events.GuildDelete, guild => {
  const guildCount = client.guilds.cache.size;
  logger.discord.info(`❌ 서버에서 제거되었습니다: ${guild.name} (ID: ${guild.id}). 현재 ${guildCount}개의 서버에서 활동 중.`);
  
  // 현재 상태 메시지가 서버 수 표시 중이면 즉시 업데이트
  const currentActivity = client.user?.presence.activities[0];
  if (currentActivity && currentActivity.name.includes('서버에서 음악 재생중')) {
    client.user?.setActivity(`${guildCount}개의 서버에서 음악 재생중`, { type: 0 });
  }
});

// Event: Interaction create
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  
  const command = (client as any).commands.get(interaction.commandName);
  
  if (!command) {
    logger.command.error(`${interaction.commandName}에 해당하는 명령어를 찾을 수 없습니다.`);
    return;
  }
  
  try {
    // 명령어 실행 시간 기록
    const startTime = Date.now();
    logger.command.info(`${interaction.user.tag}님이 /${interaction.commandName} 명령어 실행 중...`);
    
    await command.execute(interaction);
    
    const executionTime = Date.now() - startTime;
    logger.command.info(`/${interaction.commandName} 명령어 실행 완료 (소요 시간: ${executionTime}ms)`);
  } catch (error) {
    logger.command.error(`명령어 실행 중 오류 (${interaction.commandName}):`, error);
    
    // Discord API 관련 오류 처리 강화
    const discordAPIError = error as any;
    
    // 상호작용 만료 관련 오류
    if (discordAPIError.code === 10062) { // Unknown Interaction
      logger.command.warn(`상호작용 만료됨: ${interaction.commandName}`);
      return; // 응답 시도하지 않음
    }
    
    // 응답 권한 부족 오류
    if (discordAPIError.code === 50013) { // Missing Permissions
      logger.command.warn(`응답 권한 부족: ${interaction.commandName}`);
      return; // 응답 시도하지 않음
    }
    
    try {
      const errorMessage = '명령어 실행 중 오류가 발생했습니다.';
      
      // 응답 상태에 따른 처리
      if (interaction.replied) {
        // 이미 응답한 경우 후속 응답
        await interaction.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(err => {
          logger.command.warn(`후속 응답 실패 (${interaction.commandName}): ${err.message}`);
        });
      } else if (interaction.deferred) {
        // 지연된 응답이 있는 경우
        await interaction.editReply({ content: errorMessage }).catch(err => {
          logger.command.warn(`지연 응답 편집 실패 (${interaction.commandName}): ${err.message}`);
        });
      } else {
        // 아직 응답하지 않은 경우
        await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(err => {
          logger.command.warn(`응답 실패 (${interaction.commandName}): ${err.message}`);
        });
      }
    } catch (responseError) {
      logger.command.error('오류 응답 실패:', responseError);
    }
  }
});

// Event: Message create (prefix commands)
client.on(Events.MessageCreate, async message => {
  // Ignore messages from bots or messages without prefix
  if (message.author.bot || !message.content.startsWith(config.prefix)) return;
  
  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const commandName = args.shift()?.toLowerCase();
  
  if (!commandName) return;
  
  // Handle prefix commands here
  // Example: if (commandName === 'play') { ... }
});

// Event: Voice state update (for auto-disconnect when alone)
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // Skip if bot's voice state changed or if it's not in a voice channel
  if (oldState.member?.user.id === client.user?.id || newState.member?.user.id === client.user?.id) {
    return;
  }

  // Get all voice connections the bot has
  const guilds = client.guilds.cache;
  
  // Check each guild where the bot is connected
  guilds.forEach(guild => {
    const botVoiceState = guild.members.cache.get(client.user!.id)?.voice;
    if (!botVoiceState || !botVoiceState.channelId) return; // Bot is not in a voice channel in this guild
    
    const voiceChannel = guild.channels.cache.get(botVoiceState.channelId);
    if (!voiceChannel || voiceChannel.type !== 2) return; // Not a voice channel (type 2 = voice channel)
    
    // Use proper type assertion
    const voiceMembers = (voiceChannel as any).members;
    if (!voiceMembers) return;
    
    // Now we can safely filter
    const membersInChannel = voiceMembers.filter((member: any) => !member.user.bot);
    
    if (membersInChannel.size === 0) {
      logger.music.info(`음성 채널 ${(voiceChannel as any).name}에 사용자가 없음 감지. 30초 후 자동으로 나갑니다.`);
      
      // Wait 30 seconds before leaving to avoid leaving if someone just briefly drops
      setTimeout(() => {
        // Check again if the channel is still empty
        const currentBotVoiceState = guild.members.cache.get(client.user!.id)?.voice;
        if (!currentBotVoiceState || !currentBotVoiceState.channelId) return; // Bot already left
        
        // Check if it's the same channel
        if (currentBotVoiceState.channelId !== botVoiceState.channelId) return;
        
        const currentVoiceChannel = guild.channels.cache.get(currentBotVoiceState.channelId);
        if (!currentVoiceChannel || currentVoiceChannel.type !== 2) return;
        
        const currentMembers = (currentVoiceChannel as any).members;
        if (!currentMembers) return;
        
        const currentMembersInChannel = currentMembers.filter((member: any) => !member.user.bot);
        
        if (currentMembersInChannel.size === 0) {
          logger.music.info(`음성 채널 ${(currentVoiceChannel as any).name}에 30초 동안 사용자가 없어 자동으로 나갑니다.`);
          const musicManager = MusicManager.getInstance();
          musicManager.leaveVoiceChannel(guild.id);
        }
      }, 30000); // 30 seconds delay
    }
  });
});

// Process cleanup handling
process.on('SIGINT', async () => {
  logger.system.info('👋 봇 종료 중...');
  
  // 정리 작업 수행
  await musicManager.destroy();
  await db.close();
  
  client.destroy();
  process.exit(0);
});

// Login to Discord
client.login(config.token); 