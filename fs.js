var Module = typeof Module !== 'undefined' ? Module : {};
(function () {
    function runWithFS() {
        //const path = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/')) + '/fs/';
        const path = 'https://testingcf.jsdelivr.net/gh/gddhy/mrpvm/fs/';

        const dirs = [
            "/mythroad",
			"/mythroad/nes",
            "/mythroad/plugins",
            "/mythroad/plugins/ose",
            "/mythroad/system",
        ];

        const files = [
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


        for (const v of dirs) {
            FS.mkdir(v);
        }

        const dsm_gm = GetQueryString('f');
        for (const v of files) {
            const parent = v.substring(0, v.lastIndexOf('/'));
            const name = v.substring(v.lastIndexOf('/') + 1);
            if (dsm_gm && name === 'dsm_gm.mrp') {
                FS.createPreloadedFile(parent, name, dsm_gm, true, true);
            } else {
                FS.createPreloadedFile(parent, name, path + v, true, true);
            }
        }
    }

    if (!Module['preRun']) Module['preRun'] = [];
    Module["preRun"].push(runWithFS);
})();
