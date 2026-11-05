// ============================================================
// world-view.js —— 分块流式世界观测器（PixiJS v8）
//
// 与 pixi-view.js（村庄层，整图烘焙）的区别：
//   世界层 1497×960 格，整图烘焙会到 23952×15360 px，必然击穿 WebGL 纹理上限。
//   这里改为：64×64 格为一块 → 按视口按需烘焙成 canvas → LRU 缓存。
//
// 像素纪律：
//   · 缩放档位固定 [0.25, 0.5, 1, 2, 4]，全程整数像素/格
//   · zoom<1 时按 4px/8px 直接烘焙（不是缩放大图），避免线性采样糊边
//   · 相机位置按格取整，块坐标恒为整数
// ============================================================

(function () {
  "use strict";

  var TILE = 16;                 // 格尺寸（px @1×）
  var CHUNK = 64;                // 每块 64×64 格
  // 省域尺度必须能退到 1px/格（1497 格 ≈ 1497px），否则看不到全省
  var ZOOMS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4];
  var CACHE_CAP = 96;            // 块缓存上限
  var BAKE_PER_FRAME = 2;        // 每帧最多烘焙块数（防卡顿）

  var BIOME = ["省界外", "湖泊", "江河", "平原", "林地", "山地", "高山", "雪线"];
  var PAL = [
    [36, 42, 40], [62, 116, 182], [52, 104, 172],
    [116, 172, 92], [62, 116, 72], [104, 112, 88], [150, 154, 142], [228, 231, 235]
  ];

  var meta = null, grid = null, elevU8 = null, W = 0, H = 0;
  var cam = { x: 0, y: 0, zoom: 1 };
  var app, chunkLayer, labelLayer;
  var chunkMap = new Map();      // "cx,cy@pp" → { sprite, used }
  var cityLabels = [];
  var fps = 60, hudAt = 0, bakeQueue = [];
  var stats = { baked: 0, visible: 0 };

  // ---------- 工具 ----------
  function h2(x, y) {
    var n = (x | 0) * 374761393 + (y | 0) * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  }
  function bio(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    return grid[y * W + x];
  }
  function elevAt(x, y) {
    if (!elevU8 || x < 0 || y < 0 || x >= W || y >= H) return 0;
    return elevU8[y * W + x];
  }
  // 山体阴影：光源西北，取东西/南北高差做方向光。
  // 这是让 45km 视野内的山地"立起来"的关键——纯群系色块永远像地图册。
  function hillshade(x, y) {
    var e = elevAt(x, y);
    if (!e) return 0;
    var gx = elevAt(x + 1, y) - elevAt(x - 1, y);
    var gy = elevAt(x, y + 1) - elevAt(x, y - 1);
    var s = -(gx + gy) * 1.85;
    return s < -44 ? -44 : s > 44 ? 44 : s;
  }
  function blend(a, b, k) {
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }
  // 按海拔连续着色：草绿 → 林绿 → 岩灰。硬分档只有 7 个色阶，
  // 大面积山地必然读成"平涂"；连续过渡 + 山体阴影才有地形图质感。
  function tintFor(b, ev) {
    if (b === 0) return PAL[0];
    if (b === 1 || b === 2) return PAL[b];
    if (b === 7) return PAL[7];
    if (ev < 80) return PAL[3];
    if (ev < 450) return blend(PAL[3], PAL[4], (ev - 80) / 370);
    if (ev < 1050) return blend(PAL[4], PAL[5], (ev - 450) / 600);
    if (ev < 2450) return blend(PAL[5], PAL[6], (ev - 1050) / 1400);
    return PAL[7];
  }
  function ppFor(zoom) { return Math.max(1, Math.min(TILE, Math.round(TILE * zoom))); }
  function scaleFor(zoom) { return TILE * zoom / ppFor(zoom); }
  function pxPerTile() { return TILE * cam.zoom; }
  function zoomIndex() {
    var i = ZOOMS.indexOf(cam.zoom);
    return i < 0 ? 2 : i;
  }
  function shade(c, k) {
    return "rgb(" + Math.max(0, Math.min(255, Math.round(c[0] + k))) + "," +
      Math.max(0, Math.min(255, Math.round(c[1] + k))) + "," +
      Math.max(0, Math.min(255, Math.round(c[2] + k))) + ")";
  }

  // ---------- 单格绘制：这一步决定"像素画感"还是"色块图" ----------
  function drawTile(g, ox, oy, pp, tx, ty, b) {
    var evM = elevAt(tx, ty) * (meta.elevUnit || 12);
    var base = tintFor(b, evM);
    var j = (h2(tx, ty) - 0.5) * 6 + (b >= 3 ? hillshade(tx, ty) : 0);
    g.fillStyle = shade(base, j);
    g.fillRect(ox, oy, pp, pp);

    var nN = bio(tx, ty - 1), nS = bio(tx, ty + 1), nW = bio(tx - 1, ty), nE = bio(tx + 1, ty);
    var px = Math.max(1, pp >> 4);            // 1 个"像素"在当前烘焙分辨率下的尺寸

    if (b === 0) return;

    // 缩到 1~2px/格 时只保留色相与海岸高光，细节会退化成噪点
    if (pp <= 2) {
      if (b === 1 || b === 2) {
        var land = function (n) { return n !== 0 && n !== 1 && n !== 2; };
        if (land(nN) || land(nS) || land(nW) || land(nE)) {
          g.fillStyle = shade([176, 208, 216], 0);
          g.fillRect(ox, oy, pp, pp);
        }
      }
      return;
    }

    // ---- 水体：深浅带 + 岸线泡沫 ----
    if (b === 1 || b === 2) {
      if (pp >= 8 && h2(tx * 5, ty * 3) > 0.55) {   // 稀疏：逐格都画会连成横纹
        g.fillStyle = shade(base, 14);
        var sy2 = oy + Math.floor((h2(tx * 3, ty) * (pp - px * 2)) / px) * px;
        var sx2 = ox + Math.floor(h2(tx, ty * 7) * (pp * 0.35));
        g.fillRect(sx2, sy2, Math.floor(pp * 0.55), px);
      }
      // 临陆侧泡沫：pp≥8 时隔一格留缺口（读起来像浪），低倍档必须连续，
      // 否则 2~4px 一格时整条河会变成虚线。
      var foam = shade([178, 208, 218], 0);
      var step = px;   // 连续更像素岸线；断续会读成虚线框
      var thick = 1;                       // 1px 岸线在 2×/4× 下已被放大，不必再加粗
      g.fillStyle = foam;
      var isLand = function (n) { return n !== 0 && n !== 1 && n !== 2; };
      if (isLand(nN)) for (var i = 0; i < pp; i += step) g.fillRect(ox + i, oy, px, thick);
      if (isLand(nS)) for (var i2 = 0; i2 < pp; i2 += step) g.fillRect(ox + i2, oy + pp - thick, px, thick);
      if (isLand(nW)) for (var i3 = 0; i3 < pp; i3 += step) g.fillRect(ox, oy + i3, thick, px);
      if (isLand(nE)) for (var i4 = 0; i4 < pp; i4 += step) g.fillRect(ox + pp - thick, oy + i4, thick, px);
      return;
    }

    // ---- 森林/林地：深色树点 ----
    if (b === 4) {
      var dots = pp >= 8 ? 4 : 1;
      for (var d = 0; d < dots; d++) {
        var dx = Math.floor(h2(tx * 7 + d, ty * 3) * (pp - px));
        var dy = Math.floor(h2(tx * 5, ty * 7 + d) * (pp - px));
        g.fillStyle = shade(base, -26 - d * 3);
        g.fillRect(ox + dx, oy + dy, px * (pp >= 8 ? 2 : 1), px * (pp >= 8 ? 2 : 1));
      }
      return;
    }

    // ---- 山地/高山/雪线：坡向明暗 + 岩屑颗粒（大面积平涂会显得像色块） ----
    if (b >= 5) {
      var rocks = pp >= 8 ? 2 : 1;
      for (var rk = 0; rk < rocks; rk++) {
        // 深浅两档岩屑交替：单色颗粒在大面积山地会读成"脏"，双色才有体积
        g.fillStyle = shade(base, rk < rocks * 0.6 ? -36 : 22);
        g.fillRect(ox + Math.floor(h2(tx * 13 + rk, ty * 17) * (pp - px)),
                   oy + Math.floor(h2(ty * 11, tx * 19 + rk) * (pp - px)), px, px);
      }
    }
    if (b === 5 || b === 6) {
      if (b === 6 && h2(tx, ty) > 0.72) {
        g.fillStyle = shade(base, 26);
        g.fillRect(ox + Math.floor(h2(tx, ty) * (pp - px * 2)), oy + Math.floor(h2(ty, tx) * (pp - px * 2)), px * 2, px * 2);
      }
      if (nS !== 0 && nS < b) {
        g.fillStyle = shade(base, -30);
        g.fillRect(ox, oy + pp - px * 2, pp, px * 2);
      }
      if (nN !== 0 && nN < b) {
        g.fillStyle = shade(base, 22);
        g.fillRect(ox, oy, pp, px);
      }
      return;
    }

    // ---- 平原：田片（面状色差）+ 稀疏点缀 ----
    if (b === 3) {
      if (pp >= 8) {
        // 4×4 格 = 一块田（2km 见方）。只做整片色调差，不画线条：
        // 逐格画线会连成扫描线/灯芯绒，而田块本来就是面状的。
        var hv = h2((tx >> 1) * 31 + 7, (ty >> 1) * 17 + 3);
        g.fillStyle = shade(base, (hv - 0.5) * 14 + (h2(tx * 7, ty * 11) - 0.5) * 7);
        g.fillRect(ox, oy, pp, pp);
        if (h2(tx * 17, ty * 19) > 0.88) {      // 零星未耕地/水塘
          g.fillStyle = shade(base, -22);
          g.fillRect(ox + px, oy + px, pp - px * 2, pp - px * 2);
        }
      }
      if (h2(tx * 11, ty * 13) > 0.86) {
        g.fillStyle = shade(base, 16);
        g.fillRect(ox + Math.floor(h2(tx, ty) * (pp - px * 2)), oy + Math.floor(h2(ty, tx) * (pp - px * 2)), px * 2, px * 2);
      }
      return;
    }

    if (b === 7) {
      // 雪线：雪面 + 露岩斑，南缘压暗成阴影（纯白平涂会像贴纸）
      g.fillStyle = "rgb(158,164,168)";
      for (var sn = 0; sn < (pp >= 8 ? 2 : 1); sn++) {
        g.fillRect(ox + Math.floor(h2(tx * 23 + sn, ty * 29) * (pp - px)),
                   oy + Math.floor(h2(ty * 31, tx * 37 + sn) * (pp - px)), px, px);
      }
      if (nS !== 0 && nS < b) { g.fillStyle = shade(base, -22); g.fillRect(ox, oy + pp - px * 2, pp, px * 2); }
      return;
    }
  }

  // ---------- 块烘焙 ----------
  function bakeChunk(cx, cy, pp) {
    var cv = document.createElement("canvas");
    cv.width = CHUNK * pp;
    cv.height = CHUNK * pp;
    var g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    var x0 = cx * CHUNK, y0 = cy * CHUNK;
    for (var ty = 0; ty < CHUNK; ty++) {
      for (var tx = 0; tx < CHUNK; tx++) {
        var gx = x0 + tx, gy = y0 + ty;
        if (gx >= W || gy >= H) continue;
        drawTile(g, tx * pp, ty * pp, pp, gx, gy, grid[gy * W + gx]);
      }
    }
    var tex = PIXI.Texture.from(cv);
    if (tex.source && "scaleMode" in tex.source) tex.source.scaleMode = "nearest";
    stats.baked++;
    return tex;
  }

  // 省级全景：pp≤2 时整张图只有 1.5M~6M 像素，一次性烘成单纹理。
  // 若仍走 64 格分块，1440px 视口要 360 块，必然超出缓存上限并反复重建。
  var overviewSprites = {};
  function bakeOverview(pp) {
    var cw = W * pp, chh = H * pp;
    var cv = document.createElement("canvas");
    cv.width = cw; cv.height = chh;
    var g = cv.getContext("2d");
    var img = g.createImageData(cw, chh);
    var d = img.data;
    for (var ty = 0; ty < H; ty++) {
      for (var tx = 0; tx < W; tx++) {
        var b = grid[ty * W + tx];
        var c = tintFor(b, elevAt(tx, ty) * (meta.elevUnit || 12));
        var k = (h2(tx, ty) - 0.5) * 5 + (b >= 3 ? hillshade(tx, ty) * 0.95 : 0);
        var r = c[0] + k, gg = c[1] + k, bb = c[2] + k;
        if (b === 1 || b === 2) {
          var nN = bio(tx, ty - 1), nS = bio(tx, ty + 1), nW = bio(tx - 1, ty), nE = bio(tx + 1, ty);
          var isW = function (n) { return n === 1 || n === 2; };
          var wide = (isW(nN) ? 1 : 0) + (isW(nS) ? 1 : 0) + (isW(nW) ? 1 : 0) + (isW(nE) ? 1 : 0);
          // 河 vs 湖分色：河道偏亮蓝保证 1px 下可辨；湖体偏深蓝。
          if (b === 2) { r = 92; gg = 146; bb = 198; } else { r = 62; gg = 116; bb = 182; }
          // 只有"开阔水面"才加岸线高光——3 格宽的河道若逐格高光会整条变白
          if (wide >= 3) { r = b === 2 ? 128 : 96; gg = b === 2 ? 176 : 152; bb = b === 2 ? 214 : 206; }
        } else if (b === 5 || b === 6) {
          // 用邻居群系差模拟坡向，省掉高程场的传输
          if (bio(tx, ty - 1) < b) { r += 14; gg += 14; bb += 12; }
          else if (bio(tx, ty + 1) < b) { r -= 16; gg -= 16; bb -= 14; }
        }
        for (var oy = 0; oy < pp; oy++) {
          var row = ((ty * pp + oy) * cw + tx * pp) * 4;
          for (var ox = 0; ox < pp; ox++) {
            d[row + ox * 4] = r; d[row + ox * 4 + 1] = gg; d[row + ox * 4 + 2] = bb; d[row + ox * 4 + 3] = 255;
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
    var tex = PIXI.Texture.from(cv);
    if (tex.source && "scaleMode" in tex.source) tex.source.scaleMode = "nearest";
    var sp = new PIXI.Sprite(tex);
    sp.x = 0; sp.y = 0;
    chunkLayer.addChild(sp);
    overviewSprites[pp] = sp;
    stats.baked++;
    return sp;
  }
  function chunkKey(cx, cy, pp) { return cx + "," + cy + "@" + pp; }

  function getChunk(cx, cy, pp) {
    var key = chunkKey(cx, cy, pp);
    var hit = chunkMap.get(key);
    if (hit) { hit.used = performance.now(); return hit.sprite; }

    var tex = bakeChunk(cx, cy, pp);
    var sp = new PIXI.Sprite(tex);
    // 位置必须用「烘焙像素」为单位：低倍档 pp=4 时若按 16px/格 摆放，
    // 每块只占 1/4 宽，块之间就会露出大片空洞（第一版踩过）。
    sp.x = cx * CHUNK * pp;
    sp.y = cy * CHUNK * pp;
    chunkLayer.addChild(sp);

    chunkMap.set(key, { sprite: sp, used: performance.now() });
    // LRU：超上限淘汰最久未用的（同时销毁纹理，避免显存泄漏）
    if (chunkMap.size > CACHE_CAP) {
      var oldestKey = null, oldestT = Infinity;
      chunkMap.forEach(function (v, k) { if (v.used < oldestT) { oldestT = v.used; oldestKey = k; } });
      if (oldestKey) {
        var v = chunkMap.get(oldestKey);
        if (v.sprite.parent) v.sprite.parent.removeChild(v.sprite);
        if (v.sprite.texture) v.sprite.texture.destroy(true);
        v.sprite.destroy();
        chunkMap.delete(oldestKey);
      }
    }
    return sp;
  }

  // ---------- 相机 ----------
  function applyCamera() {
    var s = scaleFor(cam.zoom);
    chunkLayer.scale.set(s);
    var w = app.screen.width, h = app.screen.height;
    chunkLayer.x = Math.round(w / 2 - cam.x * pxPerTile());
    chunkLayer.y = Math.round(h / 2 - cam.y * pxPerTile());
    for (var i = 0; i < cityLabels.length; i++) {
      var c = cityLabels[i];
      c.grp.x = Math.round(w / 2 + (c.tx - cam.x) * pxPerTile());
      c.grp.y = Math.round(h / 2 + (c.ty - cam.y) * pxPerTile());
      c.grp.visible = cam.zoom >= 0.25;
    }
  }

  function clampCam() {
    var w = app.screen.width, h = app.screen.height;
    var halfW = w / 2 / pxPerTile(), halfH = h / 2 / pxPerTile();
    cam.x = Math.max(Math.min(cam.x, W - halfW), halfW);
    cam.y = Math.max(Math.min(cam.y, H - halfH), halfH);
  }

  function visibleChunkRange() {
    var w = app.screen.width, h = app.screen.height;
    var halfW = w / 2 / pxPerTile(), halfH = h / 2 / pxPerTile();
    return {
      cx0: Math.floor((cam.x - halfW) / CHUNK) - 1, cx1: Math.floor((cam.x + halfW) / CHUNK) + 1,
      cy0: Math.floor((cam.y - halfH) / CHUNK) - 1, cy1: Math.floor((cam.y + halfH) / CHUNK) + 1
    };
  }

  // ---------- 小地图 ----------
  var mini = null, miniCtx = null, miniImg = null;
  function drawMini() {
    if (!miniCtx || !miniImg) return;
    var mw = mini.width, mh = mini.height;
    miniCtx.drawImage(miniImg, 0, 0, mw, mh);
    var sx = mw / W, sy = mh / H;
    var w = app.screen.width, h = app.screen.height;
    var halfW = w / 2 / pxPerTile(), halfH = h / 2 / pxPerTile();
    miniCtx.strokeStyle = "#f4f1e8";
    miniCtx.lineWidth = 1.5;
    miniCtx.strokeRect((cam.x - halfW) * sx, (cam.y - halfH) * sy, halfW * 2 * sx, halfH * 2 * sy);
  }

  // ---------- 启动 ----------
  function boot() {
    app = new PIXI.Application();
    app.init({ background: "#0a0e07", resizeTo: window, antialias: false }).then(function () {
      document.body.appendChild(app.canvas);
      chunkLayer = new PIXI.Container();
      labelLayer = new PIXI.Container();
      app.stage.addChild(chunkLayer);
      app.stage.addChild(labelLayer);

      buildLabels();
      clampCam();
      applyCamera();
      app.ticker.add(tick);
      console.log("[world] ready", W + "×" + H, "格");
    });
  }

  function buildLabels() {
    var style = new PIXI.TextStyle({
      fontFamily: "Microsoft YaHei, system-ui, sans-serif",
      fontSize: 12,
      fill: "#101510",
      stroke: { color: "#eef3e4", width: 3, join: "round" }
    });
    for (var i = 0; i < meta.cities.length; i++) {
      var c = meta.cities[i];
      var grp = new PIXI.Container();
      var dot = new PIXI.Graphics();
      dot.circle(0, 0, 2.5).fill(0x223022);
      var t = new PIXI.Text({ text: c.name, style: style });
      t.x = 6; t.y = -8;
      grp.addChild(dot, t);
      grp.x = -999; grp.y = -999;
      labelLayer.addChild(grp);
      cityLabels.push({ grp: grp, tx: c.x, ty: c.y });
    }
  }

  function tick(ticker) {
    var dt = ticker.deltaMS || 16;
    fps = fps * 0.9 + (1000 / dt) * 0.1;

    var pp = ppFor(cam.zoom);
    var r = visibleChunkRange();
    var need = 0;
    var made = 0;

    // 先全部隐藏，再由视口需要点亮（避免旧 mip 的块残留、也省掉无效 draw call）
    chunkMap.forEach(function (v) { v.sprite.visible = false; });

    if (pp <= 2) {
      // 省级全景：单张纹理，不走分块
      for (var kk in overviewSprites) overviewSprites[kk].visible = (Number(kk) === pp);
      if (!overviewSprites[pp]) bakeOverview(pp);
      overviewSprites[pp].visible = true;
      stats.visible = 1;
      applyCamera();
      var now0 = performance.now();
      if (now0 - hudAt > 250) { hudAt = now0; updateHud(); drawMini(); }
      return;
    }
    for (var kk2 in overviewSprites) overviewSprites[kk2].visible = false;

    for (var cy = r.cy0; cy <= r.cy1; cy++) {
      for (var cx = r.cx0; cx <= r.cx1; cx++) {
        if (cx < 0 || cy < 0 || cx * CHUNK >= W || cy * CHUNK >= H) continue;
        need++;
        var key = chunkKey(cx, cy, pp);
        var hit = chunkMap.get(key);
        if (hit) {
          hit.used = performance.now();
          hit.sprite.visible = true;
        } else if (made < BAKE_PER_FRAME) {
          getChunk(cx, cy, pp).visible = true;
          made++;
        }
      }
    }
    stats.visible = need;

    applyCamera();

    var now = performance.now();
    if (now - hudAt > 250) {
      hudAt = now;
      updateHud();
      drawMini();
    }
  }

  function updateHud() {
    var tx = Math.floor(cam.x), ty = Math.floor(cam.y);
    var lng = meta.lng0 + (cam.x * meta.tileKm) / meta.kmPerDegLng;
    var lat = meta.lat1 - (cam.y * meta.tileKm) / meta.kmPerDegLat;
    var b = bio(tx, ty);
    var zt = cam.zoom < 1 ? (TILE * cam.zoom) + "px/格" : cam.zoom + "×";
    hud.textContent = "湖北 · " + zt + " · 格 " + tx + "," + ty +
      " · " + lng.toFixed(2) + "°E " + lat.toFixed(2) + "°N" +
      " · " + BIOME[b] + " · " + Math.round(fps) + " FPS · " +
      (ppFor(cam.zoom) <= 2 ? "全景单图" : "块 " + stats.visible + "/" + chunkMap.size);
  }

  // ---------- 交互 ----------
  function bindInput() {
    var dragging = false, lastX = 0, lastY = 0;

    app.canvas.addEventListener("pointerdown", function (e) {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      app.canvas.setPointerCapture(e.pointerId);
    });
    app.canvas.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      cam.x -= (e.clientX - lastX) / pxPerTile();
      cam.y -= (e.clientY - lastY) / pxPerTile();
      lastX = e.clientX; lastY = e.clientY;
      clampCam();
      applyCamera();
    });
    app.canvas.addEventListener("pointerup", function (e) {
      dragging = false;
      try { app.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    app.canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var i = zoomIndex();
      var dir = e.deltaY > 0 ? -1 : 1;
      var ni = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
      if (ni === i) return;

      // 记录光标下的格坐标，缩放后仍停在同一格
      var rect = app.canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var cxw = cam.x + (mx - app.screen.width / 2) / pxPerTile();
      var cyw = cam.y + (my - app.screen.height / 2) / pxPerTile();

      cam.zoom = ZOOMS[ni];
      cam.x = cxw - (mx - app.screen.width / 2) / pxPerTile();
      cam.y = cyw - (my - app.screen.height / 2) / pxPerTile();
      clampCam();
      applyCamera();
      // 换 mip 后旧块不可用，清空可见标记（缓存保留，可复用）
      chunkMap.forEach(function (v) { v.sprite.visible = false; });
    }, { passive: false });
  }

  // ---------- HUD / 载入 ----------
  var hud = document.getElementById("hud");

  function loadMini() {
    mini = document.getElementById("mini");
    if (!mini) return;
    miniCtx = mini.getContext("2d");
    miniImg = new Image();
    miniImg.onload = function () { miniCtx.imageSmoothingEnabled = false; drawMini(); };
    miniImg.src = "/viewer/world-preview.png";
  }

  function start() {
    loadMini();
    var q = new URLSearchParams(location.search);
    var zi = q.get("zoom");
    if (zi) {
      var z = Number(zi);
      cam.zoom = ZOOMS.indexOf(z) >= 0 ? z : 0.125;
    } else {
      // 默认选"能装下全省"的最大档（1px/格 起，保证省域一屏可见）
      cam.zoom = ZOOMS[0];
      for (var i = ZOOMS.length - 1; i >= 0; i--) {
        if (W * TILE * ZOOMS[i] <= window.innerWidth * 0.97) { cam.zoom = ZOOMS[i]; break; }
      }
    }
    if (q.get("x") && q.get("y")) {
      cam.x = Number(q.get("x"));
      cam.y = Number(q.get("y"));
    } else {
      cam.x = W / 2;
      cam.y = H / 2;
    }
    boot();
    bindInputQueued();
  }

  function bindInputQueued() {
    var iv = setInterval(function () {
      if (app && app.canvas) {
        clearInterval(iv);
        bindInput();
      }
    }, 30);
  }

  // QA 钩子
  window.__worldDebug = function () {
    return {
      fps: Math.round(fps),
      zoom: cam.zoom,
      cam: { x: +cam.x.toFixed(2), y: +cam.y.toFixed(2) },
      grid: W + "×" + H,
      chunks: chunkMap.size,
      visibleChunks: stats.visible,
      bakedTotal: stats.baked,
      biomeAt: bio(Math.floor(cam.x), Math.floor(cam.y))
    };
  };

  // ---------- 数据加载 ----------
  fetch("/maps/hubei.json").then(function (r) { return r.json(); }).then(function (m) {
    meta = m;
    W = m.w; H = m.h;
    var jobs = [fetch("/maps/hubei.bin").then(function (r) { return r.arrayBuffer(); })];
    if (m.elevFile) jobs.push(fetch("/maps/" + m.elevFile).then(function (r) { return r.arrayBuffer(); }));
    return Promise.all(jobs);
  }).then(function (bufs) {
    grid = new Uint8Array(bufs[0]);
    if (grid.length !== W * H) throw new Error("网格尺寸不匹配：" + grid.length + " vs " + (W * H));
    if (bufs[1]) elevU8 = new Uint8Array(bufs[1]);
    hud.textContent = "湖北省 · " + W + " × " + H + " 格 · 载入完成";
    start();
  }).catch(function (err) {
    hud.textContent = "载入失败：" + err.message;
    console.error(err);
  });
})();
