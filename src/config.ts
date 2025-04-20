import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

// 프로젝트 루트 디렉토리 경로
const rootDir = process.cwd();

export const config = {
  // Discord configuration
  token: process.env.DISCORD_BOT_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  prefix: process.env.BOT_PREFIX || '!',
  
  // Database configuration
  database: {
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    database: process.env.DATABASE_NAME || 'musicbot',
  },
  
  // SSH Configuration
  ssh: {
    host: process.env.SSH_HOST || '',
    port: parseInt(process.env.SSH_PORT || '22'),
    username: process.env.SSH_USERNAME || '',
    privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || '',
    ytdlpPath: process.env.SSH_YTDLP_PATH || '',
  },
  
  // WebDAV NAS Configuration
  nas: {
    cachePath: process.env.NAS_CACHE_PATH || '/cache/',
    webdav: {
      url: process.env.NAS_WEBDAV_URL || '',
      username: process.env.NAS_WEBDAV_USERNAME || '',
      password: process.env.NAS_WEBDAV_PASSWORD || '',
    },
  },
  
  // Spotify API Configuration
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  },
  
  // Apple Music API Configuration
  appleMusic: {
    developerToken: process.env.APPLE_MUSIC_DEVELOPER_TOKEN || '',
    storefront: process.env.APPLE_MUSIC_STOREFRONT || 'us',
  },
  
  // Local paths
  localCacheDir: path.join(__dirname, '..', 'cache'),
  localYtdlpPath: process.env.LOCAL_YTDLP_PATH || path.join(__dirname, '..', 'yt-dlp.exe'),
  
  // Music settings
  music: {
    maxDurationSeconds: parseInt(process.env.MAX_SONG_DURATION_SECONDS || '900'),
  },
  
  // Logging settings
  logging: {
    level: process.env.LOG_LEVEL || 'INFO',
    file: process.env.LOG_FILE || path.join(rootDir, 'logs', 'bot.log')
  },
  
  // freyr 설정 추가
  freyr: {
    path: process.env.FREYR_PATH || path.join(rootDir, 'freyr-js', 'cli.js'),
    enable: (process.env.FREYR_ENABLE?.toLowerCase() === 'true') || true,
  },
  
  // 캐시 설정
  cache: {
    directory: process.env.CACHE_DIR || path.join(rootDir, 'cache'),
    maxSize: Number(process.env.CACHE_MAX_SIZE) || 10 * 1024 * 1024 * 1024, // 기본 10GB
    keepFiles: (process.env.CACHE_KEEP_FILES === 'true') || false
  },
};

// Validate required configuration
export function validateConfig(): boolean {
  const requiredFields = [
    config.token,
    config.clientId,
    config.database.password,
    config.ssh.host,
    config.ssh.username,
    config.ssh.privateKeyPath,
    config.ssh.ytdlpPath,
    config.nas.webdav.url,
    config.nas.webdav.username,
    config.nas.webdav.password,
    config.spotify.clientId,
    config.spotify.clientSecret,
  ];
  
  return requiredFields.every(field => field !== '');
}

// 로그 디렉토리가 없는 경우 생성
const logDir = path.dirname(config.logging.file);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
} 