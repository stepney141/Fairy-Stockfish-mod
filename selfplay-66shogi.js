#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { randomUUID } = require('crypto');

const defaultEngine = path.join(__dirname, 'src', 'stockfish');
const defaultInitFile = path.join(__dirname, 'engine-options.txt');

const defaultConfigPath = path.join(__dirname, 'selfplay-66shogi.config.json');
const configPath = process.argv[2] ?? defaultConfigPath;

function loadConfig(configFilePath) {
  const resolvedPath = path.resolve(configFilePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Config file not found: ${resolvedPath}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read/parse config JSON (${resolvedPath}):`, err.message);
    process.exit(1);
  }

  const resolvedDir = path.dirname(resolvedPath);
  const resolveMaybeRelative = p => (p && !path.isAbsolute(p) ? path.resolve(resolvedDir, p) : p);
  const numberOr = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    engineA: resolveMaybeRelative(parsed.engineA) ?? defaultEngine,
    engineB: resolveMaybeRelative(parsed.engineB) ?? parsed.engineA ? resolveMaybeRelative(parsed.engineA) : defaultEngine,
    initFile: resolveMaybeRelative(parsed.initFile) ?? defaultInitFile,
    nodesPerMove: numberOr(parsed.nodesPerMove, 500000),
    maxPlies: numberOr(parsed.maxPlies, 512),
    concurrentGames: Math.max(1, numberOr(parsed.concurrentGames, 1)),
    logDir: resolveMaybeRelative(parsed.logDir) ?? path.join(__dirname, 'selfplay-logs'),
  };
}

const config = loadConfig(configPath);
const enginePathA = config.engineA;
const enginePathB = config.engineB;
const initFile = config.initFile;
const nodesPerMove = config.nodesPerMove;
const maxPlies = config.maxPlies;
const concurrentGames = config.concurrentGames;
const logDir = config.logDir;

function ensureFile(p) {
  if (!fs.existsSync(p)) {
    console.error(`Missing file: ${p}`);
    process.exit(1);
  }
}

ensureFile(enginePathA);
ensureFile(enginePathB);
ensureFile(initFile);
fs.mkdirSync(logDir, { recursive: true });

function parseInit(filePath) {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  let basePosition = 'position startpos';
  const options = [];
  for (const line of lines) {
    if (line.startsWith('position ')) {
      basePosition = line;
    } else {
      options.push(line);
    }
  }
  return { basePosition, options };
}

function buildPosition(base, moves) {
  return moves.length ? `${base} moves ${moves.join(' ')}` : base;
}

class UsiEngine {
  constructor(name, binaryPath, logStream) {
    this.name = name;
    this.binaryPath = binaryPath;
    this.process = spawn(binaryPath, [], { cwd: path.dirname(binaryPath) });
    this.process.stdin.setDefaultEncoding('utf8');
    this.buffer = '';
    this.waiters = [];
    this.bestmoveResolver = null;
    this.logStream = logStream;
    this.process.stdout.on('data', data => this.handleData(data));
    this.process.stderr.on('data', data => this.writeLog(`[${this.name} err] ${data.toString()}`));
    this.process.on('exit', code => {
      this.writeLog(`[${this.name}] exited with code ${code ?? 0}`);
    });
  }

  send(cmd) {
    this.writeLog(`[${this.name} send] ${cmd}`);
    this.process.stdin.write(cmd + '\n');
  }

  writeLog(message) {
    if (this.logStream) {
      this.logStream.write(`${new Date().toISOString()} ${message}\n`);
    }
  }

  waitFor(matchFn, label, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        matchFn,
        resolve: line => {
          clearTimeout(waiter.timer);
          this.waiters = this.waiters.filter(w => w !== waiter);
          resolve(line);
        },
        reject: err => {
          clearTimeout(waiter.timer);
          this.waiters = this.waiters.filter(w => w !== waiter);
          reject(err);
        },
      };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error(`${this.name} timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  handleData(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      this.writeLog(`[${this.name}] ${line}`);
      if (this.bestmoveResolver && line.startsWith('bestmove')) {
        const resolver = this.bestmoveResolver;
        this.bestmoveResolver = null;
        resolver(line);
        continue;
      }
      const hit = this.waiters.find(waiter => waiter.matchFn(line));
      if (hit) {
        hit.resolve(line);
      }
    }
  }

  async initialize(optionLines) {
    this.send('usi');
    await this.waitFor(line => line === 'usiok', 'usiok');
    optionLines.forEach(line => this.send(line));
    this.send('isready');
    await this.waitFor(line => line === 'readyok', 'readyok');
    this.send('usinewgame');
  }

  async go(nodes, positionCommand) {
    if (this.bestmoveResolver) {
      throw new Error(`${this.name} already pondering a move.`);
    }
    return new Promise(resolve => {
      this.bestmoveResolver = resolve;
      if (positionCommand) {
        this.send(positionCommand);
      }
      this.send(`go nodes ${nodes}`);
    });
  }

  stop() {
    if (this.process.exitCode === null) {
      this.send('quit');
    }
  }
}

