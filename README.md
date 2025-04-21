# Discord 음악 봇 (AMB)

TypeScript로 작성된 디스코드 음악 봇입니다. 여러가지 기능을 제공합니다.

## 주요 기능

- 2개의 yt-dlp 다운로드 방식 (로컬, SSH 서버)
- 유저별 플레이리스트 관리 (PostgreSQL 저장)
- 캐시 시스템 (WebDAV NAS에 저장) (아직 오류가 있어요)
- 다양한 스트리밍 서비스 지원 (YouTube, Spotify, Apple Music, Melon)
- 기본적인 음악 재생 기능들 (재생, 건너뛰기, 대기열 등)

## 설치 방법

1. 저장소 클론
```
git clone https://github.com/yourusername/amb.git
cd amb
```

2. 의존성 설치
```
npm install
```

3. `.env` 파일 설정
```
# Discord Bot Token
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id

# PostgreSQL Database
DATABASE_USER=your_db_user
DATABASE_PASSWORD=your_db_password
DATABASE_HOST=your_db_host
DATABASE_PORT=your_db_port
DATABASE_NAME=your_db_name

# SSH
SSH_HOST=your_ssh_host
SSH_PORT=22
SSH_USERNAME=your_ssh_username
SSH_PRIVATE_KEY_PATH=path_to_private_key
SSH_YTDLP_PATH=path_to_yt-dlp_on_ssh_server

# WebDAV NAS
NAS_CACHE_PATH=/path/to/cache/
NAS_WEBDAV_URL=your_webdav_url
NAS_WEBDAV_USERNAME=your_webdav_username
NAS_WEBDAV_PASSWORD=your_webdav_password

# Spotify API
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
```

4. 슬래시 명령어 등록
```
npm run deploy
```

5. 봇 실행
```
npm run build
npm start
```

## 명령어 목록

### 음악 재생
- `/play [url]` - YouTube, Spotify, Apple Music, Melon URL의 음악을 재생합니다
- `/skip` - 현재 재생 중인 곡을 건너뜁니다
- `/queue` - 현재 재생 대기열을 표시합니다
- `/leave` - 봇을 음성 채널에서 내보냅니다

### 플레이리스트 (미완성)
- `/playlist create [name]` - 새 플레이리스트를 생성합니다
- `/playlist list` - 내 플레이리스트 목록을 표시합니다
- `/playlist view [id]` - 플레이리스트의 곡 목록을 표시합니다
- `/playlist add [id]` - 현재 재생 중인 곡을 플레이리스트에 추가합니다
- `/playlist remove [playlist_id] [position]` - 플레이리스트에서 곡을 제거합니다
- `/playlist play [id]` - 플레이리스트의 곡들을 재생합니다
- `/playlist delete [id]` - 플레이리스트를 삭제합니다

## 스트리밍 서비스 지원

봇은 다음 스트리밍 서비스의 URL을 지원합니다:

### YouTube / YouTube Music
- 일반적인 YouTube 동영상 및 YouTube Music 링크를 지원합니다.
- 예시: `/play https://www.youtube.com/watch?v=dQw4w9WgXcQ`
- 예시: `/play https://music.youtube.com/watch?v=xxxxxxxxxxx`

### Spotify
- Spotify 트랙, 앨범, 플레이리스트 링크를 지원합니다.
- `.env` 파일에 Spotify API 키 설정이 필요합니다.
- 예시: `/play https://open.spotify.com/track/xxxxxxxxxxxxxxx`

### Apple Music
봇은 Apple Music URL을 자동으로 처리합니다. 다음과 같은 링크 형식을 지원합니다:

- 트랙: `https://music.apple.com/{국가}/song/{id}`
- 앨범: `https://music.apple.com/{국가}/album/{id}`
- 플레이리스트: `https://music.apple.com/{국가}/playlist/{id}`

예시: `/play https://music.apple.com/us/album/bohemian-rhapsody/1440806041?i=1440806768`

### Melon
- Melon 트랙, 앨범, 플레이리스트 링크를 지원합니다.
- 예시: `/play https://www.melon.com/song/detail.htm?songId=xxxxxxx`

## 개발 환경에서 실행

개발 모드로 실행하려면:
```
npm run dev
```

## 주의사항

- 이 봇은 Discord.js v14와 Node.js 16 이상을 필요로 합니다.
- yt-dlp가 dotenv의 경로에 있거나,프로젝트 디렉토리에 있어야 합니다.
- PostgreSQL 데이터베이스가 필요합니다.
- WebDAV가 지원되는 NAS 또는 저장소가 필요합니다.

## 라이선스

MIT License 
