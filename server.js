const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Server: SocketServer } = require('socket.io');

const User = require('./models/User');
const Server = require('./models/Server');
const ServerFile = require('./models/ServerFile');
const { requireAuth, requireOwner, JWT_SECRET } = require('./middleware/auth');
const {
  safeFileName,
  startBotServer,
  stopBotServer,
  sendConsoleInput
} = require('./utils/processManager');

const app = express();
const httpServer = http.createServer(app);
const io = new SocketServer(httpServer);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.disable('x-powered-by');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة السر' });
    }

    const user = await User.findOne({ username: String(username).trim() });
    if (!user) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    const valid = await bcrypt.compare(String(password), user.password);
    if (!valid) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('panel_token', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        maxServers: user.maxServers,
        allocatedStorageMB: user.allocatedStorageMB,
        allocatedCpu: user.allocatedCpu
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'خطأ في السيرفر أثناء الدخول' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('panel_token');
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const serversCount = await Server.countDocuments({ owner: req.user._id });
  res.json({ user: req.user, serversCount });
});

app.get('/api/servers', requireAuth, async (req, res) => {
  const query = req.user.role === 'owner' && req.query.all === '1'
    ? {}
    : { owner: req.user._id };

  const servers = await Server.find(query).populate('owner', 'username role').sort({ createdAt: -1 });
  res.json({ servers });
});

app.post('/api/servers', requireAuth, async (req, res) => {
  try {
    const { name, startupFile } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'اكتب اسم السيرفر' });
    }

    const existingCount = await Server.countDocuments({ owner: req.user._id });
    if (existingCount >= req.user.maxServers) {
      return res.status(400).json({ error: `الحد الأقصى هو ${req.user.maxServers} سيرفرات فقط لكل شخص` });
    }

    const userServers = await Server.find({ owner: req.user._id });
    const usedStorage = userServers.reduce((acc, s) => acc + (s.storageLimitMB || 0), 0);
    const remainingStorage = req.user.allocatedStorageMB - usedStorage;

    if (remainingStorage < 256) {
      return res.status(400).json({ error: 'المساحة المخصصة لك غير كافية لإنشاء سيرفر جديد' });
    }

    const server = await Server.create({
      name: String(name).trim(),
      owner: req.user._id,
      storageLimitMB: remainingStorage,
      cpuLimit: req.user.allocatedCpu,
      startupFile: startupFile ? safeFileName(startupFile) : 'index.js',
      status: 'offline'
    });

    const defaultCode = `// Bot starter for ${server.name}\nconsole.log("Bot is running...");\n`;
    await ServerFile.create({
      serverId: server._id,
      fileName: server.startupFile,
      content: defaultCode,
      sizeBytes: Buffer.byteLength(defaultCode, 'utf8')
    });

    res.status(201).json({ server });
  } catch (err) {
    res.status(400).json({ error: err.message || 'تعذر إنشاء السيرفر' });
  }
});

async function getAuthorizedServer(serverId, user) {
  const srv = await Server.findById(serverId);
  if (!srv) return { error: 'السيرفر غير موجود', code: 404 };
  if (user.role !== 'owner' && String(srv.owner) !== String(user._id)) {
    return { error: 'لا تملك صلاحية الوصول لهذا السيرفر', code: 403 };
  }
  return { server: srv };
}

app.post('/api/servers/:id/power', requireAuth, async (req, res) => {
  const { action } = req.body || {};
  const check = await getAuthorizedServer(req.params.id, req.user);
  if (check.error) return res.status(check.code).json({ error: check.error });

  if (action === 'start') {
    await startBotServer(check.server, io);
  } else if (action === 'stop') {
    await stopBotServer(check.server._id, io);
  } else if (action === 'restart') {
    await stopBotServer(check.server._id, io);
    const refreshed = await Server.findById(check.server._id);
    if (refreshed) await startBotServer(refreshed, io);
  } else {
    return res.status(400).json({ error: 'أمر غير صالح' });
  }

  const updated = await Server.findById(check.server._id);
  res.json({ server: updated });
});

app.get('/api/servers/:id/files', requireAuth, async (req, res) => {
  const check = await getAuthorizedServer(req.params.id, req.user);
  if (check.error) return res.status(check.code).json({ error: check.error });

  const files = await ServerFile.find({ serverId: check.server._id })
    .select('fileName sizeBytes updatedAt')
    .sort({ fileName: 1 });

  const totalUsedMB = files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0) / (1024 * 1024);

  res.json({
    files,
    usedStorageMB: Number(totalUsedMB.toFixed(2)),
    limitStorageMB: check.server.storageLimitMB
  });
});

