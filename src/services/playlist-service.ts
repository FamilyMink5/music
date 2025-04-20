import { db } from '../database';
import { logger } from '../utils/logger';

export interface Track {
  title: string;
  url: string;
  duration?: number;
  position: number;
}

export interface Playlist {
  id: number;
  userId: string;
  name: string;
  createdAt: Date;
  tracks?: Track[];
}

export interface PlaylistTrack {
  id: string;
  url: string;
  title: string;
  position: number;
  duration?: number;
  addedAt: Date;
  playlistId: string;
}

// Using type instead of extends to avoid compatibility issues
export type PlaylistWithTracks = Omit<Playlist, 'tracks'> & {
  tracks: PlaylistTrack[];
}

export class PlaylistService {
  /**
   * Create a new playlist for a user
   */
  async createPlaylist(userId: string, name: string): Promise<Playlist | null> {
    try {
      const result = await db.query(
        'INSERT INTO playlists (user_id, name) VALUES ($1, $2) RETURNING *',
        [userId, name]
      );
      
      if (result.rows.length > 0) {
        return {
          id: result.rows[0].id,
          userId: result.rows[0].user_id,
          name: result.rows[0].name,
          createdAt: result.rows[0].created_at
        };
      }
      return null;
    } catch (error) {
      logger.database.error('Failed to create playlist:', error);
      return null;
    }
  }

  /**
   * Get all playlists for a user
   */
  async getUserPlaylists(userId: string): Promise<Playlist[]> {
    try {
      const result = await db.query(
        'SELECT * FROM playlists WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );
      
      return result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        createdAt: row.created_at
      }));
    } catch (error) {
      logger.database.error('Failed to get user playlists:', error);
      return [];
    }
  }

  /**
   * Get a playlist by ID with its tracks
   */
  async getPlaylistWithTracks(playlistId: number): Promise<Playlist | null> {
    try {
      // First get the playlist
      const playlistResult = await db.query(
        'SELECT * FROM playlists WHERE id = $1',
        [playlistId]
      );
      
      if (playlistResult.rows.length === 0) {
        return null;
      }
      
      const playlist: Playlist = {
        id: playlistResult.rows[0].id,
        userId: playlistResult.rows[0].user_id,
        name: playlistResult.rows[0].name,
        createdAt: playlistResult.rows[0].created_at,
        tracks: []
      };
      
      // Then get the tracks
      const tracksResult = await db.query(
        'SELECT * FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position',
        [playlistId]
      );
      
      playlist.tracks = tracksResult.rows.map(row => ({
        title: row.title,
        url: row.url,
        duration: row.duration,
        position: row.position
      }));
      
      return playlist;
    } catch (error) {
      logger.database.error('Failed to get playlist with tracks:', error);
      return null;
    }
  }

  /**
   * Add a track to a playlist
   */
  async addTrackToPlaylist(playlistId: number, track: Track): Promise<boolean> {
    try {
      // Get the current count of tracks in the playlist
      const countResult = await db.query(
        'SELECT COUNT(*) as count FROM playlist_tracks WHERE playlist_id = $1',
        [playlistId]
      );
      
      const count = parseInt(countResult.rows[0].count);
      if (count >= 1000) {
        return false; // Playlist is full
      }
      
      // Calculate the position (at the end)
      const position = track.position || count + 1;
      
      // Add the track
      await db.query(
        'INSERT INTO playlist_tracks (playlist_id, title, url, duration, position) VALUES ($1, $2, $3, $4, $5)',
        [playlistId, track.title, track.url, track.duration || null, position]
      );
      
      return true;
    } catch (error) {
      logger.database.error('Failed to add track to playlist:', error);
      return false;
    }
  }

  /**
   * Remove a track from a playlist
   */
  async removeTrackFromPlaylist(playlistId: number, position: number): Promise<boolean> {
    try {
      // Remove the track
      const result = await db.query(
        'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND position = $2 RETURNING id',
        [playlistId, position]
      );
      
      if (result.rows.length === 0) {
        return false;
      }
      
      // Reorder the remaining tracks
      await db.query(`
        UPDATE playlist_tracks
        SET position = position - 1
        WHERE playlist_id = $1 AND position > $2
      `, [playlistId, position]);
      
      return true;
    } catch (error) {
      logger.database.error('Failed to remove track from playlist:', error);
      return false;
    }
  }

  /**
   * Delete a playlist
   */
  async deletePlaylist(playlistId: number): Promise<boolean> {
    try {
      const result = await db.query(
        'DELETE FROM playlists WHERE id = $1 RETURNING id',
        [playlistId]
      );
      
      return result.rows.length > 0;
    } catch (error) {
      logger.database.error('Failed to delete playlist:', error);
      return false;
    }
  }
} 