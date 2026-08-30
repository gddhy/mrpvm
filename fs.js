var Module = typeof Module !== 'undefined' ? Module : {};
(function () {
    'use strict';

    /* ====================================================================
     * 游戏进度本地持久化模块
     *
     * 存储方式：IndexedDB (无容量限制, 直接存二进制)
     * 加载优先级：IndexedDB -> 服务器
     * 同步策略：FS 文件变动实时同步到 IndexedDB (writeFile/unlink 拦截)
     * ==================================================================== */

    var SAVE_INDEX_KEY = 'vmrp_save_index'; // 仅用于迁移清理旧 localStorage 数据
    var urlParamFile = null;
    var serverPath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1) + 'fs/';

    /* ====================================================================
     * 外部 mrp 运行状态 (供 index.html 的退出弹窗判断"重新运行当前Mrp"是否可用)
     *   vmrpExternalRun   : 是否正在运行外部 mrp (?f= 链接调用 或 PWA launchQueue 传入)
     *   vmrpLaunchFileName: 当前外部 mrp 的文件名 (launchQueue 场景)
     *   vmrpRelaunchSaved : launchQueue 文件是否已记录到 sessionStorage, 可支持重新运行
     * ==================================================================== */
    window.vmrpExternalRun = false;
    window.vmrpLaunchFileName = null;
    window.vmrpRelaunchSaved = false;

    // 页面加载类型: 刷新(reload)时系统不会再次触发 launchQueue, 无需等待启动文件
    var isPageReload = false;
    try {
        var navEntries = performance.getEntriesByType('navigation');
        if (navEntries.length > 0) isPageReload = (navEntries[0].type === 'reload');
    } catch (e) { /* 忽略 */ }

    // "打开应用列表"跳转前设置的标记: 页面内导航同样不会触发系统启动事件
    var skipLaunchWait = false;
    try {
        if (sessionStorage.getItem('vmrp_skip_launch_wait') === '1') {
            skipLaunchWait = true;
            sessionStorage.removeItem('vmrp_skip_launch_wait');
        }
    } catch (e) { /* 忽略 */ }

    /* ====================================================================
     * PWA File Handling API — 支持安装为 PWA 后用系统"打开方式"打开本地 mrp 文件
     *
     * 原理: manifest.json 中注册 file_handlers 后, 系统用本应用打开 .mrp 文件时,
     * 浏览器会通过 window.launchQueue 把文件句柄传进来。
     * 这里在脚本解析阶段(尽可能早)就注册 consumer, 读取第一个 mrp 文件的数据,
     * 然后在 preRun 加载 dsm_gm.mrp 时直接把数据写入 FS(等同 ?f= 的自动运行机制,
     * 且同样不持久化到 IndexedDB), 模拟器启动后即自动运行该 mrp。
     * ==================================================================== */

    var launchFilePromise = null;   // 等待启动文件的 Promise (resolve {name,data} 或 null)
    var launchFileResolve = null;
    var launchFileSettled = false;  // preRun 等待是否已结束 (超时或已消费)

    function launchToast(msg) {
        if (typeof window.showToast === 'function') window.showToast(msg, 3500);
        console.log('[vmrp-launch] ' + msg);
    }

    (function initLaunchQueue() {
        if (!('launchQueue' in window) || typeof window.launchQueue.setConsumer !== 'function') {
            return; // 浏览器不支持 File Handling API
        }
        // 仅在安装为 PWA (standalone) 运行时才让 preRun 等待启动文件,
        // 普通浏览器标签页不可能有文件启动, 不等待以免拖慢加载
        var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                           window.navigator.standalone === true;
        if (isStandalone) {
            launchFilePromise = new Promise(function (resolve) {
                launchFileResolve = resolve;
            });
        }
        window.launchQueue.setConsumer(async function (launchParams) {
            var result = null;
            try {
                if (launchParams.files && launchParams.files.length > 0) {
                    // 多个文件时只处理第一个
                    var handle = launchParams.files[0];
                    var file = await handle.getFile();
                    if (/\.mrp$/i.test(file.name)) {
                        var buf = new Uint8Array(await file.arrayBuffer());
                        result = { name: file.name, data: buf };
                        console.log('[vmrp-launch] 收到本地 mrp 文件: ' + file.name + ' (' + buf.length + ' 字节)');
                    } else {
                        launchToast('不支持的文件类型: ' + file.name + ' (仅支持 .mrp)');
                    }
                }
            } catch (e) {
                console.warn('[vmrp-launch] 读取启动文件失败: ' + e.message);
            }
            // 本次系统启动未携带 mrp 文件: 清除旧的"重新运行"记录, 避免误恢复
            if (!result) {
                clearRelaunchFile();
            }
            if (launchFileResolve && !launchFileSettled) {
                // preRun 还在等待: 交给 dsm_gm.mrp 加载流程, 启动后自动运行
                launchFileResolve(result);
                launchFileResolve = null;
            } else if (result) {
                // 模拟器已经(或即将)按正常流程启动: 退化为导入文件
                handleLateLaunchFile(result);
            }
        });
    })();

    // 等待启动文件, 最多 timeoutMs 毫秒 (正常启动时 consumer 通常在几十毫秒内触发)
    function waitLaunchFile(timeoutMs) {
        return Promise.race([
            launchFilePromise,
            new Promise(function (resolve) { setTimeout(function () { resolve(null); }, timeoutMs); })
        ]).then(function (r) {
            launchFileSettled = true;
            return r;
        });
    }

    // 启动文件来得太晚 (模拟器已按正常流程启动): 写入 /mythroad 作为普通导入
    function handleLateLaunchFile(result) {
        function doWrite() {
            try {
                FS.writeFile('/mythroad/' + result.name, result.data);
                launchToast('已导入 ' + result.name + ', 请在模拟器列表中打开');
            } catch (e) {
                console.warn('[vmrp-launch] 导入失败: ' + e.message);
            }
        }
        if (typeof FS !== 'undefined' && !skipSync) {
            doWrite();
        } else {
            // FS 尚未就绪, 等 postRun 之后再写
            var timer = setInterval(function () {
                if (typeof FS !== 'undefined' && !skipSync) {
                    clearInterval(timer);
                    doWrite();
                }
            }, 500);
            setTimeout(function () { clearInterval(timer); }, 30000);
        }
    }

    /* ====================================================================
     * "重新运行当前Mrp"支持 — 记录 launchQueue 传入的外部 mrp 到 sessionStorage
     *
     * ?f= 场景下, 刷新 URL 即可重新运行; 但 PWA launchQueue 场景下刷新页面
     * 不会再次触发系统启动事件, 因此把文件数据暂存到 sessionStorage
     * (仅当前标签页有效, 关闭即清除), 页面重载后由 preRun 恢复并自动运行。
     * ==================================================================== */

    var RELAUNCH_KEY = 'vmrp_launch_file';

    function arrayToBase64(u8) {
        var bin = '';
        var CHUNK = 0x8000;
        for (var i = 0; i < u8.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }

    function base64ToArray(b64) {
        var bin = atob(b64);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }

    // 记录当前外部 mrp, 供"重新运行当前Mrp"使用; 成功返回 true (存储超限等失败返回 false)
    function saveRelaunchFile(info) {
        try {
            sessionStorage.setItem(RELAUNCH_KEY, JSON.stringify({
                name: info.name,
                data: arrayToBase64(info.data)
            }));
            return true;
        } catch (e) {
            console.warn('[vmrp-launch] 记录重新运行文件失败: ' + e.message);
            return false;
        }
    }

    function clearRelaunchFile() {
        try { sessionStorage.removeItem(RELAUNCH_KEY); } catch (e) { }
    }

    // 读取"重新运行"记录, 返回 {name, data} 或 null
    function getRelaunchFile() {
        try {
            var raw = sessionStorage.getItem(RELAUNCH_KEY);
            if (!raw) return null;
            var obj = JSON.parse(raw);
            if (!obj || !obj.name || !obj.data) return null;
            return { name: obj.name, data: base64ToArray(obj.data) };
        } catch (e) {
            return null;
        }
    }

    /* ====================================================================
     * IndexedDB 存储模块 (存文件数据, 无容量限制)
     * ==================================================================== */

    var IDB_SAVE_DB = 'vmrp_saves';
    var IDB_SAVE_STORE = 'files';
    var IDB_SAVE_VERSION = 1;
    var idbSaveDb = null; // 缓存数据库连接, 避免每次都重新打开

    function idbSaveOpen() {
        if (idbSaveDb) return Promise.resolve(idbSaveDb);
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(IDB_SAVE_DB, IDB_SAVE_VERSION);
            req.onupgradeneeded = function () {
                var store = req.result.createObjectStore(IDB_SAVE_STORE);
                store.createIndex('path', 'path', { unique: true });
            };
            req.onsuccess = function () {
                idbSaveDb = req.result;
                idbSaveDb.onclose = function () { idbSaveDb = null; };
                resolve(idbSaveDb);
            };
            req.onerror = function () { reject(req.error); };
            req.onblocked = function () {
                console.warn('[vmrp-idb] 数据库被阻塞, 可能需要关闭其他标签页');
            };
        });
    }

    // 保存文件数据到 IndexedDB (直接存 Uint8Array, 不需要 base64)
    async function saveToStorage(path, data) {
        try {
            var db = await idbSaveOpen();
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_SAVE_STORE, 'readwrite');
                var store = tx.objectStore(IDB_SAVE_STORE);
                store.put({ path: path, data: data, timestamp: Date.now() }, path);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () {
                    console.warn('[vmrp-save] IDB 保存失败 ' + path + ': ' + tx.error);
                    reject(tx.error);
                };
            });
        } catch (e) {
            console.warn('[vmrp-save] IDB 保存异常 ' + path + ': ' + e.message);
            return false;
        }
    }

    // 从 IndexedDB 加载文件数据
    async function loadFromStorage(path) {
        try {
            var db = await idbSaveOpen();
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_SAVE_STORE, 'readonly');
                var store = tx.objectStore(IDB_SAVE_STORE);
                var getReq = store.get(path);
                getReq.onsuccess = function () {
                    var result = getReq.result;
                    if (result && result.data) {
                        resolve(result.data);
                    } else {
                        resolve(null);
                    }
                };
                getReq.onerror = function () {
                    console.warn('[vmrp-save] IDB 读取失败 ' + path + ': ' + getReq.error);
                    resolve(null);
                };
            });
        } catch (e) {
            console.warn('[vmrp-save] IDB 读取异常 ' + path + ': ' + e.message);
            return null;
        }
    }

    // 从 IndexedDB 删除单个文件
    async function deleteFromStorage(path) {
        try {
            var db = await idbSaveOpen();
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_SAVE_STORE, 'readwrite');
                tx.objectStore(IDB_SAVE_STORE).delete(path);
                tx.oncomplete = function () {
                    console.log('[vmrp-sync] IDB 删除: ' + path);
                    resolve(true);
                };
                tx.onerror = function () {
                    console.warn('[vmrp-sync] IDB 删除失败 ' + path);
                    resolve(false);
                };
            });
        } catch (e) {
            console.warn('[vmrp-sync] IDB 删除异常 ' + path + ': ' + e.message);
            return false;
        }
    }

    // 清空 IndexedDB 中所有文件数据
    async function clearStorageAll() {
        try {
            var db = await idbSaveOpen();
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_SAVE_STORE, 'readwrite');
                tx.objectStore(IDB_SAVE_STORE).clear();
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { resolve(false); };
            });
        } catch (e) {
            return false;
        }
    }

    // 获取 IndexedDB 中所有文件路径列表
    async function getStoragePaths() {
        try {
            var db = await idbSaveOpen();
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_SAVE_STORE, 'readonly');
                var store = tx.objectStore(IDB_SAVE_STORE);
                var getAllReq = store.getAllKeys();
                getAllReq.onsuccess = function () {
                    resolve(getAllReq.result || []);
                };
                getAllReq.onerror = function () {
                    resolve([]);
                };
            });
        } catch (e) {
            return [];
        }
    }

    // 计算 IndexedDB 中所有文件的总大小
    async function getStorageSize() {
        try {
            var db = await idbSaveOpen();
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_SAVE_STORE, 'readonly');
                var store = tx.objectStore(IDB_SAVE_STORE);
                var getAllReq = store.getAll();
                getAllReq.onsuccess = function () {
                    var items = getAllReq.result || [];
                    var total = 0;
                    for (var i = 0; i < items.length; i++) {
                        if (items[i].data) total += items[i].data.length;
                    }
                    resolve(total);
                };
                getAllReq.onerror = function () { resolve(0); };
            });
        } catch (e) {
            return 0;
        }
    }

    /* ====================================================================
     * localStorage 索引 (仅用于迁移清理旧数据, 不再维护)
     * ==================================================================== */

    function getSaveIndex() {
        try {
            return JSON.parse(localStorage.getItem(SAVE_INDEX_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    /* ====================================================================
     * Emscripten FS 辅助工具
     * ==================================================================== */

    function ensureDir(path) {
        if (!path || path === '/') return;
        try {
            var stat = FS.stat(path);
            if (FS.isDir(stat.mode)) return;
        } catch (e) { /* 不存在, 继续创建 */ }
        var parent = path.substring(0, path.lastIndexOf('/'));
        ensureDir(parent);
        try { FS.mkdir(path); } catch (e) { /* 可能已被创建 */ }
    }

    function scanDir(path) {
        var result = [];
        try {
            var entries = FS.readdir(path);
            for (var i = 0; i < entries.length; i++) {
                var name = entries[i];
                if (name === '.' || name === '..') continue;
                var sep = (path.charAt(path.length - 1) === '/') ? '' : '/';
                var fullPath = path + sep + name;
                try {
                    var stat = FS.stat(fullPath);
                    if (FS.isDir(stat.mode)) {
                        result = result.concat(scanDir(fullPath));
                    } else {
                        result.push(fullPath);
                    }
                } catch (e) { /* 跳过异常项 */ }
            }
        } catch (e) { /* 目录不存在 */ }
        return result;
    }

    /* ====================================================================
     * FS 实时同步模块 — 拦截 writeFile / unlink / rename, 实时同步到 IndexedDB
     *
     * 在 postRun 中安装钩子, 替换 FS.writeFile / FS.unlink / FS.rename:
     *   - writeFile: 写入 FS 后, 立即异步写入 IndexedDB
     *   - unlink: 从 FS 删除后, 立即异步从 IndexedDB 删除
     *   - rename: 重命名后, 删除旧路径, 写入新路径
     *
     * 初始加载阶段 (skipSync=true) 不触发同步, 避免重复写入
     * 对账机制: saveAll 时对比 FS 文件列表与 IndexedDB keys, 清理孤儿记录
     * ==================================================================== */

    var skipSync = true; // 初始加载阶段跳过同步, postRun 完成后改为 false
    var syncWriteQueue = []; // 写入队列, 避免 IndexedDB 并发事务过多

    // 处理写入队列 (串行执行, 防止 IndexedDB 事务冲突)
    var processingQueue = false;
    async function processSyncQueue() {
        if (processingQueue) return;
        processingQueue = true;
        while (syncWriteQueue.length > 0) {
            var item = syncWriteQueue.shift();
            try {
                if (item.type === 'write') {
                    await saveToStorage(item.path, item.data);
                } else if (item.type === 'delete') {
                    await deleteFromStorage(item.path);
                }
            } catch (e) {
                console.warn('[vmrp-sync] 同步失败: ' + e.message);
            }
        }
        processingQueue = false;
    }

    // 入队同步操作 (异步执行, 不阻塞 FS 操作)
    function enqueueSync(type, path, data) {
        syncWriteQueue.push({ type: type, path: path, data: data });
        processSyncQueue();
    }

    // 判断路径是否在 /mythroad 下 (含子目录)
    function isMythroadPath(path) {
        if (!path) return false;
        return path.indexOf('/mythroad/') === 0 || path === '/mythroad';
    }

    // 对账: 清理 IndexedDB 中 FS 已不存在的孤儿记录
    async function reconcileStorage() {
        if (typeof FS === 'undefined') return;
        try {
            var idbPaths = await getStoragePaths();
            var fsPaths = {};
            var fsFileList = scanDir('/mythroad');
            for (var i = 0; i < fsFileList.length; i++) {
                fsPaths[fsFileList[i]] = true;
            }
            // 也不要清理预加载文件 (它们在 FS 中存在但可能还没加载)
            for (var p in preloadFileSet) {
                fsPaths[p] = true;
            }

            var orphanCount = 0;
            for (var k = 0; k < idbPaths.length; k++) {
                var idbPath = idbPaths[k];
                if (!fsPaths[idbPath]) {
                    // IndexedDB 中有但 FS 中没有 → 删除
                    await deleteFromStorage(idbPath);
                    orphanCount++;
                }
            }
            if (orphanCount > 0) {
                console.log('[vmrp-sync] 对账: 清理了 ' + orphanCount + ' 个孤儿记录');
            }
        } catch (e) {
            console.warn('[vmrp-sync] 对账失败: ' + e.message);
        }
    }

    // 安装 FS 钩子 (在 postRun 中调用)
    function installFSHooks() {
        if (typeof FS === 'undefined') {
            console.warn('[vmrp-sync] FS 不可用, 无法安装钩子');
            return;
        }

        // 保存原始方法
        var originalWriteFile = FS.writeFile;
        var originalUnlink = FS.unlink;
        var originalRename = FS.rename;

        // 替换 FS.writeFile: 写入后实时同步到 IndexedDB
        FS.writeFile = function (path, data, opts) {
            // 调用原始方法写入 FS
            var result = originalWriteFile.call(FS, path, data, opts);

            // 同步到 IndexedDB (跳过初始加载阶段和 urlParamFile)
            if (!skipSync && isMythroadPath(path)) {
                if (urlParamFile && path === urlParamFile) return result;

                // 获取写入的数据 (可能是 string 或 Uint8Array)
                var writeData;
                try {
                    writeData = FS.readFile(path);
                } catch (e) {
                    return result;
                }
                enqueueSync('write', path, writeData);
            }

            return result;
        };

        // 替换 FS.unlink: 删除后实时同步从 IndexedDB 删除
        // 使用 try-finally 确保即使原始 unlink 抛异常也能同步删除
        FS.unlink = function (path) {
            var success = false;
            try {
                var result = originalUnlink.call(FS, path);
                success = true;
                return result;
            } finally {
                // 无论成功还是失败, 只要路径匹配就尝试从 IndexedDB 删除
                // (文件可能已经从 FS 删除了, 但 IndexedDB 还有残留)
                if (!skipSync && isMythroadPath(path)) {
                    enqueueSync('delete', path, null);
                }
            }
        };

        // 替换 FS.rename: 重命名后同步 (旧路径删除, 新路径写入)
        if (originalRename) {
            FS.rename = function (oldPath, newPath) {
                var result = originalRename.call(FS, oldPath, newPath);
                if (!skipSync) {
                    // 旧路径从 IndexedDB 删除
                    if (isMythroadPath(oldPath)) {
                        enqueueSync('delete', oldPath, null);
                    }
                    // 新路径写入 IndexedDB
                    if (isMythroadPath(newPath)) {
                        if (urlParamFile && newPath === urlParamFile) return result;
                        try {
                            var data = FS.readFile(newPath);
                            enqueueSync('write', newPath, data);
                        } catch (e) { /* 跳过 */ }
                    }
                }
                return result;
            };
        }

        console.log('[vmrp-sync] FS 钩子已安装 (writeFile/unlink/rename → IndexedDB 实时同步)');
    }

    /* ====================================================================
     * 核心保存/加载逻辑
     * ==================================================================== */

    var fileSizes = {};
    var preloadFileSet = {};
    var savesCleared = false;

    // 全量保存 (仅用于手动"保存进度"按钮)
    // 同时执行对账, 清理 IndexedDB 中的孤儿记录
    async function saveAll(force) {
        if (typeof FS === 'undefined') return 0;
        if (savesCleared) return 0;
        var paths = scanDir('/mythroad');
        var saved = 0, skipped = 0, skippedUrl = 0;
        var idbPromises = [];

        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            if (urlParamFile && p === urlParamFile) { skippedUrl++; continue; }
            try {
                var stat = FS.stat(p);
                var data = FS.readFile(p);
                idbPromises.push(saveToStorage(p, data).then(function (ok) {
                    if (ok) saved++;
                }));
                fileSizes[p] = stat.size;
            } catch (e) { /* 跳过异常文件 */ }
        }

        await Promise.all(idbPromises);

        // 对账: 清理 IndexedDB 中 FS 已不存在的孤儿记录
        await reconcileStorage();

        if (saved > 0 || force) {
            console.log('[vmrp-save] 全量保存: ' + saved + ' 个文件' +
                        (skippedUrl > 0 ? ', ' + skippedUrl + ' 个链接文件跳过' : '') +
                        ' (IndexedDB)');
        }
        return saved;
    }

    // 从 IndexedDB 加载不在预加载列表中的额外存档文件
    // 加载完成后执行对账, 清理 IndexedDB 中的孤儿记录
    async function loadExtraSavesAsync() {
        if (typeof FS === 'undefined') return;

        var idbPaths = await getStoragePaths();
        var loaded = 0;

        for (var k = 0; k < idbPaths.length; k++) {
            var p = idbPaths[k];
            if (preloadFileSet[p]) continue;

            var data = await loadFromStorage(p);
            if (data) {
                try {
                    var parent = p.substring(0, p.lastIndexOf('/'));
                    ensureDir(parent);
                    FS.writeFile(p, data);
                    fileSizes[p] = data.length;
                    loaded++;
                    console.log('[vmrp-save] 恢复存档: ' + p);
                } catch (e) {
                    console.warn('[vmrp-save] 恢复失败 ' + p + ': ' + e.message);
                }
            }
        }

        if (loaded > 0) {
            console.log('[vmrp-save] 恢复了 ' + loaded + ' 个额外存档文件');
        }

        // 对账: 清理 IndexedDB 中 FS 已不存在的孤儿记录
        // (捕获上次会话中可能遗漏的删除操作)
        await reconcileStorage();
    }

    async function clearAllSaves() {
        // 先统计实际存档数量 (在清除之前读取 IndexedDB 中的文件路径)
        var savedPaths = await getStoragePaths();

        await clearStorageAll();

        localStorage.removeItem(SAVE_INDEX_KEY);

        // 清除旧的 localStorage 文件数据 (迁移遗留)
        var oldIndex = getSaveIndex();
        for (var i = 0; i < oldIndex.length; i++) {
            localStorage.removeItem('vmrp_save_' + oldIndex[i]);
        }

        fileSizes = {};
        savesCleared = true;
        console.log('[vmrp-save] 已清除 ' + savedPaths.length + ' 个存档文件 (IndexedDB)');
        return savedPaths.length;
    }

    function initFileSizes() {
        if (typeof FS === 'undefined') return;
        var paths = scanDir('/mythroad');
        for (var i = 0; i < paths.length; i++) {
            try {
                var stat = FS.stat(paths[i]);
                fileSizes[paths[i]] = stat.size;
            } catch (e) { /* 跳过 */ }
        }
    }

    /* ====================================================================
     * 预加载阶段 (preRun)
     * ==================================================================== */

    function fetchArrayBuffer(url) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(new Uint8Array(xhr.response));
                } else {
                    reject(new Error('HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function () { reject(new Error('Network error')); };
            xhr.send();
        });
    }

    /* ====================================================================
     * res=<url.zip> 资源包支持
     *
     * 链接包含 res=<zip地址> 时, 先把该 zip 下载到内存, 解压到 FS 的
     * /mythroad 目录 (含子目录), 完成后再加载运行 ?f= 指定的 mrp 或
     * 默认的 dsm_gm.mrp。原有加载流程不受影响。
     * 兼容性: 支持 store(0) / deflate(8) 两种压缩方式, 中文文件名
     * (UTF-8 标志位或 GBK 编码) 自动识别。
     * ==================================================================== */

    function isZipUrl(u) {
        try {
            var p = String(u).split('#')[0].split('?')[0];
            return /\.zip$/i.test(p);
        } catch (e) {
            return false;
        }
    }

    function setResStatus(text) {
        try {
            if (typeof statusElement !== 'undefined' && statusElement) {
                statusElement.innerHTML = text;
            }
        } catch (e) { /* 忽略 */ }
        console.log('[vmrp-res] ' + text);
    }

    // 清洗 zip 条目名, 防路径穿越, 返回相对路径或 null
    function sanitizeZipEntryName(name) {
        var n = String(name).replace(/\\/g, '/');
        var parts = n.split('/');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (p === '' || p === '.') continue;
            if (p === '..') return null; // 禁止路径穿越
            if (i === 0 && /^[a-zA-Z]:$/.test(p)) continue; // Windows 盘符
            out.push(p);
        }
        if (out.length === 0) return null;
        return out.join('/');
    }

    // deflate-raw 解压 (浏览器原生 DecompressionStream)
    async function inflateRaw(data) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('当前浏览器不支持 DecompressionStream, 无法解压 deflate 压缩的 zip');
        }
        var ds = new DecompressionStream('deflate-raw');
        var stream = new Blob([data]).stream().pipeThrough(ds);
        var buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
    }

    // 解析 zip (内存中), 返回 [{name, data}] 数组
    async function parseZipEntries(data) {
        var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

        // 从尾部向前查找 EOCD (End Of Central Directory)
        var eocdPos = -1;
        var minPos = Math.max(0, data.length - 22 - 65535);
        for (var i = data.length - 22; i >= minPos; i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocdPos = i; break; }
        }
        if (eocdPos < 0) throw new Error('未找到 ZIP 结束标记 (EOCD)');

        var entryCount = dv.getUint16(eocdPos + 10, true);
        var cdOffset = dv.getUint32(eocdPos + 16, true);
        var entries = [];
        var pos = cdOffset;

        for (var e = 0; e < entryCount; e++) {
            if (pos + 46 > data.length || dv.getUint32(pos, true) !== 0x02014b50) {
                throw new Error('ZIP 中央目录损坏');
            }
            var flag = dv.getUint16(pos + 8, true);
            var method = dv.getUint16(pos + 10, true);
            var compSize = dv.getUint32(pos + 20, true);
            var nameLen = dv.getUint16(pos + 28, true);
            var extraLen = dv.getUint16(pos + 30, true);
            var commentLen = dv.getUint16(pos + 32, true);
            var lfhOffset = dv.getUint32(pos + 42, true);
            var nameBytes = data.subarray(pos + 46, pos + 46 + nameLen);

            // 文件名编码: 标志位 bit11 (0x0800) 置位为 UTF-8,
            // 否则按中文环境下常见的 GBK 解码 (纯 ASCII 两种编码结果一致)
            var name;
            var utf8Name = null, gbkName = null;
            try { utf8Name = new TextDecoder('utf-8').decode(nameBytes); } catch (e2) { }
            try { gbkName = new TextDecoder('gbk').decode(nameBytes); } catch (e3) { }
            if (flag & 0x0800) {
                name = utf8Name;
            } else {
                name = gbkName || utf8Name;
            }

            // 目录条目跳过
            if (name.charAt(name.length - 1) === '/') {
                pos += 46 + nameLen + extraLen + commentLen;
                continue;
            }

            // 定位本地文件头中的数据起点 (本地头的 extra 长度可能与中央目录不同)
            if (lfhOffset + 30 > data.length || dv.getUint32(lfhOffset, true) !== 0x04034b50) {
                throw new Error('ZIP 本地文件头损坏: ' + name);
            }
            var lfhNameLen = dv.getUint16(lfhOffset + 26, true);
            var lfhExtraLen = dv.getUint16(lfhOffset + 28, true);
            var dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
            if (dataStart + compSize > data.length) {
                throw new Error('ZIP 条目数据越界: ' + name);
            }

            var fileData;
            if (method === 0) {
                fileData = data.subarray(dataStart, dataStart + compSize);
            } else if (method === 8) {
                fileData = await inflateRaw(data.subarray(dataStart, dataStart + compSize));
            } else {
                throw new Error('不支持的 ZIP 压缩方式 (method=' + method + '): ' + name);
            }

            entries.push({ name: name, data: fileData });
            pos += 46 + nameLen + extraLen + commentLen;
        }
        return entries;
    }

    // 下载 zip 资源包并解压到 /mythroad, 返回写入文件数 (失败返回 0, 不阻塞原流程)
    async function extractResPackage(resUrl) {
        setResStatus('正在下载资源包...');
        if (typeof showToast === 'function') showToast('正在下载资源包...', 10000);

        var data;
        try {
            data = await fetchArrayBuffer(resUrl);
        } catch (e) {
            setResStatus('资源包下载失败, 按原流程加载 (' + e.message + ')');
            if (typeof showToast === 'function') showToast('资源包下载失败, 按原流程加载', 3500);
            return 0;
        }

        // 校验 ZIP 魔数 (PK), 非 zip 内容忽略
        if (!(data.length > 4 && data[0] === 0x50 && data[1] === 0x4B)) {
            setResStatus('资源包不是有效的 zip 文件, 忽略该值');
            if (typeof showToast === 'function') showToast('资源包不是有效的 zip 文件, 按原流程加载', 3500);
            return 0;
        }

        var entries;
        try {
            entries = await parseZipEntries(data);
        } catch (e) {
            setResStatus('资源包解析失败, 按原流程加载 (' + e.message + ')');
            if (typeof showToast === 'function') showToast('资源包解析失败, 按原流程加载', 3500);
            return 0;
        }

        // 若所有条目都以 mythroad/ 开头, 去掉该层前缀 (避免解压成 /mythroad/mythroad)
        var allMythroadPrefix = entries.length > 0;
        for (var c = 0; c < entries.length; c++) {
            var sn = sanitizeZipEntryName(entries[c].name);
            if (!sn || sn.indexOf('mythroad/') !== 0) { allMythroadPrefix = false; break; }
        }
        if (allMythroadPrefix) {
            for (var c2 = 0; c2 < entries.length; c2++) {
                entries[c2].name = entries[c2].name.replace(/\\/g, '/').substring('mythroad/'.length);
            }
        }

        ensureDir('/mythroad');
        var written = 0;
        try {
            for (var w = 0; w < entries.length; w++) {
                var safe = sanitizeZipEntryName(entries[w].name);
                if (!safe) continue;
                var target = '/mythroad/' + safe;
                var parent = target.substring(0, target.lastIndexOf('/'));
                ensureDir(parent);
                FS.writeFile(target, entries[w].data);
                fileSizes[target] = entries[w].data.length;
                // 持久化到 IndexedDB, 刷新页面后资源仍然可用
                saveToStorage(target, entries[w].data);
                written++;
            }
        } catch (e) {
            setResStatus('资源包写入失败, 按原流程加载 (' + e.message + ')');
            if (typeof showToast === 'function') showToast('资源包写入失败, 按原流程加载', 3500);
            return written;
        }

        setResStatus('资源包导入完成: ' + written + ' 个文件');
        if (typeof showToast === 'function') showToast('资源包导入完成: ' + written + ' 个文件', 3500);
        return written;
    }

    function runWithFS() {
        var dirs = [
            "/mythroad",
            "/mythroad/nes",
            "/mythroad/plugins",
            "/mythroad/plugins/ose",
            "/mythroad/system",
        ];

        var files = [
            "/mythroad/mynes.mrp",
            "/mythroad/opezip.mrp",
            "/mythroad/gxqds.mrp",
            "/mythroad/gyhzb.mrp",
            "/mythroad/opmtyx.mrp",
            "/mythroad/txz.mrp",
            "/mythroad/winmine.mrp",
            "/mythroad/dsm_gm.mrp",
            "/mythroad/mpc.mrp",
            "/mythroad/ydqtwo.mrp",
            "/mythroad/nes/tank.nes",
            "/mythroad/nes/超级玛丽中文.nes",
            "/mythroad/plugins/advbar.mrp",
            "/mythroad/plugins/netpay.mrp",
            "/mythroad/plugins/flaengine.mrp",
            "/mythroad/plugins/ose/brwcore.mrp",
            "/mythroad/system/gb12.uc2",
            "/mythroad/system/gb12v2.uc2",
            "/mythroad/system/gb16.uc2",
            "/cfunction.ext",
        ];

        for (var i = 0; i < files.length; i++) {
            preloadFileSet[files[i]] = true;
        }

        for (var d = 0; d < dirs.length; d++) {
            FS.mkdir(dirs[d]);
        }

        var dsm_gm = GetQueryString('f');
        if (dsm_gm) {
            urlParamFile = '/mythroad/dsm_gm.mrp';
            window.vmrpExternalRun = true; // 外部链接 ?f= 调用
        }

        // 添加运行依赖, 防止 Emscripten 在文件加载完成前启动
        var hasRunDep = typeof Module.addRunDependency === 'function';
        var depId = 'vmrp_file_load';
        if (hasRunDep) {
            Module.addRunDependency(depId);
        }

        // 立即开始加载文件
        // 加载优先级: IndexedDB -> 服务器
        var pending = files.length;
        var depRemoved = false;
        function removeDep() {
            if (!depRemoved && hasRunDep) {
                depRemoved = true;
                Module.removeRunDependency(depId);
            }
        }
        function onAllFilesDone() {
            // ---- res=<url.zip> 资源包: 先下载解压到 /mythroad, 再继续原加载流程 ----
            // res 值不是 zip 文件时忽略, 按原流程加载
            var resUrl = GetQueryString('res');
            var resPromise = Promise.resolve(0);
            if (resUrl) {
                if (isZipUrl(resUrl)) {
                    resPromise = extractResPackage(resUrl);
                } else {
                    console.warn('[vmrp-res] res 参数不是 zip 文件, 忽略: ' + resUrl);
                }
            }

            resPromise.then(function () {
                var safetyTimer = setTimeout(function () {
                    console.warn('[vmrp-save] loadExtraSavesAsync 超时, 强制启动运行时');
                    removeDep();
                }, 5000);

                return loadExtraSavesAsync().then(function () {
                    clearTimeout(safetyTimer);
                    console.log('[vmrp-save] 文件加载完成');
                });
            }).catch(function (e) {
                console.warn('[vmrp-res] 资源包处理失败: ' + e.message);
            }).then(function () {
                // 无论成功失败都移除运行依赖, 保证模拟器能启动
                removeDep();
            });
        }
        function onFileDone() {
            pending--;
            if (pending === 0) onAllFilesDone();
        }

        for (var f = 0; f < files.length; f++) {
            loadFileAsync(files[f], dsm_gm, onFileDone);
        }
    }

    // ?f= 外部文件加载失败: 弹窗提示"打开应用列表 / 重新运行当前Mrp", 避免黑屏等待
    // 此时模拟器尚未启动, 直接调用 index.html 暴露的 showMrpExitDialog(message, title)
    function notifyUrlLoadFailed(v, e) {
        var fileName = null;
        try {
            var urlFile = String(GetQueryString('f') || '').replace(/\\/g, '/').match(/[^/?#]+$/);
            fileName = urlFile ? urlFile[0] : (v ? v.split('/').pop() : '');
        } catch (e2) { /* 忽略 */ }
        var msg = '外部 MRP 文件加载失败。' +
            (fileName ? '\n程序: ' + fileName : '') +
            (e && e.message ? '\n原因: ' + e.message : '') +
            '\n\n请选择下一步操作:';
        console.warn('[vmrp-save] ' + msg);
        try {
            if (typeof window.showMrpExitDialog === 'function') {
                window.showMrpExitDialog(msg, 'MRP 程序加载失败');
            } else {
                alert(msg);
            }
        } catch (e2) { /* 忽略 */ }
    }

    // 异步加载单个文件
    async function loadFileAsync(v, dsm_gm, callback) {
        var name = v.substring(v.lastIndexOf('/') + 1);
        var useUrlParam = (dsm_gm && name === 'dsm_gm.mrp');

        // 通过 ?f= 引入的文件: 始终从 URL 加载, 不缓存
        if (useUrlParam) {
            try {
                var data = await fetchArrayBuffer(dsm_gm);
                FS.writeFile(v, data);
                fileSizes[v] = data.length;
            } catch (e) {
                console.warn('[vmrp-save] URL 文件加载失败 ' + v + ': ' + e.message);
                // ?f= 文件加载失败: 直接弹窗提示"打开应用列表 / 重新运行当前Mrp",
                // 且不调用 callback() — 运行依赖不释放, 模拟器不会启动, 避免黑屏等待
                notifyUrlLoadFailed(v, e);
                return;
            }
            callback();
            return;
        }

        // PWA File Handling: 系统"打开方式"传入的本地 mrp 文件
        // 直接写入 dsm_gm.mrp 位置 (与 ?f= 相同的自动运行机制, 不持久化)
        if (name === 'dsm_gm.mrp' && launchFilePromise) {
            var lf = null;
            // 刷新/应用列表跳转不会触发新的系统启动事件, 无需等待 launchQueue
            if (!isPageReload && !skipLaunchWait) {
                lf = await waitLaunchFile(2000);
            }
            if (lf) {
                urlParamFile = v; // 标记为临时文件, 不同步到 IndexedDB
                try {
                    FS.writeFile(v, lf.data);
                    fileSizes[v] = lf.data.length;
                    console.log('[vmrp-launch] 本地文件 ' + lf.name + ' 已载入, 启动后自动运行');
                } catch (e) {
                    console.warn('[vmrp-launch] 写入失败 ' + v + ': ' + e.message);
                }
                window.vmrpExternalRun = true;
                window.vmrpLaunchFileName = lf.name;
                window.vmrpRelaunchSaved = saveRelaunchFile(lf);
                callback();
                return;
            }
            // 没有新的系统启动文件: 若是"重新运行当前Mrp"重载的页面, 从 sessionStorage 恢复
            var relaunch = getRelaunchFile();
            if (relaunch) {
                urlParamFile = v;
                try {
                    FS.writeFile(v, relaunch.data);
                    fileSizes[v] = relaunch.data.length;
                    console.log('[vmrp-launch] 恢复外部文件 ' + relaunch.name + ' (重新运行当前Mrp)');
                } catch (e) {
                    console.warn('[vmrp-launch] 恢复写入失败 ' + v + ': ' + e.message);
                }
                window.vmrpExternalRun = true;
                window.vmrpLaunchFileName = relaunch.name;
                window.vmrpRelaunchSaved = true;
                callback();
                return;
            }
        }

        // 统一加载: IndexedDB -> 服务器
        await tryIdbOrServer(v);
        callback();
    }

    // 尝试 IndexedDB, 不存在则从服务器获取
    async function tryIdbOrServer(v) {
        var savedData = await loadFromStorage(v);
        if (savedData) {
            try {
                FS.writeFile(v, savedData);
                fileSizes[v] = savedData.length;
                console.log('[vmrp-save] 从 IndexedDB 加载: ' + v);
            } catch (e) {
                console.warn('[vmrp-save] 写入失败 ' + v + ': ' + e.message);
            }
            return;
        }

        // 从服务器获取
        try {
            var data = await fetchArrayBuffer(serverPath + v.substring(1));
            try {
                FS.writeFile(v, data);
                fileSizes[v] = data.length;
            } catch (e) {
                console.warn('[vmrp-save] 写入失败 ' + v + ': ' + e.message);
            }
            // 保存到 IndexedDB (初始加载阶段直接写入, 不经过钩子)
            saveToStorage(v, data);
        } catch (e) {
            console.warn('[vmrp-save] 服务器获取失败 ' + v + ': ' + e.message);
        }
    }

    /* ====================================================================
     * 注册 preRun / postRun 钩子
     * ==================================================================== */

    if (!Module['preRun']) Module['preRun'] = [];
    Module["preRun"].push(runWithFS);

    if (!Module['postRun']) Module['postRun'] = [];
    Module["postRun"].push(function () {
        initFileSizes();

        // 安装 FS 实时同步钩子
        installFSHooks();

        // 初始加载阶段结束, 开启实时同步
        skipSync = false;
        console.log('[vmrp-save] 存档系统已启动 (实时同步模式: writeFile/unlink → IndexedDB)');
    });

    /* ====================================================================
     * 打包下载 /mythroad
     * ==================================================================== */

    var crcTable = null;
    function getCrcTable() {
        if (crcTable) return crcTable;
        crcTable = [];
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crcTable[n] = c >>> 0;
        }
        return crcTable;
    }

    function crc32(u8) {
        var table = getCrcTable();
        var crc = 0xFFFFFFFF;
        for (var i = 0; i < u8.length; i++) {
            crc = (crc >>> 8) ^ table[(crc ^ u8[i]) & 0xFF];
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function dosDateTime(d) {
        var year = d.getFullYear();
        var date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        return { date: date, time: time };
    }

    function buildZip(entries) {
        var chunks = [];
        var centralDir = [];
        var offset = 0;
        var dt = dosDateTime(new Date());

        for (var i = 0; i < entries.length; i++) {
            var name = entries[i].name;
            var data = entries[i].data;
            var nameBytes = new TextEncoder().encode(name);
            var crc = crc32(data);
            var compressed = data;
            var compSize = compressed.length;
            var uncompSize = data.length;

            var lfh = new Uint8Array(30 + nameBytes.length);
            var lv = new DataView(lfh.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint16(6, 0, true);
            lv.setUint16(8, 0, true);
            lv.setUint16(10, dt.time, true);
            lv.setUint16(12, dt.date, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, compSize, true);
            lv.setUint32(22, uncompSize, true);
            lv.setUint16(26, nameBytes.length, true);
            lv.setUint16(28, 0, true);
            lfh.set(nameBytes, 30);

            chunks.push(lfh);
            chunks.push(compressed);

            var cdh = new Uint8Array(46 + nameBytes.length);
            var cv = new DataView(cdh.buffer);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0, true);
            cv.setUint16(10, 0, true);
            cv.setUint16(12, dt.time, true);
            cv.setUint16(14, dt.date, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, compSize, true);
            cv.setUint32(24, uncompSize, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint16(30, 0, true);
            cv.setUint16(32, 0, true);
            cv.setUint16(34, 0, true);
            cv.setUint16(36, 0, true);
            cv.setUint32(38, 0, true);
            cv.setUint32(42, offset, true);
            cdh.set(nameBytes, 46);

            centralDir.push(cdh);

            offset += lfh.length + compressed.length;
        }

        var cdTotal = 0;
        for (var c = 0; c < centralDir.length; c++) cdTotal += centralDir[c].length;
        var cdBytes = new Uint8Array(cdTotal);
        var pos = 0;
        for (var c2 = 0; c2 < centralDir.length; c2++) {
            cdBytes.set(centralDir[c2], pos);
            pos += centralDir[c2].length;
        }

        var eocd = new Uint8Array(22);
        var ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, entries.length, true);
        ev.setUint16(10, entries.length, true);
        ev.setUint32(12, cdTotal, true);
        ev.setUint32(16, offset, true);
        ev.setUint16(20, 0, true);

        var allChunks = chunks.concat([cdBytes, eocd]);
        var totalLen = 0;
        for (var a = 0; a < allChunks.length; a++) totalLen += allChunks[a].length;
        var result = new Uint8Array(totalLen);
        var p = 0;
        for (var b = 0; b < allChunks.length; b++) {
            result.set(allChunks[b], p);
            p += allChunks[b].length;
        }
        return new Blob([result], { type: 'application/zip' });
    }

    function downloadAll() {
        if (typeof FS === 'undefined') return 0;
        var paths = scanDir('/mythroad');
        var entries = [];
        var skippedUrl = 0;
        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            if (urlParamFile && p === urlParamFile) { skippedUrl++; continue; }
            try {
                var data = FS.readFile(p);
                var zipName = p.charAt(0) === '/' ? p.substring(1) : p;
                entries.push({ name: zipName, data: data });
            } catch (e) { /* 跳过 */ }
        }

        if (entries.length === 0) {
            if (typeof showToast === 'function') {
                showToast('没有可下载的文件');
            }
            return 0;
        }

        var blob = buildZip(entries);
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'mythroad_' + new Date().toISOString().slice(0, 10) + '.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);

        console.log('[vmrp-save] 已打包下载 ' + entries.length + ' 个文件' +
                    (skippedUrl > 0 ? ' (跳过 ' + skippedUrl + ' 个链接文件)' : ''));
        return entries.length;
    }

    /* ====================================================================
     * 暴露全局方法供 UI 按钮调用
     * ==================================================================== */

    window.vmrpSaveAll = async function () {
        var count = await saveAll(true);
        if (typeof print === 'function') {
            print('游戏进度已保存 (' + count + ' 个文件)');
        }
        return count;
    };

    window.vmrpClearSaves = async function () {
        var count = await clearAllSaves();
        if (typeof print === 'function') {
            print('已清除 ' + count + ' 个本地存档文件');
        }
        return count;
    };

    window.vmrpGetSaveInfo = async function () {
        var paths = await getStoragePaths();
        var totalSize = await getStorageSize();
        return {
            count: paths.length,
            sizeBytes: totalSize,
            paths: paths,
            storageType: 'IndexedDB'
        };
    };

    window.vmrpDownloadAll = function () {
        return downloadAll();
    };

    // 暴露内部方法供文件管理器使用
    window.vmrpScanDir = function (path) {
        return scanDir(path);
    };

    window.vmrpBuildZip = function (entries) {
        return buildZip(entries);
    };

    // res 资源包调试辅助
    window.vmrpParseZipEntries = function (u8) {
        return parseZipEntries(u8);
    };
    window.vmrpSanitizeZipEntryName = function (name) {
        return sanitizeZipEntryName(name);
    };

})();
