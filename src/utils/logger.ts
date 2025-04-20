// Since we're using chalk v5 which is ESM-only in a CommonJS project, 
// we need to use native terminal colors directly instead
// or use a compatible version of chalk (v4.x)

import { config } from '../config';

/**
 * 로그 레벨
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  SUCCESS = 2,
  WARN = 3,
  ERROR = 4,
  FATAL = 5
}

/**
 * 로그 카테고리
 */
export enum LogCategory {
  SYSTEM = 'SYSTEM',
  BOT = 'BOT',
  DISCORD = 'DISCORD',
  MUSIC = 'MUSIC',
  CACHE = 'CACHE',
  DATABASE = 'DATABASE',
  DOWNLOAD = 'DOWNLOAD',
  VOICE = 'VOICE',
  COMMAND = 'COMMAND',
  WEBDAV = 'WEBDAV',
  NETWORK = 'NETWORK'
}

/**
 * 터미널 색상 코드
 */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',

  // Foreground Colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Background Colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  bgGray: '\x1b[100m',
};

/**
 * 현재 설정된 최소 로그 레벨 (이 레벨 이상만 출력)
 */
let currentLogLevel: LogLevel = LogLevel.INFO;

/**
 * 문자열 로그 레벨을 LogLevel enum으로 변환
 */
export function parseLogLevel(level: string): LogLevel {
  const upperLevel = level.toUpperCase();
  
  switch (upperLevel) {
    case 'DEBUG':
      return LogLevel.DEBUG;
    case 'INFO':
      return LogLevel.INFO;
    case 'SUCCESS':
      return LogLevel.SUCCESS;
    case 'WARN':
      return LogLevel.WARN;
    case 'ERROR':
      return LogLevel.ERROR;
    case 'FATAL':
      return LogLevel.FATAL;
    default:
      console.warn(`알 수 없는 로그 레벨: ${level}, 'INFO'로 기본 설정됩니다.`);
      return LogLevel.INFO;
  }
}

/**
 * 로그 레벨 설정
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
  log(LogLevel.INFO, LogCategory.SYSTEM, `로그 레벨이 [${LogLevel[level]}](으)로 설정되었습니다.`);
}

/**
 * 색상 적용하기
 */
function colorize(text: string, ...colorCodes: string[]): string {
  return `${colorCodes.join('')}${text}${colors.reset}`;
}

/**
 * 타임스탬프 생성
 */
function getTimestamp(): string {
  const now = new Date();
  return colorize(
    `[${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now
      .getDate()
      .toString()
      .padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now
      .getMinutes()
      .toString()
      .padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now
      .getMilliseconds()
      .toString()
      .padStart(3, '0')}]`,
    colors.gray
  );
}

/**
 * 로그 레벨에 따른 스타일
 */
const levelStyles: Record<LogLevel, (text: string) => string> = {
  [LogLevel.DEBUG]: (text) => colorize(text, colors.cyan),
  [LogLevel.INFO]: (text) => colorize(text, colors.blue),
  [LogLevel.SUCCESS]: (text) => colorize(text, colors.green),
  [LogLevel.WARN]: (text) => colorize(text, colors.yellow),
  [LogLevel.ERROR]: (text) => colorize(text, colors.red),
  [LogLevel.FATAL]: (text) => colorize(text, colors.bgRed, colors.white),
};

/**
 * 로그 카테고리에 따른 스타일
 */
const categoryStyles: Record<LogCategory, (text: string) => string> = {
  [LogCategory.SYSTEM]: (text) => colorize(text, colors.bgGray, colors.white),
  [LogCategory.BOT]: (text) => colorize(text, colors.bgBlue, colors.white),
  [LogCategory.DISCORD]: (text) => colorize(text, colors.bgMagenta, colors.white),
  [LogCategory.MUSIC]: (text) => colorize(text, colors.bgGreen, colors.black),
  [LogCategory.CACHE]: (text) => colorize(text, colors.bgCyan, colors.black),
  [LogCategory.DATABASE]: (text) => colorize(text, colors.bgBlue, colors.white),
  [LogCategory.DOWNLOAD]: (text) => colorize(text, colors.bgYellow, colors.black),
  [LogCategory.VOICE]: (text) => colorize(text, colors.bgGreen, colors.white),
  [LogCategory.COMMAND]: (text) => colorize(text, colors.bgCyan, colors.black),
  [LogCategory.WEBDAV]: (text) => colorize(text, colors.bgMagenta, colors.white),
  [LogCategory.NETWORK]: (text) => colorize(text, colors.bgBlue, colors.white),
};

// 설정에서 로그 레벨 초기화
setLogLevel(parseLogLevel(config.logging.level));

