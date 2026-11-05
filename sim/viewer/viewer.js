"use strict";
// 观测站：只消费 /api/world + /api/stream，不依赖任何私有格式。
(function () {
  var canvas = document.getElementById("world");
  var mainCtx = canvas.getContext("2d");
  var ctx = mainCtx;
  var worldCanvas = document.createElement("canvas");
  var wctx = worldCanvas.getContext("2d");
  var mm = document.getElementById("minimap");
  var mmx = mm.getContext("2d");

  var map = null;
  var state = { tick: 0, clock: { day: 1, minutes: 480 }, entities: [], doors: [], log: [] };
  var views = new Map();
  var patchMap = new Map();
  var propViews = [];       // 门 / 储物箱的最新状态（角色面板轮询 /api/props 后回写）
  var PIXEL = 3;
  try {
    var pQs = new URLSearchParams(location.search);
    if (pQs.get("pixel")) PIXEL = Math.max(1, Math.min(8, Number(pQs.get("pixel")) || 3));
  } catch (e) {}
  var pixelBuf = document.createElement("canvas");
  var watchToken = null;
  var chief = false;
  var locked = false;
  var feed = [];
  var selectedId = null;
  var hoverId = null;
  var follow = false;
  var showVision = false;
  var artOff = false;   // ?art=off：退回旧的程序化画法，只用来做前后对比
  var forceHour = null; // ?hour=11：只看白天光照，截图用
  var TILE = 32;
  var cam = { x: 32, y: 36, zoom: 1.35 };

  // ---- 湖北省底图 / 镜头模式 ----
  var geo = window.GeoLayer || null;
  var geoOn = false;            // 底图已接管（加载失败自动退回原村庄底图）
  var overview = false;         // 全省地图模式
  var showMini = false;         // 小地图默认不显示
  var compact = false;          // 低倍：居民画成标记点而不是小人
  var viewTween = null;         // 镜头平滑过渡
  var savedView = null;
  var geoHudAt = 0;
  var MAX_ZOOM = 3.4;
  var FALLBACK_MIN = 0.8;
  var wantOverview = false, wantFollow = false;

  function minZoom() { return geoOn ? geo.minZoom(window.innerWidth, window.innerHeight, TILE) : FALLBACK_MIN; }
  function logGeo(s) { try { console.log("[geo] " + s); } catch (e) {} }

  try {
    var camQs = new URLSearchParams(location.search);
    if (camQs.get("cam")) {
      var cxq = camQs.get("cam").split(",").map(Number);
      if (isFinite(cxq[0]) && isFinite(cxq[1])) { cam.x = cxq[0]; cam.y = cxq[1]; }
    }
    if (camQs.get("zoom")) cam.zoom = Math.max(0.04, Math.min(MAX_ZOOM, Number(camQs.get("zoom")) || 1.35));
    if (camQs.get("watch") || camQs.get("token")) watchToken = camQs.get("watch") || camQs.get("token");
    if (camQs.get("view") === "chief") { chief = true; follow = false; cam.zoom = 0.85; }
    if (camQs.get("art") === "off") artOff = true;
    if (camQs.get("hour") != null && isFinite(Number(camQs.get("hour")))) forceHour = Number(camQs.get("hour"));
    if (camQs.get("geo") === "off") geo = null;
    if (camQs.get("mini") === "1") showMini = true;
    if (camQs.get("overview") === "1") wantOverview = true;
    if (camQs.get("follow") === "1") wantFollow = true;
  } catch (e) {}
  var dragging = false, dragged = false, lastMouse = null;
  var timeMs = 0;
  var skillCache = new Map();

  var COLORS = {
    grass: [104, 170, 84], path: [222, 166, 110], wall: [74, 61, 49], door: [129, 92, 52],
    floor: [168, 148, 111], bed: [203, 182, 146], stove: [95, 95, 95], tree: [58, 112, 52],
    water: [96, 190, 220], rock: [108, 97, 107], fence: [140, 87, 69],
    flower: [104, 170, 84], lamp: [92, 82, 61], bench: [126, 92, 54],
    plank: [178, 150, 108], fountain: [156, 138, 104], board: [120, 96, 64],
    soil: [96, 70, 48], crop: [110, 150, 70], stall: [170, 84, 64], sand: [206, 190, 146],
    hedge: [58, 112, 52], barrel: [128, 92, 54], crate: [138, 98, 56]
  };

  // ---------- 图集（Kenney CC0：Tiny Town / Tiny Battle）----------
  var TS = window.TILESET || null;
  var atlas = null, atlasReady = false;
  if (TS) {
    atlas = new Image();
    atlas.onload = function () { atlasReady = true; };
    atlas.src = TS.img;
  }
  function artOn() { return atlasReady && !artOff; }
  // ---------- 第二套图集（Overworld，CC0）：?art=ow 启用 ----------
  var TS2 = window.TILESET2 || null;
  var atlas2 = null, atlas2Ready = false;
  if (TS2) { atlas2 = new Image(); atlas2.onload = function () { atlas2Ready = true; }; atlas2.src = TS2.img; }
  var useOW = !/[?&]art=old/.test(location.search);   // 默认新图集，?art=old 回退
  function drawSpr(name, dx, dy, dw) {
    if (useOW && atlas2Ready && TS2) {
      var j = TS2.idx[name];
      if (j != null) {
        var t2 = TS2.size, c2 = TS2.cols;
        ctx.drawImage(atlas2, (j % c2) * t2, Math.floor(j / c2) * t2, t2, t2, Math.round(dx), Math.round(dy), dw, dw);
        return true;
      }
    }
    if (!atlasReady || artOff || !TS) return false;
    var i = TS.idx[name];
    if (i == null) return false;
    var t = TS.size, c = TS.cols;
    ctx.drawImage(atlas, (i % c) * t, Math.floor(i / c) * t, t, t, Math.round(dx), Math.round(dy), dw, dw);
    return true;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hash2(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function rgba(c, a) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function shade(c, f) {
    return "rgb(" + clamp(Math.round(c[0] * f), 0, 255) + "," + clamp(Math.round(c[1] * f), 0, 255) + "," + clamp(Math.round(c[2] * f), 0, 255) + ")";
  }

  // ---------- 尺寸 ----------
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    mainCtx.imageSmoothingEnabled = false;

    // 世界画布只有 1/PIXEL 大小：图元天然落在像素网格上
    worldCanvas.width = Math.max(1, Math.ceil(window.innerWidth / PIXEL));
    worldCanvas.height = Math.max(1, Math.ceil(window.innerHeight / PIXEL));
    wctx.setTransform(1 / PIXEL, 0, 0, 1 / PIXEL, 0, 0);
    wctx.imageSmoothingEnabled = false;

    ctx = mainCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------- 数据 ----------
  fetch("/api/world").then(function (r) { return r.json(); }).then(function (d) {
    map = d.map;
    findFountain();
    applyState(d);
    connect();
    watchAgent();
    if (chief) setBadge("村长视角 · 全省");
    setMini(showMini);
    // 湖北底图异步接入：失败只退回原村庄底图，不阻塞观测
    if (geo) {
      geo.load().then(function () {
        geoOn = geo.ready();
        if (!geoOn) { logGeo("底图不可用：" + geo.failed()); return; }
        logGeo("湖北省 " + geo.status() + " 已接入");
        clampCamera();
        if (wantOverview) setOverview(true, true);
        else if (wantFollow) selectVillager(selectedId, true);
      });
    }
    drawMini();
  });

  var fountain = null;
  function findFountain() {
    var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, found = false;
    for (var y = 0; y < map.height; y++) {
      for (var x = 0; x < map.width; x++) {
        var legend = map.legend[map.rows[y][x]] || map.legend["."];
        if (legend.kind !== "fountain") continue;
        found = true;
        minx = Math.min(minx, x); maxx = Math.max(maxx, x);
        miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      }
    }
    if (found) fountain = { x: (minx + maxx) / 2 + 0.5, y: (miny + maxy) / 2 + 0.5, w: maxx - minx + 1, h: maxy - miny + 1 };
  }

  function watchAgent() {
    if (!watchToken) return;
    fetch("/api/agents/" + watchToken + "/status").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.villager) return;
      selectedId = d.villager.id;
      follow = true;
      locked = true;
      setBadge("观看：" + d.villager.name);
    }).catch(function () {});
  }

  function setBadge(text) {
    var el = document.getElementById("watch-badge");
    if (!el) {
      el = document.createElement("div");
      el.id = "watch-badge";
      el.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);" +
        "padding:7px 16px;border-radius:999px;background:rgba(18,24,16,.82);" +
        "border:1px solid rgba(255,255,255,.12);font:12px 'Microsoft YaHei',system-ui;color:#dfe8d4;z-index:7;" +
        "pointer-events:none;backdrop-filter:blur(8px)";
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  function connect() {
    var es = new EventSource("/api/stream?v=2");
    es.onmessage = function (msg) {
      var d = JSON.parse(msg.data);
      if (d.type === "state") { applyState(d); drawMini(); }
      else if (d.type === "dyn") { applyDyn(d); drawMini(); }
      if (d.type === "mapnew") { map = d.map; findFountain(); patchMap = new Map(); drawMini(); }
      else if (d.type === "event") pushEvent(d.ev);
    };
    es.onerror = function () { setTimeout(connect, 2000); es.close(); };
  }

  // v2 增量帧：只更新会动的字段（位置/朝向/状态/HP/气泡），静态信息等 2s 全量对账
  function applyDyn(d) {
    state.tick = d.tick;
    if (d.clock) state.clock = d.clock;
    var ents = state.entities || [];
    for (var i = 0; i < d.e.length; i++) {
      var a = d.e[i];
      for (var j = 0; j < ents.length; j++) {
        if (ents[j].id !== a[0]) continue;
        var e = ents[j];
        e.x = a[1]; e.y = a[2]; e.dir = a[3]; e.state = a[4];
        if (a[5] != null) e.hp = a[5];
        if (a[6] !== undefined) e.bubble = a[6];
        var cur = views.get(e.id);
        if (cur) {
          cur.tx = e.x; cur.ty = e.y;
          cur.x = lerp(cur.x, e.x, 0.5);
          cur.y = lerp(cur.y, e.y, 0.5);
          cur.dir = e.dir; cur.state = e.state; cur.bubble = e.bubble;
          if (a[5] != null) cur.hp = e.hp;
        }
        break;
      }
    }
    updateHud();
  }

  function applyState(d) {
    state = d;
    if (d.patches) {
      patchMap = new Map();
      for (var pi = 0; pi < d.patches.length; pi++) {
        var pp = d.patches[pi];
        patchMap.set(pp[0] + "," + pp[1], pp[2]);
      }
    }
    for (var i = 0; i < d.entities.length; i++) {
      var e = d.entities[i];
      var cur = views.get(e.id);
      if (!cur) {
        cur = { x: e.x, y: e.y };
        views.set(e.id, cur);
      }
      cur.tx = e.x; cur.ty = e.y;
      cur.x = lerp(cur.x, e.x, 0.35);
      cur.y = lerp(cur.y, e.y, 0.35);
      Object.assign(cur, {
        id: e.id, name: e.name, role: e.role, color: e.color,
        hp: e.hp, maxHp: e.maxHp, state: e.state, bubble: e.bubble,
        dir: e.dir, talkTo: e.talkTo, exploredCount: e.exploredCount,
        coins: e.coins, inventory: e.inventory, uid: e.uid, appearance: e.appearance,
        needs: e.needs, bag: e.bag, mood: e.mood, goal: e.goal,
        external: e.external, stage: e.stage, ageDays: e.ageDays
      });
    }
    if (!selectedId && d.entities.length) selectedId = d.entities[0].id;
    updateHud();
  }

  // ---------- 事件流 ----------
  function pushEvent(ev) {
    var item = describe(ev);
    if (!item) return;
    feed.push(item);
    while (feed.length > 14) feed.shift();
    renderFeed();
  }

  function describe(ev) {
    var t = clockText();
    if (ev.type === "utterance") {
      return { cls: "talk", who: ev.from.name, txt: ev.text, t: t };
    }
    if (ev.type === "heard_muffled") {
      return { cls: "talk", who: ev.from.name, txt: "（低声说话，听不清）", t: t };
    }
    if (ev.type === "fell") {
      return { cls: "danger", who: "!", txt: "有人从" + ev.drop + " 米高处摔下来，掉了" + ev.damage + " 点", t: t };
    }
    if (ev.type === "downed") {
      return { cls: "danger", who: "!", txt: "有人倒下了", t: t };
    }
    if (ev.type === "learned_recipe") {
      return { cls: "good", who: "+", txt: "有人学会了做" + ev.name + "！", t: t };
    }
    if (ev.type === "attack_landed") {
      return { cls: "danger", who: "!", txt: "有人挨了一下，掉" + ev.damage + " 点血", t: t };
    }
    return null;
  }

  function renderFeed() {
    var el = document.getElementById("feed");
    el.innerHTML = "";
    for (var i = feed.length - 1; i >= 0; i--) {
      var f = feed[i];
      var row = document.createElement("div");
      row.className = "feed-item " + (f.cls || "");
      var who = document.createElement("span");
      who.className = "who"; who.textContent = f.who;
      var txt = document.createElement("span");
      txt.className = "txt"; txt.textContent = f.txt;
      var tt = document.createElement("span");
      tt.className = "t"; tt.textContent = f.t;
      row.appendChild(who); row.appendChild(txt); row.appendChild(tt);
      el.appendChild(row);
    }
  }

  // ---------- HUD ----------
  function clockText() {
    if (!state.clock) return "--:--";
    var h = Math.floor(state.clock.minutes / 60);
    var m = Math.floor(state.clock.minutes % 60);
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function updateHud() {
    document.getElementById("clock-text").textContent = "第" + state.clock.day + " 天 · " + clockText();
    document.getElementById("pop-text").textContent = "村民 " + state.entities.length;
    document.getElementById("tick-text").textContent = "tick " + state.tick;

    var dot = document.getElementById("sky-dot");
    var h = state.clock.minutes / 60;
    dot.className = "dot " + (h >= 20 || h < 6 ? "night" : h >= 17 ? "dusk" : "");

    var sel = views.get(selectedId);
    // 角色展示页由 character-panel.js 独立渲染（角色 / 背包 / 储物·门禁三个视图）。
    // 这里只负责把"当前选中的是谁 + 最新世界状态"递过去，不再直接改它的 DOM。
    if (window.CharacterPanel) window.CharacterPanel.update(sel, state);
  }

  // 技能与性格改由角色面板直接从 /api/villagers/:id 读取并渲染，旧的
  // loadSkills / renderSkills 操作的是已经不存在的 #insp-skills，整段移除。

  function roleName(r) {
    return { fisher: "渔夫", farmer: "农夫", cook: "厨子", wanderer: "闲人" }[r] || r;
  }

  // ---------- 相机 ----------
  function worldToScreen(x, y) {
    var z = TILE * cam.zoom;
    return { x: (x - cam.x) * z + window.innerWidth / 2, y: (y - cam.y) * z + window.innerHeight / 2, z: z };
  }

  function clampCamera() {
    if (!map) return;
    var hw = window.innerWidth / 2 / (TILE * cam.zoom);
    var hh = window.innerHeight / 2 / (TILE * cam.zoom);
    // 底图接管后，镜头活动范围是整个湖北省，居民靠边也能真正居中
    var b = geoOn ? geo.bounds() : { x0: 0, y0: 0, x1: map.width, y1: map.height };
    cam.x = (b.x1 - b.x0) <= hw * 2 ? (b.x0 + b.x1) / 2 : clamp(cam.x, b.x0 + hw, b.x1 - hw);
    cam.y = (b.y1 - b.y0) <= hh * 2 ? (b.y0 + b.y1) / 2 : clamp(cam.y, b.y0 + hh, b.y1 - hh);
  }

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

  // ---------- 主循环 ----------
  function pixelate() {
    if (PIXEL <= 1) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(canvas.width / PIXEL));
    var h = Math.max(1, Math.round(canvas.height / PIXEL));
    pixelBuf.width = w;
    pixelBuf.height = h;
    var pctx = pixelBuf.getContext("2d");
    pctx.imageSmoothingEnabled = true;
    pctx.drawImage(canvas, 0, 0, w, h);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(pixelBuf, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function frame(ts) {
    timeMs = ts || 0;
    requestAnimationFrame(frame);
    if (!map) return;

    // 镜头过渡优先于跟随：全地图 ↔ 居民视角是平滑飞行，不瞬移
    if (viewTween) {
      var k = Math.min(1, (timeMs - viewTween.t0) / viewTween.dur);
      var e = k * k * (3 - 2 * k);
      cam.zoom = lerp(viewTween.fromZoom, viewTween.toZoom, e);
      cam.x = lerp(viewTween.fromX, viewTween.toX, e);
      cam.y = lerp(viewTween.fromY, viewTween.toY, e);
      if (k >= 1) viewTween = null;
    } else if (follow) {
      var sel = views.get(selectedId);
      if (sel) { cam.x = lerp(cam.x, sel.x, 0.10); cam.y = lerp(cam.y, sel.y, 0.10); }
    }
    clampCamera();
    compact = geoOn && (TILE * cam.zoom) < 10;
    if (geoOn && timeMs - geoHudAt > 260) { geoHudAt = timeMs; updateGeoHud(); }

    // 世界层画在 1/PIXEL 的画布上
    ctx = wctx;
    ctx.setTransform(1 / PIXEL, 0, 0, 1 / PIXEL, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0a0e07";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    drawWorld();
    drawHudOverlay();

    // 整数倍放大到主画布（最近邻）
    ctx = mainCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(worldCanvas, 0, 0, canvas.width, canvas.height);

    // 文字层：高清，不参与缩放
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    drawWorldText();
  }

  function drawWorld() {
    var z = TILE * cam.zoom;
    if (geoOn) geo.draw(ctx, cam, z, window.innerWidth, window.innerHeight);

    // 全省低倍：不逐格画村庄，只留地形 + 居民标记，避免几千格 fillRect 拖慢帧率
    if (compact) { drawCompactMarkers(z); return; }

    var x0 = Math.max(0, Math.floor(cam.x - window.innerWidth / 2 / z) - 1);
    var y0 = Math.max(0, Math.floor(cam.y - window.innerHeight / 2 / z) - 1);
    var x1 = Math.min(map.width, Math.ceil(cam.x + window.innerWidth / 2 / z) + 1);
    var y1 = Math.min(map.height, Math.ceil(cam.y + window.innerHeight / 2 / z) + 1);

    // 地面（树/栅栏/石头只铺草皮，本体进下面的 y 排序层）
    var props = [];
    for (var ty = y0; ty < y1; ty++) {
      for (var tx = x0; tx < x1; tx++) {
        var kd = tileKind(tx, ty);
        // 湖北地形接管纯草皮，房子/路/水/树仍按聚落格叠加
        if (geoOn && (kd === "grass" || kd === "flower" || kd === "sand" || kd === "soil" || kd === "edge")) continue;
        if (artOn() && (kd === "tree" || kd === "rock" || kd === "fence" || kd === "lamp")) {
          if (!geoOn) drawGroundTile(tx, ty, z, true);
          props.push({ prop: true, tx: tx, ty: ty, kind: kd, y: ty + 0.9 });
        } else {
          drawGroundTile(tx, ty, z);
        }
      }
    }

    if (fountain) drawFountain(z);

    // 门
    var doors = state.doors || [];
    for (var i = 0; i < doors.length; i++) {
      var d = doors[i];
      if (d.x < x0 - 1 || d.x > x1 || d.y < y0 - 1 || d.y > y1) continue;
      var s = worldToScreen(d.x, d.y);
      if (artOn() && drawSpr(d.open ? "door_open" : "door", s.x, s.y, z + 1)) continue;
      ctx.fillStyle = d.open ? "#c9b48f" : "#815c34";
      ctx.fillRect(s.x + z * 0.14, s.y + z * 0.1, z * 0.72, z * 0.84);
      ctx.strokeStyle = "rgba(0,0,0,.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x + z * 0.14, s.y + z * 0.1, z * 0.72, z * 0.84);
      if (!d.open) {
        ctx.fillStyle = "rgba(255,220,150,.5)";
        ctx.beginPath();
        ctx.arc(s.x + z * 0.72, s.y + z * 0.52, z * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 储物箱：箱盖开合与锁扣在地图上直接可见（状态来自 /api/props）
    if (propViews.length && z > 7) {
      for (var ci = 0; ci < propViews.length; ci++) {
        var cp = propViews[ci];
        if (cp.kind !== "chest") continue;
        if (cp.x < x0 - 1 || cp.x > x1 || cp.y < y0 - 1 || cp.y > y1) continue;
        var cs = worldToScreen(cp.x, cp.y);
        var bx = cs.x + z * 0.16, by = cs.y + z * 0.3;
        var bw = z * 0.68, bh = z * 0.54;
        ctx.fillStyle = "#8a6238";
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = "rgba(0,0,0,.45)";
        ctx.lineWidth = Math.max(1, z * 0.035);
        ctx.strokeRect(bx, by, bw, bh);
        // 开着时盖子向上翻起，关着时压在箱口
        ctx.fillStyle = cp.open ? "#c89655" : "#a9793f";
        ctx.fillRect(bx - z * 0.04, by - (cp.open ? z * 0.3 : z * 0.11), bw + z * 0.08, z * 0.2);
        ctx.fillStyle = cp.lock && cp.lock.locked ? "#ef7d6a" : "#e8cf8a";
        ctx.fillRect(bx + bw * 0.42, by + bh * 0.4, bw * 0.16, bh * 0.26);
      }
    }

    // 对话连线
    views.forEach(function (e) {
      if (!e.talkTo) return;
      if (e.id > e.talkTo) return;
      var o = views.get(e.talkTo);
      if (!o) return;
      var a = worldToScreen(e.x, e.y), b = worldToScreen(o.x, o.y);
      ctx.save();
      ctx.strokeStyle = "rgba(159,210,255,.35)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -(timeMs / 80) % 10;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    });

    // 选中视野锥
    var sel = views.get(selectedId);
    if (showVision && sel && sel.state !== "downed") {
      var s0 = worldToScreen(sel.x, sel.y);
      var R = 8 * z;
      var g = ctx.createRadialGradient(s0.x, s0.y, 0, s0.x, s0.y, R);
      g.addColorStop(0, "rgba(200,255,170,.18)");
      g.addColorStop(1, "rgba(200,255,170,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      ctx.arc(s0.x, s0.y, R, sel.dir - Math.PI / 3, sel.dir + Math.PI / 3);
      ctx.closePath();
      ctx.fill();
    }

    // 实体 + 物件（统一按 y 排序：这样树才会挡住站在它后面的人）
    var list = [];
    views.forEach(function (e) { list.push(e); });
    list.sort(function (a, b) { return a.y - b.y; });
    var drawList = [];
    for (var li = 0; li < list.length; li++) drawList.push({ y: list[li].y, ent: list[li] });
    for (var pi = 0; pi < props.length; pi++) drawList.push({ y: props[pi].y, prop: props[pi] });
    drawList.sort(function (a, b) { return a.y - b.y; });
    for (var k = 0; k < drawList.length; k++) {
      var it = drawList[k];
      if (it.prop) { drawProp(it.prop, z); continue; }
      var e = it.ent;
      var s2 = worldToScreen(e.x, e.y);
      if (s2.x < -100 || s2.y < -100 || s2.x > window.innerWidth + 100 || s2.y > window.innerHeight + 160) continue;
      drawFish(s2.x, s2.y, z * 1.05, e, e.id === selectedId, e.id === hoverId, false);
    }

  }

  // 文字层：名字 + 气泡，画在主画布上，保持清晰
  function drawWorldText() {
    var z = TILE * cam.zoom;
    // 城市名 / 聚落框画在高清文字层，不参与像素化
    if (geoOn) geo.drawLabels(ctx, cam, z, window.innerWidth, window.innerHeight, { w: map.width, h: map.height });
    if (compact) { drawCompactNames(z); return; }
    var list = [];
    views.forEach(function (e) { list.push(e); });
    list.sort(function (a, b) { return a.y - b.y; });

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var s = worldToScreen(e.x, e.y);
      if (s.x < -100 || s.y < -100 || s.x > window.innerWidth + 100 || s.y > window.innerHeight + 160) continue;
      drawName(s.x, s.y, z * 1.05, e);
    }

    var placed = [];
    for (var m = 0; m < list.length; m++) {
      var b = list[m];
      if (!b.bubble) continue;
      var s3 = worldToScreen(b.x, b.y);
      if (s3.x < 70 || s3.x > window.innerWidth - 70 || s3.y < 40 || s3.y > window.innerHeight - 6) continue;
      var box = bubbleBox(s3.x, s3.y - z * 1.15, b.bubble);
      var guard = 0;
      while (guard < 8 && placed.some(function (r) { return overlaps(r, box); })) {
        box.y -= box.h + 8;
        guard++;
      }
      placed.push(box);
      drawBubbleAt(box, b.bubble);
    }
  }

  function drawFountain(z) {
    var s = worldToScreen(fountain.x, fountain.y);
    var r = Math.max(fountain.w, fountain.h) * z * 0.5;
    var t = timeMs / 1000;

    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + r * 0.55, r * 1.02, r * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#9a9a8e";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r, r * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#b6b6a8";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y - r * 0.06, r * 0.94, r * 0.84, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#3d6ba3";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 0.74, r * 0.66, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,.22)";
    ctx.lineWidth = 1.2;
    for (var i = 0; i < 3; i++) {
      var rr = r * (0.22 + i * 0.18) + Math.sin(t * 1.6 + i) * r * 0.03;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, rr, rr * 0.9, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = "#cfcfc0";
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(230,245,255,.75)";
    ctx.beginPath();
    ctx.arc(s.x, s.y - r * 0.12 - Math.abs(Math.sin(t)) * r * 0.06, r * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  function tileKind(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return "edge";
    var patched = patchMap.get(tx + "," + ty);
    if (patched) return patched;
    var ch = map.rows[ty][tx];
    var legend = map.legend[ch] || map.legend["."];
    return legend.kind;
  }

  function isKind(tx, ty, kind) { return tileKind(tx, ty) === kind; }

  // 小路按邻格算 4 位掩码，取预合成的拼边块（与 build-tiles.py 一致）
  function pathMask(tx, ty) {
    var m = 0;
    if (tileKind(tx, ty - 1) !== "path") m |= 1;
    if (tileKind(tx + 1, ty) !== "path") m |= 2;
    if (tileKind(tx, ty + 1) !== "path") m |= 4;
    if (tileKind(tx - 1, ty) !== "path") m |= 8;
    return m;
  }

  // 地形贴图：同一格按位置散列取变体，看起来不重复
  function groundSprite(kind, tx, ty) {
    var n = hash2(tx, ty);
    if (kind === "grass") return n < 0.16 ? "grass_tuft" : n < 0.20 ? "grass_flower" : "grass";
    if (kind === "flower") return "grass_flower";
    if (kind === "path") return "path_" + pathMask(tx, ty);
    if (kind === "water") return (Math.floor(timeMs / 620) % 2) ? "water_b" : "water_a";
    if (kind === "wall") return "wall";
    if (kind === "floor") return "floor";
    if (kind === "door") return "wall";      // 门后面是墙，门本身在上面单独画
    if (kind === "lamp") return "lamp";
    return null;
  }

  function isHouse(kind) { return kind === "wall" || kind === "floor" || kind === "door"; }

  // 和邻格不同就在那一边压一道暗边，盖住硬接缝
  function drawRim(kind, tx, ty, s, z, color) {
    var w = Math.max(2, z * 0.10);
    ctx.fillStyle = color;
    if (!isKind(tx, ty - 1, kind)) ctx.fillRect(s.x, s.y, z + 1, w);
    if (!isKind(tx, ty + 1, kind)) ctx.fillRect(s.x, s.y + z + 1 - w, z + 1, w);
    if (!isKind(tx - 1, ty, kind)) ctx.fillRect(s.x, s.y, w, z + 1);
    if (!isKind(tx + 1, ty, kind)) ctx.fillRect(s.x + z + 1 - w, s.y, w, z + 1);
  }

  // 屋檐：取屋顶图的下半条，画在房子上沿外侧（不会挡住屋里的地面）
  function drawRoof(s, z) {
    if (!atlasReady || !TS) return;
    var i = TS.idx.roof;
    if (i == null) return;
    var t = TS.size, c = TS.cols;
    var h = Math.max(4, z * 0.55);
    ctx.drawImage(atlas, (i % c) * t, Math.floor(i / c) * t + t * 0.5, t, t * 0.5,
      Math.round(s.x), Math.round(s.y - h), z + 1, h);
    ctx.fillStyle = "rgba(0,0,0,.20)";
    ctx.fillRect(Math.round(s.x), Math.round(s.y - 2), z + 1, 2);
  }

  // 岸边：陆地挨着水的那一边压一条浅滩，水才不会像一块贴上去的蓝方块
  function drawShore(kind, tx, ty, s, z) {
    if (kind === "wall" || kind === "door") return;
    var w = Math.max(3, z * 0.14);
    ctx.fillStyle = "rgba(228,186,126,.92)";
    if (isKind(tx, ty - 1, "water")) ctx.fillRect(s.x, s.y, z + 1, w);
    if (isKind(tx, ty + 1, "water")) ctx.fillRect(s.x, s.y + z + 1 - w, z + 1, w);
    if (isKind(tx - 1, ty, "water")) ctx.fillRect(s.x, s.y, w, z + 1);
    if (isKind(tx + 1, ty, "water")) ctx.fillRect(s.x + z + 1 - w, s.y, w, z + 1);
  }

  // 物件层：树 / 栅栏 / 石头
  function drawProp(p, z) {
    var s = worldToScreen(p.tx, p.ty);
    if (s.x < -z * 4 || s.y < -z * 4 || s.x > window.innerWidth + z * 4 || s.y > window.innerHeight + z * 4) return;
    var n = hash2(p.tx * 7 + 3, p.ty * 11 + 5);

    if (p.kind === "tree") {
      ctx.fillStyle = "rgba(0,0,0,.20)";
      ctx.beginPath();
      ctx.ellipse(s.x + z * 0.5, s.y + z * 0.86, z * 0.34, z * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      var tname = n < 0.52 ? "tree_round" : n < 0.80 ? "tree_orange" : "tree_autumn";
      var b = spriteBounds(tname);
      if (b) {
        // 按内容实际高度缩放，底边（树干）落在格子底部，左右居中
        var th = z * 1.9;
        var tw = th * (b.sw / b.sh);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(atlas, b.sx, b.sy, b.sw, b.sh, Math.round(s.x + z * 0.5 - tw / 2), Math.round(s.y + z - th), Math.round(tw), Math.round(th));
      } else {
        drawSpr(tname, s.x + z * 0.5 - z * 0.95, s.y + z - z * 1.9, z * 1.9);
      }
      return;
    }

    if (p.kind === "lamp") {
      // 两格高的街灯：程序化画，不用图集（图集那块带暗底，放大后像黑方块）
      var cx = s.x + z * 0.5, baseY = s.y + z * 0.96;
      ctx.fillStyle = "rgba(0,0,0,.22)";
      ctx.beginPath();
      ctx.ellipse(cx, baseY, z * 0.24, z * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();
      // 底座
      ctx.fillStyle = "#4a4033";
      ctx.fillRect(cx - z * 0.11, baseY - z * 0.16, z * 0.22, z * 0.16);
      // 杆
      ctx.fillStyle = "#5c5040";
      ctx.fillRect(cx - z * 0.045, baseY - z * 1.55, z * 0.09, z * 1.4);
      // 灯头
      ctx.fillStyle = "#6b5f4c";
      ctx.fillRect(cx - z * 0.18, baseY - z * 1.92, z * 0.36, z * 0.34);
      ctx.fillStyle = isNight() ? "#ffe6a3" : "#d9c79a";
      ctx.fillRect(cx - z * 0.12, baseY - z * 1.84, z * 0.24, z * 0.2);
      ctx.fillStyle = "#3f362a";
      ctx.fillRect(cx - z * 0.2, baseY - z * 1.96, z * 0.4, z * 0.06);
      if (isNight()) {
        var lg = ctx.createRadialGradient(s.x + z * 0.5, s.y - z * 0.55, 0, s.x + z * 0.5, s.y - z * 0.55, z * 1.5);
        lg.addColorStop(0, "rgba(255,214,130,.30)");
        lg.addColorStop(1, "rgba(255,214,130,0)");
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.arc(s.x + z * 0.5, s.y - z * 0.55, z * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    if (p.kind === "rock") {
      ctx.fillStyle = "rgba(0,0,0,.18)";
      ctx.beginPath();
      ctx.ellipse(s.x + z * 0.5, s.y + z * 0.88, z * 0.32, z * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      drawSpr("rock", s.x, s.y, z + 1);
      return;
    }

    if (p.kind === "fence") {
      var L = isKind(p.tx - 1, p.ty, "fence"), R = isKind(p.tx + 1, p.ty, "fence");
      var U = isKind(p.tx, p.ty - 1, "fence"), D = isKind(p.tx, p.ty + 1, "fence");
      var fname = (L || R || !(U || D)) ? "fence_h" : "fence_v";
      drawSpr(fname, s.x, s.y, z + 1);
      return;
    }
  }

  function drawGroundTile(tx, ty, z, baseOnly) {
    var h = Number(map.heights[ty][tx]) || 0;
    var kind = tileKind(tx, ty);
    var s = worldToScreen(tx, ty);

    // 有图集：地面出贴图，物件的格子只铺草皮
    if (artOn()) {
      var name = baseOnly ? "grass" : groundSprite(kind, tx, ty);
      if (name) {
        // 物件类格子先铺草皮，否则背景会露出黑底
        if (!baseOnly && (kind === 'lamp' || kind === 'fence' || kind === 'bench' || kind === 'barrel' || kind === 'stall' || kind === 'rock')) {
          drawSpr('grass', s.x, s.y, z + 1);
        }
        drawSpr(name, s.x, s.y, z + 1);
        if (!baseOnly && kind === "water") drawRim("water", tx, ty, s, z, "rgba(18,58,86,.38)");
        if (!baseOnly && kind !== "water") drawShore(kind, tx, ty, s, z);
        if (!baseOnly && kind === "wall") {            // 墙的上沿压暗，房子才有厚度
          ctx.fillStyle = "rgba(30,18,10,.35)";
          ctx.fillRect(s.x, s.y, z + 1, Math.max(2, z * 0.07));
        }
        if (!baseOnly && kind === "floor") {           // 地板：贴图是纯色的，加一道很淡的板缝
          ctx.fillStyle = "rgba(96,70,46,.10)";
          ctx.fillRect(s.x, s.y + z + 1 - Math.max(1, z * 0.05), z + 1, Math.max(1, z * 0.05));
        }
        // 房子最上面一排：往上压一条屋檐，房子才有"顶"
        if (!baseOnly && isHouse(kind) && !isHouse(tileKind(tx, ty - 1))) drawRoof(s, z);
        var belowH = ty + 1 < map.height ? Number(map.heights[ty + 1][tx]) : 0;
        if (h > belowH) {
          ctx.fillStyle = "rgba(0,0,0,.28)";
          ctx.fillRect(s.x, s.y + z * 0.8, z + 1, z * 0.22);
        }
        return;
      }
    }

    var base = COLORS[kind] || COLORS.grass;
    var n = hash2(tx, ty);
    var patch = hash2(Math.floor(tx / 5) + 91, Math.floor(ty / 5) + 17);
    if (kind === "grass") base = [base[0] * (0.93 + patch * 0.14), base[1] * (0.93 + patch * 0.14), base[2] * (0.93 + patch * 0.14)];

    if (kind === "tree") {
      ctx.fillStyle = shade(COLORS.grass, 1 + h * 0.07);
      ctx.fillRect(s.x, s.y, z + 1, z + 1);
      drawTree(s, z, n);
      return;
    }
    if (kind === "water") {
      drawWater(s, z, tx, ty);
      return;
    }
    if (kind === "wall") {
      ctx.fillStyle = shade(base, 1 + h * 0.05);
      ctx.fillRect(s.x, s.y, z + 1, z + 1);
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.fillRect(s.x, s.y, z + 1, z * 0.18);
      ctx.fillStyle = "rgba(0,0,0,.18)";
      ctx.fillRect(s.x, s.y + z * 0.82, z + 1, z * 0.18);
      return;
    }

    ctx.fillStyle = "rgb(" + Math.round(base[0] * (1 + h * 0.07)) + "," + Math.round(base[1] * (1 + h * 0.07)) + "," + Math.round(base[2] * (1 + h * 0.07)) + ")";
    ctx.fillRect(s.x, s.y, z + 1, z + 1);

    if (kind === "grass") {
      ctx.fillStyle = n > 0.55 ? "rgba(255,255,255,.045)" : "rgba(0,0,0,.06)";
      var bx = s.x + n * z * 0.7, by = s.y + ((n * 7) % 1) * z * 0.7;
      ctx.fillRect(bx, by, Math.max(1, z * 0.06), Math.max(1, z * 0.12));
      if (n > 0.82) {
        ctx.fillStyle = "rgba(190,220,140,.18)";
        ctx.fillRect(s.x + z * 0.3, s.y + z * 0.55, z * 0.06, z * 0.06);
      }
    } else if (kind === "path") {
      ctx.fillStyle = "rgba(0,0,0,.05)";
      ctx.fillRect(s.x + n * z * 0.8, s.y + ((n * 3) % 1) * z * 0.8, z * 0.1, z * 0.1);
      ctx.fillStyle = "rgba(255,255,255,.05)";
      ctx.fillRect(s.x + ((n * 5) % 1) * z * 0.8, s.y + ((n * 11) % 1) * z * 0.8, z * 0.08, z * 0.08);
      ctx.fillStyle = "rgba(70,58,40,.16)";
      if (neighborKind(tx, ty - 1) === "grass") ctx.fillRect(s.x, s.y, z + 1, z * 0.1);
      if (neighborKind(tx, ty + 1) === "grass") ctx.fillRect(s.x, s.y + z * 0.9, z + 1, z * 0.1);
      if (neighborKind(tx - 1, ty) === "grass") ctx.fillRect(s.x, s.y, z * 0.1, z + 1);
      if (neighborKind(tx + 1, ty) === "grass") ctx.fillRect(s.x + z * 0.9, s.y, z * 0.1, z + 1);
    } else if (kind === "floor") {
      ctx.fillStyle = "rgba(0,0,0,.08)";
      ctx.fillRect(s.x, s.y + z * 0.5, z + 1, 1);
      ctx.fillRect(s.x + z * 0.5, s.y, 1, z + 1);
    } else if (kind === "bed") {
      ctx.fillStyle = "#dcC9a4";
      ctx.fillRect(s.x + z * 0.1, s.y + z * 0.12, z * 0.8, z * 0.76);
      ctx.fillStyle = "#f0e6cf";
      ctx.fillRect(s.x + z * 0.18, s.y + z * 0.18, z * 0.64, z * 0.24);
    } else if (kind === "stove") {
      ctx.fillStyle = "#4c4c4c";
      ctx.fillRect(s.x + z * 0.14, s.y + z * 0.14, z * 0.72, z * 0.72);
      ctx.fillStyle = "#ff9a3c";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.5, s.y + z * 0.62, z * 0.12, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "flower") {
      var blooms = ["#f2a7c3", "#f6e27a", "#c9a7f2", "#f4f4f4"];
      for (var bi = 0; bi < 3; bi++) {
        var hx = hash2(tx * 7 + bi, ty * 13 + bi);
        ctx.fillStyle = blooms[Math.floor(hx * blooms.length)];
        ctx.beginPath();
        ctx.arc(s.x + z * (0.2 + hx * 0.6), s.y + z * (0.25 + ((hx * 7) % 1) * 0.5), Math.max(1.2, z * 0.05), 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === "lamp") {
      ctx.fillStyle = "rgba(0,0,0,.25)";
      ctx.beginPath();
      ctx.ellipse(s.x + z * 0.5, s.y + z * 0.86, z * 0.22, z * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4a4033";
      ctx.fillRect(s.x + z * 0.44, s.y + z * 0.28, z * 0.12, z * 0.58);
      var night = isNight();
      if (night) {
        var gg = ctx.createRadialGradient(s.x + z * 0.5, s.y + z * 0.24, 0, s.x + z * 0.5, s.y + z * 0.24, z * 1.2);
        gg.addColorStop(0, "rgba(255,214,130,.42)");
        gg.addColorStop(1, "rgba(255,214,130,0)");
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(s.x + z * 0.5, s.y + z * 0.24, z * 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = night ? "#ffe6a3" : "#c9b98a";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.5, s.y + z * 0.22, z * 0.1, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "bench") {
      ctx.fillStyle = "#6b4c2b";
      ctx.fillRect(s.x + z * 0.08, s.y + z * 0.38, z * 0.84, z * 0.16);
      ctx.fillRect(s.x + z * 0.08, s.y + z * 0.6, z * 0.84, z * 0.1);
      ctx.fillStyle = "#3e2c19";
      ctx.fillRect(s.x + z * 0.16, s.y + z * 0.7, z * 0.08, z * 0.16);
      ctx.fillRect(s.x + z * 0.76, s.y + z * 0.7, z * 0.08, z * 0.16);
    } else if (kind === "plank") {
      ctx.fillStyle = "#b09364";
      ctx.fillRect(s.x, s.y, z + 1, z + 1);
      ctx.fillStyle = "rgba(60,44,24,.25)";
      ctx.fillRect(s.x, s.y + z * 0.45, z + 1, Math.max(1, z * 0.07));
      ctx.fillRect(s.x + z * 0.5, s.y, Math.max(1, z * 0.05), z + 1);
    } else if (kind === "fountain") {
      ctx.fillStyle = "rgb(" + Math.round(base[0] * (1 + h * 0.07)) + "," + Math.round(base[1] * (1 + h * 0.07)) + "," + Math.round(base[2] * (1 + h * 0.07)) + ")";
      ctx.fillRect(s.x, s.y, z + 1, z + 1);
    } else if (kind === "soil") {
      ctx.fillStyle = "#5f4630";
      ctx.fillRect(s.x, s.y, z + 1, z + 1);
      ctx.fillStyle = "rgba(0,0,0,.18)";
      for (var srow = 0; srow < 3; srow++) ctx.fillRect(s.x, s.y + z * (0.2 + srow * 0.25), z + 1, Math.max(1, z * 0.05));
    } else if (kind === "crop") {
      ctx.fillStyle = "#5f4630";
      ctx.fillRect(s.x, s.y, z + 1, z + 1);
      ctx.fillStyle = "#7fae4a";
      for (var cr = 0; cr < 3; cr++) {
        ctx.fillRect(s.x + z * (0.2 + cr * 0.28), s.y + z * 0.18, Math.max(1, z * 0.09), z * 0.68);
      }
    } else if (kind === "stall") {
      ctx.fillStyle = "#7a4b33";
      ctx.fillRect(s.x + z * 0.1, s.y + z * 0.45, z * 0.8, z * 0.45);
      ctx.fillStyle = "#d65b4a";
      ctx.fillRect(s.x + z * 0.06, s.y + z * 0.1, z * 0.88, z * 0.3);
      ctx.fillStyle = "#f0e6d2";
      for (var st = 0; st < 3; st++) ctx.fillRect(s.x + z * (0.1 + st * 0.3), s.y + z * 0.1, z * 0.14, z * 0.3);
    } else if (kind === "hedge") {
      ctx.fillStyle = "#3a6b34";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.5, s.y + z * 0.52, z * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4d8443";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.4, s.y + z * 0.42, z * 0.26, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "barrel") {
      ctx.fillStyle = "#6b4a2a";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.5, s.y + z * 0.52, z * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3f2b16";
      ctx.lineWidth = Math.max(1, z * 0.05);
      ctx.beginPath();
      ctx.arc(s.x + z * 0.5, s.y + z * 0.52, z * 0.34, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === "board") {
      ctx.fillStyle = "#5a3f24";
      ctx.fillRect(s.x + z * 0.1, s.y + z * 0.2, z * 0.8, z * 0.5);
      ctx.fillStyle = "#d8c9a8";
      ctx.fillRect(s.x + z * 0.16, s.y + z * 0.26, z * 0.68, z * 0.38);
      ctx.fillStyle = "rgba(60,44,24,.55)";
      for (var bl = 0; bl < 3; bl++) ctx.fillRect(s.x + z * 0.22, s.y + z * (0.34 + bl * 0.1), z * (0.5 - bl * 0.08), Math.max(1, z * 0.04));
      ctx.fillStyle = "#4a3220";
      ctx.fillRect(s.x + z * 0.44, s.y + z * 0.68, z * 0.12, z * 0.24);
    } else if (kind === "fence") {
      ctx.fillStyle = "#5a452e";
      ctx.fillRect(s.x + z * 0.08, s.y + z * 0.44, z * 0.84, z * 0.12);
      ctx.fillRect(s.x + z * 0.16, s.y + z * 0.22, z * 0.1, z * 0.56);
      ctx.fillRect(s.x + z * 0.74, s.y + z * 0.22, z * 0.1, z * 0.56);
    } else if (kind === "stump") {
      ctx.fillStyle = "#5a4028";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.5, s.y + z * 0.55, z * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8a6a44";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.5, s.y + z * 0.52, z * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(60,42,24,.6)";
      ctx.lineWidth = 1;
      for (var sr = 1; sr <= 2; sr++) {
        ctx.beginPath();
        ctx.arc(s.x + z * 0.5, s.y + z * 0.52, z * (0.08 + sr * 0.06), 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (kind === "rock") {
      ctx.fillStyle = "#575349";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.5, s.y + z * 0.55, z * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#6f6a60";
      ctx.beginPath();
      ctx.arc(s.x + z * 0.42, s.y + z * 0.45, z * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 悬崖边缘：比下面那格高，就画一道暗边
    var below = ty + 1 < map.height ? Number(map.heights[ty + 1][tx]) : 0;
    if (h > below) {
      ctx.fillStyle = "rgba(0,0,0,.28)";
      ctx.fillRect(s.x, s.y + z * 0.8, z + 1, z * 0.22);
    }
  }

  function isNight() {
    var h = state.clock ? state.clock.minutes / 60 : 12;
    return h >= 19.5 || h < 6;
  }

  function neighborKind(x, y) {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return "edge";
    var ch = map.rows[y][x];
    var legend = map.legend[ch] || map.legend["."];
    return legend.kind;
  }

  function drawTree(s, z, n) {
    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.beginPath();
    ctx.ellipse(s.x + z * 0.52, s.y + z * 0.86, z * 0.34, z * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3a2c1c";
    ctx.fillRect(s.x + z * 0.44, s.y + z * 0.56, z * 0.14, z * 0.34);
    ctx.fillStyle = "#2b5426";
    ctx.beginPath();
    ctx.arc(s.x + z * 0.5, s.y + z * 0.42, z * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3d7233";
    ctx.beginPath();
    ctx.arc(s.x + z * (0.38 + n * 0.1), s.y + z * 0.34, z * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(190,230,150,.16)";
    ctx.beginPath();
    ctx.arc(s.x + z * 0.42, s.y + z * 0.3, z * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawWater(s, z, tx, ty) {
    var t = timeMs / 1000;
    ctx.fillStyle = "#2f5f9a";
    ctx.fillRect(s.x, s.y, z + 1, z + 1);
    ctx.fillStyle = "rgba(255,255,255,.07)";
    var off = Math.sin(t * 0.9 + tx * 0.6 + ty * 0.3) * z * 0.12;
    ctx.fillRect(s.x, s.y + z * 0.3 + off, z * 0.7, Math.max(1, z * 0.05));
    ctx.fillStyle = "rgba(255,255,255,.05)";
    ctx.fillRect(s.x + z * 0.2, s.y + z * 0.65 - off, z * 0.5, Math.max(1, z * 0.04));
  }

  function drawName(x, y, size, e) {
    ctx.font = "600 12px 'Microsoft YaHei', system-ui, sans-serif";
    ctx.textAlign = "center";
    var w = ctx.measureText(e.name).width + 10;
    ctx.fillStyle = "rgba(10,14,8,.62)";
    roundRect(x - w / 2, y + size * 0.62, w, 16, 7);
    ctx.fill();
    ctx.fillStyle = "#eef5e4";
    ctx.fillText(e.name, x, y + size * 0.62 + 12);
  }

  // ---------- 分层像素角色：身体 / 上衣 / 帽子，按 8 个朝向预生成 ----------
  var spriteCache = new Map();
  function shadeHex(hex, f) {
    var n = parseInt(String(hex).replace('#', ''), 16);
    if (!isFinite(n)) return hex;
    var r = Math.round(((n >> 16) & 255) * f);
    var g = Math.round(((n >> 8) & 255) * f);
    var b = Math.round((n & 255) * f);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // 在 16x16 的网格上逐像素判定，天然是像素画
  function samplePix(bx, by, body, outline, cloth, clothDark, hat, ap) {
    // 尾鳍（在身体后面）
    if (bx < -4.4) {
      var tw = (-bx - 4.4) / 3.2;
      if (Math.abs(by - 1) < 3.0 * tw) return body;
      if (Math.abs(by - 1) < 3.0 * tw + 0.8) return outline;
      return null;
    }
    var ex = bx / 6.0, ey = (by - 1) / 3.8;
    var d = ex * ex + ey * ey;
    if (d > 1.25) return null;
    if (d > 1) return outline;

    // 帽子：帽檐 + 帽顶
    if (hat) {
      if (by > -3.4 && by < -2.2 && Math.abs(bx) < 3.6) return hat;
      var hx = (bx - 0.8) / 2.6, hy = (by + 4.2) / 2.2;
      if (hx * hx + hy * hy <= 1) return hat;
    }

    // 眼睛
    if (bx > 3.2 && bx < 4.2 && by > -0.9 && by < 0.1) return '#10150c';
    if (bx > 4.0 && bx < 4.8 && by > -1.5 && by < -0.7) return '#f6f9f0';

    // 上衣：身体下半段一条带子 + 领口
    if (cloth && by > 0.6 && by < 2.9) {
      if (ap && ap.cloth && ap.cloth.pattern > 0) {
        var dotRow = by > 1.6 && by < 2.2;
        if (dotRow && Math.abs(((bx + 12) % 3) - 1) < 0.6) return '#f2f6ec';
      }
      return by < 1.4 ? clothDark : cloth;
    }

    return body;
  }

  var paletteCache = new Map();
  function getPaletteSprite(pal) {
    var key = JSON.stringify(pal);
    var hit = paletteCache.get(key);
    if (hit) return hit;
    if (!window.TAIFISH) return null;
    var c = window.TAIFISH.build(pal);
    paletteCache.set(key, c);
    return c;
  }

  var portraitCache = new Map();
  function getPortrait(dataUrl) {
    var rec = portraitCache.get(dataUrl);
    if (rec) return rec.ready ? rec.canvas : null;
    var c = document.createElement('canvas');
    rec = { canvas: c, ready: false };
    portraitCache.set(dataUrl, rec);
    var im = new Image();
    im.onload = function () {
      c.width = im.naturalWidth || 64;
      c.height = im.naturalHeight || 64;
      var g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(im, 0, 0);
      rec.ready = true;
    };
    im.src = dataUrl;
    return null;
  }

  function getSprite(bodyColor, ap, oct) {
    var key = bodyColor + '|' + (ap && ap.cloth ? ap.cloth.hue + '_' + ap.cloth.pattern : '-') + '|' + (ap && ap.hat ? ap.hat.hue : '-') + '|' + oct;
    var hit = spriteCache.get(key);
    if (hit) return hit;
    var S = 16, H = 8;
    var c = document.createElement('canvas');
    c.width = S; c.height = S;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    var ang = oct * Math.PI / 4;
    var cos = Math.cos(-ang), sin = Math.sin(-ang);
    var cloth = ap && ap.cloth ? 'hsl(' + ap.cloth.hue + ',62%,55%)' : null;
    var clothDark = ap && ap.cloth ? 'hsl(' + ap.cloth.hue + ',62%,38%)' : null;
    var hat = ap && ap.hat ? 'hsl(' + ap.hat.hue + ',55%,48%)' : null;
    var outline = shadeHex(bodyColor, 0.55);
    for (var py = 0; py < S; py++) {
      for (var px = 0; px < S; px++) {
        var rx = px - H + 0.5, ry = py - H + 0.5;
        var bx = rx * cos - ry * sin;
        var by = rx * sin + ry * cos;
        var col = samplePix(bx, by, bodyColor, outline, cloth, clothDark, hat, ap);
        if (col) { g.fillStyle = col; g.fillRect(px, py, 1, 1); }
      }
    }
    spriteCache.set(key, c);
    return c;
  }

  // ---------- 角色图集（Zelda-like，CC0）：四方向行走 + 调色板换色 ----------
  var charImg = new Image();
  charImg.src = '/viewer/char.png';
  var charReady = false;
  charImg.onload = function () { charReady = true; };
  var charCache = new Map();
  var CHAR_ROW = { down: 6, left: 38, up: 70 };
  var CHAR_H = 22;
  function mixHex(a, b, k) {
    var A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
    var r = Math.round(((A >> 16) & 255) * (1 - k) + ((B >> 16) & 255) * k);
    var g = Math.round(((A >> 8) & 255) * (1 - k) + ((B >> 8) & 255) * k);
    var bl = Math.round((A & 255) * (1 - k) + (B & 255) * k);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }
  function recolorSheet(hair, shirt, skin) {
    var key = hair + '|' + shirt + '|' + skin;
    var hit = charCache.get(key);
    if (hit) return hit;
    var c = document.createElement('canvas');
    c.width = charImg.naturalWidth;
    c.height = charImg.naturalHeight;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(charImg, 0, 0);
    var img = g.getImageData(0, 0, c.width, c.height);
    var d = img.data;
    var map = {};
    map['432e27'] = mixHex(hair, '#000000', 0.35);
    map['6a4834'] = hair;
    map['e8d4b2'] = skin;
    map['bfa787'] = mixHex(skin, '#000000', 0.2);
    map['c43c3c'] = shirt;
    map['882e2e'] = mixHex(shirt, '#000000', 0.3);
    map['681c1c'] = mixHex(shirt, '#000000', 0.5);
    map['65659b'] = mixHex(shirt, '#2b3a6b', 0.75);
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      var k = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0');
      var to = map[k];
      if (!to) continue;
      var n = parseInt(to.slice(1), 16);
      d[i] = (n >> 16) & 255; d[i + 1] = (n >> 8) & 255; d[i + 2] = n & 255;
    }
    g.putImageData(img, 0, 0);
    charCache.set(key, c);
    return c;
  }
  function charColors(e) {
    var seed = 0;
    var s = String(e.id || e.name || 'x');
    for (var i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) | 0;
    var hairList = ['#432e27', '#2f2f46', '#8c6239', '#3a3a3a', '#5b3a2a', '#6b2f4a', '#6a4834'];
    var skinList = ['#f0d0b0', '#e8c49a', '#d9a97e', '#c98f66', '#f4dcc4'];
    return {
      hair: hairList[Math.abs(seed) % hairList.length],
      shirt: e.color || '#c43c3c',
      skin: skinList[Math.abs(seed >> 3) % skinList.length]
    };
  }
  function charSprite(e) {
    if (!charReady) return null;
    var moving = e.state === 'walking';
    var dir = e.dir || 0;
    var oct = ((dir % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    var face;
    if (oct > Math.PI * 0.25 && oct <= Math.PI * 0.75) face = 'down';
    else if (oct > Math.PI * 0.75 && oct <= Math.PI * 1.25) face = 'left';
    else if (oct > Math.PI * 1.25 && oct <= Math.PI * 1.75) face = 'up';
    else face = 'right';
    var col = charColors(e);
    var sheet = recolorSheet(col.hair, col.shirt, col.skin);
    var frame = moving ? Math.floor(timeMs / 150) % 4 : 0;
    var y0 = CHAR_ROW[face === 'right' ? 'left' : face];
    var c = document.createElement('canvas');
    c.width = 16; c.height = CHAR_H;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    if (face === 'right') { g.translate(16, 0); g.scale(-1, 1); }
    g.drawImage(sheet, frame * 16, y0, 16, CHAR_H, 0, 0, 16, CHAR_H);
    return c;
  }
  // 取图集里某块贴图的实际内容边界（去掉透明留白），避免缩放后悬空
  var boundsCache = new Map();
  function spriteBounds(name) {
    if (boundsCache.has(name)) return boundsCache.get(name);
    var res = null;
    if (TS && TS.idx[name] != null && atlasReady) {
      var i = TS.idx[name], t = TS.size, c = TS.cols;
      var cv = document.createElement('canvas');
      cv.width = t; cv.height = t;
      var g = cv.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(atlas, (i % c) * t, Math.floor(i / c) * t, t, t, 0, 0, t, t);
      var d = g.getImageData(0, 0, t, t).data;
      var minX = t, minY = t, maxX = -1, maxY = -1;
      for (var y = 0; y < t; y++) {
        for (var x = 0; x < t; x++) {
          if (d[(y * t + x) * 4 + 3] > 20) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= 0) res = { sx: (i % c) * t + minX, sy: Math.floor(i / c) * t + minY, sw: maxX - minX + 1, sh: maxY - minY + 1 };
    }
    boundsCache.set(name, res);
    return res;
  }
  function drawFish(x, y, size, e, isSel, isHover, withText) {
    var down = e.state === 'downed';
    var bob = Math.sin(timeMs / 520 + e.x * 1.7) * size * 0.045;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath();
    ctx.ellipse(x, y + size * 0.42, size * 0.4, size * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    var dir = e.dir || 0;
    var oct = Math.round((((dir % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    var ap = down ? null : e.appearance;
    var portrait = ap && ap.portrait ? getPortrait(ap.portrait) : null;
    var palSpr = !portrait && ap && ap.palette ? getPaletteSprite(ap.palette) : null;
    var charSpr = !portrait && !palSpr && !down ? charSprite(e) : null;
    var spr = portrait || palSpr || charSpr || getSprite(down ? '#7a7a7a' : e.color, ap, oct);
    var sw = Math.max(8, Math.round(size * (portrait ? 1.05 : 1.0)));
    var flip = !!portrait && oct >= 3 && oct <= 5;

    ctx.save();
    ctx.globalAlpha = down ? 0.45 : 1;
    ctx.imageSmoothingEnabled = false;
    if (flip) { ctx.translate(x, 0); ctx.scale(-1, 1); ctx.translate(-x, 0); }
    var sh = charSpr ? Math.round(sw * 22 / 16) : sw;
    var sy = charSpr ? Math.round(y + bob + size * 0.45 - sh) : Math.round(y + bob - sw / 2);
    ctx.drawImage(spr, Math.round(x - sw / 2), sy, sw, sh);
    ctx.restore();

    if (isSel || isHover) {
      ctx.strokeStyle = isSel ? 'rgba(255,236,150,.95)' : 'rgba(255,255,255,.45)';
      ctx.lineWidth = isSel ? 2 : 1.2;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.7, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (withText !== false) drawName(x, y, size, e);
  }

  function bubbleBox(x, y, bubble) {
    var maxW = 240;
    ctx.font = "12px 'Microsoft YaHei', system-ui, sans-serif";
    var lines = wrap(bubble.text, maxW - 20);
    var w = 0;
    for (var i = 0; i < lines.length; i++) w = Math.max(w, ctx.measureText(lines[i]).width);
    w = Math.min(maxW, w + 20);
    var lh = 17;
    var h = lines.length * lh + 14;
    return { x: x - w / 2, y: y - h, w: w, h: h, lines: lines, cx: x, cy: y, lh: lh };
  }

  function overlaps(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  }

  function drawBubbleAt(box, bubble) {
    var lines = box.lines;
    var w = box.w, h = box.h, bx = box.x, by = box.y;
    var x = box.cx;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.4)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = bubble.private ? "rgba(52,46,72,.95)" : "rgba(20,25,16,.95)";
    roundRect(bx, by, w, h, 10);
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(x - 5, by + h);
    ctx.lineTo(x, by + h + 7);
    ctx.lineTo(x + 5, by + h);
    ctx.closePath();
    ctx.fillStyle = bubble.private ? "rgba(52,46,72,.95)" : "rgba(20,25,16,.95)";
    ctx.fill();

    ctx.strokeStyle = bubble.private ? "rgba(180,160,240,.9)" : "rgba(255,255,255,.16)";
    ctx.lineWidth = 1;
    if (bubble.private) ctx.setLineDash([4, 3]);
    roundRect(bx, by, w, h, 10);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = bubble.private ? "#d9d0ff" : "#eef5e4";
    ctx.textAlign = "left";
    for (var j = 0; j < lines.length; j++) ctx.fillText(lines[j], bx + 10, by + 18 + j * box.lh);
    ctx.textAlign = "center";
  }

  function wrap(text, maxW) {
    var out = [], line = "";
    var arr = Array.from(String(text));
    for (var i = 0; i < arr.length; i++) {
      var test = line + arr[i];
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = arr[i]; }
      else line = test;
    }
    if (line) out.push(line);
    return out.slice(0, 4);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawHudOverlay() {
    var tint = skyTint(forceHour != null ? forceHour * 60 : (state.clock ? state.clock.minutes : 720));
    if (tint) {
      ctx.fillStyle = "rgba(" + tint[0] + "," + tint[1] + "," + tint[2] + "," + tint[3] + ")";
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }
    var g = ctx.createRadialGradient(
      window.innerWidth / 2, window.innerHeight / 2, Math.min(window.innerWidth, window.innerHeight) * 0.35,
      window.innerWidth / 2, window.innerHeight / 2, Math.max(window.innerWidth, window.innerHeight) * 0.78
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,.30)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  }

  // ---------- 全省低倍：居民标记点 ----------
  function drawCompactMarkers(z) {
    ctx.save();
    views.forEach(function (e) {
      var s = worldToScreen(e.x, e.y);
      if (s.x < -20 || s.y < -20 || s.x > window.innerWidth + 20 || s.y > window.innerHeight + 20) return;
      var on = e.id === selectedId;
      var r = on ? 6 : 4;
      if (on) {
        ctx.fillStyle = "rgba(255,236,150,.24)";
        ctx.beginPath(); ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = on ? "#ffec96" : (e.color || "#dfe8d4");
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(12,18,10,.85)"; ctx.lineWidth = 1.5; ctx.stroke();
    });
    ctx.restore();
  }

  function drawCompactNames(z) {
    var e = views.get(selectedId);
    if (!e || !e.name) return;
    var s = worldToScreen(e.x, e.y);
    if (s.x < 0 || s.y < 0 || s.x > window.innerWidth || s.y > window.innerHeight) return;
    ctx.save();
    ctx.font = "12px 'Microsoft YaHei',system-ui,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(10,16,10,.9)"; ctx.lineWidth = 3;
    ctx.strokeText(e.name, s.x + 11, s.y);
    ctx.fillStyle = "#ffec96"; ctx.fillText(e.name, s.x + 11, s.y);
    ctx.restore();
  }

  // ---------- 小地图：默认隐藏；打开时是「湖北省定位图」 ----------
  var miniT = null;
  function drawMini() {
    if (!map || !showMini) return;
    var W = mm.width, H = mm.height;
    mmx.clearRect(0, 0, W, H);
    if (geoOn) {
      miniT = geo.drawThumb(mmx, W, H);
      if (!miniT) return;
      var a = geo.worldToMini(0, 0, miniT);
      var b2 = geo.worldToMini(map.width, map.height, miniT);
      mmx.strokeStyle = "rgba(255,236,150,.85)";
      mmx.lineWidth = 1;
      mmx.strokeRect(a.x, a.y, b2.x - a.x, b2.y - a.y);
      var z = TILE * cam.zoom;
      var hw = window.innerWidth / 2 / z, hh = window.innerHeight / 2 / z;
      var c0 = geo.worldToMini(cam.x - hw, cam.y - hh, miniT);
      var c1 = geo.worldToMini(cam.x + hw, cam.y + hh, miniT);
      mmx.strokeStyle = "rgba(255,255,255,.85)";
      mmx.lineWidth = 1.4;
      mmx.strokeRect(c0.x, c0.y, c1.x - c0.x, c1.y - c0.y);
      views.forEach(function (e) {
        var p = geo.worldToMini(e.x, e.y, miniT);
        mmx.fillStyle = e.id === selectedId ? "#ffec96" : (e.color || "#dfe8d4");
        mmx.beginPath(); mmx.arc(p.x, p.y, e.id === selectedId ? 2.6 : 1.8, 0, Math.PI * 2); mmx.fill();
      });
      return;
    }
    // 底图未接入时的降级：原来的村庄小地图
    miniT = null;
    var sx = W / map.width, sy = H / map.height;
    for (var y = 0; y < map.height; y++) {
      for (var x = 0; x < map.width; x++) {
        var ch = map.rows[y][x];
        var legend = map.legend[ch] || map.legend["."];
        var c = COLORS[legend.kind] || COLORS.grass;
        mmx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
        mmx.fillRect(x * sx, y * sy, sx + 0.5, sy + 0.5);
      }
    }
    views.forEach(function (e) {
      mmx.fillStyle = e.id === selectedId ? "#ffec96" : e.color;
      mmx.beginPath();
      mmx.arc(e.x * sx, e.y * sy, e.id === selectedId ? 3 : 2, 0, Math.PI * 2);
      mmx.fill();
    });
    var zw = TILE * cam.zoom;
    var vw = window.innerWidth / zw * sx, vh = window.innerHeight / zw * sy;
    mmx.strokeStyle = "rgba(255,255,255,.55)";
    mmx.lineWidth = 1;
    mmx.strokeRect((cam.x - vw / 2) * sx, (cam.y - vh / 2) * sy, vw * sx, vh * sy);
  }

  // ---------- 地理读数：让聚落尺度下也能看出「这是湖北」 ----------
  function updateGeoHud() {
    var el = document.getElementById("geo-hud");
    if (!el) return;
    if (!geoOn) { el.textContent = ""; return; }
    var i = geo.infoAt(cam.x, cam.y);
    if (!i) return;
    var viewKm = (window.innerWidth / (TILE * cam.zoom)) * i.kmPerWorld;
    var elevTxt = i.elev == null ? "—" : i.elev + " m";
    el.textContent = "湖北省 · " + i.biome + " · 海拔 " + elevTxt + " · 距" + i.city + " " + i.cityKm +
      " km · " + i.lat.toFixed(2) + "°N " + i.lng.toFixed(2) + "°E · 视野 " +
      (viewKm >= 100 ? Math.round(viewKm) : viewKm.toFixed(1)) + " km";
  }

  // ---------- 镜头 / 模式 ----------
  function setFollow(on) {
    follow = !!on;
    var b = document.getElementById("btn-follow");
    if (b) b.classList.toggle("on", follow);
  }
  function setMini(on) {
    showMini = !!on;
    var wrap = document.getElementById("minimap-wrap");
    if (wrap) wrap.classList.toggle("mm-hidden", !showMini);
    document.body.classList.toggle("mini-on", showMini);
    var b = document.getElementById("btn-mini");
    if (b) b.classList.toggle("on", showMini);
    if (showMini) drawMini();
  }
  function startViewTo(zoom, x, y, dur) {
    if (dur === 0) { cam.zoom = zoom; cam.x = x; cam.y = y; viewTween = null; return; }
    viewTween = {
      fromZoom: cam.zoom, toZoom: zoom, fromX: cam.x, toX: x, fromY: cam.y, toY: y,
      t0: timeMs || performance.now(), dur: dur || 520
    };
  }
  function markOverview(on) {
    overview = !!on;
    var b = document.getElementById("btn-overview");
    if (b) b.classList.toggle("on", overview);
    document.body.classList.toggle("overview-mode", overview);
  }
  function exitOverviewMark() {
    if (!overview) return;
    markOverview(false);
    savedView = null;
  }
  function setOverview(on, instant) {
    if (!geoOn && on) return;
    if (on) {
      if (!savedView || savedView.zoom < 0.2)
        savedView = { zoom: cam.zoom, x: cam.x, y: cam.y };
      setFollow(false);
      setMini(false);
      viewTween = null;
      markOverview(true);
      var z = geo.overviewZoom(window.innerWidth, window.innerHeight, TILE);
      var c = geo.center();
      startViewTo(z, c.x, c.y, instant ? 0 : 560);
    } else {
      var e = views.get(selectedId);
      var tz = savedView && savedView.zoom > 0.2 ? savedView.zoom : 1.35;
      var tx = e ? e.x : (savedView ? savedView.x : map.width / 2);
      var ty = e ? e.y : (savedView ? savedView.y : map.height / 2);
      markOverview(false);
      startViewTo(tz, tx, ty, instant ? 0 : 560);
      savedView = null;
    }
  }
  // 点击居民 → 以他为中心跟随；从全省模式点标记会平滑飞回聚落
  function selectVillager(id, zoomIn) {
    if (!id) return;
    selectedId = id;
    var e = views.get(id);
    if (zoomIn && overview) setOverview(false);
    if (zoomIn && e && TILE * cam.zoom < 12) startViewTo(1.35, e.x, e.y, 520);
    setFollow(true);
    updateHud();
  }

  // ---------- 交互 ----------
  canvas.addEventListener("mousedown", function (e) {
    if (locked) return;
    dragging = true; dragged = false;
    lastMouse = { x: e.clientX, y: e.clientY };
    canvas.classList.add("dragging");
  });
  window.addEventListener("mousemove", function (e) {
    if (dragging) {
      var dx = e.clientX - lastMouse.x, dy = e.clientY - lastMouse.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        dragged = true;
        if (follow) setFollow(false);
        viewTween = null;
        exitOverviewMark();
      }
      cam.x -= dx / (TILE * cam.zoom);
      cam.y -= dy / (TILE * cam.zoom);
      lastMouse = { x: e.clientX, y: e.clientY };
      return;
    }
    var best = null, bd = compact ? 15 : 24;
    views.forEach(function (en) {
      var s = worldToScreen(en.x, en.y);
      var d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
      if (d < bd) { bd = d; best = en.id; }
    });
    hoverId = best;
    canvas.style.cursor = best ? "pointer" : "grab";
  });
  window.addEventListener("mouseup", function () {
    dragging = false;
    canvas.classList.remove("dragging");
  });
  canvas.addEventListener("click", function (e) {
    if (dragged) return;
    var best = null, bd = compact ? 15 : 24;
    views.forEach(function (en) {
      var s = worldToScreen(en.x, en.y);
      var d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
      if (d < bd) { bd = d; best = en.id; }
    });
    if (best) selectVillager(best, true);
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    viewTween = null;
    exitOverviewMark();
    var wx = cam.x + (e.clientX - window.innerWidth / 2) / (TILE * cam.zoom);
    var wy = cam.y + (e.clientY - window.innerHeight / 2) / (TILE * cam.zoom);
    cam.zoom = clamp(cam.zoom * (e.deltaY > 0 ? 0.9 : 1.1), minZoom(), MAX_ZOOM);
    cam.x = wx - (e.clientX - window.innerWidth / 2) / (TILE * cam.zoom);
    cam.y = wy - (e.clientY - window.innerHeight / 2) / (TILE * cam.zoom);
  }, { passive: false });

  document.getElementById("btn-follow").addEventListener("click", function () { setFollow(!follow); });
  document.getElementById("btn-vision").addEventListener("click", function () {
    showVision = !showVision;
    this.classList.toggle("on", showVision);
  });
  document.getElementById("btn-zoom-in").addEventListener("click", function () {
    viewTween = null; exitOverviewMark();
    cam.zoom = clamp(cam.zoom * 1.15, minZoom(), MAX_ZOOM);
  });
  document.getElementById("btn-zoom-out").addEventListener("click", function () {
    viewTween = null; exitOverviewMark();
    cam.zoom = clamp(cam.zoom / 1.15, minZoom(), MAX_ZOOM);
  });
  var charBtn = document.getElementById("btn-char");
  if (charBtn) charBtn.addEventListener("click", function () {
    if (!window.CharacterPanel) return;
    if (window.CharacterPanel.hidden()) window.CharacterPanel.show();
    else window.CharacterPanel.hide();
  });
  var ovBtn = document.getElementById("btn-overview");
  if (ovBtn) ovBtn.addEventListener("click", function () { setOverview(!overview); });
  var miniBtn = document.getElementById("btn-mini");
  if (miniBtn) miniBtn.addEventListener("click", function () { setMini(!showMini); });
  var backBtn = document.getElementById("btn-back");
  if (backBtn) backBtn.addEventListener("click", function () {
    if (overview) setOverview(false);
    selectVillager(selectedId, true);
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "f" || e.key === "F") setFollow(!follow);
    if (e.key === "v" || e.key === "V") {
      showVision = !showVision;
      document.getElementById("btn-vision").classList.toggle("on", showVision);
    }
    if (e.key === "m" || e.key === "M") setOverview(!overview);
    if (e.key === "n" || e.key === "N") setMini(!showMini);
    if (e.key === "Escape") { if (overview) setOverview(false); else setFollow(false); }
    if (e.key === "+" || e.key === "=") { viewTween = null; cam.zoom = clamp(cam.zoom * 1.15, minZoom(), MAX_ZOOM); }
    if (e.key === "-" || e.key === "_") { viewTween = null; cam.zoom = clamp(cam.zoom / 1.15, minZoom(), MAX_ZOOM); }
  });

  mm.addEventListener("click", function (e) {
    if (!map) return;
    var r = mm.getBoundingClientRect();
    var px = (e.clientX - r.left) / r.width * mm.width;
    var py = (e.clientY - r.top) / r.height * mm.height;
    setFollow(false);
    viewTween = null;
    exitOverviewMark();
    if (geoOn) {
      var t = miniT || geo.thumbTransform(mm.width, mm.height);
      if (t) { var w = geo.miniToWorld(px, py, t); cam.x = w.x; cam.y = w.y; }
    } else {
      cam.x = px / mm.width * map.width;
      cam.y = py / mm.height * map.height;
    }
  });

  // 自动化 / 排障用：只读状态 + 与界面同一套动作入口
  window.__viewer = {
    state: function () {
      return {
        geo: geo ? geo.status() : "off", geoOn: geoOn, overview: overview, compact: compact,
        mini: showMini, follow: follow, zoom: +cam.zoom.toFixed(4),
        camX: +cam.x.toFixed(2), camY: +cam.y.toFixed(2), selected: selectedId,
        bounds: geoOn ? geo.bounds() : null, villagers: views.size,
        geoInfo: geoOn ? geo.infoAt(cam.x, cam.y) : null
      };
    },
    select: function (id) { selectVillager(id, true); },
    overview: function (on) { setOverview(!!on); },
    mini: function (on) { setMini(!!on); },
    tweenDone: function () { viewTween = null; },
    // 角色面板每 2.5 秒拉一次 /api/props；把门开合同步回绘制用的 state.doors，
    // 这样点「打开」之后地图上的门立刻变样，不用等下一帧全量快照。
    syncProps: function (list) {
      propViews = Array.isArray(list) ? list : [];
      var doors = state.doors || [];
      for (var i = 0; i < propViews.length; i++) {
        var p = propViews[i];
        if (p.kind !== "door") continue;
        for (var j = 0; j < doors.length; j++) {
          if (doors[j].x === p.x && doors[j].y === p.y) {
            doors[j].open = p.open;
            doors[j].locked = !!(p.lock && p.lock.locked);
            break;
          }
        }
      }
    },
    hidePanel: function () { var e = document.getElementById("inspector"); if (e) e.classList.add("hidden"); },
    showPanel: function () { var e = document.getElementById("inspector"); if (e) e.classList.remove("hidden"); },
    markers: function () {
      var out = [];
      views.forEach(function (e) {
        var s = worldToScreen(e.x, e.y);
        out.push({ id: e.id, name: e.name, x: Math.round(s.x), y: Math.round(s.y), wx: +e.x.toFixed(2), wy: +e.y.toFixed(2) });
      });
      return out;
    }
  };
  window.ViewerAPI = window.__viewer;

  requestAnimationFrame(frame);
})();
