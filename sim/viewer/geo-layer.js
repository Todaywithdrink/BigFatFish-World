// ============================================================
// geo-layer.js —— 湖北省真实比例底图（主观测站接入层）
//
// 数据：/maps/hubei.json + hubei.bin（群系，1 字节/格）+ hubei.elev.bin（高程）
// 坐标：世界内核仍跑 384×96 的聚落网格，居民坐标不变。
//       这里只做「视觉映射」：1 世界格 = STEP 湖北格，世界 (0,0) 落在湖北格 ORIGIN。
//       聚落中心 (192,48) ≈ 湖北格 (1084,596)，即武汉—孝感一带。
// 渲染：加载后一次性烘焙全省缩略图（2px/格），每帧只做一次 drawImage；
//       低倍时缩小看全省，高倍时最近邻放大成像素地形，性能与村庄层无关。
// ============================================================
(function () {
  "use strict";

  var STEP = 2;
  var ORIGIN = { gx: 700, gy: 500 };
  var THUMB_SCALE = 2;

  var PAL = [
    [36, 42, 40],     // 0 省界外
    [62, 116, 182],   // 1 湖泊
    [52, 104, 172],   // 2 江河
    [116, 172, 92],   // 3 平原
    [62, 116, 72],    // 4 林地
    [104, 112, 88],   // 5 山地
    [150, 154, 142],  // 6 高山
    [228, 231, 235]   // 7 雪线
  ];

  var meta = null, grid = null, elev = null, thumb = null;
  var W = 0, H = 0, elevUnit = 12;
  var ok = false, err = "", loading = null;

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
  function hash2(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function blend(a, b, k) {
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }
  // 无高程文件时退回按群系直接上色（8 色地形图），仍然看得出省界/江河/山地
  function tintFor(b, evM, hasElev) {
    if (b === 0) return PAL[0];
    if (b === 1 || b === 2) return PAL[b];
    if (b === 7) return PAL[7];
    if (!hasElev) return PAL[b];
    if (evM < 80) return PAL[3];
    if (evM < 450) return blend(PAL[3], PAL[4], (evM - 80) / 370);
    if (evM < 1050) return blend(PAL[4], PAL[5], (evM - 450) / 600);
    if (evM < 2450) return blend(PAL[5], PAL[6], (evM - 1050) / 1400);
    return PAL[7];
  }
  function elevAt(x, y) {
    if (!elev || x < 0 || y < 0 || x >= W || y >= H) return 0;
    return elev[y * W + x];
  }
  // 西北光源的方向阴影：让山地从平涂色块里立起来
  function hillshade(x, y) {
    var gx = elevAt(x + 1, y) - elevAt(x - 1, y);
    var gy = elevAt(x, y + 1) - elevAt(x, y - 1);
    var s = -(gx + gy) * 2.2;
    return s < -40 ? -40 : s > 40 ? 40 : s;
  }

  // 全省烘焙一次：1 湖北格 = THUMB_SCALE² 像素，含连续高程着色 + 山体阴影 + 微噪声
  function bake() {
    thumb = document.createElement("canvas");
    thumb.width = W * THUMB_SCALE;
    thumb.height = H * THUMB_SCALE;
    var g = thumb.getContext("2d");
    var img = g.createImageData(thumb.width, thumb.height);
    var d = img.data;
    var tw = thumb.width;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var b = grid[y * W + x];
        var c = tintFor(b, elevAt(x, y) * elevUnit, !!elev);
        var jitter = (hash2(x, y) - 0.5) * 7;
        if (elev && b >= 3 && b <= 6) jitter += hillshade(x, y);
        var r = clamp255(c[0] + jitter), gg = clamp255(c[1] + jitter), bb = clamp255(c[2] + jitter);
        for (var sy = 0; sy < THUMB_SCALE; sy++) {
          var row = ((y * THUMB_SCALE + sy) * tw + x * THUMB_SCALE) * 4;
          for (var sx = 0; sx < THUMB_SCALE; sx++) {
            // 子像素轻抖动：放大后不会读成纯色大方块
            var k = sx === 0 && sy === 0 ? 0 : (hash2(x * 7 + sx, y * 11 + sy) - 0.5) * 6;
            var i = row + sx * 4;
            d[i] = clamp255(r + k); d[i + 1] = clamp255(gg + k); d[i + 2] = clamp255(bb + k); d[i + 3] = 255;
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
  }

  function load() {
    if (loading) return loading;
    loading = fetch("/maps/hubei.json")
      .then(function (r) { if (!r.ok) throw new Error("hubei.json " + r.status); return r.json(); })
      .then(function (m) {
        meta = m; W = m.w; H = m.h; elevUnit = m.elevUnit || 12;
        var jobs = [fetch("/maps/hubei.bin").then(function (r) {
          if (!r.ok) throw new Error("hubei.bin " + r.status);
          return r.arrayBuffer();
        })];
        jobs.push(m.elevFile ? fetch("/maps/" + m.elevFile)
          .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
          .catch(function () { return null; }) : Promise.resolve(null));
        return Promise.all(jobs);
      })
      .then(function (bufs) {
        grid = new Uint8Array(bufs[0]);
        if (grid.length !== W * H) throw new Error("网格尺寸不符 " + grid.length + " ≠ " + W * H);
        if (bufs[1] && bufs[1].byteLength >= W * H) elev = new Uint8Array(bufs[1]);
        bake();
        ok = true;
      })
      .catch(function (e) { err = e.message || String(e); });
    return loading;
  }

  function bounds() {
    return {
      x0: -ORIGIN.gx / STEP, y0: -ORIGIN.gy / STEP,
      x1: (W - ORIGIN.gx) / STEP, y1: (H - ORIGIN.gy) / STEP
    };
  }
  function center() { var b = bounds(); return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; }
  function overviewZoom(w, h, tile) {
    if (!ok) return 0.06;
    var b = bounds();
    return Math.min(w / ((b.x1 - b.x0) * tile), h / ((b.y1 - b.y0) * tile)) * 0.96;
  }
  function minZoom(w, h, tile) { return overviewZoom(w, h, tile) * 0.75; }

  // 每帧一次 drawImage，但只取视口覆盖的湖北格：
  // 3.4× 时整图目标矩形会到 8 万 px（超过 canvas 上限），裁剪后恒等于屏幕尺寸量级。
  var lastDraw = { dw: 0, dh: 0 };
  function draw(ctx, cam, z, w, h) {
    if (!ok) return;
    var stepPx = z / STEP;
    var halfW = w / 2 / z, halfH = h / 2 / z;
    var gx0 = Math.max(0, Math.floor((cam.x - halfW) * STEP + ORIGIN.gx) - 1);
    var gy0 = Math.max(0, Math.floor((cam.y - halfH) * STEP + ORIGIN.gy) - 1);
    var gx1 = Math.min(W, Math.ceil((cam.x + halfW) * STEP + ORIGIN.gx) + 1);
    var gy1 = Math.min(H, Math.ceil((cam.y + halfH) * STEP + ORIGIN.gy) + 1);
    if (gx1 <= gx0 || gy1 <= gy0) return;
    var dx = ((gx0 - ORIGIN.gx) / STEP - cam.x) * z + w / 2;
    var dy = ((gy0 - ORIGIN.gy) / STEP - cam.y) * z + h / 2;
    var dw = (gx1 - gx0) * stepPx, dh = (gy1 - gy0) * stepPx;
    lastDraw = { dw: Math.round(dw), dh: Math.round(dh), gx0: gx0, gy0: gy0, gx1: gx1, gy1: gy1 };
    ctx.imageSmoothingEnabled = stepPx < 2.2;   // 全省降采样要平滑，放大保持像素硬边
    ctx.drawImage(thumb, gx0 * THUMB_SCALE, gy0 * THUMB_SCALE,
      (gx1 - gx0) * THUMB_SCALE, (gy1 - gy0) * THUMB_SCALE, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = false;
  }

  // 城市名 + 聚落范围：画在高清文字层，不参与像素化
  function drawLabels(ctx, cam, z, w, h, mapSize) {
    if (!ok || !meta || !meta.cities) return;
    var stepPx = z / STEP;
    var toScreen = function (gx, gy) {
      return { x: ((gx - ORIGIN.gx) / STEP - cam.x) * z + w / 2,
               y: ((gy - ORIGIN.gy) / STEP - cam.y) * z + h / 2 };
    };
    ctx.save();
    ctx.textBaseline = "middle";
    var placed = [];   // 标签避让：武汉/鄂州/黄冈在城市圈里容易叠成一团
    // 聚落框：全地图 / 中倍时帮助定位
    if (mapSize && stepPx < 14) {
      var a = toScreen(ORIGIN.gx, ORIGIN.gy);
      var bw = mapSize.w * z, bh = mapSize.h * z;
      if (bw > 3 && bh > 3) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = "rgba(255,236,150,.75)";
        ctx.lineWidth = 1.4;
        ctx.strokeRect(a.x, a.y, bw, bh);
        ctx.setLineDash([]);
        if (bw > 70) {
          ctx.font = "11px 'Microsoft YaHei',system-ui,sans-serif";
          ctx.textAlign = "left";
          var tag = "聚落 · 居民在此";
          label(ctx, tag, a.x + 4, a.y - 8);
          placed.push({ x: a.x + 4, y: a.y - 15, w: ctx.measureText(tag).width + 5, h: 14 });
        }
      }
    }
    // 全省 / 中倍显示城市；放大到村庄尺度后隐藏，避免压住居民
    if (stepPx >= 0.45 && stepPx < 9) {
      var font = stepPx < 1.6 ? "10px" : "12px";
      ctx.font = font + " 'Microsoft YaHei',system-ui,sans-serif";
      ctx.textAlign = "left";
      var cities = meta.cities;
      var stride = stepPx < 1 ? 1 : (stepPx < 2 ? 2 : 3);
      for (var i = 0; i < cities.length; i += stride) {
        var c = cities[i];
        var s = toScreen(c.x, c.y);
        if (s.x < -60 || s.y < -20 || s.x > w + 60 || s.y > h + 20) continue;
        var tw = ctx.measureText(c.name).width;
        var r = { x: s.x + 5, y: s.y - 7, w: tw + 5, h: 14 };
        var clash = false;
        for (var j = 0; j < placed.length; j++) {
          var q = placed[j];
          if (r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y) { clash = true; break; }
        }
        if (clash) continue;
        placed.push(r);
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.beginPath(); ctx.arc(s.x, s.y, 2, 0, Math.PI * 2); ctx.fill();
        label(ctx, c.name, s.x + 5, s.y);
      }
    }
    ctx.restore();
  }
  function label(ctx, text, x, y) {
    ctx.strokeStyle = "rgba(10,16,10,.85)";
    ctx.lineWidth = 2.6;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "#f2f6e6";
    ctx.fillText(text, x, y);
  }

  // ---------- 地理读数 / 全省定位小图 ----------
  var BIOME_CN = ["省界外", "湖泊", "江河", "平原", "林地", "山地", "高山", "雪线"];
  function infoAt(wx, wy) {
    if (!ok) return null;
    var gx = Math.max(0, Math.min(W - 1, Math.round(ORIGIN.gx + wx * STEP)));
    var gy = Math.max(0, Math.min(H - 1, Math.round(ORIGIN.gy + wy * STEP)));
    var b = grid[gy * W + gx];
    var lng = meta.lng0 + (gx * meta.tileKm) / meta.kmPerDegLng;
    var lat = meta.lat1 - (gy * meta.tileKm) / meta.kmPerDegLat;
    var near = "—", nd = 1e9;
    for (var i = 0; i < (meta.cities || []).length; i++) {
      var c = meta.cities[i];
      var d = Math.hypot(c.x - gx, c.y - gy) * meta.tileKm;
      if (d < nd) { nd = d; near = c.name; }
    }
    return {
      biome: BIOME_CN[b] || "—", elev: elev ? Math.round(elevAt(gx, gy) * elevUnit) : null,
      lng: lng, lat: lat, city: near, cityKm: Math.round(nd),
      kmPerWorld: STEP * meta.tileKm, gx: gx, gy: gy
    };
  }
  function thumbTransform(w, h) {
    if (!ok) return null;
    var k = Math.min(w / W, h / H);
    return { k: k, ox: (w - W * k) / 2, oy: (h - H * k) / 2 };
  }
  function drawThumb(ctx, w, h) {
    var t = thumbTransform(w, h);
    if (!t) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(thumb, t.ox, t.oy, W * t.k, H * t.k);
    ctx.imageSmoothingEnabled = false;
    return t;
  }
  function worldToMini(wx, wy, t) {
    return { x: t.ox + (ORIGIN.gx + wx * STEP) * t.k, y: t.oy + (ORIGIN.gy + wy * STEP) * t.k };
  }
  function miniToWorld(px, py, t) {
    return { x: ((px - t.ox) / t.k - ORIGIN.gx) / STEP, y: ((py - t.oy) / t.k - ORIGIN.gy) / STEP };
  }

  window.GeoLayer = {
    load: load,
    ready: function () { return ok; },
    failed: function () { return err; },
    status: function () { return ok ? "ready " + W + "×" + H : (err ? "fail " + err : "loading"); },
    bounds: bounds,
    center: center,
    overviewZoom: overviewZoom,
    minZoom: minZoom,
    draw: draw,
    drawLabels: drawLabels,
    worldToGeo: function (wx, wy) { return { gx: ORIGIN.gx + wx * STEP, gy: ORIGIN.gy + wy * STEP }; },
    infoAt: infoAt,
    lastDraw: function () { return lastDraw; },
    drawThumb: drawThumb,
    thumbTransform: thumbTransform,
    worldToMini: worldToMini,
    miniToWorld: miniToWorld,
    meta: function () { return meta; }
  };
})();
