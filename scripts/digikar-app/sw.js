// ============================================================
// デジスマ PWA - Service Worker
// オフラインでもランチャー画面を表示できるようにキャッシュする
// ============================================================

const CACHE_NAME = 'digikar-app-v1';
const ASSETS = [
    './index.html',
    './manifest.json',
];

// インストール時：必要なファイルをキャッシュに保存
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    // 即座にアクティブ化
    self.skipWaiting();
});

// アクティベート時：古いキャッシュを削除
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// フェッチ時：キャッシュ優先、なければネットワーク
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
});
