/* MRP模拟器 Service Worker */

var CACHE_NAME = 'vmrp-cache-v2';

// 核心资源: 必须缓存的页面和脚本
var CORE_ASSETS = [
    '/dev/',
    '/dev/index.html',
    '/dev/manifest.json',
    '/dev/icon.png',
    '/dev/icon-512.png',
    '/dev/fs.js',
    '/dev/midi.js',
    '/dev/vmrp.js',
    '/dev/vmrp.wasm'
];

// 游戏数据文件 (按需缓存)
var GAME_FILES = [
    '/dev/fs/cfunction.ext',
    '/dev/fs/mythroad/dsm_gm.mrp',
    '/dev/fs/mythroad/gxqds.mrp',
    '/dev/fs/mythroad/gyhzb.mrp',
    '/dev/fs/mythroad/mpc.mrp',
    '/dev/fs/mythroad/mpzc.mrp',
    '/dev/fs/mythroad/mynes.mrp',
    '/dev/fs/mythroad/opezip.mrp',
    '/dev/fs/mythroad/opmtyx.mrp',
    '/dev/fs/mythroad/txz.mrp',
    '/dev/fs/mythroad/winmine.mrp',
    '/dev/fs/mythroad/ydqtwo.mrp',
    '/dev/fs/mythroad/nes/tank.nes',
    '/dev/fs/mythroad/nes/超级玛丽中文.nes',
    '/dev/fs/mythroad/plugins/advbar.mrp',
    '/dev/fs/mythroad/plugins/flaengine.mrp',
    '/dev/fs/mythroad/plugins/netpay.mrp',
    '/dev/fs/mythroad/plugins/ose/brwcore.mrp',
    '/dev/fs/mythroad/system/gb12.uc2',
    '/dev/fs/mythroad/system/gb12v2.uc2',
    '/dev/fs/mythroad/system/gb16.uc2'
];

// 安装: 缓存核心资源, 然后台缓存游戏文件
self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            // 先缓存核心资源
            return cache.addAll(CORE_ASSETS).then(function () {
                // 后台缓存游戏文件 (不阻塞安装)
                GAME_FILES.forEach(function (url) {
                    cache.add(url).catch(function () {
                        // 个别游戏文件缓存失败不影响安装
                    });
                });
                return Promise.resolve();
            });
        }).then(function () {
            // 立即激活, 不等待旧 SW 关闭
            return self.skipWaiting();
        })
    );
});

// 激活: 清理旧缓存, 立即接管
self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(
                keys.filter(function (key) {
                    return key !== CACHE_NAME;
                }).map(function (key) {
                    return caches.delete(key);
                })
            );
        }).then(function () {
            return self.clients.claim();
        })
    );
});

// 请求拦截: 缓存优先, 回退到网络
self.addEventListener('fetch', function (event) {
    // 只处理 GET 请求
    if (event.request.method !== 'GET') return;

    // 非同源请求直接放行 (vconsole CDN 等)
    if (!event.request.url.startsWith(self.location.origin)) return;

    event.respondWith(
        caches.match(event.request).then(function (cached) {
            if (cached) {
                // 有缓存则返回, 同时后台更新 (stale-while-revalidate)
                var fetchPromise = fetch(event.request).then(function (networkResponse) {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_NAME).then(function (cache) {
                            cache.put(event.request, networkResponse.clone());
                        });
                    }
                    return networkResponse;
                }).catch(function () {
                    // 网络请求失败不影响已返回的缓存
                });
                return cached;
            }

            // 无缓存, 从网络获取并缓存
            return fetch(event.request).then(function (networkResponse) {
                if (networkResponse && networkResponse.status === 200) {
                    var responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then(function (cache) {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            }).catch(function () {
                // 网络失败, 对于 HTML 返回离线页面
                if (event.request.mode === 'navigate') {
                    return caches.match('/dev/index.html');
                }
                return new Response('Offline', { status: 503 });
            });
        })
    );
});
