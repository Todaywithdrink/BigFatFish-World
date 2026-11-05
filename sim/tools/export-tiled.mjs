import fs from "node:fs";
import path from "node:path";

const HERE = path.resolve(".");
const map = JSON.parse(fs.readFileSync(path.join(HERE, "data", "world-map.json"), "utf8"));
const outDir = path.join(HERE, "maps");
fs.mkdirSync(outDir, { recursive: true });

const W = map.width, H = map.height, legend = map.legend, rows = map.rows;
const kindAt = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return "edge";
  const lg = legend[rows[y][x]];
  return lg ? lg.kind : "grass";
};
const hash2 = (x, y) => {
  let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const G = { grass: 1, tuft: 2, grass2: 3, water_a: 5, water_b: 6, dirt: 7, path0: 17 };
// tiles.png（firstgid 33）的 0 基索引
const K = { wall: 13, floor: 15, door: 16, bench: 21, barrel: 22, stall: 23, lamp: 19, sign: 20, rock: 12, fence: 10 };
const O = { tree_round: 38, tree_orange: 40, tree_autumn: 41 };

const ground = new Array(W * H).fill(0);
const objects = new Array(W * H).fill(0);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const k = kindAt(x, y);
    const i = y * W + x;
    if (k === "water") ground[i] = ((Math.floor((x + y) / 7) % 2) ? G.water_b : G.water_a);
    else if (k === "sand") ground[i] = G.dirt;
    else if (k === "path") {
      let m = 0;
      if (kindAt(x, y - 1) !== "path") m |= 1;
      if (kindAt(x + 1, y) !== "path") m |= 2;
      if (kindAt(x, y + 1) !== "path") m |= 4;
      if (kindAt(x - 1, y) !== "path") m |= 8;
      ground[i] = G.path0 + m;
    } else if (k === "wall" || k === "floor" || k === "door") {
      ground[i] = 33 + K[k];
    } else if (k === "stall" || k === "bench" || k === "barrel" || k === "lamp") {
      ground[i] = G.grass;
      objects[i] = 33 + K[k];
    } else if (k === "fountain") {
      ground[i] = G.grass;
    } else {
      const n = hash2(x, y);
      ground[i] = n < 0.18 ? G.tuft : n < 0.26 ? G.grass2 : G.grass;
    }

    if (k === "tree") {
      const n = hash2(x + 7, y + 3);
      objects[i] = n < 0.5 ? O.tree_round : n < 0.8 ? O.tree_orange : O.tree_autumn;
    } else if (k === "rock") objects[i] = 33 + K.rock;
    else if (k === "fence") objects[i] = 33 + K.fence;
  }
}

const tmj = {
  type: "map", version: "1.10", tiledversion: "1.11.0",
  orientation: "orthogonal", renderorder: "right-down",
  width: W, height: H, tilewidth: 16, tileheight: 16,
  infinite: false, nextlayerid: 3, nextobjectid: 1,
  tilesets: [
    { firstgid: 1, name: "tiles2", image: "tiles2.png", imagewidth: 128, imageheight: 64, tilewidth: 16, tileheight: 16, columns: 8, tilecount: 32, margin: 0, spacing: 0 },
    { firstgid: 33, name: "tiles", image: "tiles.png", imagewidth: 128, imageheight: 80, tilewidth: 16, tileheight: 16, columns: 8, tilecount: 40, margin: 0, spacing: 0 }
  ],
  layers: [
    { id: 1, name: "ground", type: "tilelayer", width: W, height: H, x: 0, y: 0, visible: true, opacity: 1, data: ground },
    { id: 2, name: "objects", type: "tilelayer", width: W, height: H, x: 0, y: 0, visible: true, opacity: 1, data: objects }
  ]
};

fs.writeFileSync(path.join(outDir, "village.tmj"), JSON.stringify(tmj), "utf8");
fs.copyFileSync(path.join(HERE, "viewer", "tiles2.png"), path.join(outDir, "tiles2.png"));
fs.copyFileSync(path.join(HERE, "viewer", "tiles.png"), path.join(outDir, "tiles.png"));
console.log("ok", W + "x" + H);
