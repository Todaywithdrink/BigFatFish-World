// Pixi 渲染器 v3：SSE 增量流 + 帧级插值 + 整数缩放 + 昼夜色调 + 水面动画
//                   + 单图集（atlas.js）+ 角色常量表（char.js）+ 村民换装 + 视口裁剪
// 数据来源：GET /api/world（地图与初始快照）+ GET /api/stream（10Hz 状态推流）
// 资产来源：viewer/atlas.js、viewer/char.js —— 均由 sim/tools/build-*.mjs 自动生成，本文件不写死任何图集索引
//
// 像素纪律（本文件的三条硬约束）：
//   1. 世界坐标 = 1 倍原生像素（TILE=16），所有精灵位置取整；
//   2. 缩放档位只允许整数倍（1/2/3/4），屏幕像素倍率不可能出现半像素；
//   3. 相机平移量取整 —— 三条合起来保证任何缩放下像素边缘都落在整数像素上。
(async function () {
  var TILE = 16;
  var ZOOM_STEPS = [1, 2, 3, 4];   // 屏幕像素倍率，只取整数
  var ZOOM_DEFAULT = 2;            // 贴近旧版 1.2×2≈2.4 的观感
  var WATER_ANIM_MS = 520;         // 水面两帧交替周期
  var WATER_SPRITE_CAP = 4000;     // 水面瓦片超过此数则退回静态烘焙（保护低端机）
  var WALK_HOLD_MS = 240;          // 最后一次位移后继续播放走路动画的时长
  var CULL_INTERVAL_MS = 180;      // 视口裁剪重算间隔
  var RECOLOR_LIMIT = 40;          // 换装贴图缓存上限（每张约 0.27MB，超限退回共用贴图）

  var ATLAS = window.ATLAS, CHAR_SET = window.CHAR_SET;
  if (!ATLAS || !CHAR_SET) {
    console.error("缺少 atlas.js / char.js —— 先跑 node sim/tools/build-atlas.mjs 与 node sim/tools/build-char.mjs");
    return;
  }

  var app = new PIXI.Application();
  await app.init({ background: 0x0a0e07, resizeTo: window, antialias: false, roundPixels: true });
  document.body.appendChild(app.canvas);
  app.canvas.style.imageRendering = "pixelated";

  var world = new PIXI.Container();
  app.stage.addChild(world);

  var atlasTex = await PIXI.Assets.load(ATLAS.img);
  var charTex = await PIXI.Assets.load(CHAR_SET.img);

  var hud = document.getElementById("hud");

  var tmj = null;
  try {
    var r = await fetch("/maps/village.tmj");
    if (r.ok) tmj = await r.json();
  } catch (e) { tmj = null; }

  var data = await (await fetch("/api/world")).json();
  var map = data.map;
  var W = tmj ? tmj.width : map.width;
  var H = tmj ? tmj.height : map.height;

  function hash2(x, y) {
    var h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---------- 图集取格工具：索引全部来自 ATLAS，本文件不出现任何裸数字索引 ----------
  function cellRect(i) {
    return new PIXI.Rectangle((i % ATLAS.cols) * TILE, Math.floor(i / ATLAS.cols) * TILE, TILE, TILE);
  }
  var waterA = ATLAS.ground.water_a;
  var waterB = ATLAS.ground.water_b;
  var waterTexA = new PIXI.Texture({ source: atlasTex.source, frame: cellRect(waterA) });
  var waterTexB = new PIXI.Texture({ source: atlasTex.source, frame: cellRect(waterB) });

  // ---------- 地面烘焙（同时采集水面瓦片位置，供动画层复用） ----------
  var groundCanvas = document.createElement("canvas");
  groundCanvas.width = W * TILE;
  groundCanvas.height = H * TILE;
  var gc = groundCanvas.getContext("2d");
  gc.imageSmoothingEnabled = false;

  var waterTiles = [];
  var atlasRes = atlasTex.source.resource;

  function drawCell(idx, dx, dy) {
    gc.drawImage(
      atlasRes,
      (idx % ATLAS.cols) * TILE, Math.floor(idx / ATLAS.cols) * TILE, TILE, TILE,
      dx, dy, TILE, TILE
    );
  }

  if (tmj) {
    var groundData = tmj.layers.find(function (l) { return l.name === "ground"; }).data;
    var G0 = ATLAS.ground;

    // 第一遍：先把每格的地皮索引算出来（后面水岸、道路拼边都要查邻居）
    var groundIdx = new Int16Array(W * H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var gid = groundData[y * W + x];
        groundIdx[y * W + x] = gid ? ATLAS.idxOfGid(gid) : -1;
      }
    }

    // 道路集合：path / path2 以及 path_0..15 都算"路面"，用于算拼边掩码
    var PATH_N0 = G0.path_0, PATH_N1 = G0.path_15;
    function isPathIdx(i) {
      if (i < 0) return false;
      if (i === G0.path || i === G0.path2) return true;
      return PATH_N0 != null && i >= PATH_N0 && i <= PATH_N1;
    }
    var roadSet = {};
    for (var ry = 0; ry < H; ry++) {
      for (var rx = 0; rx < W; rx++) {
        if (isPathIdx(groundIdx[ry * W + rx])) roadSet[rx + "," + ry] = 1;
      }
    }
    function isRoadCell(x, y) { return roadSet[x + "," + y] === 1; }

    // 第二遍：路面按 4 邻接掩码换成拼边变体（图集里 path_N 与掩码 N 是恒等映射）
    // 之前的做法把整条路都画成一格纯土，边缘是刀切一样的直线 —— 这是画面"廉价感"的主要来源之一。
    for (var y5 = 0; y5 < H; y5++) {
      for (var x5 = 0; x5 < W; x5++) {
        var ci = groundIdx[y5 * W + x5];
        if (ci < 0) continue;
        if (ci === waterA || ci === waterB) waterTiles.push({ x: x5, y: y5 });
        if (ci === G0.path || ci === G0.path2) {
          var pm = 0;
          if (!isRoadCell(x5, y5 - 1)) pm |= 1;
          if (!isRoadCell(x5 + 1, y5)) pm |= 2;
          if (!isRoadCell(x5, y5 + 1)) pm |= 4;
          if (!isRoadCell(x5 - 1, y5)) pm |= 8;
          var pv = G0["path_" + pm];
          if (pv != null) ci = pv;
        }
        drawCell(ci, x5 * TILE, y5 * TILE);
      }
    }
  } else {
    var legend = map.legend;
    var kindAt = function (x, y) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return "edge";
      var lg = legend[map.rows[y][x]];
      return lg ? lg.kind : "grass";
    };
    var G = ATLAS.ground;
    for (var y2 = 0; y2 < H; y2++) {
      for (var x2 = 0; x2 < W; x2++) {
        var k = kindAt(x2, y2);
        var gi = G.grass;
        if (k === "water") { gi = G.water_a; waterTiles.push({ x: x2, y: y2 }); }
        else if (k === "path") gi = G.path_0;
        else if (k === "sand") gi = G.path;
        drawCell(gi, x2 * TILE, y2 * TILE);
      }
    }
  }

  var ground = new PIXI.Sprite(PIXI.Texture.from(groundCanvas));
  world.addChild(ground);

  // ---------- 水岸过渡：按 4 邻接掩码取岸线变体（瓦片由 build-atlas 程序化派生） ----------
  // 掩码位：1=北是陆地 2=东 4=南 8=西；图外一律视为陆地（水体会在地图边缘收口）
  var waterSet = {};
  for (var ws0 = 0; ws0 < waterTiles.length; ws0++) waterSet[waterTiles[ws0].x + "," + waterTiles[ws0].y] = 1;
  function isWater(x, y) { return waterSet[x + "," + y] === 1; }
  function waterMask(x, y) {
    var m = 0;
    if (!isWater(x, y - 1)) m |= 1;
    if (!isWater(x + 1, y)) m |= 2;
    if (!isWater(x, y + 1)) m |= 4;
    if (!isWater(x - 1, y)) m |= 8;
    return m;
  }
  var shoreTexCache = {};
  function shoreTex(mask, frame) {
    var k = (frame ? 16 : 0) + mask;
    if (shoreTexCache[k]) return shoreTexCache[k];
    var t = ATLAS.shore
      ? new PIXI.Texture({ source: atlasTex.source, frame: ATLAS.shore.rect(mask, frame) })
      : (frame ? waterTexB : waterTexA);   // 旧图集兜底
    shoreTexCache[k] = t;
    return t;
  }

  // ---------- 水面动画层（共享同一图集 → 单批次；超上限退回静态） ----------
  var waterLayer = null, waterFrame = 0, waterFlipAt = 0;
  var waterBoxes = [];
  if (waterTiles.length && waterTiles.length <= WATER_SPRITE_CAP) {
    waterLayer = new PIXI.Container();
    for (var wi = 0; wi < waterTiles.length; wi++) {
      var wtx = waterTiles[wi];
      var wm = waterMask(wtx.x, wtx.y);
      var ws = new PIXI.Sprite(shoreTex(wm, waterFrame));
      ws.x = wtx.x * TILE;
      ws.y = wtx.y * TILE;
      ws.__mask = wm;                              // 换帧时按各自掩码取变体，不能一刀切换同一张图
      waterLayer.addChild(ws);
      waterBoxes.push({ sp: ws, x: ws.x, y: ws.y, w: TILE, h: TILE });
    }
    world.addChild(waterLayer);
  }

  var layer = new PIXI.Container();
  layer.sortableChildren = true;
  world.addChild(layer);

  // ---------- 道具（1× 原尺寸：Kenney Tiny 是"一树一格"的瓦片包） ----------
  // 记录每件道具的世界包围盒，供视口裁剪使用
  var props = [];
  var P = ATLAS.props;
  // 统一转成"图集格索引"，与 tmj 的 idxOfGid 保持同一坐标；两套写法不会再有 32 偏移的隐性 bug
  var PROP_IDS = {
    tree_round: ATLAS.idxOfProp(P.tree_round), tree_green2: ATLAS.idxOfProp(P.tree_green2),
    tree_orange: ATLAS.idxOfProp(P.tree_orange), tree_autumn: ATLAS.idxOfProp(P.tree_autumn),
    fence_h: ATLAS.idxOfProp(P.fence_h), fence_v: ATLAS.idxOfProp(P.fence_v),
    rock: ATLAS.idxOfProp(P.rock)
  };
  var objTextures = {};
  Object.keys(PROP_IDS).forEach(function (k) {
    objTextures[PROP_IDS[k]] = new PIXI.Texture({ source: atlasTex.source, frame: cellRect(PROP_IDS[k]) });
  });

  function addProp(propIdx, x, y) {
    var t = objTextures[propIdx];
    if (!t) return;
    var sp = new PIXI.Sprite(t);
    sp.anchor.set(0.5, 1);
    sp.x = Math.round((x + 0.5) * TILE);
    sp.y = Math.round((y + 1) * TILE);
    sp.zIndex = (y + 1) * 10;
    layer.addChild(sp);
    props.push({ sp: sp, x: sp.x - TILE / 2, y: sp.y - TILE, w: TILE, h: TILE });
  }

  if (tmj) {
    var objData = tmj.layers.find(function (l) { return l.name === "objects"; }).data;
    for (var y3 = 0; y3 < H; y3++) {
      for (var x3 = 0; x3 < W; x3++) {
        var g = objData[y3 * W + x3];
        if (!g) continue;
        addProp(ATLAS.idxOfGid(g), x3, y3);     // objects 层与 ground 层共用 gid 空间
      }
    }
  } else {
    for (var y4 = 0; y4 < H; y4++) {
      for (var x4 = 0; x4 < W; x4++) {
        var lg2 = map.legend[map.rows[y4][x4]];
        var kk = lg2 ? lg2.kind : "grass";
        if (kk === "tree") addProp(hash2(x4, y4) < 0.5 ? PROP_IDS.tree_round : PROP_IDS.tree_orange, x4, y4);
        else if (kk === "rock") addProp(PROP_IDS.rock, x4, y4);
      }
    }
  }

  // ---------- 村庄装饰层 ----------
  // 目的：把图集里"早就有、却从来没被画出来"的那批道具真正用起来（路灯/招牌/木桶/长椅/摊位），
  //       再补一个多格地标（水井）。全部按坐标哈希确定性放置 —— 每次刷新位置一致，便于截图回归。
  var decoCount = 0, wellPlaced = false;
  var occupied = {};

  // 图集末端的 deco 分区：多格精灵用像素矩形直接切图，不再受 16px 格约束
  function decoTexture(name) {
    var d = ATLAS.deco && ATLAS.deco[name];
    if (!d) return null;
    return new PIXI.Texture({
      source: atlasTex.source,
      frame: new PIXI.Rectangle(d.x, d.y, d.w, d.h)
    });
  }

  // 以"底边中点"为锚点放置多格装饰：与角色/树的排序基准一致
  function addDeco(tex, x, y, colsWide) {
    if (!tex) return;
    var sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5, 1);
    sp.x = Math.round((x + 0.5) * TILE);
    sp.y = Math.round((y + 1) * TILE);
    sp.zIndex = (y + 1) * 10;
    layer.addChild(sp);
    var w = tex.width, h = tex.height;
    props.push({ sp: sp, x: sp.x - w / 2, y: sp.y - h, w: w, h: h });
    decoCount++;
    var half = Math.floor((colsWide - 1) / 2);
    for (var dx = -half; dx <= half; dx++) occupied[(x + dx) + "," + y] = 1;
  }

  var singleTex = {};
  ["lamp", "sign", "bench", "barrel", "stall", "bush"].forEach(function (k) {
    if (P[k] == null) return;
    var ci = ATLAS.idxOfProp(P[k]);
    singleTex[k] = objTextures[ci] ||
      new PIXI.Texture({ source: atlasTex.source, frame: cellRect(ci) });
  });
  // 自然点缀必须用"地面图集"里的变体，不能用 props 里的同名格：
  // props 的 grass_tuft / grass_flower 是不透明且底色更亮（132,198,105），铺到 (53,165,65) 的草地上
  // 会变成一块块浅绿方格；ground 里的变体与草地同底色，盖上去是无缝的。
  if (ATLAS.ground.grass_tuft != null) singleTex.grass_tuft = new PIXI.Texture({ source: atlasTex.source, frame: cellRect(ATLAS.ground.grass_tuft) });
  if (ATLAS.ground.grass_flower != null) singleTex.grass_flower = new PIXI.Texture({ source: atlasTex.source, frame: cellRect(ATLAS.ground.grass_flower) });

  if (tmj) {
    var gData = tmj.layers.find(function (l) { return l.name === "ground"; }).data;
    var oData = tmj.layers.find(function (l) { return l.name === "objects"; }).data;
    var G2 = ATLAS.ground;
    // 道路格：用于判断"路边"；房屋/墙体不参与装饰，避免把道具摆进墙里
    var ROAD_IDX = {};
    ["path", "path2"].forEach(function (k) { if (G2[k] != null) ROAD_IDX[G2[k]] = 1; });
    for (var pi = 0; pi < 16; pi++) if (G2["path_" + pi] != null) ROAD_IDX[G2["path_" + pi]] = 1;
    var GRASS_IDX = {};
    ["grass", "grass_tuft", "grass_flower", "grass2"].forEach(function (k) { if (G2[k] != null) GRASS_IDX[G2[k]] = 1; });

    function cellIdx(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return -1;
      var gid = gData[y * W + x];
      return gid ? ATLAS.idxOfGid(gid) : -1;
    }
    function isGrass(x, y) { return GRASS_IDX[cellIdx(x, y)] === 1; }
    function isRoad(x, y) { return ROAD_IDX[cellIdx(x, y)] === 1; }
    function hasObject(x, y) { return oData[y * W + x] !== 0; }
    // 建筑结构：objects 层里的墙体/地板/屋顶/门 —— 用来判断"这块空地是不是院子旁边"
    var STRUCT_IDX = {};
    ["wall", "wall_stone", "floor", "roof", "door", "door_open"].forEach(function (k) {
      if (P[k] != null) STRUCT_IDX[ATLAS.idxOfProp(P[k])] = 1;
    });
    function nearBuilding(x, y) {
      for (var bdy = -3; bdy <= 3; bdy++) {
        for (var bdx = -3; bdx <= 3; bdx++) {
          var bx2 = x + bdx, by2 = y + bdy;
          if (bx2 < 0 || by2 < 0 || bx2 >= W || by2 >= H) continue;
          var og = oData[by2 * W + bx2];
          if (og && STRUCT_IDX[ATLAS.idxOfGid(og)] === 1) return true;
        }
      }
      return false;
    }
    function nearRoad(x, y) {
      return isRoad(x + 1, y) || isRoad(x - 1, y) || isRoad(x, y + 1) || isRoad(x, y - 1);
    }
    function free(x, y) {
      return isGrass(x, y) && !hasObject(x, y) && !occupied[x + "," + y] &&
        !isWater(x, y) && !isRoad(x, y);
    }

    // ① 地标：水井（3×3）。从地图中心螺旋外扩，先找"贴着道路"的空地，找不到就退而求其次找任意空地。
    //    分两轮是因为这张地图的道路是十字干道，很多区域离路很远，硬要求贴路会导致永远放不下。
    if (ATLAS.deco && ATLAS.deco.well) {
      var cx0 = Math.floor(W / 2), cy0 = Math.floor(H / 2);
      function findSpot(needAnchor) {
        for (var rr2 = 0; rr2 < 60; rr2++) {
          for (var ang2 = 0; ang2 < 32; ang2++) {
            var ax = Math.round(cx0 + Math.cos(ang2 / 32 * Math.PI * 2) * rr2);
            var ay = Math.round(cy0 + Math.sin(ang2 / 32 * Math.PI * 2) * rr2);
            var ok2 = true;
            for (var oy2 = -1; oy2 <= 1 && ok2; oy2++) {
              for (var ox2 = -1; ox2 <= 1 && ok2; ox2++) if (!free(ax + ox2, ay + oy2)) ok2 = false;
            }
            if (!ok2) continue;
            // 锚点：贴近道路或房屋（3 格内），空地上的孤立水井会显得像 bug
            if (needAnchor && !(nearRoad(ax, ay) || nearRoad(ax, ay + 1) || nearBuilding(ax, ay))) continue;
            return { x: ax, y: ay };
          }
        }
        return null;
      }
      var best = findSpot(true) || findSpot(false);
      if (best) {
        addDeco(decoTexture("well"), best.x, best.y, 3);
        wellPlaced = true;
        for (var by = -1; by <= 1; by++) for (var bx = -1; bx <= 1; bx++) occupied[(best.x + bx) + "," + (best.y + by)] = 1;
      }
    }

    // ② 路边生活道具：路灯 / 木桶 / 招牌 / 长椅 / 摊贩
    //    密度必须克制：像素画里"每屏 1~2 件"才有生活感，"每格 1 件"只会变成噪声。
    //    概率用坐标哈希决定 → 确定性、无随机种子、每次渲染一致，便于截图回归。
    var DECO_CAP = 48;
    for (var dy2 = 0; dy2 < H && decoCount < DECO_CAP; dy2++) {
      for (var dx2 = 0; dx2 < W && decoCount < DECO_CAP; dx2++) {
        if (!free(dx2, dy2) || !nearRoad(dx2, dy2)) continue;
        // 相邻格已被占用就跳过，避免道具挤成一堆
        if (occupied[(dx2 + 1) + "," + dy2] || occupied[(dx2 - 1) + "," + dy2] ||
            occupied[dx2 + "," + (dy2 + 1)] || occupied[dx2 + "," + (dy2 - 1)]) continue;
        var h2 = hash2(dx2 * 7 + 13, dy2 * 11 + 5);
        var pick = null;
        if (h2 < 0.030) pick = "lamp";
        else if (h2 < 0.070) pick = "barrel";
        else if (h2 < 0.092) pick = "sign";
        else if (h2 < 0.110) pick = "bench";
        else if (h2 < 0.124) pick = "stall";
        if (!pick || !singleTex[pick]) continue;
        addDeco(singleTex[pick], dx2, dy2, 1);
      }
    }

    // ③ 自然点缀：草丛 / 野花 / 灌木 —— 只在纯草地格上零星撒，用来打散大片色块
    var NATURE_CAP = 160;
    var natureCount = 0;
    for (var ny = 0; ny < H && natureCount < NATURE_CAP; ny++) {
      for (var nx = 0; nx < W && natureCount < NATURE_CAP; nx++) {
        if (!free(nx, ny)) continue;
        if (occupied[nx + "," + ny]) continue;
        if (occupied[(nx - 1) + "," + ny] || occupied[(nx + 1) + "," + ny]) continue;
        var hn = hash2(nx * 3 + 1, ny * 3 + 7);
        var nat = hn < 0.010 ? "grass_tuft" : hn < 0.016 ? "grass_flower" : hn < 0.019 ? "bush" : null;
        if (!nat || !singleTex[nat]) continue;
        addDeco(singleTex[nat], nx, ny, 1);
        natureCount++;
      }
    }
  }

  // ---------- 村民换装（调色板键替换，移植 viewer.js 的 recolorSheet） ----------
  // 做法：把整张角色图按颜色键批量换色 → 生成该村民专属贴图（每人一次，之后只切帧）。
  // 好处：一个 shader 都不用写，纯 CPU 预处理；相对逐帧重绘（Canvas 版做法）省掉每帧开销。
  var HAIR = ["#432e27", "#2f2f46", "#8c6239", "#3a3a3a", "#5b3a2a", "#6b2f4a", "#6a4834"];
  var SKIN = ["#f0d0b0", "#e8c49a", "#d9a97e", "#c98f66", "#f4dcc4"];
  var sheetCache = new Map();
  var baseSheet = charTex.source.resource;

  function mixHex(hex, to, k) {
    var a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
    var r = Math.round(((a >> 16) & 255) * (1 - k) + ((b >> 16) & 255) * k);
    var g = Math.round(((a >> 8) & 255) * (1 - k) + ((b >> 8) & 255) * k);
    var bl = Math.round((a & 255) * (1 - k) + (b & 255) * k);
    return "#" + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
  }

  function paletteOf(e) {
    var seed = 0, s = String(e.id || e.name || "x");
    for (var i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) | 0;
    return {
      hair: HAIR[Math.abs(seed) % HAIR.length],
      shirt: e.color || "#c43c3c",
      skin: SKIN[Math.abs(seed >> 3) % SKIN.length]
    };
  }

  function sheetFor(pal) {
    var key = pal.hair + "|" + pal.shirt + "|" + pal.skin;
    if (sheetCache.has(key)) return sheetCache.get(key);
    if (sheetCache.size >= RECOLOR_LIMIT) return charTex.source;   // 超限退回共用贴图

    var cv = document.createElement("canvas");
    cv.width = baseSheet.width; cv.height = baseSheet.height;
    var g2 = cv.getContext("2d");
    g2.imageSmoothingEnabled = false;
    g2.drawImage(baseSheet, 0, 0);
    var img = g2.getImageData(0, 0, cv.width, cv.height);
    var d = img.data;
    var map = {};
    map["432e27"] = mixHex(pal.hair, "#000000", 0.35);
    map["6a4834"] = pal.hair;
    map["e8d4b2"] = pal.skin;
    map["bfa787"] = mixHex(pal.skin, "#000000", 0.2);
    map["c43c3c"] = pal.shirt;
    map["882e2e"] = mixHex(pal.shirt, "#000000", 0.3);
    map["681c1c"] = mixHex(pal.shirt, "#000000", 0.5);
    map["65659b"] = mixHex(pal.shirt, "#2b3a6b", 0.75);
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      var k = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, "0");
      var to = map[k];
      if (!to) continue;
      var n = parseInt(to.slice(1), 16);
      d[i] = (n >> 16) & 255; d[i + 1] = (n >> 8) & 255; d[i + 2] = n & 255;
    }
    g2.putImageData(img, 0, 0);
    var tex = PIXI.Texture.from(cv);
    sheetCache.set(key, tex.source);
    return tex.source;
  }

  // ---------- 角色 ----------
  var charFrameCache = new Map();
  function charFrame(sheetSource, face, fr) {
    var src = sheetSource || charTex.source;
    var key = (src.uid || "base") + "|" + face + "|" + fr;
    var hit = charFrameCache.get(key);
    if (hit) return hit;
    var t = new PIXI.Texture({
      source: src,
      frame: new PIXI.Rectangle(fr * CHAR_SET.frameW, CHAR_SET.rowY(face), CHAR_SET.frameW, CHAR_SET.frameH)
    });
    charFrameCache.set(key, t);
    return t;
  }

  function faceOf(dir) {
    var o = ((dir % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (o > Math.PI * 0.25 && o <= Math.PI * 0.75) return "down";
    if (o > Math.PI * 0.75 && o <= Math.PI * 1.25) return "left";
    if (o > Math.PI * 1.25 && o <= Math.PI * 1.75) return "up";
    return "right";
  }

  // rec: { sp, sheet, x, y, tx, ty, dir, lastMoveAt, lastRow }
  var chars = new Map();
  var entityCount = 0;

  function applyState(d) {
    if (!d || !d.entities) return;
    var now = performance.now();
    var seen = new Set();
    for (var i = 0; i < d.entities.length; i++) {
      var e = d.entities[i];
      if (e.state === "dead") continue;
      seen.add(e.id);
      var rec = chars.get(e.id);
      if (!rec) {
        var sheet = sheetFor(paletteOf(e));
        var sp = new PIXI.Sprite(charFrame(sheet, "down", 0));
        sp.anchor.set(0.5, 1);
        layer.addChild(sp);
        rec = { sp: sp, sheet: sheet, x: e.x, y: e.y, tx: e.x, ty: e.y, dir: e.dir || 0, lastMoveAt: 0, lastRow: -1 };
        chars.set(e.id, rec);
      }
      // 用位移本身判定"在走"：不依赖可能与画面脱节的状态字段
      if (Math.abs(e.x - rec.tx) + Math.abs(e.y - rec.ty) > 0.02) rec.lastMoveAt = now;
      rec.tx = e.x;
      rec.ty = e.y;
      rec.dir = e.dir || 0;
    }
    chars.forEach(function (rec, id) {
      if (!seen.has(id)) { layer.removeChild(rec.sp); chars.delete(id); }
    });
    entityCount = seen.size;
    var mins = (d.clock && typeof d.clock.minutes === "number") ? d.clock.minutes : null;
    if (mins != null) nightTarget = skyTint(forceHour != null ? forceHour * 60 : mins);
  }

  // ---------- 昼夜色调（移植 viewer.js 的 skyTint 阶跃表） ----------
  function skyTint(minutes) {
    var h = minutes / 60;
    if (h < 5) return [10, 16, 44, 0.46];
    if (h < 7) return [120, 90, 70, 0.16];
    if (h < 9) return [255, 190, 140, 0.10];
    if (h < 16) return null;
    if (h < 18.5) return [255, 150, 90, 0.12];
    if (h < 20.5) return [90, 80, 150, 0.24];
    return [10, 16, 44, 0.46];
  }

  var nightTarget = skyTint((data.clock && typeof data.clock.minutes === "number") ? data.clock.minutes : 8 * 60);
  var nightCur = nightTarget ? nightTarget.slice() : [255, 255, 255, 0];
  var nightLayer = new PIXI.Sprite(PIXI.Texture.WHITE);
  nightLayer.anchor.set(0);
  nightLayer.alpha = nightCur[3];
  app.stage.addChild(nightLayer);

  function resizeNight() {
    nightLayer.width = app.screen.width;
    nightLayer.height = app.screen.height;
  }
  resizeNight();
  window.addEventListener("resize", resizeNight);

  // ---------- 相机：整数档缩放 + 平移整像素对齐 + 边界夹紧 ----------
  var cam = { x: 32, y: 36, zoom: ZOOM_DEFAULT };
  if (data.entities && data.entities.length) { cam.x = data.entities[0].x; cam.y = data.entities[0].y; }

  function nearestStep(z) {
    var best = ZOOM_STEPS[0];
    for (var i = 0; i < ZOOM_STEPS.length; i++) {
      if (Math.abs(ZOOM_STEPS[i] - z) < Math.abs(best - z)) best = ZOOM_STEPS[i];
    }
    return best;
  }

  var q = new URLSearchParams(location.search);
  if (q.get("cam")) { var c = q.get("cam").split(",").map(Number); if (c[0] && c[1]) { cam.x = c[0]; cam.y = c[1]; } }
  if (q.get("zoom")) cam.zoom = nearestStep(Number(q.get("zoom")) || ZOOM_DEFAULT);
  var forceHour = q.get("hour") != null ? Number(q.get("hour")) : null;

  function applyCam() {
    var z = cam.zoom;
    var halfW = window.innerWidth / 2 / (TILE * z);
    var halfH = window.innerHeight / 2 / (TILE * z);
    cam.x = W <= halfW * 2 ? W / 2 : Math.min(Math.max(cam.x, halfW), W - halfW);
    cam.y = H <= halfH * 2 ? H / 2 : Math.min(Math.max(cam.y, halfH), H - halfH);

    world.scale.set(z);
    world.x = Math.round(window.innerWidth / 2 - cam.x * TILE * z);
    world.y = Math.round(window.innerHeight / 2 - cam.y * TILE * z);
    cullDirty = true;
  }
  applyCam();
  window.addEventListener("resize", applyCam);

  var dragging = false, last = null;
  app.canvas.addEventListener("mousedown", function (e) { dragging = true; last = { x: e.clientX, y: e.clientY }; });
  window.addEventListener("mouseup", function () { dragging = false; });
  window.addEventListener("mousemove", function (e) {
    if (!dragging || !last) return;
    var z = cam.zoom;
    cam.x -= (e.clientX - last.x) / (TILE * z);
    cam.y -= (e.clientY - last.y) / (TILE * z);
    last = { x: e.clientX, y: e.clientY };
    applyCam();
  });
  app.canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var cur = ZOOM_STEPS.indexOf(cam.zoom);
    if (cur < 0) cur = ZOOM_STEPS.indexOf(ZOOM_DEFAULT);
    var next = e.deltaY > 0 ? cur - 1 : cur + 1;
    if (next < 0 || next >= ZOOM_STEPS.length) return;
    cam.zoom = ZOOM_STEPS[next];
    applyCam();
  }, { passive: false });

  // ---------- 视口裁剪：只保留屏幕内（含 1 格余量）的道具与水面可见 ----------
  var cullDirty = true, cullAt = 0, visibleProps = 0, visibleWater = 0;

  function cullList(list, x0, x1, y0, y1) {
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var vis = !(p.x > x1 || p.x + p.w < x0 || p.y > y1 || p.y + p.h < y0);
      if (p.sp.visible !== vis) p.sp.visible = vis;
      if (vis) n++;
    }
    return n;
  }

  function cull() {
    var z = cam.zoom;
    var viewW = window.innerWidth / z, viewH = window.innerHeight / z;
    var x0 = cam.x * TILE - viewW / 2 - TILE, x1 = cam.x * TILE + viewW / 2 + TILE;
    var y0 = cam.y * TILE - viewH / 2 - TILE, y1 = cam.y * TILE + viewH / 2 + TILE;
    visibleProps = cullList(props, x0, x1, y0, y1);
    visibleWater = cullList(waterBoxes, x0, x1, y0, y1);
    cullDirty = false;
  }

  // ---------- 主循环 ----------
  var hudAt = 0;

  app.ticker.add(function (ticker) {
    var dt = ticker.deltaMS || 16.7;
    var now = performance.now();
    var k = 1 - Math.exp(-dt / 90);   // 10Hz 数据 → 60FPS 平滑

    chars.forEach(function (rec) {
      rec.x += (rec.tx - rec.x) * k;
      rec.y += (rec.ty - rec.y) * k;

      var px = Math.round(rec.x * TILE);
      var py = Math.round((rec.y + 0.6) * TILE);
      rec.sp.x = px;
      rec.sp.y = py;
      // 只在跨格时改 zIndex：避免每帧把整个排序层标脏、白做一次全层重排
      var row = Math.floor(py / TILE);
      if (row !== rec.lastRow) { rec.sp.zIndex = py; rec.lastRow = row; }

      var face = faceOf(rec.dir);
      var walking = (now - rec.lastMoveAt) < WALK_HOLD_MS;
      var fr = walking ? Math.floor(now / 150) % CHAR_SET.walkFrames : 0;
      rec.sp.texture = charFrame(rec.sheet, face === "right" ? "left" : face, fr);
      rec.sp.scale.x = face === "right" ? -1 : 1;
    });

    if (waterLayer && now >= waterFlipAt) {
      waterFlipAt = now + WATER_ANIM_MS;
      waterFrame ^= 1;
      // 每个瓦片按自己的岸线掩码换帧，岸线位置才不会跳
      for (var i = 0; i < waterLayer.children.length; i++) {
        var wsp = waterLayer.children[i];
        wsp.texture = shoreTex(wsp.__mask || 0, waterFrame);
      }
    }

    if (cullDirty && now - cullAt > CULL_INTERVAL_MS) { cullAt = now; cull(); }

    var tgt = nightTarget || [nightCur[0], nightCur[1], nightCur[2], 0];
    var nk = 1 - Math.exp(-dt / 700);
    for (var ci = 0; ci < 4; ci++) nightCur[ci] += (tgt[ci] - nightCur[ci]) * nk;
    nightLayer.tint = (Math.round(nightCur[0]) << 16) | (Math.round(nightCur[1]) << 8) | Math.round(nightCur[2]);
    nightLayer.alpha = nightCur[3];

    if (now - hudAt > 300) {
      hudAt = now;
      hud.textContent = (tmj ? "Tiled 地图" : "实时地图") + " · " + W + "×" + H +
        " · 村民 " + entityCount + " · " + cam.zoom + "× · 裁剪 " + (visibleProps + visibleWater) + "/" +
        (props.length + waterBoxes.length) + " · SSE";
    }
  });

  // ---------- 数据接入：初始快照 + SSE 增量流 ----------
  applyState(data);
  connectStream();

  function connectStream() {
    var es = new EventSource("/api/stream?v=2");
    es.onmessage = function (msg) {
      var d;
      try { d = JSON.parse(msg.data); } catch (e) { return; }
      if (d.type === "state") applyState(d);
      else if (d.type === "dyn") applyDyn(d);
    };
    es.onerror = function () {
      es.close();
      setTimeout(connectStream, 2000);
    };
  }

  // v2 增量帧：只挪位置/朝向；新实体与移除交给 2s 一次的全量 state 对账
  function applyDyn(d) {
    if (!d || !d.e) return;
    var now = performance.now();
    for (var i = 0; i < d.e.length; i++) {
      var a = d.e[i];
      var rec = chars.get(a[0]);
      if (!rec) continue;
      if (Math.abs(a[1] - rec.tx) + Math.abs(a[2] - rec.ty) > 0.02) rec.lastMoveAt = now;
      rec.tx = a[1];
      rec.ty = a[2];
      rec.dir = a[3] || 0;
    }
    var mins = (d.clock && typeof d.clock.minutes === "number") ? d.clock.minutes : null;
    if (mins != null) nightTarget = skyTint(forceHour != null ? forceHour * 60 : mins);
  }

  // ---------- QA 钩子 ----------
  window.__pixiDebug = function () {
    var list = [];
    chars.forEach(function (rec, id) {
      list.push({ id: id, x: +rec.x.toFixed(3), y: +rec.y.toFixed(3), tx: rec.tx, ty: rec.ty });
    });
    return {
      fps: Math.round(app.ticker.FPS),
      entities: entityCount,
      zoom: cam.zoom,
      night: { a: +nightLayer.alpha.toFixed(3), tint: nightLayer.tint },
      water: waterLayer ? waterLayer.children.length : 0,
      waterVisible: visibleWater,
      props: { total: props.length, visible: visibleProps },
      sheets: sheetCache.size,
      deco: { count: decoCount, well: wellPlaced },
      atlasCells: ATLAS.cols * ATLAS.rows,
      cam: { x: +cam.x.toFixed(2), y: +cam.y.toFixed(2) },
      chars: list
    };
  };
})();
