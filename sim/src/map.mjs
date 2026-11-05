// 地图：瓦片、碰撞、视线、声音、寻路
import fs from "node:fs";
import { generateTerrain } from "./terrain.mjs";
import { regionTheme, THEMES } from "./outline.mjs";

export const TILE = {
  GRASS: "grass", PATH: "path", WALL: "wall", DOOR: "door", FLOOR: "floor",
  BED: "bed", STOVE: "stove", TREE: "tree", WATER: "water", ROCK: "rock"
};

export class GameMap {
  constructor(data) {
    this.width = data.width;
    this.height = data.height;
    this.legend = { ...data.legend };
    this.spawn = data.spawn;
    this.homes = data.homes || [];
    this.tiles = [];
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        const ch = data.rows[y][x];
        const def = this.legend[ch] || this.legend["."];
        row.push({
          ch,
          kind: def.kind,
          walkable: def.walkable,
          opaque: def.opaque,
          soundproof: def.soundproof,
          height: Number(data.heights[y][x]) || 0,
          doorId: def.kind === "door" ? x + "," + y : null
        });
      }
      this.tiles.push(row);
    }
    this.byKind = {};
    this.charByKind = {};
    for (const [ch, def] of Object.entries(this.legend)) {
      this.byKind[def.kind] = def;
      this.charByKind[def.kind] = ch;
    }
    // 储物箱是内核能力，不该依赖某张地图恰好登记过 crate 这一档。
    // 正式地图有 "X"=crate，几张老测试地图没有；这里补一个内建定义并占一个空闲字符。
    if (!this.byKind.crate) {
      let ch = "X";
      for (const c of "XYZQqWw0123456789") if (!this.legend[c]) { ch = c; break; }
      const def = { kind: "crate", walkable: false, opaque: false, soundproof: false };
      this.legend[ch] = def;
      this.byKind.crate = def;
      this.charByKind.crate = ch;
    }
    this.doors = new Map();
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const t = this.tiles[y][x];
        if (t.kind === "door") this.doors.set(t.doorId, { x, y, open: false });
      }
    }
  }

  static load(file) {
    return new GameMap(JSON.parse(fs.readFileSync(file, "utf8")));
  }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  tile(x, y) { return this.inBounds(x, y) ? this.tiles[y | 0][x | 0] : null; }
  tileAtFloat(x, y) { return this.tile(Math.floor(x), Math.floor(y)); }

  isWalkable(x, y) {
    const t = this.tileAtFloat(x, y);
    return !!t && t.walkable;
  }

  makeTile(kind, height = 0) {
    const def = this.byKind[kind] || this.byKind.grass;
    return {
      ch: this.charByKind[def.kind] || "?",
      kind: def.kind,
      walkable: def.walkable,
      opaque: def.opaque,
      soundproof: def.soundproof,
      height,
      doorId: null
    };
  }

  toJSON() {
    const rows = [], heights = [];
    for (let y = 0; y < this.height; y++) {
      let r = "", h = "";
      for (let x = 0; x < this.width; x++) {
        const t = this.tiles[y][x];
        r += this.charByKind[t.kind] || "?";
        h += String(t.height);
      }
      rows.push(r);
      heights.push(h);
    }
    return {
      width: this.width, height: this.height,
      rows, heights, legend: this.legend,
      spawn: this.spawn, homes: this.homes
    };
  }

  /**
   * 按大陆大纲长出一个区域：32 格宽/高的一条。
   * 主题由 (区域坐标, 世界种子) 预先定死——渐进开放是"显现"，不是"临时随机"。
   * 大陆边缘（东海/南山脊）长出一条海岸/山麓条带，走到跟前看得见，但过不去。
   */
  expand(side, seed = 1, worldSeed = 1) {
    const N = 32;
    const oldW = this.width, oldH = this.height;
    const KIND = { water: "water", sand: "sand", grass: "grass", forest: "tree", rock: "rock", flower: "flower" };

    // 大纲：这一块是什么主题。东扩看新列，南扩看整行的代表主题（中部）
    const cx = Math.floor(oldW / N), cy = Math.floor(oldH / N);
    const theme = side === "e" ? regionTheme(cx, cy, worldSeed) : regionTheme(4, cy, worldSeed);
    const conf = THEMES[theme] || THEMES.plain;
    const isEdge = !!conf.edgeKind;   // sea / mountain：生成边缘条带

    // 疏林：树与树至少隔 2 格，只有"林带"里才密一点，其余是散树
    const rnd2 = (x, y, k) => {
      let h = (x * 374761393 + y * 668265263 + seed * 144665 + k * 97) | 0;
      h = (h ^ (h >>> 13)) * 1274126177;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const treeChance = conf.treeChance != null ? conf.treeChance : 0.05;
    const plantTrees = (x0, y0, w, h) => {
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const t = this.tile(x, y);
          if (!t || t.kind !== "grass") continue;
          const biome = rnd2(x >> 4, y >> 4, 11);
          const chance = biome < 0.34 ? treeChance * 2.4 : treeChance;
          if (rnd2(x, y, 2) > chance) continue;
          let blocked = false;
          for (let dy = -2; dy <= 2 && !blocked; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (dx === 0 && dy === 0) continue;
              const n = this.tile(x + dx, y + dy);
              if (n && (n.kind === "tree" || n.kind === "stump")) { blocked = true; break; }
            }
          }
          if (!blocked) this.setKind(x, y, "tree");
        }
      }
    };
    // 边缘条带：靠外一大半是海/山，靠内一小半草坡过渡
    const edgeRow = (i, total) => isEdge && i >= total - 24;

    if (side === "e" || side === "s") {
      const kinds = generateTerrain(
        side === "e"
          ? { x0: oldW, y0: 0, width: N, height: oldH, seed }
          : { x0: 0, y0: oldH, width: oldW, height: N, seed }
      );

      if (side === "e") {
        for (let y = 0; y < oldH; y++) {
          this.setKind(oldW - 1, y, "grass");
          if (oldW > 2) this.setKind(oldW - 2, y, "grass");
          for (let i = 0; i < N; i++) this.tiles[y].push(this.makeTile("grass", 0));
        }
        this.width = oldW + N;
        for (let y = 0; y < oldH; y++) {
          for (let i = 0; i < N; i++) {
            const k = isEdge && edgeRow(i, N) ? conf.edgeKind : (KIND[kinds[y][i]] || "grass");
            this.setKind(oldW + i, y, k);
          }
        }
        if (!isEdge) plantTrees(oldW, 0, N, oldH);
      } else {
        for (let i = 0; i < N; i++) {
          const row = [];
          for (let x = 0; x < this.width; x++) row.push(this.makeTile("grass", 0));
          this.tiles.push(row);
        }
        this.height = oldH + N;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < this.width; x++) {
            const k = isEdge && edgeRow(y, N) ? conf.edgeKind : (KIND[kinds[y][x]] || "grass");
            this.setKind(x, oldH + y, k);
          }
        }
        if (!isEdge) plantTrees(0, oldH, this.width, N);
      }
    }

    return { side, width: this.width, height: this.height, theme, edge: isEdge };
  }

  // 改一格的地形（建造/拆除用），高度不动
  setKind(x, y, kind) {
    const def = this.byKind[kind];
    if (!def) return false;
    const t = this.tile(x, y);
    if (!t) return false;
    t.ch = "*";
    t.kind = def.kind;
    t.walkable = def.walkable;
    t.opaque = def.opaque;
    t.soundproof = def.soundproof;
    return true;
  }

  setDoor(id, open) {
    const d = this.doors.get(id);
    if (!d) return false;
    const t = this.tiles[d.y][d.x];
    d.open = open;
    t.walkable = open;
    t.opaque = !open;
    t.soundproof = !open;
    return true;
  }

  // 视线：起点终点之间的瓦片是否被不透明的东西挡住
  lineBlocked(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return false;
    const steps = Math.ceil(dist / 0.2);
    // 终点所在的格子不挡自己：否则"看得见的树/墙"永远进不了 explored，
    // 居民也就永远不知道世界上有树。
    const ex = Math.floor(bx), ey = Math.floor(by);
    for (let i = 1; i < steps; i++) {
      const t = Math.floor(ay + (dy * i) / steps);
      const l = Math.floor(ax + (dx * i) / steps);
      if (l === ex && t === ey) continue;
      const tile = this.tile(l, t);
      if (!tile) return true;
      if (tile.opaque) return true;
    }
    return false;
  }

  // 声音：被 soundproof 挡住（关着的门、墙）
  soundBlocked(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return false;
    const steps = Math.ceil(dist / 0.2);
    for (let i = 1; i < steps; i++) {
      const t = this.tile(Math.floor(ax + (dx * i) / steps), Math.floor(ay + (dy * i) / steps));
      if (!t) return true;
      if (t.soundproof) return true;
    }
    return false;
  }

  tileCenter(x, y) { return { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 }; }

  findNearest(kind, x, y) {
    if (!this._kindCache) this._kindCache = new Map();
    var list = this._kindCache.get(kind);
    if (!list) {
      list = [];
      for (var ty = 0; ty < this.height; ty++) {
        for (var tx = 0; tx < this.width; tx++) {
          if (this.tiles[ty][tx].kind === kind) list.push({ x: tx, y: ty });
        }
      }
      this._kindCache.set(kind, list);
    }
    var best = null, bd = Infinity;
    for (var i = 0; i < list.length; i++) {
      var d = Math.hypot(list[i].x - x, list[i].y - y);
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best;
  }

  /**
   * A* 寻路，返回瓦片中心点数组（不含起点）。
   * 8 方向，禁止穿墙，禁止爬升超过 1 米，允许下落。
   */
  findPath(sx, sy, tx, ty, maxNodes = 1200) {
    const start = { x: Math.floor(sx), y: Math.floor(sy) };
    const goal = { x: Math.floor(tx), y: Math.floor(ty) };
    if (!this.inBounds(goal.x, goal.y) || !this.tiles[goal.y][goal.x].walkable) return null;
    if (start.x === goal.x && start.y === goal.y) return [];

    const key = (x, y) => y * this.width + x;
    const open = [{ ...start, g: 0, f: 0, parent: null }];
    const best = new Map([[key(start.x, start.y), 0]]);
    const closed = new Set();
    let iter = 0;

    while (open.length && iter++ < maxNodes) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur.x === goal.x && cur.y === goal.y) {
        const path = [];
        let n = cur;
        while (n && !(n.x === start.x && n.y === start.y)) {
          path.push({ x: n.x + 0.5, y: n.y + 0.5 });
          n = n.parent;
        }
        return path.reverse();
      }
      closed.add(key(cur.x, cur.y));

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cur.x + dx, ny = cur.y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const t = this.tiles[ny][nx];
          if (!t.walkable) continue;
          const curT = this.tiles[cur.y][cur.x];
          if (t.height - curT.height > 1) continue;           // 太陡，上不去
          if (dx && dy) {                                     // 不能斜穿墙角
            const a = this.tiles[cur.y][nx], b = this.tiles[ny][cur.x];
            if (!a.walkable || !b.walkable) continue;
          }
          const k = key(nx, ny);
          if (closed.has(k)) continue;
          const g = cur.g + (dx && dy ? 1.4142 : 1);
          if (best.has(k) && best.get(k) <= g) continue;
          best.set(k, g);
          const h = Math.hypot(nx - goal.x, ny - goal.y);
          open.push({ x: nx, y: ny, g, f: g + h, parent: cur });
        }
      }
    }
    return null;
  }
}