const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'keo_hosting_super_secret_key_2026';

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.panel_token;
    if (!token) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود' });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة' });
  }
}

function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'مسموح للمالك فقط' });
  }
  next();
}

module.exports = { requireAuth, requireOwner, JWT_SECRET };
