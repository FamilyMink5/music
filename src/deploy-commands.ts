import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { logger } from './utils/logger';

const commands: any[] = [];
const commandsPath = path.join(__dirname, 'commands');

// Read all command files
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

// Import each command and add it to the commands array
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
  } else {
    logger.command.warn(`⚠️ ${file} 명령어가 필요한 "data" 또는 "execute" 속성이 없습니다.`);
  }
}

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    logger.system.info('🔄 슬래시 명령어를 등록하는 중...');
    
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commands }
    );
    
    logger.system.success('✅ 슬래시 명령어가 성공적으로 등록되었습니다!');
  } catch (error) {
    logger.system.error('❌ 슬래시 명령어 등록 중 오류가 발생했습니다:', error);
  }
})(); 