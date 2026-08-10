import { Command } from 'commander';
import { parse } from 'csv-parse/sync';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const VPN_GATE_API = 'https://www.vpngate.net/api/iphone/';

const RUNTIME_DIR = path.resolve('.runtime/vpn');
const CONFIG_PATH = path.join(RUNTIME_DIR, 'current.ovpn');
const PID_PATH = path.join(RUNTIME_DIR, 'openvpn.pid');
const STATUS_PATH = path.join(RUNTIME_DIR, 'openvpn-status.log');
const LOG_PATH = path.join(RUNTIME_DIR, 'openvpn.log');
const SERVER_PATH = path.join(RUNTIME_DIR, 'server.json');

interface VpnServer {
  HostName: string;
  IP: string;
  Score: string;
  Ping: string;
  Speed: string;
  CountryLong: string;
  CountryShort: string;
  NumVpnSessions: string;
  Uptime: string;
  TotalUsers: string;
  TotalTraffic: string;
  LogType: string;
  Operator: string;
  Message: string;
  OpenVPN_ConfigData_Base64: string;
}

interface SavedServer {
  hostName: string;
  ip: string;
  country: string;
  countryCode: string;
  ping: number;
  speed: number;
  score: number;
  connectedAt: string;
}

function ensureRuntimeDir(): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
}

