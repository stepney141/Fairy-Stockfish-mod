#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const defaultEngine = path.join(__dirname, 'src', 'stockfish');
const defaultInitFile = path.join(__dirname, 'engine-options.txt');

const enginePath = process.argv[2] ?? defaultEngine;
const initFile = process.argv[3] ?? defaultInitFile;

if (!fs.existsSync(enginePath)) {
  console.error(`Engine not found at ${enginePath}`);
  process.exit(1);
}
if (!fs.existsSync(initFile)) {
  console.error(`USI init file not found at ${initFile}`);
  process.exit(1);
}

const linesToProcess = fs
  .readFileSync(initFile, 'utf8')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean);

let currentBasePosition = 'position startpos';
const optionLines = [];

for (const line of linesToProcess) {
  if (line.startsWith('position ')) {
    currentBasePosition = line;
  } else {
    optionLines.push(line);
  }
}

const engine = spawn(enginePath, [], { cwd: path.dirname(enginePath) });
engine.stdin.setDefaultEncoding('utf8');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let waitingForUsiok = true;
let waitingForReadyok = false;
let started = false;
let awaitingBestmove = false;
let buffer = '';
let waitingForDisplay = false;
let displayTimer = null;
let pendingDisplay = false;
const moves = [];

function send(cmd) {
  console.log(`[send] ${cmd}`);
  engine.stdin.write(cmd + '\n');
}

function clearDisplayTimer() {
  if (displayTimer) {
    clearTimeout(displayTimer);
    displayTimer = null;
  }
}

function scheduleDisplayPrompt() {
  clearDisplayTimer();
  displayTimer = setTimeout(() => {
    displayTimer = null;
    waitingForDisplay = false;
    if (!awaitingBestmove) promptMove();
  }, 50);
}

function requestBoardDisplay(forceImmediate = false) {
  waitingForDisplay = true;
  clearDisplayTimer();
  if (!forceImmediate && awaitingBestmove) {
    if (!pendingDisplay) {
      pendingDisplay = true;
      send('stop');
    }
    return;
  }
  pendingDisplay = false;
  send(buildPositionCommand());
  send('d');
}

function buildPositionCommand() {
  return moves.length ? `${currentBasePosition} moves ${moves.join(' ')}` : currentBasePosition;
}

function startEngineSearch() {
  if (awaitingBestmove) {
    console.log('Engine is already thinking.');
    return false;
  }
  waitingForDisplay = false;
  pendingDisplay = false;
  clearDisplayTimer();
  send(buildPositionCommand());
  awaitingBestmove = true;
  send('go time 20000');
  return true;
}

function tryOverridePosition(input) {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith('position ')) return 'invalid';
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    console.log('Invalid position command.');
    return 'invalid';
  }
  const movesIdx = tokens.findIndex((tok, idx) => tok.toLowerCase() === 'moves' && idx >= 2);
  const baseTokens = movesIdx === -1 ? tokens : tokens.slice(0, movesIdx);
  const moveTokens = movesIdx === -1 ? [] : tokens.slice(movesIdx + 1);
  if (baseTokens.length < 2) {
    console.log('Position command must include "startpos" or "sfen".');
    return 'invalid';
  }
  currentBasePosition = baseTokens.join(' ');
  moves.length = 0;
  moves.push(...moveTokens);
  awaitingBestmove = false;
  waitingForDisplay = false;
  pendingDisplay = false;
  clearDisplayTimer();
  send(buildPositionCommand());
  console.log(`Position overwritten via manual command (${moveTokens.length} moves).`);
  const userToMove = moveTokens.length % 2 === 0;
  if (userToMove) {
    console.log('It is your turn. Play a move or type "go" to let the engine move again.');
  } else {
    console.log('It is the engine\'s turn. Type "go" when you want it to move.');
  }
  return 'user';
}

function promptMove() {
  if (!started || awaitingBestmove) return;
  rl.question('Your move (USI, "d", "you_start", "go", "position ...", or "quit"): ', answer => {
    const move = answer.trim();
    if (!move) return promptMove();
    const command = move.toLowerCase();
    if (command === 'quit') {
      shutdown(0);
      return;
    }
    if (command === 'd') {
      requestBoardDisplay();
      return;
    }
    if (command === 'you_start') {
      if (moves.length) {
        console.log('"you_start" is only valid before any moves are made.');
        promptMove();
        return;
      }
      if (!startEngineSearch()) promptMove();
      return;
    }
    if (command === 'go') {
      if (!startEngineSearch()) promptMove();
      return;
    }
    if (command.startsWith('position ')) {
      const result = tryOverridePosition(move);
      if (result === 'invalid') {
        promptMove();
        return;
      }
      promptMove();
      return;
    }
    moves.push(move);
    if (!startEngineSearch()) promptMove();
  });
}

function handleEngineLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return;
  console.log(`[engine] ${line}`);

  if (waitingForUsiok && line === 'usiok') {
    waitingForUsiok = false;
    optionLines.forEach(send);
    waitingForReadyok = true;
    send('isready');
    return;
  }

  if (waitingForReadyok && line === 'readyok') {
    waitingForReadyok = false;
    started = true;
    send('usinewgame');
    send(currentBasePosition);
    promptMove();
    return;
  }

  if (awaitingBestmove && line.startsWith('bestmove')) {
    awaitingBestmove = false;
    const parts = line.split(/\s+/);
    const best = parts[1];
    if (best && best !== '(none)' && best !== 'resign') {
      moves.push(best);
      console.log(`Engine plays: ${best}`);
      console.log(`Moves so far: ${moves.join(' ')}`);
    } else {
      console.log('Engine has no legal move.');
    }
    if (pendingDisplay) {
      requestBoardDisplay(true);
      return;
    }
    promptMove();
    return;
  }

  if (waitingForDisplay) scheduleDisplayPrompt();
}

engine.stdout.on('data', data => {
  buffer += data.toString();
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop();
  lines.forEach(handleEngineLine);
});

engine.stderr.on('data', data => process.stderr.write(data));

engine.on('exit', code => {
  console.log(`Engine exited with code ${code ?? 0}`);
  process.exit(code ?? 0);
});

function shutdown(code) {
  if (engine.exitCode === null) send('quit');
  rl.close();
  setTimeout(() => process.exit(code), 100);
}

process.on('SIGINT', () => {
  console.log('\nInterrupted, shutting down.');
  shutdown(0);
});

send('usi');
