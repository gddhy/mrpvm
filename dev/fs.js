var Module = typeof Module !== 'undefined' ? Module : {};
(function () {
    'use strict';

    /* ====================================================================
     * 游戏进度本地持久化模块
     *
     * 存储方式：
     *   1. File System Access API (Chromium) -- 映射到用户选择的本地文件夹
     *   2. localStorage -- 所有浏览器通用的回退方案
     *
     * 加载优先级：本地文件夹 -> localStorage -> 服务器
     * ==================================================================== */

    var SAVE_PREFIX = 'vmrp_save_';
    var SAVE_INDEX_KEY = 'vmrp_save_index';
    var SAVE_INTERVAL = 10000;
    var urlParamFile = null;
    var serverPath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1) + 'fs/';

    /* ====================================================================
     * File System Access API 模块
     * ==================================================================== */

    var fsaSupported = typeof window.showDirectoryPicker === 'function';
    var dirHandle = null;
    var fsaActive = false;
    var FSA_DB_NAME = 'vmrp_fsa';
    var FSA_STORE = 'handles';
    var FSA_KEY = 'mythroad_dir';
    var FSA_SKIP_KEY = 'vmrp_fsa_skipped';

    function isFsaSupported() {
        return typeof window.showDirectoryPicker === 'function';
    }

    /* ---- IndexedDB (存储 directory handle) ---- */

    function idbOpen() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(FSA_DB_NAME, 1);
            req.onupgradeneeded = function () {
                req.result.createObjectStore(FSA_STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    async function idbGet(key) {
        var db = await idbOpen();
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(FSA_STORE, 'readonly');
            var getReq = tx.objectStore(FSA_STORE).get(key);
            getReq.onsuccess = function () { resolve(getReq.result || null); db.close(); };
            getReq.onerror = function () { reject(getReq.error); db.close(); };
        });
    }

    async function idbSet(key, value) {
        var db = await idbOpen();
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(FSA_STORE, 'readwrite');
            tx.objectStore(FSA_STORE).put(value, key);
            tx.oncomplete = function () { resolve(); db.close(); };
            tx.onerror = function () { reject(tx.error); db.close(); };
        });
    }

    async function idbDelete(key) {
        var db = await idbOpen();
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(FSA_STORE, 'readwrite');
            tx.objectStore(FSA_STORE).delete(key);
            tx.oncomplete = function () { resolve(); db.close(); };
            tx.onerror = function () { reject(tx.error); db.close(); };
        });
    }

    /* ---- FSA 路径转换 ---- */

    // /mythroad/foo/bar -> ['foo', 'bar']
    // /cfunction.ext -> null (不在 mythroad 下)
    function fsPathToSegments(fsPath) {
        if (fsPath.indexOf('/mythroad/') !== 0) return null;
        var rel = fsPath.substring('/mythroad/'.length);
        return rel.split('/').filter(function (s) { return s.length > 0; });
    }

    /* ---- FSA 文件读写 ---- */

    async function fsaReadFile(fsPath) {
        var segments = fsPathToSegments(fsPath);
        if (!segments || !dirHandle) return null;
        try {
            var handle = dirHandle;
            for (var i = 0; i < segments.length - 1; i++) {
                handle = await handle.getDirectoryHandle(segments[i]);
            }
            var fh = await handle.getFileHandle(segments[segments.length - 1]);
            var file = await fh.getFile();
            var buf = await file.arrayBuffer();
            return new Uint8Array(buf);
        } catch (e) {
            return null;
        }
    }

    async function fsaWriteFile(fsPath, data) {
        var segments = fsPathToSegments(fsPath);
        if (!segments || !dirHandle) return;
        try {
            var handle = dirHandle;
            for (var i = 0; i < segments.length - 1; i++) {
                handle = await handle.getDirectoryHandle(segments[i], { create: true });
            }
            var fh = await handle.getFileHandle(segments[segments.length - 1], { create: true });
            var writable = await fh.createWritable();
            await writable.write(data);
            await writable.close();
        } catch (e) {
            console.warn('[vmrp-fsa] 写入失败 ' + fsPath + ': ' + e.message);
        }
    }

    // 递归扫描 FSA 目录，返回所有文件的 FS 路径列表
    async function fsaScanDir(handle, prefix) {
        var result = [];
        try {
            for await (var entry of handle.values()) {
                var fsPath = '/mythroad/' + (prefix ? prefix + '/' : '') + entry.name;
                if (entry.kind === 'file') {
                    result.push(fsPath);
                } else if (entry.kind === 'directory') {
                    var sub = await fsaScanDir(entry, (prefix ? prefix + '/' : '') + entry.name);
                    result = result.concat(sub);
                }
            }
        } catch (e) { /* 跳过 */ }
        return result;
    }

    // 清空 FSA 目录中的所有内容
    async function fsaClearAll() {
        if (!dirHandle) return 0;
        var count = 0;
        try {
            var entries = [];
            for await (var entry of dirHandle.values()) {
                entries.push(entry);
            }
            for (var i = 0; i < entries.length; i++) {
                await dirHandle.removeEntry(entries[i].name, { recursive: true });
                count++;
            }
        } catch (e) { /* 跳过 */ }
        return count;
    }

    /* ---- FSA UI 遮罩 ---- */

    function createFsaOverlay(title, desc, primaryText, skipText) {
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.id = 'vmrp-fsa-overlay';
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.7)',
                'display:flex', 'align-items:center', 'justify-content:center',
                'z-index:99999',
                'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif'
            ].join(';');

            var card = document.createElement('div');
            card.style.cssText = [
                'background:#161b28', 'border:1px solid rgba(255,255,255,0.1)',
                'border-radius:12px', 'padding:28px 24px',
                'max-width:360px', 'width:calc(100% - 48px)', 'text-align:center'
            ].join(';');

            var titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-size:18px;font-weight:700;color:#e6edf3;margin-bottom:12px;';
            titleEl.textContent = title;

            var descEl = document.createElement('div');
            descEl.style.cssText = 'font-size:13px;color:#8b949e;line-height:1.7;margin-bottom:20px;';
            descEl.innerHTML = desc;

            var btnContainer = document.createElement('div');
            btnContainer.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

            var primaryBtn = document.createElement('button');
            primaryBtn.textContent = primaryText;
            primaryBtn.style.cssText = [
                'padding:12px 24px', 'font-size:14px', 'font-weight:600',
                'border:none', 'border-radius:8px', 'cursor:pointer',
                'background:#238636', 'color:#fff', 'transition:background 0.15s'
            ].join(';');
            primaryBtn.onmouseenter = function () { primaryBtn.style.background = '#2ea043'; };
            primaryBtn.onmouseleave = function () { primaryBtn.style.background = '#238636'; };

            var skipBtn = document.createElement('button');
            skipBtn.textContent = skipText;
            skipBtn.style.cssText = [
                'padding:10px 24px', 'font-size:13px',
                'border:1px solid rgba(255,255,255,0.1)', 'border-radius:8px',
                'cursor:pointer', 'background:transparent', 'color:#8b949e',
                'transition:background 0.15s'
            ].join(';');
            skipBtn.onmouseenter = function () { skipBtn.style.background = 'rgba(255,255,255,0.05)'; };
            skipBtn.onmouseleave = function () { skipBtn.style.background = 'transparent'; };

            btnContainer.appendChild(primaryBtn);
            btnContainer.appendChild(skipBtn);
            card.appendChild(titleEl);
            card.appendChild(descEl);
            card.appendChild(btnContainer);
            overlay.appendChild(card);
            document.body.appendChild(overlay);

            function closeOverlay(val) {
                if (overlay.parentNode) document.body.removeChild(overlay);
                resolve(val);
            }

            primaryBtn.onclick = function () { closeOverlay('primary'); };
            skipBtn.onclick = function () { closeOverlay('skip'); };
        });
    }

    /* ---- FSA 初始化 (返回 Promise<handle|null>) ---- */

    window.vmrpFsaReady = (async function () {
        if (!isFsaSupported()) {
            console.log('[vmrp-fsa] 浏览器不支持 File System Access API, 使用 localStorage');
            return null;
        }

        try {
            // 检查是否有已存储的 handle
            var stored = await idbGet(FSA_KEY);

            if (stored) {
                // 检查权限
                var perm = await stored.queryPermission({ mode: 'readwrite' });
                if (perm === 'granted') {
                    console.log('[vmrp-fsa] 已有文件夹权限: ' + stored.name);
                    return stored;
                }

                // 权限为 prompt: 不再自动弹遮罩层 (避免覆盖模拟器画面导致黑屏)
                // 用户可通过 "本地文件夹" 按钮手动重新授权
                console.log('[vmrp-fsa] 文件夹权限为 ' + perm + ', 使用 localStorage。可在界面中手动重新连接。');
                return null;
            }

            // 用户之前跳过则不再提示
            if (localStorage.getItem(FSA_SKIP_KEY) === '1') {
                return null;
            }

            // 首次使用, 提示选择文件夹
            var action2 = await createFsaOverlay(
                '\u{1F4C1} 选择本地存储文件夹',
                '授权后游戏文件将直接保存在本地文件夹中<br>不再占用浏览器存储空间，下次打开时可直接从本地加载<br><small style="color:#6e7681">支持 Chrome, Edge 等 Chromium 内核浏览器</small>',
                '选择文件夹',
                '跳过（使用浏览器存储）'
            );

            if (action2 === 'primary') {
                try {
                    var handle = await window.showDirectoryPicker({
                        mode: 'readwrite',
                        id: 'vmrp-mythroad'
                    });
                    await idbSet(FSA_KEY, handle);
                    localStorage.removeItem(FSA_SKIP_KEY);
                    console.log('[vmrp-fsa] 已选择文件夹: ' + handle.name);
                    return handle;
                } catch (e) {
                    if (e.name === 'AbortError') {
                        console.log('[vmrp-fsa] 用户取消了选择');
                    } else {
                        console.warn('[vmrp-fsa] 选择失败: ' + e.message);
                    }
                    return null;
                }
            }

            // 用户跳过, 记录标志
            localStorage.setItem(FSA_SKIP_KEY, '1');
            console.log('[vmrp-fsa] 用户跳过, 使用 localStorage');
            return null;
        } catch (e) {
            console.warn('[vmrp-fsa] 初始化异常: ' + e.message);
            return null;
        }
    })();

    /* ====================================================================
     * 编码工具
     * ==================================================================== */

    function uint8ToBase64(u8) {
        var binary = '';
        var chunk = 8192;
        for (var i = 0; i < u8.length; i += chunk) {
            var end = Math.min(i + chunk, u8.length);
            binary += String.fromCharCode.apply(null, u8.subarray(i, end));
        }
        return btoa(binary);
    }

    function base64ToUint8(b64) {
        var binary = atob(b64);
        var len = binary.length;
        var u8 = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            u8[i] = binary.charCodeAt(i);
        }
        return u8;
    }

    /* ====================================================================
     * localStorage 读写
     * ==================================================================== */

    function getSaveIndex() {
        try {
            return JSON.parse(localStorage.getItem(SAVE_INDEX_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    function setSaveIndex(index) {
        localStorage.setItem(SAVE_INDEX_KEY, JSON.stringify(index));
    }

    function addToIndex(path) {
        var index = getSaveIndex();
        if (index.indexOf(path) === -1) {
            index.push(path);
            setSaveIndex(index);
        }
    }

    function saveToStorage(path, data) {
        try {
            localStorage.setItem(SAVE_PREFIX + path, uint8ToBase64(data));
            addToIndex(path);
            return true;
        } catch (e) {
            console.warn('[vmrp-save] 保存失败 ' + path + ': ' + e.message);
            return false;
        }
    }

    function loadFromStorage(path) {
        try {
            var b64 = localStorage.getItem(SAVE_PREFIX + path);
            if (b64) return base64ToUint8(b64);
        } catch (e) {
            console.warn('[vmrp-save] 读取失败 ' + path + ': ' + e.message);
        }
        return null;
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
     * 核心保存/加载逻辑
     * ==================================================================== */

    var fileSizes = {};
    var preloadFileSet = {};
    var savesCleared = false;
    var saveIntervalId = null;

    // 将 /mythroad 目录下所有文件保存到存储
    // 始终保存到 localStorage (确保下次快速加载)
    // FSA 激活时额外保存到本地文件夹
    function saveAll(force) {
        if (typeof FS === 'undefined') return 0;
        if (savesCleared) return 0;
        var paths = scanDir('/mythroad');
        var saved = 0, skipped = 0, skippedUrl = 0;
        var fsaPromises = [];

        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            if (urlParamFile && p === urlParamFile) { skippedUrl++; continue; }
            try {
                var stat = FS.stat(p);
                if (!force && fileSizes[p] === stat.size) { skipped++; continue; }
                var data = FS.readFile(p);

                // 始终保存到 localStorage (确保下次访问可快速加载)
                if (saveToStorage(p, data)) {
                    fileSizes[p] = stat.size;
                    saved++;
                }

                // FSA 激活时额外写入本地文件夹
                if (fsaActive && dirHandle) {
                    fsaPromises.push(fsaWriteFile(p, data));
                }
            } catch (e) { /* 跳过异常文件 */ }
        }

        if (fsaPromises.length > 0) {
            Promise.all(fsaPromises).then(function () {
                console.log('[vmrp-fsa] 已同步 ' + fsaPromises.length + ' 个文件到本地文件夹');
            }).catch(function () { /* 忽略 */ });
        }

        if (saved > 0 || force) {
            console.log('[vmrp-save] 保存完成: ' + saved + ' 个文件, ' +
                        skipped + ' 个未变更' +
                        (skippedUrl > 0 ? ', ' + skippedUrl + ' 个链接文件跳过' : '') +
                        (fsaActive ? ' (已同步到本地文件夹)' : ' (localStorage)'));
        }
        return saved;
    }

    // 从 localStorage + FSA 加载不在预加载列表中的额外存档文件
    // 始终从 localStorage 恢复 (快速, 同步), FSA 作为补充
    // FSA 操作有超时保护, 防止挂起导致运行时无法启动
    async function loadExtraSavesAsync() {
        if (typeof FS === 'undefined') return;
        var allPaths = {};

        // 从 localStorage 索引获取 (始终可用)
        var index = getSaveIndex();
        for (var j = 0; j < index.length; j++) {
            allPaths[index[j]] = 'ls';
        }

        // 从 FSA 扫描补充 (异步, 仅 FSA 激活时)
        // 添加 3 秒超时保护, 超时则跳过 FSA 操作
        if (fsaActive && dirHandle) {
            try {
                var scanPromise = fsaScanDir(dirHandle, '');
                var timeoutPromise = new Promise(function (_, reject) {
                    setTimeout(function () { reject(new Error('FSA scan timeout')); }, 3000);
                });
                var fsaPaths = await Promise.race([scanPromise, timeoutPromise]);
                for (var i = 0; i < fsaPaths.length; i++) {
                    if (!allPaths[fsaPaths[i]]) {
                        allPaths[fsaPaths[i]] = 'fsa';
                    }
                }
            } catch (e) {
                console.warn('[vmrp-save] FSA 扫描跳过: ' + e.message);
            }
        }

        var loaded = 0;
        var keys = Object.keys(allPaths);
        for (var k = 0; k < keys.length; k++) {
            var p = keys[k];
            if (preloadFileSet[p]) continue;

            var data = null;
            // 优先 localStorage (同步, 快速)
            if (allPaths[p] === 'ls') {
                data = loadFromStorage(p);
            }
            // FSA 补充 (localStorage 无数据时), 带超时保护
            if (!data && allPaths[p] === 'fsa' && fsaActive && dirHandle) {
                try {
                    var readPromise = fsaReadFile(p);
                    var readTimeout = new Promise(function (_, reject) {
                        setTimeout(function () { reject(new Error('read timeout')); }, 2000);
                    });
                    data = await Promise.race([readPromise, readTimeout]);
                } catch (e) {
                    console.warn('[vmrp-save] FSA 读取失败 ' + p + ': ' + e.message);
                    data = null;
                }
            }

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
    }

    function clearAllSaves() {
        // 始终清除 localStorage (包括 FSA 模式下可能残留的旧数据)
        var index = getSaveIndex();
        for (var i = 0; i < index.length; i++) {
            localStorage.removeItem(SAVE_PREFIX + index[i]);
        }
        localStorage.removeItem(SAVE_INDEX_KEY);

        // 清除 FSA (异步)
        if (fsaActive) {
            fsaClearAll().then(function (count) {
                console.log('[vmrp-fsa] 已清除本地文件夹中 ' + count + ' 个文件');
            });
        }

        fileSizes = {};
        savesCleared = true;
        if (saveIntervalId) {
            clearInterval(saveIntervalId);
            saveIntervalId = null;
        }
        var storageType = fsaActive ? '本地文件夹' : 'localStorage';
        console.log('[vmrp-save] 已清除 ' + index.length + ' 个存档文件 (' + storageType + ')');
        return index.length;
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

    // 从服务器获取文件 (XMLHttpRequest, 兼容性好)
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

        // 构建预加载文件集合
        for (var i = 0; i < files.length; i++) {
            preloadFileSet[files[i]] = true;
        }

        // 创建目录
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

        // FSA 初始化完全在后台进行, 不阻塞文件加载
        // vmrpFsaReady 解析后设置 dirHandle/fsaActive, 后续 saveAll 会同步到本地文件夹
        if (window.vmrpFsaReady) {
            window.vmrpFsaReady.then(function (handle) {
                dirHandle = handle;
                fsaActive = !!handle;
                console.log('[vmrp-fsa] FSA 已初始化: ' + (handle ? '本地文件夹 ' + handle.name : '使用 localStorage'));
                // FSA 激活后延迟同步文件到本地文件夹
                if (handle && typeof FS !== 'undefined') {
                    setTimeout(function () { saveAll(true); }, 500);
                }
            }).catch(function (e) {
                console.warn('[vmrp-fsa] FSA 初始化失败: ' + e.message);
                dirHandle = null;
                fsaActive = false;
            });
        }

        // 立即开始加载文件, 不等待 FSA
        // 加载优先级: localStorage -> 服务器 (始终可用, 无需等待 FSA)
        var pending = files.length;
        var depRemoved = false;
        function removeDep() {
            if (!depRemoved && hasRunDep) {
                depRemoved = true;
                Module.removeRunDependency(depId);
            }
        }
        function onAllFilesDone() {
            // 最终安全保护: 5 秒后无论如何都移除依赖, 防止运行时卡死
            var safetyTimer = setTimeout(function () {
                console.warn('[vmrp-save] loadExtraSavesAsync 超时, 强制启动运行时');
                removeDep();
            }, 5000);

            loadExtraSavesAsync().then(function () {
                clearTimeout(safetyTimer);
                removeDep();
                console.log('[vmrp-save] 文件加载完成' +
                    (fsaActive ? ' (本地文件夹: ' + dirHandle.name + ')' : ''));
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
    // 统一加载策略: localStorage -> 服务器 (写入 localStorage, FSA 激活时额外写入)
    function loadFileAsync(v, dsm_gm, callback) {
        var name = v.substring(v.lastIndexOf('/') + 1);
        var useUrlParam = (dsm_gm && name === 'dsm_gm.mrp');

        // 通过 ?f= 引入的文件: 始终从 URL 加载, 不缓存
        if (useUrlParam) {
            fetchArrayBuffer(dsm_gm).then(function (data) {
                try { FS.writeFile(v, data); fileSizes[v] = data.length; } catch (e) { console.warn('[vmrp-save] 写入失败 ' + v + ': ' + e.message); }
                callback();
            }).catch(function () { callback(); });
            return;
        }

        // 统一加载: localStorage -> 服务器
        tryLsOrServer(v, callback);
    }

    // 尝试 localStorage, 不存在则从服务器获取
    // 始终保存到 localStorage, FSA 激活时额外写入本地文件夹
    function tryLsOrServer(v, callback) {
        var savedData = loadFromStorage(v);
        if (savedData) {
            try {
                FS.writeFile(v, savedData);
                fileSizes[v] = savedData.length;
                console.log('[vmrp-save] 从 localStorage 加载: ' + v);
            } catch (e) {
                console.warn('[vmrp-save] 写入失败 ' + v + ': ' + e.message);
            }
            callback();
            return;
        }

        // 从服务器获取
        fetchArrayBuffer(serverPath + v.substring(1)).then(function (data) {
            try {
                FS.writeFile(v, data);
                fileSizes[v] = data.length;
            } catch (e) {
                console.warn('[vmrp-save] 写入失败 ' + v + ': ' + e.message);
            }
            // 始终保存到 localStorage
            saveToStorage(v, data);
            // FSA 激活时额外写入本地文件夹
            if (fsaActive && dirHandle) {
                fsaWriteFile(v, data);
            }
            callback();
        }).catch(function () {
            callback(); // 即使出错也继续
        });
    }

    /* ====================================================================
     * 注册 preRun / postRun 钩子
     * ==================================================================== */

    if (!Module['preRun']) Module['preRun'] = [];
    Module["preRun"].push(runWithFS);

    if (!Module['postRun']) Module['postRun'] = [];
    Module["postRun"].push(function () {
        initFileSizes();

        saveIntervalId = setInterval(function () { saveAll(false); }, SAVE_INTERVAL);

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') {
                saveAll(true);
            }
        });

        window.addEventListener('pagehide', function () { saveAll(true); });
        window.addEventListener('beforeunload', function () { saveAll(true); });

        console.log('[vmrp-save] 存档系统已启动 (自动保存间隔: ' + (SAVE_INTERVAL / 1000) + 's' +
            (fsaActive ? ', 本地文件夹: ' + dirHandle.name : '') + ')');
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

    window.vmrpSaveAll = function () {
        var count = saveAll(true);
        if (typeof print === 'function') {
            print('游戏进度已保存 (' + count + ' 个文件)');
        }
        return count;
    };

    window.vmrpClearSaves = function () {
        var count = clearAllSaves();
        if (typeof print === 'function') {
            print('已清除 ' + count + ' 个本地存档文件');
        }
        return count;
    };

    window.vmrpGetSaveInfo = function () {
        // 始终从 localStorage 索引获取信息 (主存储)
        var index = getSaveIndex();
        var totalSize = 0;
        for (var j = 0; j < index.length; j++) {
            var b64 = localStorage.getItem(SAVE_PREFIX + index[j]);
            if (b64) totalSize += b64.length;
        }
        return {
            count: index.length,
            sizeBytes: Math.round(totalSize * 0.75),
            paths: index,
            fsaActive: fsaActive,
            fsaDirName: dirHandle ? dirHandle.name : null,
            storageType: fsaActive ? '本地文件夹 + localStorage' : 'localStorage'
        };
    };

    window.vmrpDownloadAll = function () {
        return downloadAll();
    };

    // FSA: 查询当前状态
    window.vmrpFsaStatus = function () {
        return {
            supported: fsaSupported,
            active: fsaActive,
            dirName: dirHandle ? dirHandle.name : null
        };
    };

    // FSA: 手动选择/更换文件夹
    window.vmrpFsaSelectFolder = async function () {
        if (!isFsaSupported()) {
            alert('当前浏览器不支持 File System Access API');
            return false;
        }
        // 先尝试重新连接已存储的文件夹
        try {
            var stored = await idbGet(FSA_KEY);
            if (stored) {
                var perm = await stored.queryPermission({ mode: 'readwrite' });
                if (perm === 'granted') {
                    dirHandle = stored;
                    fsaActive = true;
                    console.log('[vmrp-fsa] 已重新连接文件夹: ' + stored.name);
                    if (typeof FS !== 'undefined') {
                        setTimeout(function () { saveAll(true); }, 100);
                    }
                    return true;
                }
                // 权限为 prompt, 尝试重新请求 (需要用户手势)
                if (perm === 'prompt') {
                    var result = await stored.requestPermission({ mode: 'readwrite' });
                    if (result === 'granted') {
                        dirHandle = stored;
                        fsaActive = true;
                        console.log('[vmrp-fsa] 已重新授权文件夹: ' + stored.name);
                        if (typeof FS !== 'undefined') {
                            setTimeout(function () { saveAll(true); }, 100);
                        }
                        return true;
                    }
                }
            }
        } catch (e) {
            console.warn('[vmrp-fsa] 重新连接失败: ' + e.message);
        }
        // 没有已存储的文件夹或重新连接失败, 选择新文件夹
        try {
            var handle = await window.showDirectoryPicker({
                mode: 'readwrite',
                id: 'vmrp-mythroad'
            });
            await idbSet(FSA_KEY, handle);
            localStorage.removeItem(FSA_SKIP_KEY);
            dirHandle = handle;
            fsaActive = true;
            console.log('[vmrp-fsa] 已选择文件夹: ' + handle.name);
            // 立即同步当前文件到新文件夹
            if (typeof FS !== 'undefined') {
                setTimeout(function () { saveAll(true); }, 100);
            }
            return true;
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.warn('[vmrp-fsa] 选择文件夹失败: ' + e.message);
            }
            return false;
        }
    };

    // FSA: 断开文件夹连接
    window.vmrpFsaDisconnect = async function () {
        await idbDelete(FSA_KEY);
        localStorage.removeItem(FSA_SKIP_KEY);
        dirHandle = null;
        fsaActive = false;
        console.log('[vmrp-fsa] 已断开文件夹连接');
        return true;
    };

})();
