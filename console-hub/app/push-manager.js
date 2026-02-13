const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

class PushManager {
  constructor() {
    this.dataDir = path.join(__dirname, '..', 'data');
    this.keyFile = path.join(this.dataDir, 'vapid-keys.json');
    this.subFile = path.join(this.dataDir, 'push-subscriptions.json');
    this.subscriptions = [];
    this._init();
  }

  _init() {
    // Load or generate VAPID keys
    let keys;
    if (fs.existsSync(this.keyFile)) {
      keys = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
    } else {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(this.keyFile, JSON.stringify(keys, null, 2));
      console.log('Generated new VAPID keys');
    }

    webpush.setVapidDetails(
      'mailto:your-email@example.com',
      keys.publicKey,
      keys.privateKey
    );

    this.publicKey = keys.publicKey;

    // Load existing subscriptions
    if (fs.existsSync(this.subFile)) {
      try {
        this.subscriptions = JSON.parse(fs.readFileSync(this.subFile, 'utf8'));
      } catch {
        this.subscriptions = [];
      }
    }
  }

  subscribe(subscription) {
    // Avoid duplicates by endpoint
    const exists = this.subscriptions.find(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      this.subscriptions.push(subscription);
      fs.writeFileSync(this.subFile, JSON.stringify(this.subscriptions, null, 2));
    }
  }

  async notify(title, body, url) {
    const payload = JSON.stringify({ title, body, url });
    const expired = [];

    for (let i = 0; i < this.subscriptions.length; i++) {
      try {
        await webpush.sendNotification(this.subscriptions[i], payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          expired.push(i);
        }
        console.error('Push notification error:', err.message);
      }
    }

    // Remove expired subscriptions
    if (expired.length > 0) {
      this.subscriptions = this.subscriptions.filter((_, i) => !expired.includes(i));
      fs.writeFileSync(this.subFile, JSON.stringify(this.subscriptions, null, 2));
    }
  }
}

module.exports = PushManager;