/**
 * 로그 출력
 */
export function log(level: LogLevel, category: LogCategory, message: string, ...args: any[]): void {
  // 현재 설정된 로그 레벨보다 낮으면 무시
  if (level < currentLogLevel) {
    return;
  }

  const timestamp = getTimestamp();
  const levelName = levelStyles[level](LogLevel[level].padEnd(7));
  const categoryName = categoryStyles[category](` ${category} `);

  // 에러 객체가 있으면 별도 처리
  const hasError = args.some(arg => arg instanceof Error);

  // 기본 로그 메시지 출력
  console.log(`${timestamp} ${levelName} ${categoryName} ${message}`);

  // 추가 인자 출력
  if (args.length > 0) {
    args.forEach(arg => {
      if (arg instanceof Error) {
        console.log(
          `${timestamp} ${levelName} ${categoryName} ${colorize('ERROR:', colors.red)} ${arg.message}`
        );
        if (arg.stack) {
          console.log(colorize(arg.stack.replace(/^Error: .*\n/, ''), colors.gray));
        }
      } else if (typeof arg === 'object') {
        try {
          console.log(
            `${timestamp} ${levelName} ${categoryName} ${colorize(JSON.stringify(arg, null, 2), colors.gray)}`
          );
        } catch (e) {
          console.log(`${timestamp} ${levelName} ${categoryName} [Object]`);
        }
      } else {
        console.log(`${timestamp} ${levelName} ${categoryName} ${arg}`);
      }
    });
  }
}

/**
 * 편의성 함수들
 */
export const logger = {
  debug: (category: LogCategory, message: string, ...args: any[]) =>
    log(LogLevel.DEBUG, category, message, ...args),
  info: (category: LogCategory, message: string, ...args: any[]) =>
    log(LogLevel.INFO, category, message, ...args),
  success: (category: LogCategory, message: string, ...args: any[]) =>
    log(LogLevel.SUCCESS, category, message, ...args),
  warn: (category: LogCategory, message: string, ...args: any[]) =>
    log(LogLevel.WARN, category, message, ...args),
  error: (category: LogCategory, message: string, ...args: any[]) =>
    log(LogLevel.ERROR, category, message, ...args),
  fatal: (category: LogCategory, message: string, ...args: any[]) =>
    log(LogLevel.FATAL, category, message, ...args),

  // 특정 카테고리에 대한 로거
  system: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.SYSTEM, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.SYSTEM, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.SYSTEM, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.SYSTEM, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.SYSTEM, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.SYSTEM, message, ...args)
  },
  discord: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.DISCORD, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.DISCORD, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.DISCORD, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.DISCORD, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.DISCORD, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.DISCORD, message, ...args)
  },
  music: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.MUSIC, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.MUSIC, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.MUSIC, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.MUSIC, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.MUSIC, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.MUSIC, message, ...args)
  },
  cache: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.CACHE, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.CACHE, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.CACHE, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.CACHE, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.CACHE, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.CACHE, message, ...args)
  },
  database: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.DATABASE, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.DATABASE, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.DATABASE, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.DATABASE, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.DATABASE, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.DATABASE, message, ...args)
  },
  download: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.DOWNLOAD, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.DOWNLOAD, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.DOWNLOAD, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.DOWNLOAD, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.DOWNLOAD, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.DOWNLOAD, message, ...args)
  },
  voice: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.VOICE, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.VOICE, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.VOICE, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.VOICE, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.VOICE, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.VOICE, message, ...args)
  },
  command: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.COMMAND, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.COMMAND, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.COMMAND, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.COMMAND, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.COMMAND, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.COMMAND, message, ...args)
  },
  webdav: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.WEBDAV, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.WEBDAV, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.WEBDAV, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.WEBDAV, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.WEBDAV, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.WEBDAV, message, ...args)
  },
  network: {
    debug: (message: string, ...args: any[]) => log(LogLevel.DEBUG, LogCategory.NETWORK, message, ...args),
    info: (message: string, ...args: any[]) => log(LogLevel.INFO, LogCategory.NETWORK, message, ...args),
    success: (message: string, ...args: any[]) => log(LogLevel.SUCCESS, LogCategory.NETWORK, message, ...args),
    warn: (message: string, ...args: any[]) => log(LogLevel.WARN, LogCategory.NETWORK, message, ...args),
    error: (message: string, ...args: any[]) => log(LogLevel.ERROR, LogCategory.NETWORK, message, ...args),
    fatal: (message: string, ...args: any[]) => log(LogLevel.FATAL, LogCategory.NETWORK, message, ...args)
  }
};

export default logger; 