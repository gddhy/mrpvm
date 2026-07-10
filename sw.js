/* MRP模拟器 Service Worker v2 */

var CACHE_NAME = 'vmrp-cache-v2';

// 核心资源: 必须缓存的页面和脚本
var CORE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon.png',
    './icon-512.png',
    './fs.js',
    './midi.js',
    './vmrp.js',
    './vmrp.wasm'
];

// 游戏数据文件 (按需缓存, 不阻塞安装)
var GAME_FILES = [
    './fs/cfunction.ext',
    './fs/mythroad/dsm_gm.mrp',
    './fs/mythroad/gxqds.mrp',
    './fs/mythroad/gyhzb.mrp',
    './fs/mythroad/mpc.mrp',
    './fs/mythroad/mpzc.mrp',
    './fs/mythroad/mynes.mrp',
    './fs/mythroad/opezip.mrp',
    './fs/mythroad/opmtyx.mrp',
    './fs/mythroad/txz.mrp',
    './fs/mythroad/winmine.mrp',
    './fs/mythroad/ydqtwo.mrp',
    './fs/mythroad/nes/tank.nes',
    './fs/mythroad/nes/超级玛丽中文.nes',
    './fs/mythroad/plugins/advbar.mrp',
    './fs/mythroad/plugins/flaengine.mrp',
    './fs/mythroad/plugins/netpay.mrp',
    './fs/mythroad/plugins/ose/brwcore.mrp',
    './fs/mythroad/system/gb12.uc2',
    './fs/mythroad/system/gb12v2.uc2',
    './fs/mythroad/system/gb16.uc2'
];

// 安装: 逐个缓存核心资源 (非原子, 单个失败不影响整体)
self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            // 逐个缓存, 某个文件失败不影响其他文件
            var promises = CORE_ASSETS.map(function (url) {
                return cache.add(url).catch(function (err) {
                    console.warn('[sw] 缓存失败: ' + url + ' - ' + err.message);
                });
            });
            return Promise.all(promises);
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
                    console.log('[sw] 清理旧缓存: ' + key);
                    return caches.delete(key);
                })
            );
        }).then(function () {
            // 后台缓存游戏文件 (不阻塞激活)
            caches.open(CACHE_NAME).then(function (cache) {
                GAME_FILES.forEach(function (url) {
                    cache.add(url).catch(function () {
                        // 个别游戏文件缓存失败不影响
                    });
                });
            });
            return self.clients.claim();
        })
    );
});

// 请求拦截
self.addEventListener('fetch', function (event) {
    var req = event.request;

    // 只处理 GET 请求
    if (req.method !== 'GET') return;

    // 非同源请求直接放行 (CDN 等)
    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // Range 请求直接放行 (大文件分片下载, 不缓存)
    if (req.headers.get('range')) return;

    // 导航请求: 网络优先 (确保 PWA 启动时获取最新 HTML)
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then(function (networkResponse) {
                if (networkResponse && networkResponse.status === 200) {
                    var clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(function (cache) {
                        cache.put(req, clone);
                    });
                }
                return networkResponse;
            }).catch(function () {
                // 网络失败, 尝试缓存
                return caches.match(req).then(function (cached) {
                    if (cached) return cached;
                    // 最终兜底: 返回缓存的 index.html
                    return caches.match('./index.html').then(function (fallback) {
                        if (fallback) return fallback;
                        return new Response(
                            '<html><body><h2>离线模式</h2><p>请连接网络后重试</p></body></html>',
                            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                        );
                    });
                });
            })
        );
        return;
    }

    // 静态资源: 缓存优先, 后台更新 (stale-while-revalidate)
    event.respondWith(
        caches.match(req).then(function (cached) {
            var fetchPromise = fetch(req).then(function (networkResponse) {
                if (networkResponse && networkResponse.status === 200) {
                    var clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(function (cache) {
                        cache.put(req, clone);
                    });
                }
                return networkResponse;
            }).catch(function () {
                // 网络失败, 如果有缓存则使用缓存 (已在前面返回)
                // 如果没有缓存, 返回空响应
                if (!cached) {
                    return new Response('', { status: 503, statusText: 'Offline' });
                }
            });

            // 有缓存则立即返回, 同时后台更新; 无缓存则等待网络
            return cached || fetchPromise;
        })
    );
});
