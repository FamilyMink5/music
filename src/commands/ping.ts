import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder, 
  MessageFlags,
  Routes
} from 'discord.js';
import { Command } from '../utils/command';
import os from 'os';

// CPU 사용률 계산 함수
function getCPUUsage(): Promise<number> {
  return new Promise((resolve) => {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    // 첫 번째 측정
    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });
    
    // 잠시 대기
    setTimeout(() => {
      const cpusAfter = os.cpus();
      let totalIdleAfter = 0;
      let totalTickAfter = 0;
      
      // 두 번째 측정
      cpusAfter.forEach((cpu) => {
        for (const type in cpu.times) {
          totalTickAfter += cpu.times[type as keyof typeof cpu.times];
        }
        totalIdleAfter += cpu.times.idle;
      });
      
      // 차이 계산
      const idleDiff = totalIdleAfter - totalIdle;
      const tickDiff = totalTickAfter - totalTick;
      
      // CPU 사용률 = 100 - (유휴 시간 차이 / 전체 시간 차이 * 100)
      const cpuUsage = 100 - (idleDiff / tickDiff * 100);
      resolve(Math.round(cpuUsage * 100) / 100);
    }, 200);
  });
}

// 프로세스 CPU 사용률 계산 함수
function getProcessCPUUsage(): Promise<number> {
  return new Promise((resolve) => {
    // 첫 번째 측정
    const startTime = process.hrtime();
    const startUsage = process.cpuUsage();
    
    // 500ms 동안 기다린 후 두 번째 측정 (더 긴 시간으로 증가)
    setTimeout(() => {
      const elapsedTime = process.hrtime(startTime);
      const elapsedTimeMS = elapsedTime[0] * 1000 + elapsedTime[1] / 1000000;
      const eUsage = process.cpuUsage(startUsage);
      
      // micros to ms
      const uToMS = 1000;
      
      // CPU 시간을 밀리초로 변환하고 경과 시간으로 나누어 비율 계산
      // user CPU time (밀리초) + system CPU time (밀리초)
      const cpuPercent = ((eUsage.user / uToMS) + (eUsage.system / uToMS)) / elapsedTimeMS * 100;
      
      // 0보다 작거나 미미한 값인 경우 최소값 0.01로 설정
      if (cpuPercent <= 0.01) {
        resolve(0.01);
      } else {
        resolve(Math.round(cpuPercent * 100) / 100);
      }
    }, 500); // 측정 시간을 500ms로 증가
  });
}

export = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('봇 서버 상태, API 지연 시간 및 시스템 자원 사용량을 표시합니다'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    // 일단 지연 응답 요청
    await interaction.deferReply();
    
    // 봇 내부 지연 시간 측정 시작
    const startTime = Date.now();
    
    // 디스코드 API 지연 시간 측정
    let apiLatency: number;
    
    try {
      // 웹소켓 핑이 유효하지 않은 경우 REST API 호출로 측정
      if (interaction.client.ws.ping <= 0) {
        const apiStartTime = Date.now();
        // 간단한 API 요청 실행 (현재 서버 정보 요청)
        const guildId = interaction.guild?.id;
        if (guildId) {
          // Guild 정보 요청으로 API 지연 시간 측정
          await interaction.client.rest.get(Routes.guild(guildId));
          apiLatency = Date.now() - apiStartTime;
        } else {
          // 서버가 없는 경우 봇 사용자 정보 요청
          await interaction.client.rest.get(Routes.user(interaction.client.user.id));
          apiLatency = Date.now() - apiStartTime;
        }
      } else {
        // 웹소켓 핑이 유효한 경우 그대로 사용
        apiLatency = interaction.client.ws.ping;
      }
    } catch (error) {
      console.error('API 지연 시간 측정 중 오류:', error);
      apiLatency = 0; // 측정 실패시 0으로 설정
    }
    
    // CPU 사용률 측정 (시스템 전체와 프로세스)
    const [systemCpuUsage, processCpuUsage] = await Promise.all([
      getCPUUsage(),
      getProcessCPUUsage()
    ]);
    
    // 측정 지연 시간 계산 (완료된 시점에서)
    const botLatency = Date.now() - startTime;
    
    // 시스템 정보 수집
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = Math.round((usedMem / totalMem) * 100);
    
    // 프로세스 메모리 사용량
    const processMemoryUsage = process.memoryUsage();
    const rss = Math.round(processMemoryUsage.rss / 1024 / 1024);
    const heapTotal = Math.round(processMemoryUsage.heapTotal / 1024 / 1024);
    const heapUsed = Math.round(processMemoryUsage.heapUsed / 1024 / 1024);
    
    // CPU 정보
    const cpus = os.cpus();
    const cpuCount = cpus.length;
    const cpuModel = cpus[0].model;
    const cpuSpeed = cpus[0].speed;
    
    // 시스템 CPU 로드 (평균 부하)
    const cpuLoad = Math.round(os.loadavg()[0] * 100) / 100;
    
    // 서버 업타임
    const uptimeSec = os.uptime();
    const uptimeDay = Math.floor(uptimeSec / 86400);
    const uptimeHour = Math.floor((uptimeSec % 86400) / 3600);
    const uptimeMin = Math.floor(((uptimeSec % 86400) % 3600) / 60);
    const uptimeSecs = Math.floor(((uptimeSec % 86400) % 3600) % 60);
    const uptime = `${uptimeDay}일 ${uptimeHour}시간 ${uptimeMin}분 ${uptimeSecs}초`;
    
    // 봇 업타임
    const botUptimeSec = process.uptime();
    const botUptimeDay = Math.floor(botUptimeSec / 86400);
    const botUptimeHour = Math.floor((botUptimeSec % 86400) / 3600);
    const botUptimeMin = Math.floor(((botUptimeSec % 86400) % 3600) / 60);
    const botUptimeSecs = Math.floor(((botUptimeSec % 86400) % 3600) % 60);
    const botUptime = `${botUptimeDay}일 ${botUptimeHour}시간 ${botUptimeMin}분 ${botUptimeSecs}초`;
    
    // 지연 시간 이모티콘 선택
    const getLatencyEmoji = (latency: number): string => {
      if (latency === 0) return '⚪'; // 측정 불가
      if (latency < 100) return '🟢'; // 좋음
      if (latency < 200) return '🟡'; // 양호
      if (latency < 500) return '🟠'; // 보통
      return '🔴'; // 나쁨
    };
    
    // CPU 사용량 이모티콘 선택
    const getCpuEmoji = (usage: number): string => {
      if (usage === 0) return '⚪'; // 측정 불가
      if (usage < 30) return '🟢'; // 좋음
      if (usage < 60) return '🟡'; // 양호
      if (usage < 90) return '🟠'; // 주의
      return '🔴'; // 위험
    };
    
    // 메모리 사용량 이모티콘 선택
    const getMemoryEmoji = (percentage: number): string => {
      if (percentage < 50) return '🟢'; // 좋음
      if (percentage < 70) return '🟡'; // 양호
      if (percentage < 85) return '🟠'; // 주의
      return '🔴'; // 위험
    };
    
    // 부하(Load) 이모티콘 선택 (코어 당 부하 기준)
    const getLoadEmoji = (load: number, cores: number): string => {
      const loadPerCore = load / cores;
      if (loadPerCore < 0.3) return '🟢'; // 좋음
      if (loadPerCore < 0.7) return '🟡'; // 양호
      if (loadPerCore < 1.0) return '🟠'; // 주의
      return '🔴'; // 위험
    };
    
    // 임베드 생성
    const pingEmbed = new EmbedBuilder()
      .setTitle('🏓 봇 시스템 상태')
      .setColor(0x3498DB)
      .setDescription('봇 서버의 상태 정보와 시스템 자원 사용량입니다.')
      .addFields(
        { name: '📊 지연 시간', value: 
          `${getLatencyEmoji(apiLatency)} 디스코드 API: **${apiLatency > 0 ? `${apiLatency}ms` : 'N/A'}**\n` +
          `${getLatencyEmoji(botLatency)} 봇 내부 처리: **${botLatency}ms**`
        },
        { name: '💻 시스템 정보', value: 
          `🖥️ OS: **${os.type()} ${os.release()} (${os.platform()})**\n` +
          `🧠 CPU: **${cpuModel}** (${cpuCount}코어, ${cpuSpeed}MHz)\n` +
          `${getLoadEmoji(cpuLoad, cpuCount)} CPU 부하: **${cpuLoad}** (시스템 평균)\n` +
          `${getCpuEmoji(systemCpuUsage)} CPU 사용률: **${systemCpuUsage}%** (시스템 전체)\n` +
          `${getCpuEmoji(processCpuUsage)} CPU 사용률: **${processCpuUsage}%** (봇 프로세스)\n` +
          `${getMemoryEmoji(memUsage)} RAM: **${memUsage}%** (${Math.round(usedMem / 1024 / 1024 / 1024 * 100) / 100}GB / ${Math.round(totalMem / 1024 / 1024 / 1024 * 100) / 100}GB)\n` +
          `⏰ 서버 업타임: **${uptime}**`
        },
        { name: '🤖 봇 정보', value:
          `💾 RSS: **${rss}MB**, Heap: **${heapUsed}MB / ${heapTotal}MB**\n` +
          `⏱️ 봇 업타임: **${botUptime}**\n` +
          `🟩 Node.js: **${process.version}**`
        }
      )
      .setTimestamp()
      .setFooter({ text: '음악은 나의 삶 🎵' });
    
    // 응답 전송
    await interaction.editReply({ embeds: [pingEmbed] });
  }
} as Command; 