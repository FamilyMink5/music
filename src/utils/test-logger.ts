import { logger, LogCategory, LogLevel, setLogLevel } from './logger';

// 테스트를 위한 파일입니다.
// 실행: npx ts-node src/utils/test-logger.ts

// 모든 로그 레벨 테스트
console.log('\n=== 로그 레벨 테스트 ===');
setLogLevel(LogLevel.DEBUG); // 모든 로그를 보기 위해 디버그 레벨로 설정

logger.debug(LogCategory.SYSTEM, '디버그 메시지입니다.');
logger.info(LogCategory.SYSTEM, '정보 메시지입니다.');
logger.success(LogCategory.SYSTEM, '성공 메시지입니다.');
logger.warn(LogCategory.SYSTEM, '경고 메시지입니다.');
logger.error(LogCategory.SYSTEM, '에러 메시지입니다.');
logger.fatal(LogCategory.SYSTEM, '치명적 에러 메시지입니다.');

// 모든 카테고리 테스트
console.log('\n=== 카테고리 테스트 ===');
for (const category of Object.values(LogCategory)) {
  if (typeof category === 'string') {
    logger.info(category as LogCategory, `${category} 카테고리 테스트`);
  }
}

// 객체 로깅 테스트
console.log('\n=== 객체 로깅 테스트 ===');
const testObject = {
  name: '테스트 객체',
  properties: {
    value: 42,
    isValid: true,
    items: ['항목1', '항목2']
  }
};
logger.info(LogCategory.SYSTEM, '객체 로깅 테스트:', testObject);

// 에러 로깅 테스트
console.log('\n=== 에러 로깅 테스트 ===');
try {
  throw new Error('테스트 에러가 발생했습니다.');
} catch (error) {
  logger.error(LogCategory.SYSTEM, '에러 발생:', error);
}

// 카테고리별 로거 테스트
console.log('\n=== 카테고리별 로거 테스트 ===');
logger.system.info('시스템 로그입니다.');
logger.discord.info('디스코드 로그입니다.');
logger.music.info('음악 로그입니다.');
logger.cache.info('캐시 로그입니다.');
logger.database.info('데이터베이스 로그입니다.');
logger.download.info('다운로드 로그입니다.');
logger.voice.info('음성 로그입니다.');
logger.command.info('명령어 로그입니다.');
logger.webdav.info('WebDAV 로그입니다.');
logger.network.info('네트워크 로그입니다.');

// 로그 레벨 필터링 테스트
console.log('\n=== 로그 레벨 필터링 테스트 ===');
setLogLevel(LogLevel.WARN); // 경고 이상 레벨만 표시
console.log('로그 레벨을 WARN으로 설정했습니다. 이하 레벨은 표시되지 않습니다:');
logger.debug(LogCategory.SYSTEM, '이 디버그 메시지는 표시되지 않습니다.');
logger.info(LogCategory.SYSTEM, '이 정보 메시지는 표시되지 않습니다.');
logger.warn(LogCategory.SYSTEM, '이 경고 메시지는 표시됩니다.');
logger.error(LogCategory.SYSTEM, '이 에러 메시지는 표시됩니다.');

console.log('\n테스트 완료'); 