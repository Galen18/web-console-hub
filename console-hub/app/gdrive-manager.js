const { execSync, spawn } = require('child_process');
const fs = require('fs');

const MOUNT_POINT = process.env.GDRIVE_MOUNT || '/home/' + (process.env.USER || 'root') + '/gdrive';
const RCLONE_REMOTE = process.env.GDRIVE_REMOTE || 'gdrive';

class GDriveManager {
  constructor() {
    this.mountPoint = MOUNT_POINT;
    this.rcloneRemote = RCLONE_REMOTE;
  }

  status() {
    try {
      execSync(`mountpoint -q "${this.mountPoint}" 2>/dev/null`);
      return { mounted: true, path: this.mountPoint };
    } catch {
      return { mounted: false, path: this.mountPoint };
    }
  }

  async mount() {
    const st = this.status();
    if (st.mounted) return { success: true, message: 'Already mounted', path: this.mountPoint };

    // Check if rclone remote is configured
    try {
      const remotes = execSync('rclone listremotes 2>/dev/null').toString();
      if (!remotes.includes(`${this.rcloneRemote}:`)) {
        return { success: false, message: `rclone remote "${this.rcloneRemote}" not configured. Run: rclone config` };
      }
    } catch {
      return { success: false, message: 'rclone not available' };
    }

    // Create mount point
    execSync(`mkdir -p "${this.mountPoint}"`);

    // Mount with rclone
    const proc = spawn('rclone', [
      'mount', `${this.rcloneRemote}:`, this.mountPoint,
      '--vfs-cache-mode', 'full',
      '--vfs-cache-max-size', '5G',
      '--allow-other',
      '--daemon'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    proc.unref();

    // Wait and verify
    await new Promise(resolve => setTimeout(resolve, 3000));

    const verify = this.status();
    if (verify.mounted) {
      return { success: true, message: 'Google Drive mounted', path: this.mountPoint };
    } else {
      return { success: false, message: 'Mount failed - check rclone config' };
    }
  }

  unmount() {
    const st = this.status();
    if (!st.mounted) return { success: true, message: 'Not mounted' };

    try {
      execSync(`fusermount -uz "${this.mountPoint}" 2>/dev/null`);
      return { success: true, message: 'Google Drive unmounted' };
    } catch (e) {
      return { success: false, message: `Unmount failed: ${e.message}` };
    }
  }
}

module.exports = GDriveManager;
