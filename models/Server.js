const mongoose = require('mongoose');

const serverSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  storageLimitMB: { type: Number, required: true },
  cpuLimit: { type: Number, required: true },
  startupFile: { type: String, default: 'index.js' },
  status: { type: String, enum: ['offline', 'running'], default: 'offline' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Server', serverSchema);
