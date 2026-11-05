"use strict";
/**
 * 贴图渲染层（Kenney CC0 素材）——不依赖 viewer.js 的任何内部状态。
 *
 * 用法（低分辨率画布）：
 *   ART.load(function () { ... });          // 载入图集，载入前所有函数都返回 false
 *   ART.ground(ctx, map, patchMap, tx, ty, x, y, 16, t);
 *   ART.prop(ctx, map, patchMap, tx, ty, kind, x, y, 16, t);
 *
 * 约定：
 *   - size 就是"一格在世界画布上占几个像素"，原生低分辨率下固定 16，别传小数。
 *   - 所有坐标都是世界画布像素（不是 CSS 像素，也不是设备像素）。
 *   - map 是 /api/world 里那个 map（rows 字符 + legend + heights）。
 */
(function () {
  var TS = window.TILESET || null;
  var img = null, ready = false;
  var SIZE = TS ? TS.size : 16;
  var COLS = TS ? TS.cols : 8;

  function load(cb) {
    if (!TS) { if (cb) cb(false); return; }
    if (ready) { if (cb) cb(true); return; }
    img = new Image();
    img.onload = function () { ready = true; if (cb) cb(true); };
    img.onerror = function () { if (cb) cb(false); };
    img.src = TS.img;
  }

  function name2idx(n) { return TS && TS.idx[n] != null ? TS.idx[n] : -1; }

  // 画一格贴图：size 是整数，坐标取整，低分辨率画布下就是 1:1
  function blit(ctx, name, x, y, size) {
    if (!ready) return false;
    var i = name2idx(name);
    if (i < 0) return false;
    ctx.drawImage(img, (i % COLS) * SIZE, Math.floor(i / COLS) * SIZE, SIZE, SIZE,
      Math.round(x), Math.round(y), size, size);
    return true;
  }

  // ---------- 地图查询 ----------
  function kindAt(map, patchMap, tx, ty) {
    if (!map || tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return "edge";
    if (patchMap) {
      var p = patchMap.get(tx + "," + ty);
      if (p) return p;
    }
    var ch = map.rows[ty][tx];
    var legend = map.legend[ch] || map.legend["."];
    return legend.kind;
  }

  function isHouse(k) { return k === "wall" || k === "floor" || k === "door"; }

  // 小路 4 位邻接掩码，和 tools/build-tiles.py 里预合成的 16 块对应
  function pathMask(map, patchMap, tx, ty) {
    var m = 0;
    if (kindAt(map, patchMap, tx, ty - 1) !== "path") m |= 1;
    if (kindAt(map, patchMap, tx + 1, ty) !== "path") m |= 2;
    if (kindAt(map, patchMap, tx, ty + 1) !== "path") m |= 4;
    if (kindAt(map, patchMap, tx - 1, ty) !== "path") m |= 8;
    return m;
  }

  function hash2(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // 地形 → 贴图名。返回 null 表示"这个 kind 还没接图"，交给宿主的旧画法
  function groundSprite(map, patchMap, kind, tx, ty, t) {
    var n = hash2(tx, ty);
    if (kind === "grass") return n < 0.16 ? "grass_tuft" : n < 0.20 ? "grass_flower" : "grass";
    if (kind === "flower") return "grass_flower";
    if (kind === "path") return "path_" + pathMask(map, patchMap, tx, ty);
    if (kind === "water") return (Math.floor((t || 0) / 620) % 2) ? "water_b" : "water_a";
    if (kind === "wall") return "wall";
    if (kind === "floor") return "floor";
    if (kind === "door") return "wall";     // 门画在墙上，门本身用 ART.door()
    if (kind === "lamp") return "lamp";
    return null;
  }

  function needsProp(kind) { return kind === "tree" || kind === "rock" || kind === "fence"; }

  // 水边浅滩：陆地挨着水的那一边压一条，水才不像贴上去的蓝方块
  function shore(ctx, map, patchMap, kind, tx, ty, x, y, size) {
    if (kind === "wall" || kind === "door" || kind === "floor") return;
    var w = Math.max(2, size * 0.14);
    ctx.fillStyle = "rgba(228,186,126,.92)";
    if (kindAt(map, patchMap, tx, ty - 1) === "water") ctx.fillRect(x, y, size, w);
    if (kindAt(map, patchMap, tx, ty + 1) === "water") ctx.fillRect(x, y + size - w, size, w);
    if (kindAt(map, patchMap, tx - 1, ty) === "water") ctx.fillRect(x, y, w, size);
    if (kindAt(map, patchMap, tx + 1, ty) === "water") ctx.fillRect(x + size - w, y, w, size);
  }

  // 屋檐：房子最上一排的外侧压半格红瓦，屋里仍然看得见
  function roof(ctx, x, y, size) {
    if (!ready) return false;
    var i = name2idx("roof");
    if (i < 0) return false;
    var h = Math.max(4, size * 0.55);
    ctx.drawImage(img, (i % COLS) * SIZE, Math.floor(i / COLS) * SIZE + SIZE * 0.5, SIZE, SIZE * 0.5,
      Math.round(x), Math.round(y - h), size, h);
    ctx.fillStyle = "rgba(0,0,0,.20)";
    ctx.fillRect(Math.round(x), Math.round(y - 2), size, 2);
    return true;
  }

  /**
   * 画一格地面。返回 true 表示这一格已经画完（宿主就别再画旧画法）。
   * baseOnly = true：这一格上面要放树/石头/围栏，只铺草皮。
   */
  function ground(ctx, map, patchMap, tx, ty, x, y, size, t, baseOnly) {
    if (!ready) return false;
    var kind = kindAt(map, patchMap, tx, ty);
    var name = baseOnly ? "grass" : groundSprite(map, patchMap, kind, tx, ty, t);
    if (!name || !blit(ctx, name, x, y, size)) return false;

    if (!baseOnly) {
      if (kind === "water") {
        // 水体本身的暗边
        ctx.fillStyle = "rgba(18,58,86,.38)";
        var w = Math.max(2, size * 0.10);
        if (kindAt(map, patchMap, tx, ty - 1) !== "water") ctx.fillRect(x, y, size, w);
        if (kindAt(map, patchMap, tx, ty + 1) !== "water") ctx.fillRect(x, y + size - w, size, w);
        if (kindAt(map, patchMap, tx - 1, ty) !== "water") ctx.fillRect(x, y, w, size);
        if (kindAt(map, patchMap, tx + 1, ty) !== "water") ctx.fillRect(x + size - w, y, w, size);
      } else {
        shore(ctx, map, patchMap, kind, tx, ty, x, y, size);
      }
      if (kind === "wall") {
        ctx.fillStyle = "rgba(30,18,10,.35)";
        ctx.fillRect(x, y, size, Math.max(1, size * 0.07));
      }
      if (kind === "floor") {
        ctx.fillStyle = "rgba(96,70,46,.10)";
        ctx.fillRect(x, y + size - Math.max(1, size * 0.05), size, Math.max(1, size * 0.05));
      }
      if (isHouse(kind) && !isHouse(kindAt(map, patchMap, tx, ty - 1))) roof(ctx, x, y, size);
    }

    // 高度差：比下面那格高就压一道暗边
    var below = ty + 1 < map.height ? Number(map.heights[ty + 1][tx]) || 0 : 0;
    var h = Number(map.heights[ty][tx]) || 0;
    if (h > below) {
      ctx.fillStyle = "rgba(0,0,0,.28)";
      ctx.fillRect(x, y + size * 0.8, size, size * 0.22);
    }
    return true;
  }

  // 有高度的物件：树 / 石头 / 围栏。宿主负责按 y 排序，和角色一起画
  function prop(ctx, map, patchMap, tx, ty, kind, x, y, size) {
    if (!ready) return false;
    var n = hash2(tx * 7 + 3, ty * 11 + 5);

    if (kind === "tree") {
      ctx.fillStyle = "rgba(0,0,0,.20)";
      ctx.beginPath();
      ctx.ellipse(x + size * 0.5, y + size * 0.86, size * 0.34, size * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      var tname = n < 0.40 ? "tree_round" : n < 0.68 ? "tree_green2"
        : n < 0.85 ? "tree_orange" : "tree_autumn";
      return blit(ctx, tname, x, y, size);
    }

    if (kind === "rock") {
      ctx.fillStyle = "rgba(0,0,0,.18)";
      ctx.beginPath();
      ctx.ellipse(x + size * 0.5, y + size * 0.88, size * 0.32, size * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      return blit(ctx, "rock", x, y, size);
    }

    if (kind === "fence") {
      var L = kindAt(map, patchMap, tx - 1, ty) === "fence";
      var R = kindAt(map, patchMap, tx + 1, ty) === "fence";
      var U = kindAt(map, patchMap, tx, ty - 1) === "fence";
      var D = kindAt(map, patchMap, tx, ty + 1) === "fence";
      var fname = (L || R || !(U || D)) ? "fence_h" : "fence_v";
      return blit(ctx, fname, x, y, size);
    }
    return false;
  }

  // 门：open 时是黑洞洞的门框，关着是木门
  function door(ctx, x, y, size, open) {
    return ready ? blit(ctx, open ? "door_open" : "door", x, y, size) : false;
  }

  window.ART = {
    load: load,
    ready: function () { return ready; },
    tile: SIZE,
    kindAt: kindAt,
    ground: ground,
    prop: prop,
    door: door,
    roof: roof,
    needsProp: needsProp,
    isHouse: isHouse
  };
})();
