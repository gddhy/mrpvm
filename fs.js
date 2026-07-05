var Module = typeof Module !== 'undefined' ? Module : {};
(function () {
    'use strict';

    /* ====================================================================
     * 游戏进度本地持久化模块
     *
     * 原理：
     *   - 模拟器所有文件都在 Emscripten 内存文件系统(FS)中，刷新即丢失
     *   - 本模块将 /mythroad 目录下的文件同步到浏览器 localStorage
     *   - 下次打开网页时优先从 localStorage 恢复，不存在才从服务器获取
     *
     * 使用 Emscripten FS 模块的方法：
     *   FS.readdir / FS.stat / FS.readFile / FS.writeFile / FS.mkdir
     * ==================================================================== */

    var SAVE_PREFIX = 'vmrp_save_';        // localStorage key 前缀
    var SAVE_INDEX_KEY = 'vmrp_save_index'; // 存档文件路径索引(JSON 数组)
    var SAVE_INTERVAL = 10000;              // 自动保存间隔(毫秒)
    // 通过 ?f= 链接参数引入的文件路径，保存时跳过(可从链接重新获取)
    var urlParamFile = null;

    /* ---------- 编码工具 ---------- */

    // Uint8Array -> base64 字符串(分块处理避免栈溢出)
    function uint8ToBase64(u8) {
        var binary = '';
        var chunk = 8192;
        for (var i = 0; i < u8.length; i += chunk) {
            var end = Math.min(i + chunk, u8.length);
            binary += String.fromCharCode.apply(null, u8.subarray(i, end));
        }
        return btoa(binary);
    }

    // base64 字符串 -> Uint8Array
    function base64ToUint8(b64) {
        var binary = atob(b64);
        var len = binary.length;
        var u8 = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            u8[i] = binary.charCodeAt(i);
        }
        return u8;
    }

    /* ---------- localStorage 读写 ---------- */

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

    // 将一个文件写入 localStorage
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

    // 从 localStorage 读取一个文件，返回 Uint8Array 或 null
    function loadFromStorage(path) {
        try {
            var b64 = localStorage.getItem(SAVE_PREFIX + path);
            if (b64) return base64ToUint8(b64);
        } catch (e) {
            console.warn('[vmrp-save] 读取失败 ' + path + ': ' + e.message);
        }
        return null;
    }

    // 自动保存定时器 ID
    var saveIntervalId = null;

    // 清除所有存档
    function clearAllSaves() {
        var index = getSaveIndex();
        for (var i = 0; i < index.length; i++) {
            localStorage.removeItem(SAVE_PREFIX + index[i]);
        }
        localStorage.removeItem(SAVE_INDEX_KEY);
        fileSizes = {};
        savesCleared = true;
        // 停止当前页的自动保存，避免立即重新写入
        if (saveIntervalId) {
            clearInterval(saveIntervalId);
            saveIntervalId = null;
        }
        console.log('[vmrp-save] 已清除 ' + index.length + ' 个存档文件');
        return index.length;
    }

    /* ---------- Emscripten FS 辅助工具 ---------- */

    // 递归创建目录(类似 mkdir -p)
    function ensureDir(path) {
        if (!path || path === '/') return;
        try {
            var stat = FS.stat(path);
            if (FS.isDir(stat.mode)) return;
        } catch (e) { /* 不存在，继续创建 */ }
        var parent = path.substring(0, path.lastIndexOf('/'));
        ensureDir(parent);
        try { FS.mkdir(path); } catch (e) { /* 可能已被创建 */ }
    }

    // 递归扫描目录，返回所有文件的完整路径列表
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

    /* ---------- 核心保存/加载逻辑 ---------- */

    // 记录每个文件上次保存时的大小，用于跳过未变更的文件
    var fileSizes = {};
    // 预加载文件集合(从服务器获取的原始文件)
    var preloadFileSet = {};
    // 标记是否已手动清除存档，防止页面隐藏/卸载时重新保存
    var savesCleared = false;

    // 将 /mythroad 目录下所有文件保存到 localStorage
    // force=true 时强制保存所有文件(忽略变更检测)
    function saveAll(force) {
        if (typeof FS === 'undefined') return 0;
        if (savesCleared) return 0;
        var paths = scanDir('/mythroad');
        var saved = 0, skipped = 0, skippedUrl = 0;
        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            // 跳过通过 ?f= 链接引入的文件(可从链接重新获取)
            if (urlParamFile && p === urlParamFile) { skippedUrl++; continue; }
            try {
                var stat = FS.stat(p);
                // 大小未变则跳过(force 模式下不跳过)
                if (!force && fileSizes[p] === stat.size) { skipped++; continue; }
                var data = FS.readFile(p);
                if (saveToStorage(p, data)) {
                    fileSizes[p] = stat.size;
                    saved++;
                }
            } catch (e) { /* 跳过异常文件 */ }
        }
        if (saved > 0 || force) {
            console.log('[vmrp-save] 保存完成: ' + saved + ' 个文件, ' +
                        skipped + ' 个未变更' +
                        (skippedUrl > 0 ? ', ' + skippedUrl + ' 个链接文件跳过' : ''));
        }
        return saved;
    }

    // 从 localStorage 加载不在预加载列表中的额外存档文件
    function loadExtraSaves() {
        if (typeof FS === 'undefined') return;
        var index = getSaveIndex();
        var loaded = 0;
        for (var i = 0; i < index.length; i++) {
            var p = index[i];
            // 跳过预加载文件(已在 runWithFS 中处理)
            if (preloadFileSet[p]) continue;
            var data = loadFromStorage(p);
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
            console.log('[vmrp-save] 从 localStorage 恢复了 ' + loaded + ' 个额外存档文件');
        }
    }

    // 初始化文件大小记录(用于后续跳过未变更文件)
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

    /* ---------- 预加载阶段(preRun) ---------- */

    function runWithFS() {
        //var path = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/')) + '/fs/';
        const path = 'https://gcore.jsdelivr.net/gh/gddhy/mrpvm/fs/';

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
            "/mythroad/dsm_gm.mrp", // 入口mrp
            "/mythroad/mpc.mrp",
            "/mythroad/ydqtwo.mrp", // 电子书阅读器
            "/mythroad/nes/tank.nes",
            "/mythroad/nes/超级玛丽中文.nes",
            "/mythroad/plugins/advbar.mrp",
            "/mythroad/plugins/netpay.mrp", // 支付模块
            "/mythroad/plugins/flaengine.mrp", // flash播放器
            "/mythroad/plugins/ose/brwcore.mrp", // 冒泡浏览器插件
            "/mythroad/system/gb12.uc2",  // 12号字体
            "/mythroad/system/gb12v2.uc2",
            "/mythroad/system/gb16.uc2",  // 16号字体
            "/cfunction.ext",  // mythroad层
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
        var loadedFromStorage = 0;

        // 记录通过 ?f= 链接引入的文件路径，保存时跳过
        if (dsm_gm) {
            urlParamFile = '/mythroad/dsm_gm.mrp';
        }

        for (var f = 0; f < files.length; f++) {
            var v = files[f];
            var parent = v.substring(0, v.lastIndexOf('/'));
            var name = v.substring(v.lastIndexOf('/') + 1);

            // 如果通过 URL 参数 ?f= 指定了入口 mrp，则始终从该 URL 加载(不使用缓存)
            var useUrlParam = (dsm_gm && name === 'dsm_gm.mrp');

            if (!useUrlParam) {
                // 优先从 localStorage 加载
                var savedData = loadFromStorage(v);
                if (savedData) {
                    FS.writeFile(v, savedData);
                    fileSizes[v] = savedData.length;
                    loadedFromStorage++;
                    console.log('[vmrp-save] 从本地存储加载: ' + v);
                    continue;
                }
            }

            // localStorage 中不存在，从服务器获取
            if (useUrlParam) {
                FS.createPreloadedFile(parent, name, dsm_gm, true, true);
            } else {
                FS.createPreloadedFile(parent, name, path + v, true, true);
            }
        }

        // 加载不在预加载列表中的额外存档文件(游戏创建的存档)
        loadExtraSaves();

        if (loadedFromStorage > 0) {
            console.log('[vmrp-save] 从本地存储加载了 ' + loadedFromStorage + ' 个预加载文件');
        }
    }

    /* ---------- 注册 preRun / postRun 钩子 ---------- */

    if (!Module['preRun']) Module['preRun'] = [];
    Module["preRun"].push(runWithFS);

    if (!Module['postRun']) Module['postRun'] = [];
    Module["postRun"].push(function () {
        // 记录当前所有文件大小，作为后续变更检测的基准
        initFileSizes();

        // 定时自动保存(每 10 秒)
        saveIntervalId = setInterval(function () { saveAll(false); }, SAVE_INTERVAL);

        // 页面隐藏时保存(切到后台、最小化等)
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') {
                saveAll(true);
            }
        });

        // 页面关闭时保存
        window.addEventListener('pagehide', function () { saveAll(true); });
        window.addEventListener('beforeunload', function () { saveAll(true); });

        console.log('[vmrp-save] 存档系统已启动 (自动保存间隔: ' + (SAVE_INTERVAL / 1000) + 's)');
    });

    /* ---------- 打包下载 /mythroad ---------- */

    // CRC32 查表实现
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

    // DOS 日期时间打包(1980-01-01 为基准)
    function dosDateTime(d) {
        var year = d.getFullYear();
        var date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        return { date: date, time: time };
    }

    // 将文件列表打包成 ZIP，返回 Blob
    function buildZip(entries) {
        // entries: [{ name, data(Uint8Array) }]
        var chunks = [];          // 本地文件头+数据
        var centralDir = [];      // 中央目录记录
        var offset = 0;

        var dt = dosDateTime(new Date());

        for (var i = 0; i < entries.length; i++) {
            var name = entries[i].name;
            var data = entries[i].data;
            var nameBytes = new TextEncoder().encode(name);
            var crc = crc32(data);
            var compressed = data; // STORE 模式(无压缩)
            var compSize = compressed.length;
            var uncompSize = data.length;

            // --- 本地文件头 (30 bytes + name) ---
            var lfh = new Uint8Array(30 + nameBytes.length);
            var lv = new DataView(lfh.buffer);
            lv.setUint32(0, 0x04034b50, true);   // 签名
            lv.setUint16(4, 20, true);            // 解压所需版本
            lv.setUint16(6, 0, true);             // 标志位
            lv.setUint16(8, 0, true);             // 压缩方法: 0=STORE
            lv.setUint16(10, dt.time, true);      // 修改时间
            lv.setUint16(12, dt.date, true);      // 修改日期
            lv.setUint32(14, crc, true);          // CRC-32
            lv.setUint32(18, compSize, true);     // 压缩大小
            lv.setUint32(22, uncompSize, true);   // 原始大小
            lv.setUint16(26, nameBytes.length, true); // 文件名长度
            lv.setUint16(28, 0, true);            // 额外字段长度
            lfh.set(nameBytes, 30);

            chunks.push(lfh);
            chunks.push(compressed);

            // --- 中央目录头 (46 bytes + name) ---
            var cdh = new Uint8Array(46 + nameBytes.length);
            var cv = new DataView(cdh.buffer);
            cv.setUint32(0, 0x02014b50, true);    // 签名
            cv.setUint16(4, 20, true);            // 版本
            cv.setUint16(6, 20, true);            // 解压所需版本
            cv.setUint16(8, 0, true);             // 标志位
            cv.setUint16(10, 0, true);            // 压缩方法
            cv.setUint16(12, dt.time, true);
            cv.setUint16(14, dt.date, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, compSize, true);
            cv.setUint32(24, uncompSize, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint16(30, 0, true);            // 额外字段长度
            cv.setUint16(32, 0, true);            // 注释长度
            cv.setUint16(34, 0, true);            // 磁盘号
            cv.setUint16(36, 0, true);            // 内部属性
            cv.setUint32(38, 0, true);            // 外部属性
            cv.setUint32(42, offset, true);       // 本地头偏移
            cdh.set(nameBytes, 46);
            centralDir.push(cdh);

            offset += lfh.length + compressed.length;
        }

        // 合并中央目录
        var cdTotal = 0;
        for (var c = 0; c < centralDir.length; c++) cdTotal += centralDir[c].length;
        var cdBytes = new Uint8Array(cdTotal);
        var pos = 0;
        for (var c2 = 0; c2 < centralDir.length; c2++) {
            cdBytes.set(centralDir[c2], pos);
            pos += centralDir[c2].length;
        }

        // --- End of Central Directory Record (22 bytes) ---
        var eocd = new Uint8Array(22);
        var ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);               // 磁盘号
        ev.setUint16(6, 0, true);               // 磁盘号(中央目录起始)
        ev.setUint16(8, entries.length, true);  // 本磁盘记录数
        ev.setUint16(10, entries.length, true); // 总记录数
        ev.setUint32(12, cdTotal, true);        // 中央目录大小
        ev.setUint32(16, offset, true);         // 中央目录偏移
        ev.setUint16(20, 0, true);              // 注释长度

        // 合并所有部分
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

    // 打包下载 /mythroad 目录下所有文件
    function downloadAll() {
        if (typeof FS === 'undefined') return 0;
        var paths = scanDir('/mythroad');
        var entries = [];
        var skippedUrl = 0;
        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            // 跳过通过 ?f= 链接引入的文件
            if (urlParamFile && p === urlParamFile) { skippedUrl++; continue; }
            try {
                var data = FS.readFile(p);
                // ZIP 内路径: 去掉开头的 /
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

    /* ---------- 暴露全局方法供 UI 按钮调用 ---------- */

    // 手动保存全部进度
    window.vmrpSaveAll = function () {
        var count = saveAll(true);
        if (typeof print === 'function') {
            print('游戏进度已保存到浏览器本地 (' + count + ' 个文件)');
        }
        return count;
    };

    // 清除所有本地存档
    window.vmrpClearSaves = function () {
        var count = clearAllSaves();
        if (typeof print === 'function') {
            print('已清除 ' + count + ' 个本地存档文件');
        }
        return count;
    };

    // 获取存档信息(供 UI 显示)
    window.vmrpGetSaveInfo = function () {
        var index = getSaveIndex();
        var totalSize = 0;
        for (var i = 0; i < index.length; i++) {
            var b64 = localStorage.getItem(SAVE_PREFIX + index[i]);
            if (b64) totalSize += b64.length;
        }
        return {
            count: index.length,
            sizeBytes: Math.round(totalSize * 0.75), // base64 -> 原始大小估算
            paths: index
        };
    };

    // 打包下载 /mythroad 目录下所有文件为 ZIP
    window.vmrpDownloadAll = function () {
        return downloadAll();
    };

})();
