// Web Console Hub — Service Worker for Push Notifications

self.addEventListener('push', function(event) {
  var data = { title: 'Web Console Hub', body: 'Notification', url: '/console/' };
  try {
    data = event.data.json();
  } catch(e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/console/favicon.ico',
      badge: '/console/favicon.ico',
      data: { url: data.url || '/console/' },
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = event.notification.data.url || '/console/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(url) !== -1 && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
