const mongoose = require('mongoose');

const serverFileSchema = new mongoose.Schema({
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true },
  fileName: { type: String, required: true },
  content: { type: String, default: '' },
  sizeBytes: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

serverFileSchema.index({ serverId: 1, fileName: 1 }, { unique: true });

module.exports = mongoose.model('ServerFile', serverFileSchema);
