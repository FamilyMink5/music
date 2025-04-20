import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';

/**
 * Ensure that all required directories exist
 */
export function ensureDirectories(): void {
  // Ensure cache directory exists
  if (!fs.existsSync(config.localCacheDir)) {
    logger.system.info(`📁 캐시 디렉토리 생성: ${config.localCacheDir}`);
    fs.mkdirSync(config.localCacheDir, { recursive: true });
  }
}

// Run this if called directly
if (require.main === module) {
  ensureDirectories();
  logger.system.success('✅ 모든 디렉토리가 준비되었습니다.');
} 