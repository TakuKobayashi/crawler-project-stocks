import { Command } from 'commander';
import { parse } from 'csv-parse/sync';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const VPN_GATE_API = 'https://www.vpngate.net/api/iphone/';

const RUNTIME_DIR = path.resolve('.runtime/vpn');
const CONFIG_PATH = path.join(RUNTIME_DIR, 'current.ovpn');
const PID_PATH = path.join(RUNTIME_DIR, 'openvpn.pid');
const STATUS_PATH = path.join(RUNTIME_DIR, 'openvpn-status.log');
const LOG_PATH = path.join(RUNTIME_DIR, 'openvpn.log');
const SERVER_PATH = path.join(RUNTIME_DIR, 'server.json');
const API_TIMEOUT_MS = 15_000;
const API_ATTEMPTS = 3;
const CONNECTION_TIMEOUT_MS = 45_000;
const CONNECTION_POLL_MS = 500;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchServers(): Promise<VpnServer[]> {
  let response: Response | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(VPN_GATE_API, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      break;
    } catch (error) {
      lastError = error;

      if (attempt < API_ATTEMPTS) {
        console.warn(`VPN Gate APIへの接続に失敗しました。再試行します (${attempt}/${API_ATTEMPTS})`);
        await sleep(attempt * 1_000);
      }
    }
  }

  if (!response) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`VPN Gate APIへ接続できませんでした (${API_ATTEMPTS}回試行): ${detail}`);
  }

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

function parsePositiveNumber(value: string | undefined, name: string, options?: { allowZero?: boolean }): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  const minimum = options?.allowZero ? 0 : Number.MIN_VALUE;

  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name}には${options?.allowZero ? '0以上' : '0より大きい'}数値を指定してください: ${value}`);
  }

  return parsed;
}

function assertOpenVpnAvailable(): string {
  const result = spawnSync('openvpn', ['--version'], { stdio: 'ignore' });

  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error('openvpnコマンドが見つかりません。macOSでは `brew install openvpn` などでインストールしてください');
  }

  if (result.error || result.status !== 0) {
    throw new Error(`openvpnを実行できません${result.error ? `: ${result.error.message}` : ''}`);
  }

  if (process.platform === 'darwin') {
    const which = spawnSync('which', ['openvpn'], { encoding: 'utf8' });
    const executable = which.stdout.trim();

    if (which.status === 0 && executable) {
      return executable;
    }
  }

  return 'openvpn';
}

function needsSudoForOpenVpn(): boolean {
  return process.platform === 'darwin' && typeof process.geteuid === 'function' && process.geteuid() !== 0;
}

async function startOpenVpn(openVpnExecutable: string): Promise<void> {
  const commonArguments = ['--config', CONFIG_PATH, '--status', STATUS_PATH, '5', '--log', LOG_PATH];

  if (process.platform === 'win32') {
    const child = spawn(openVpnExecutable, commonArguments, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    if (!child.pid) {
      throw new Error('OpenVPNプロセスのPIDを取得できませんでした');
    }

    writeFileSync(PID_PATH, String(child.pid), { encoding: 'utf8', mode: 0o600 });
    child.unref();
    return;
  }

  const openVpnArguments = [...commonArguments, '--daemon', 'crawler-vpngate', '--writepid', PID_PATH];
  const result = needsSudoForOpenVpn()
    ? spawnSync('sudo', [openVpnExecutable, ...openVpnArguments], { stdio: 'inherit' })
    : spawnSync(openVpnExecutable, openVpnArguments, { stdio: 'inherit' });

  if (result.error) {
    throw new Error(`OpenVPNを起動できません: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`OpenVPN起動失敗: exit=${result.status}`);
  }
}

function readLog(): string {
  return existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : '';
}

async function waitForConnection(): Promise<number> {
  const deadline = Date.now() + CONNECTION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const pid = readPid();
    const log = readLog();

    if (log.includes('Initialization Sequence Completed')) {
      if (pid && processExists(pid)) {
        return pid;
      }
      break;
    }

    if (pid && !processExists(pid)) {
      break;
    }

    await sleep(CONNECTION_POLL_MS);
  }

  const pid = readPid();
  if (pid && processExists(pid)) {
    stopProcess(pid);
  }

  const tail = readLog().split(/\r?\n/).slice(-30).join('\n').trim();
  for (const file of [PID_PATH, STATUS_PATH, SERVER_PATH]) {
    rmSync(file, { force: true });
  }
  throw new Error(`VPN接続を確認できませんでした${tail ? `\n\nOpenVPNログ:\n${tail}` : ''}`);
}