async function fetchServers(): Promise<VpnServer[]> {
  const response = await fetch(VPN_GATE_API);

  if (!response.ok) {
    throw new Error(`VPN Gate API error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  // VPN Gate CSV:
  //
  // *vpn_servers
  // #HostName,IP,...
  // ...
  // *
  //
  // csv-parse に渡せる形へ整形する。
  const csv = text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return false;
      }

      return !trimmed.startsWith('*');
    })
    .join('\n')
    .replace(/^#HostName/, 'HostName');

  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as VpnServer[];

  return records.filter((server) => server.OpenVPN_ConfigData_Base64 && server.IP && server.CountryShort);
}

function number(value: string | undefined): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function selectServer(
  servers: VpnServer[],
  options: {
    country?: string;
    maxPing?: number;
    minSpeedMbps?: number;
    top: number;
  },
): VpnServer {
  let candidates = servers;

  if (options.country) {
    const country = options.country.toUpperCase();

    candidates = candidates.filter(
      (server) => server.CountryShort.toUpperCase() === country || server.CountryLong.toUpperCase() === country,
    );
  }

  if (options.maxPing !== undefined) {
    candidates = candidates.filter((server) => number(server.Ping) <= options.maxPing!);
  }

  if (options.minSpeedMbps !== undefined) {
    const minimum = options.minSpeedMbps * 1_000_000;

    candidates = candidates.filter((server) => number(server.Speed) >= minimum);
  }

  if (candidates.length === 0) {
    throw new Error('条件に一致するVPN Gateサーバーがありません');
  }

  // VPN Gate自身のScoreを基本ランキングとして利用する。
  candidates.sort((a, b) => number(b.Score) - number(a.Score));

  // 常に1位だけ使うのではなく、上位N台からランダム選択。
  const top = candidates.slice(0, Math.min(options.top, candidates.length));

  return top[Math.floor(Math.random() * top.length)]!;
}

function decodeOpenVpnConfig(server: VpnServer): string {
  return Buffer.from(server.OpenVPN_ConfigData_Base64, 'base64').toString('utf8');
}

function readPid(): number | null {
  if (!existsSync(PID_PATH)) {
    return null;
  }

  const pid = Number(readFileSync(PID_PATH, 'utf8').trim());

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleFiles(): void {
  const pid = readPid();

  if (pid && processExists(pid)) {
    return;
  }

  for (const file of [PID_PATH, STATUS_PATH, SERVER_PATH]) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
  }
}

async function connect(options: { country?: string; maxPing?: string; minSpeed?: string; top: string }): Promise<void> {
  ensureRuntimeDir();
  cleanupStaleFiles();

  const existingPid = readPid();

  if (existingPid && processExists(existingPid)) {
    throw new Error(`VPNはすでに接続中です (PID=${existingPid})`);
  }

  console.log('VPN Gateサーバー一覧を取得中...');

  const servers = await fetchServers();

  console.log(`${servers.length} サーバー取得`);

  const server = selectServer(servers, {
    country: options.country,
    maxPing: options.maxPing !== undefined ? Number(options.maxPing) : undefined,
    minSpeedMbps: options.minSpeed !== undefined ? Number(options.minSpeed) : undefined,
    top: Number(options.top),
  });

  const ping = number(server.Ping);
  const speed = number(server.Speed);
  const score = number(server.Score);

  console.log('');
  console.log('接続先:');
  console.log(`  Country : ${server.CountryLong}`);
  console.log(`  Host    : ${server.HostName}`);
  console.log(`  IP      : ${server.IP}`);
  console.log(`  Ping    : ${ping} ms`);
  console.log(`  Speed   : ${(speed / 1_000_000).toFixed(1)} Mbps`);
  console.log(`  Score   : ${score}`);
  console.log('');

  let config = decodeOpenVpnConfig(server);

  // OpenVPNが終了しにくい設定が含まれていても、
  // daemon管理はこちら側で行う。
  config += '\n';

  writeFileSync(CONFIG_PATH, config, 'utf8');

  const saved: SavedServer = {
    hostName: server.HostName,
    ip: server.IP,
    country: server.CountryLong,
    countryCode: server.CountryShort,
    ping,
    speed,
    score,
    connectedAt: new Date().toISOString(),
  };

  writeFileSync(SERVER_PATH, JSON.stringify(saved, null, 2), 'utf8');

  const result = spawnSync(
    'openvpn',
    ['--config', CONFIG_PATH, '--daemon', 'crawler-vpngate', '--writepid', PID_PATH, '--status', STATUS_PATH, '5', '--log', LOG_PATH],
    {
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`OpenVPN起動失敗: exit=${result.status}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const pid = readPid();

  if (!pid || !processExists(pid)) {
    console.error('');
    console.error('OpenVPNログ:');

    if (existsSync(LOG_PATH)) {
      console.error(readFileSync(LOG_PATH, 'utf8').split(/\r?\n/).slice(-30).join('\n'));
    }

    throw new Error('OpenVPNが起動後に終了しました');
  }

  console.log(`VPN接続プロセス起動完了 PID=${pid}`);
  console.log(`ログ: ${LOG_PATH}`);
}

function disconnect(): void {
  ensureRuntimeDir();

  const pid = readPid();

  if (!pid) {
    console.log('VPNは接続されていません');
    return;
  }

  if (!processExists(pid)) {
    console.log('OpenVPNプロセスは既に終了しています');
    cleanupStaleFiles();
    return;
  }

  console.log(`OpenVPNを停止します PID=${pid}`);

  process.kill(pid, 'SIGTERM');

  rmSync(PID_PATH, {
    force: true,
  });

  console.log('VPN切断要求を送信しました');
}

function status(): void {
  ensureRuntimeDir();
  cleanupStaleFiles();

  const pid = readPid();

  if (!pid || !processExists(pid)) {
    console.log('VPN: DISCONNECTED');
    return;
  }

  console.log('VPN: CONNECTED');
  console.log(`PID: ${pid}`);

  if (existsSync(SERVER_PATH)) {
    const server = JSON.parse(readFileSync(SERVER_PATH, 'utf8')) as SavedServer;

    console.log(`Country: ${server.country}`);
    console.log(`Host: ${server.hostName}`);
    console.log(`IP: ${server.ip}`);
    console.log(`Ping: ${server.ping} ms`);
    console.log(`Speed: ${(server.speed / 1_000_000).toFixed(1)} Mbps`);
    console.log(`Score: ${server.score}`);
    console.log(`Connected: ${server.connectedAt}`);
  }

  console.log(`OpenVPN log: ${LOG_PATH}`);
}

async function list(options: { country?: string; limit: string }): Promise<void> {
  const servers = await fetchServers();

  let candidates = servers;

  if (options.country) {
    const country = options.country.toUpperCase();

    candidates = candidates.filter((server) => server.CountryShort.toUpperCase() === country);
  }

  candidates.sort((a, b) => number(b.Score) - number(a.Score));

  for (const server of candidates.slice(0, Number(options.limit))) {
    console.log(
      [
        server.CountryShort.padEnd(3),
        server.IP.padEnd(16),
        `${number(server.Ping)}ms`.padEnd(8),
        `${(number(server.Speed) / 1_000_000).toFixed(1)}Mbps`.padEnd(12),
        `score=${number(server.Score)}`,
      ].join(' '),
    );
  }
}

export const vpnCommand = new Command('vpn').description('VPN Gate VPN management');

vpnCommand.name('vpn').description('VPN Gate crawler VPN manager');

vpnCommand
  .command('connect')
  .description('VPN GateのVPNへ接続')
  .option('-c, --country <code>', '接続国 (JP, US, KR など)')
  .option('--max-ping <ms>', '最大Ping値')
  .option('--min-speed <mbps>', '最低回線速度 Mbps')
  .option('--top <n>', '上位何台からランダム選択するか', '10')
  .action(connect);

vpnCommand.command('disconnect').description('VPNを切断').action(disconnect);

vpnCommand.command('status').description('VPN状態確認').action(status);

vpnCommand
  .command('list')
  .description('VPN Gateサーバー一覧')
  .option('-c, --country <code>', '国コード')
  .option('-n, --limit <n>', '表示件数', '20')
  .action(list);
