const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['owner', 'member'], default: 'member' },
  maxServers: { type: Number, default: 2 },
  allocatedStorageMB: { type: Number, default: 5120 },
  allocatedCpu: { type: Number, default: 150 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