app.get('/api/servers/:id/files/content', requireAuth, async (req, res) => {
  try {
    const check = await getAuthorizedServer(req.params.id, req.user);
    if (check.error) return res.status(check.code).json({ error: check.error });

    const fileName = safeFileName(req.query.name);
    const file = await ServerFile.findOne({ serverId: check.server._id, fileName });
    if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

    res.json({ fileName: file.fileName, content: file.content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/servers/:id/files/save', requireAuth, async (req, res) => {
  try {
    const check = await getAuthorizedServer(req.params.id, req.user);
    if (check.error) return res.status(check.code).json({ error: check.error });

    const fileName = safeFileName(req.body?.fileName);
    const content = String(req.body?.content ?? '');
    const newBytes = Buffer.byteLength(content, 'utf8');

    const existingFiles = await ServerFile.find({ serverId: check.server._id });
    const otherBytes = existingFiles
      .filter((f) => f.fileName !== fileName)
      .reduce((sum, f) => sum + (f.sizeBytes || 0), 0);

    const maxBytes = check.server.storageLimitMB * 1024 * 1024;
    if (otherBytes + newBytes > maxBytes) {
      return res.status(400).json({ error: 'تجاوزت الحد المسموح للمساحة في هذا السيرفر' });
    }

    const saved = await ServerFile.findOneAndUpdate(
      { serverId: check.server._id, fileName },
      { content, sizeBytes: newBytes, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, file: { fileName: saved.fileName, sizeBytes: saved.sizeBytes } });
  } catch (err) {
    res.status(400).json({ error: err.message || 'تعذر حفظ الملف' });
  }
});

app.post('/api/servers/:id/files/rename', requireAuth, async (req, res) => {
  try {
    const check = await getAuthorizedServer(req.params.id, req.user);
    if (check.error) return res.status(check.code).json({ error: check.error });

    const oldName = safeFileName(req.body?.oldName);
    const newName = safeFileName(req.body?.newName);

    if (oldName === newName) {
      return res.json({ success: true, fileName: newName });
    }

    const sourceFile = await ServerFile.findOne({ serverId: check.server._id, fileName: oldName });
    if (!sourceFile) {
      return res.status(404).json({ error: 'الملف الأصلي غير موجود' });
    }

    const targetExists = await ServerFile.findOne({ serverId: check.server._id, fileName: newName });
    if (targetExists) {
      return res.status(400).json({ error: 'يوجد ملف آخر بهذا الاسم بالفعل' });
    }

    sourceFile.fileName = newName;
    sourceFile.updatedAt = new Date();
    await sourceFile.save();

    if (check.server.startupFile === oldName) {
      check.server.startupFile = newName;
      await check.server.save();
    }

    res.json({ success: true, fileName: newName });
  } catch (err) {
    res.status(400).json({ error: err.message || 'تعذر تغيير اسم الملف' });
  }
});

app.get('/api/servers/:id/files/download', requireAuth, async (req, res) => {
  try {
    const check = await getAuthorizedServer(req.params.id, req.user);
    if (check.error) return res.status(check.code).json({ error: check.error });

    const fileName = safeFileName(req.query.name);
    const file = await ServerFile.findOne({ serverId: check.server._id, fileName });
    if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`);
    return res.send(Buffer.from(file.content || '', 'utf8'));
  } catch (err) {
    res.status(400).json({ error: err.message || 'تعذر تنزيل الملف' });
  }
});

app.post('/api/servers/:id/files/archive', requireAuth, async (req, res) => {
  try {
    const check = await getAuthorizedServer(req.params.id, req.user);
    if (check.error) return res.status(check.code).json({ error: check.error });

    const fileName = safeFileName(req.body?.fileName);
    const sourceFile = await ServerFile.findOne({ serverId: check.server._id, fileName });
    if (!sourceFile) {
      return res.status(404).json({ error: 'الملف غير موجود للأرشفة' });
    }

    const archiveName = safeFileName(`archive_${fileName}.bak`);
    const content = sourceFile.content || '';
    const bytes = Buffer.byteLength(content, 'utf8');

    const existingFiles = await ServerFile.find({ serverId: check.server._id });
    const otherBytes = existingFiles
      .filter((f) => f.fileName !== archiveName)
      .reduce((sum, f) => sum + (f.sizeBytes || 0), 0);

    const maxBytes = check.server.storageLimitMB * 1024 * 1024;
    if (otherBytes + bytes > maxBytes) {
      return res.status(400).json({ error: 'المساحة المتبقية لا تكفي لأرشفة الملف' });
    }

    await ServerFile.findOneAndUpdate(
      { serverId: check.server._id, fileName: archiveName },
      { content, sizeBytes: bytes, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, archiveName, message: `تمت الأرشفة باسم ${archiveName}` });
  } catch (err) {
    res.status(400).json({ error: err.message || 'تعذرت أرشفة الملف' });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/servers/:id/files/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const check = await getAuthorizedServer(req.params.id, req.user);
    if (check.error) return res.status(check.code).json({ error: check.error });
    if (!req.file) return res.status(400).json({ error: 'لم يتم اختيار ملف' });

    const fileName = safeFileName(req.file.originalname);
    const content = req.file.buffer.toString('utf8');
    const newBytes = req.file.size;

    const existingFiles = await ServerFile.find({ serverId: check.server._id });
    const otherBytes = existingFiles
      .filter((f) => f.fileName !== fileName)
      .reduce((sum, f) => sum + (f.sizeBytes || 0), 0);

    const maxBytes = check.server.storageLimitMB * 1024 * 1024;
    if (otherBytes + newBytes > maxBytes) {
      return res.status(400).json({ error: 'حجم الملف يتجاوز المساحة المخصصة للسيرفر' });
    }

    await ServerFile.findOneAndUpdate(
      { serverId: check.server._id, fileName },
      { content, sizeBytes: newBytes, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, fileName });
  } catch (err) {
    res.status(400).json({ error: err.message || 'فشل رفع الملف' });
  }
});

app.delete('/api/servers/:id/files', requireAuth, async (req, res) => {
  try {
    const check = await getAuthorizedServer(req.params.id, req.user);
    if (check.error) return res.status(check.code).json({ error: check.error });

    const fileName = safeFileName(req.query.name);
    await ServerFile.deleteOne({ serverId: check.server._id, fileName });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/users', requireAuth, requireOwner, async (req, res) => {
  const users = await User.find().select('-password').sort({ createdAt: -1 });
  res.json({ users });
});

app.post('/api/users', requireAuth, requireOwner, async (req, res) => {
  try {
    const { username, password, role, maxServers, allocatedStorageMB, allocatedCpu } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'اسم المستخدم وكلمة السر مطلوبان' });
    }

    const exists = await User.findOne({ username: String(username).trim() });
    if (exists) {
      return res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);
    const created = await User.create({
      username: String(username).trim(),
      password: hashedPassword,
      role: role === 'owner' ? 'owner' : 'member',
      maxServers: Math.min(Number(maxServers || 2), 2),
      allocatedStorageMB: Number(allocatedStorageMB || 5120),
      allocatedCpu: Number(allocatedCpu || 150)
    });

    res.status(201).json({
      user: {
        _id: created._id,
        username: created.username,
        role: created.role,
        maxServers: created.maxServers,
        allocatedStorageMB: created.allocatedStorageMB,
        allocatedCpu: created.allocatedCpu
      }
    });
  } catch (err) {
    res.status(400).json({ error: 'تعذر إضافة العضو' });
  }
});

app.patch('/api/users/:id/allocations', requireAuth, requireOwner, async (req, res) => {
  try {
    const { allocatedStorageMB, allocatedCpu, maxServers } = req.body || {};
    const storageVal = Number(allocatedStorageMB);
    const cpuVal = Number(allocatedCpu);
    const serversVal = maxServers !== undefined ? Math.min(Math.max(Number(maxServers), 1), 2) : 2;

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      {
        allocatedStorageMB: storageVal,
        allocatedCpu: cpuVal,
        maxServers: serversVal
      },
      { new: true }
    ).select('-password');

    if (!updatedUser) return res.status(404).json({ error: 'العضو غير موجود' });

    await Server.updateMany(
      { owner: updatedUser._id },
      { storageLimitMB: storageVal, cpuLimit: cpuVal }
    );

    res.json({ user: updatedUser });
  } catch (err) {
    res.status(400).json({ error: 'تعذر تحديث موارد العضو' });
  }
});

io.on('connection', (socket) => {
  socket.on('join_server', (serverId) => {
    if (serverId) socket.join(`server_${serverId}`);
  });

  socket.on('console_command', ({ serverId, command }) => {
    if (serverId && command) {
      sendConsoleInput(serverId, command, io);
    }
  });
});

async function ensureAccounts() {
  const defaultAccounts = [
    {
      username: 'terbo',
      password: '73849274628491837465djfbfbrhdjzkkieueiwksndnxbxjxdjehrbrjfjjdhwwiowjddbskdb9283746518293746xkfbfbrhdjzjjkiieueiwksndnxbx',
      role: 'member',
      maxServers: 2,
      allocatedStorageMB: 5120,
      allocatedCpu: 150
    },
    {
      username: 'keo',
      password: process.env.OWNER_PASSWORD || '9pcvtGac',
      role: 'owner',
      maxServers: 2,
      allocatedStorageMB: 10240,
      allocatedCpu: 250
    },
    {
      username: 'eşref tek',
      password: '9pcvtGac',
      role: 'member',
      maxServers: 2,
      allocatedStorageMB: 5120,
      allocatedCpu: 150
    },
    {
      username: 'terbo2',
      password: '9pcvtGac',
      role: 'member',
      maxServers: 2,
      allocatedStorageMB: 5120,
      allocatedCpu: 150
    }
  ];

  for (const acc of defaultAccounts) {
    const exists = await User.findOne({ username: acc.username });
    if (!exists) {
      const hash = await bcrypt.hash(acc.password, 10);
      await User.create({
        username: acc.username,
        password: hash,
        role: acc.role,
        maxServers: acc.maxServers,
        allocatedStorageMB: acc.allocatedStorageMB,
        allocatedCpu: acc.allocatedCpu
      });
      console.log(`Created account: ${acc.username}`);
    }
  }
}

async function startApp() {
  if (!MONGO_URI) {
    console.error('Missing MONGO_URI environment variable');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  await ensureAccounts();

  httpServer.listen(PORT, () => {
    console.log(`Hosting panel listening on port ${PORT}`);
  });
}

startApp();
