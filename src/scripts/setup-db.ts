import { Client } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

async function createDatabase() {
  // 먼저 'postgres' 데이터베이스에 연결 (기본 DB)
  const client = new Client({
    user: config.database.user,
    password: config.database.password,
    host: config.database.host,
    port: config.database.port,
    database: 'postgres' // 기본 데이터베이스에 연결
  });

  try {
    await client.connect();
    logger.database.info('PostgreSQL 서버에 연결되었습니다.');

    // 데이터베이스가 존재하는지 확인
    const checkResult = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [config.database.database]
    );

    // 데이터베이스가 존재하지 않으면 생성
    if (checkResult.rowCount === 0) {
      logger.database.info(`데이터베이스 '${config.database.database}'를 생성합니다...`);
      await client.query(`CREATE DATABASE ${config.database.database}`);
      logger.database.success(`데이터베이스 '${config.database.database}'가 성공적으로 생성되었습니다.`);
      
      // 새로 생성된 데이터베이스에 연결하여 필요한 테이블 생성
      await client.end();
      
      // 새 데이터베이스에 연결
      const newDbClient = new Client({
        user: config.database.user,
        password: config.database.password,
        host: config.database.host,
        port: config.database.port,
        database: config.database.database
      });
      
      await newDbClient.connect();
      logger.database.info(`새로 생성된 데이터베이스 '${config.database.database}'에 연결되었습니다.`);
      
      // music_cache 테이블 생성
      await newDbClient.query(`
        CREATE TABLE IF NOT EXISTS music_cache (
          id SERIAL PRIMARY KEY,
          video_id VARCHAR(100) NOT NULL,
          title VARCHAR(255) NOT NULL,
          original_url TEXT NOT NULL,
          service_type VARCHAR(50) NOT NULL,
          file_path_nas TEXT,
          file_size BIGINT,
          duration INTEGER,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          access_count INTEGER DEFAULT 1,
          is_processing BOOLEAN DEFAULT FALSE,
          UNIQUE (video_id, service_type)
        )
      `);
      
      // 인덱스 생성
      await newDbClient.query(`
        CREATE INDEX IF NOT EXISTS idx_music_cache_video_id ON music_cache(video_id);
        CREATE INDEX IF NOT EXISTS idx_music_cache_last_accessed ON music_cache(last_accessed);
        CREATE INDEX IF NOT EXISTS idx_music_cache_access_count ON music_cache(access_count DESC);
      `);
      
      logger.database.success('music_cache 테이블과 인덱스가 생성되었습니다.');
      
      await newDbClient.end();
    } else {
      logger.database.info(`데이터베이스 '${config.database.database}'가 이미 존재합니다.`);
      await client.end();
    }
  } catch (error) {
    logger.database.error('데이터베이스 생성 중 오류가 발생했습니다:', error);
    await client.end();
  }
}

// 직접 실행될 경우에만 함수 호출
if (require.main === module) {
  createDatabase()
    .then(() => logger.database.success('데이터베이스 설정 완료'))
    .catch(err => logger.database.error('데이터베이스 설정 실패:', err))
    .finally(() => process.exit());
}

export default createDatabase; 