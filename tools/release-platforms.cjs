'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const manifestPath = path.join(ROOT, 'release-platforms.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.platforms) || manifest.platforms.length !== 3) {
  throw new Error('release-platforms.json must contain exactly three schema v1 platforms');
}
const platforms = manifest.platforms;
const byRid = new Map(platforms.map(platform => [platform.rid, platform]));
if (byRid.size !== platforms.length) throw new Error('release-platforms.json contains duplicate RIDs');

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function validateNativeBytes(platform, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  if (platform.format === 'pe-x86_64') {
    if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return false;
    const pe = buffer.readUInt32LE(0x3c);
    return pe + 6 <= buffer.length && buffer.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0])) && buffer.readUInt16LE(pe + 4) === 0x8664;
  }
  if (platform.format === 'elf-x86_64') return buffer.length >= 20 && buffer[0] === 0x7f && buffer.subarray(1, 4).toString('ascii') === 'ELF' && buffer[4] === 2 && buffer.readUInt16LE(18) === 0x3e;
  if (platform.format === 'macho-x86_64') return buffer.length >= 8 && buffer.subarray(0, 4).toString('hex') === 'cffaedfe' && buffer.readUInt32LE(4) === 0x01000007;
  return false;
}
function stagedPath(platform, releaseRoot = path.join(ROOT, 'release')) { return path.join(releaseRoot, 'bin', 'server', platform.rid, platform.stagedBinary); }
function validateStagedServers(releaseRoot = path.join(ROOT, 'release')) {
  const errors = []; const hashes = new Set();
  for (const platform of platforms) {
    const file = stagedPath(platform, releaseRoot);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { errors.push('missing ' + path.relative(ROOT, file)); continue; }
    const bytes = fs.readFileSync(file);
    if (!validateNativeBytes(platform, bytes)) errors.push('invalid ' + platform.format + ' binary: ' + path.relative(ROOT, file));
    hashes.add(sha256(bytes));
    if (platform.rid !== 'win-x64' && process.platform !== 'win32' && (fs.statSync(file).mode & 0o111) === 0) errors.push('not executable: ' + path.relative(ROOT, file));
  }
  if (hashes.size !== platforms.length) errors.push('native server artifacts are not three distinct binaries');
  const serverRoot = path.join(releaseRoot, 'bin', 'server');
  if (fs.existsSync(serverRoot)) {
    const expected = new Set(platforms.map(platform => path.resolve(stagedPath(platform, releaseRoot))));
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (!expected.has(path.resolve(full))) errors.push('unexpected server artifact: ' + path.relative(ROOT, full)); } };
    walk(serverRoot);
  }
  return errors;
}
module.exports = { ROOT, manifest, platforms, byRid, sha256, validateNativeBytes, stagedPath, validateStagedServers };