async function playSingleGame(gameId, basePosition, options, stopSignal) {
  const logPath = path.join(logDir, `${randomUUID()}.txt`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const engineA = new UsiEngine(`Game${gameId}-Sente`, enginePathA, logStream);
  const engineB = new UsiEngine(`Game${gameId}-Gote`, enginePathB, logStream);
  const engines = [engineA, engineB];
  const moves = [];
  let result;

  try {
    await Promise.all(engines.map(e => e.initialize(options)));
    const startCommand = buildPosition(basePosition, moves);
    engines.forEach(e => e.send(startCommand));

    for (let ply = 0; ply < maxPlies; ply += 1) {
      if (stopSignal?.isStopped()) {
        result = { winner: null, reason: 'stopped', plies: ply };
        break;
      }
      const senteTurn = ply % 2 === 0;
      const current = senteTurn ? engineA : engineB;
      const opponent = senteTurn ? engineB : engineA;
      const turnLabel = senteTurn ? 'Sente' : 'Gote';
      const positionCommand = buildPosition(basePosition, moves);

      opponent.send(positionCommand);
      const bestLine = await Promise.race([
        current.go(nodesPerMove, positionCommand),
        stopSignal?.promise.then(() => 'bestmove stop'),
      ]);

      if (stopSignal?.isStopped()) {
        engines.forEach(e => e.send('stop'));
        result = { winner: null, reason: 'stopped', plies: ply };
        break;
      }

      const [, bestMove = ''] = bestLine.split(/\s+/);
      console.log(`[Game ${gameId}] ${turnLabel} plays: ${bestMove}`);

      if (!bestMove || bestMove === 'resign' || bestMove === '(none)') {
        result = {
          winner: senteTurn ? 'gote' : 'sente',
          reason: bestMove === 'resign' ? 'resign' : 'no_legal_move',
          plies: ply,
        };
        break;
      }

      if (bestMove === 'win') {
        result = {
          winner: senteTurn ? 'sente' : 'gote',
          reason: 'declared_win',
          plies: ply,
        };
        break;
      }

      moves.push(bestMove);
      const updated = buildPosition(basePosition, moves);
      engines.forEach(e => e.send(updated));
    }

    if (!result) {
      result = { winner: 'draw', reason: 'max_plies', plies: maxPlies };
    }
  } catch (err) {
    console.error(`[Game ${gameId}] terminated with error:`, err);
    result = { winner: null, reason: 'error' };
  } finally {
    engines.forEach(e => e.stop());
    logStream.end();
  }

  return { ...result, logPath };
}

async function main() {
  const { basePosition, options } = parseInit(initFile);

  let senteWins = 0;
  let goteWins = 0;
  let draws = 0;
  let nextGameId = 1;
  let stopped = false;

  const requestStop = () => {
    if (!stopped) console.log('Stop requested. Finishing ongoing games...');
    stopped = true;
  };

  // Accept line-based input; keep stdout quieter so input remains usable.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  let stopResolve;
  const stopPromise = new Promise(res => {
    stopResolve = res;
  });
  const stopSignal = {
    isStopped: () => stopped,
    promise: stopPromise,
  };
  const promptUser = () => {
    if (!stopped) rl.prompt();
  };
  rl.setPrompt('cmd> ');
  console.log('Enter "q" to stop after current games finish.');
  promptUser();
  rl.on('line', line => {
    if (line.trim().toLowerCase() === 'q') {
      requestStop();
      if (stopResolve) stopResolve();
      rl.close();
      return;
    }
    promptUser();
  });

  const shouldStop = () => stopped;

  const worker = async () => {
    while (!shouldStop()) {
      const gameId = nextGameId;
      nextGameId += 1;

      const result = await playSingleGame(gameId, basePosition, options, stopSignal);
      if (result.reason === 'stopped') break;
      if (result.winner === 'sente') {
        senteWins += 1;
      } else if (result.winner === 'gote') {
        goteWins += 1;
      } else {
        draws += 1;
      }
      console.log(`[Game ${gameId}] result: ${result.winner ?? 'error'}${result.reason ? ` (${result.reason})` : ''}`);
      if (result.logPath) {
        console.log(`[Game ${gameId}] log: ${result.logPath}`);
      }
    }
  };

  const workerCount = concurrentGames;
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  const played = senteWins + goteWins + draws;
  const senteRate = played ? ((senteWins / played) * 100).toFixed(1) : '0.0';
  const goteRate = played ? ((goteWins / played) * 100).toFixed(1) : '0.0';

  console.log('=== Summary ===');
  console.log(`Games finished: ${played}`);
  console.log(`Sente wins: ${senteWins} (${senteRate}%)`);
  console.log(`Gote wins: ${goteWins} (${goteRate}%)`);
  console.log(`Draws/other: ${draws}`);
}

main();
