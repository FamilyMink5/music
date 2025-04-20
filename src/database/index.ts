import { Pool, QueryResult } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

class Database {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      user: config.database.user,
      password: config.database.password,
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
    });
  }

  /**
   * Execute a query on the database
   */
  async query(text: string, params: any[] = []): Promise<QueryResult> {
    return this.pool.query(text, params);
  }

  /**
   * Initialize the database schema and tables
   */
  async initialize(): Promise<void> {
    // Create playlists table
    await this.query(`
      CREATE TABLE IF NOT EXISTS playlists (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, name)
      )
    `);

    // Create playlist_tracks table
    await this.query(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        id SERIAL PRIMARY KEY,
        playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        url VARCHAR(512) NOT NULL,
        duration INTEGER,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        position INTEGER NOT NULL,
        UNIQUE (playlist_id, url)
      )
    `);

    // Create play_history table
    await this.query(`
      CREATE TABLE IF NOT EXISTS play_history (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        url VARCHAR(512) NOT NULL,
        played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create music_cache table for improved caching system
    await this.query(`
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
    
    // Create index on most frequently queried fields
    await this.query(`
      CREATE INDEX IF NOT EXISTS idx_music_cache_video_id ON music_cache(video_id);
      CREATE INDEX IF NOT EXISTS idx_music_cache_last_accessed ON music_cache(last_accessed);
      CREATE INDEX IF NOT EXISTS idx_music_cache_access_count ON music_cache(access_count DESC);
    `);

    // 플레이리스트 개수 제한 함수 생성 (사용자당 10개)
    await this.query(`
      CREATE OR REPLACE FUNCTION check_playlist_limit()
      RETURNS TRIGGER AS $$
      DECLARE
        playlist_count INTEGER;
      BEGIN
        SELECT COUNT(*) INTO playlist_count 
        FROM playlists 
        WHERE user_id = NEW.user_id;
        
        IF playlist_count >= 10 THEN
          RAISE EXCEPTION '사용자당 최대 10개의 플레이리스트까지 생성 가능합니다';
        END IF;
        
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 플레이리스트 트랙 개수 제한 함수 생성 (플레이리스트당 1000개)
    await this.query(`
      CREATE OR REPLACE FUNCTION check_track_limit()
      RETURNS TRIGGER AS $$
      DECLARE
        track_count INTEGER;
      BEGIN
        SELECT COUNT(*) INTO track_count 
        FROM playlist_tracks 
        WHERE playlist_id = NEW.playlist_id;
        
        IF track_count >= 1000 THEN
          RAISE EXCEPTION '플레이리스트당 최대 1000개의 트랙까지 추가 가능합니다';
        END IF;
        
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 트리거 생성 (트리거가 존재하는지 확인 후 삭제 후 재생성)
    await this.query(`
      DROP TRIGGER IF EXISTS check_playlist_limit_trigger ON playlists;
      CREATE TRIGGER check_playlist_limit_trigger
      BEFORE INSERT ON playlists
      FOR EACH ROW
      EXECUTE FUNCTION check_playlist_limit();
    `);

    await this.query(`
      DROP TRIGGER IF EXISTS check_track_limit_trigger ON playlist_tracks;
      CREATE TRIGGER check_track_limit_trigger
      BEFORE INSERT ON playlist_tracks
      FOR EACH ROW
      EXECUTE FUNCTION check_track_limit();
    `);

    logger.database.info('Database tables initialized');
  }

  /**
   * Close the database connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Export a singleton instance
export const db = new Database(); 