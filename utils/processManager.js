const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ServerFile = require('../models/ServerFile');
const Server = require('../models/Server');

const RUNTIME_ROOT = path.join(__dirname, '..', 'servers_runtime');
if (!fs.existsSync(RUNTIME_ROOT)) {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
}

const runningProcesses = new Map();

function safeFileName(name) {
  const cleaned = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..')) {
    throw new Error('اسم الملف غير صالح');
  }
  return cleaned;
}

function getServerDir(serverId) {
  const dir = path.join(RUNTIME_ROOT, String(serverId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function syncFilesToDisk(serverId) {
  const dir = getServerDir(serverId);
  const files = await ServerFile.find({ serverId });

  for (const file of files) {
    const cleanName = safeFileName(file.fileName);
    const fullPath = path.join(dir, cleanName);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content ?? '', 'utf8');
  }
}

function emitLog(io, serverId, line) {
  io.to(`server_${serverId}`).emit('console_log', {
    serverId: String(serverId),
    line: String(line)
  });
}

async function startBotServer(serverDoc, io) {
  const id = String(serverDoc._id);
  if (runningProcesses.has(id)) {
    emitLog(io, id, '[SYSTEM] السيرفر يعمل بالفعل.');
    return;
  }

  await syncFilesToDisk(serverDoc._id);
  const dir = getServerDir(serverDoc._id);
  const startup = safeFileName(serverDoc.startupFile || 'index.js');
  const entryPath = path.join(dir, startup);

  if (!fs.existsSync(entryPath)) {
    emitLog(io, id, `[ERROR] ملف التشغيل (${startup}) غير موجود في ملفات السيرفر.`);
    await Server.findByIdAndUpdate(serverDoc._id, { status: 'offline' });
    return;
  }

  const pkgPath = path.join(dir, 'package.json');
  const nodeModulesPath = path.join(dir, 'node_modules');

  if (fs.existsSync(pkgPath) && !fs.existsSync(nodeModulesPath)) {
    emitLog(io, id, '[SYSTEM] جاري تثبيت مكتبات package.json لأول مرة...');
    await new Promise((resolve) => {
      const npmProc = spawn('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: dir,
        shell: true
      });
      npmProc.stdout.on('data', (d) => emitLog(io, id, d.toString()));
      npmProc.stderr.on('data', (d) => emitLog(io, id, d.toString()));
      npmProc.on('close', () => resolve());
    });
  }

  emitLog(io, id, `[SYSTEM] تشغيل البوت عبر ${startup} ...`);
  const child = spawn('node', [startup], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BOT_CPU_LIMIT: String(serverDoc.cpuLimit),
      BOT_RAM_LIMIT_MB: String(serverDoc.storageLimitMB)
    }
  });

  runningProcesses.set(id, child);
  await Server.findByIdAndUpdate(serverDoc._id, { status: 'running' });

  child.stdout.on('data', (data) => emitLog(io, id, data.toString()));
  child.stderr.on('data', (data) => emitLog(io, id, `[STDERR] ${data.toString()}`));

  child.on('close', async (code) => {
    runningProcesses.delete(id);
    emitLog(io, id, `[SYSTEM] توقف البوت (Code: ${code ?? 0}).`);
    await Server.findByIdAndUpdate(serverDoc._id, { status: 'offline' }).catch(() => {});
  });
}

async function stopBotServer(serverId, io) {
  const id = String(serverId);
  const child = runningProcesses.get(id);
  if (child) {
    emitLog(io, id, '[SYSTEM] جاري إيقاف البوت...');
    child.kill('SIGTERM');
    runningProcesses.delete(id);
  }
  await Server.findByIdAndUpdate(serverId, { status: 'offline' });
  emitLog(io, id, '[SYSTEM] تم إيقاف السيرفر.');
}

function sendConsoleInput(serverId, command, io) {
  const id = String(serverId);
  const child = runningProcesses.get(id);
  if (!child || !child.stdin.writable) {
    emitLog(io, id, '[SYSTEM] البوت متوقف حالياً ولا يقبل أوامر الكونسول.');
    return;
  }
  child.stdin.write(`${command}\n`);
  emitLog(io, id, `> ${command}`);
}

module.exports = {
  safeFileName,
  startBotServer,
  stopBotServer,
  sendConsoleInput
};