function decodeOpenVpnConfig(server: VpnServer): string {
  return (
    Buffer.from(server.OpenVPN_ConfigData_Base64, 'base64')
      .toString('utf8')
      // OpenVPN 2.7以降では鍵は常に再起動後も保持されるため、この設定は廃止されている。
      // `\s` は改行にも一致するため使わず、対象の1行だけを削除する。
      .replace(/^[ \t]*persist-key(?:[ \t]+[^\r\n]*)?\r?\n/gim, '')
  );
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM' && needsSudoForOpenVpn()) {
      const result = spawnSync('sudo', ['kill', '-TERM', String(pid)], { stdio: 'inherit' });

      if (result.status === 0) {
        return;
      }
    }

    throw error;
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

async function connect(options: { country?: string; maxPing?: string; minSpeed?: string; top: string; attempts: string }): Promise<void> {
  ensureRuntimeDir();
  cleanupStaleFiles();

  const maxPing = parsePositiveNumber(options.maxPing, '--max-ping', { allowZero: true });
  const minSpeedMbps = parsePositiveNumber(options.minSpeed, '--min-speed', { allowZero: true });
  const top = parsePositiveNumber(options.top, '--top');
  const attempts = parsePositiveNumber(options.attempts, '--attempts');

  if (top === undefined || !Number.isInteger(top)) {
    throw new Error(`--topには正の整数を指定してください: ${options.top}`);
  }

  if (attempts === undefined || !Number.isInteger(attempts)) {
    throw new Error(`--attemptsには正の整数を指定してください: ${options.attempts}`);
  }

  const openVpnExecutable = assertOpenVpnAvailable();
  const existingPid = readPid();

  if (existingPid && processExists(existingPid)) {
    throw new Error(`VPNはすでに接続中です (PID=${existingPid})`);
  }

  console.log('VPN Gateサーバー一覧を取得中...');

  const servers = await fetchServers();

  console.log(`${servers.length} サーバー取得`);

  const attemptedServerIps = new Set<string>();
  const failures: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remainingServers = servers.filter((server) => !attemptedServerIps.has(server.IP));
    let server: VpnServer;

    try {
      server = selectServer(remainingServers, {
        country: options.country,
        maxPing,
        minSpeedMbps,
        top,
      });
    } catch (error) {
      if (failures.length > 0) {
        break;
      }
      throw error;
    }

    attemptedServerIps.add(server.IP);

    const ping = number(server.Ping);
    const speed = number(server.Speed);
    const score = number(server.Score);

    console.log('');
    console.log(`接続先 (${attempt}/${attempts}):`);
    console.log(`  Country : ${server.CountryLong}`);
    console.log(`  Host    : ${server.HostName}`);
    console.log(`  IP      : ${server.IP}`);
    console.log(`  Ping    : ${ping} ms`);
    console.log(`  Speed   : ${(speed / 1_000_000).toFixed(1)} Mbps`);
    console.log(`  Score   : ${score}`);
    console.log('');

    const config = `${decodeOpenVpnConfig(server)}\n`;

    writeFileSync(CONFIG_PATH, config, { encoding: 'utf8', mode: 0o600 });
    rmSync(LOG_PATH, { force: true });
    // OpenVPNはmacOSではrootで動くが、接続確認はこのプロセスがログを読んで行う。
    // 先に通常ユーザー所有で作成しておけば、rootが追記した後も読み取れる。
    writeFileSync(LOG_PATH, '', { encoding: 'utf8', mode: 0o600 });
    rmSync(STATUS_PATH, { force: true });

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

    try {
      await startOpenVpn(openVpnExecutable);
      const pid = await waitForConnection();
      writeFileSync(SERVER_PATH, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });

      console.log(`VPN接続完了 PID=${pid}`);
      console.log(`ログ: ${LOG_PATH}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${server.HostName} (${server.IP}): ${message}`);

      const pid = readPid();
      if (pid && processExists(pid)) {
        stopProcess(pid);
      }
      for (const file of [PID_PATH, STATUS_PATH, SERVER_PATH]) {
        rmSync(file, { force: true });
      }

      console.warn(`接続失敗の理由:\n${message}`);

      if (attempt < attempts) {
        console.warn(`接続に失敗しました。別のサーバーで再試行します (${attempt}/${attempts})`);
      }
    }
  }

  throw new Error(`VPN接続に失敗しました (${failures.length}回試行)\n\n${failures.join('\n\n')}`);
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

  stopProcess(pid);

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

  if (!readLog().includes('Initialization Sequence Completed')) {
    console.log('VPN: CONNECTING');
    console.log(`PID: ${pid}`);
    console.log(`OpenVPN log: ${LOG_PATH}`);
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
  .option('-a, --attempts <n>', '接続を試行する最大回数', '5')
  .action(connect);

vpnCommand.command('disconnect').description('VPNを切断').action(disconnect);

vpnCommand.command('status').description('VPN状態確認').action(status);

vpnCommand
  .command('list')
  .description('VPN Gateサーバー一覧')
  .option('-c, --country <code>', '国コード')
  .option('-n, --limit <n>', '表示件数', '20')
  .action(list);
