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
        await clearStorageAll();

        localStorage.removeItem(SAVE_INDEX_KEY);

        // 清除旧的 localStorage 文件数据 (迁移遗留)
        var oldIndex = getSaveIndex();
        for (var i = 0; i < oldIndex.length; i++) {
            localStorage.removeItem('vmrp_save_' + oldIndex[i]);
        }

        fileSizes = {};
        savesCleared = true;
        console.log('[vmrp-save] 已清除所有存档文件 (IndexedDB)');
        return oldIndex.length;
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
            var safetyTimer = setTimeout(function () {
                console.warn('[vmrp-save] loadExtraSavesAsync 超时, 强制启动运行时');
                removeDep();
            }, 5000);

            loadExtraSavesAsync().then(function () {
                clearTimeout(safetyTimer);
                removeDep();
                console.log('[vmrp-save] 文件加载完成');
            }).catch(function (e) {
                clearTimeout(safetyTimer);
                console.warn('[vmrp-save] 加载额外存档失败: ' + e.message);
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
            }
            callback();
            return;
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
            alert('没有可下载的文件');
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

})();
