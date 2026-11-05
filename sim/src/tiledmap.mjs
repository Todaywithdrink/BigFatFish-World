// 把 Tiled 的 .tmj 读成运行时地图（rows + legend），复用 GameMap
import fs from "node:fs";

const GID_KIND = (gid) => {
  // tiles2（1..32）
  if (gid >= 1 && gid <= 4) return "grass";
  if (gid === 5 || gid === 6) return "water";
  if (gid === 7) return "path";
  if (gid >= 17 && gid <= 32) return "path";
  // tiles（33..72）
  const i = gid - 33;
  if (i === 5 || i === 6 || i === 7 || i === 8) return "tree";
  if (i === 10 || i === 11) return "fence";
  if (i === 12) return "rock";
  if (i === 13 || i === 14) return "wall";
  if (i === 15) return "floor";
  if (i === 16 || i === 17) return "door";
  if (i === 19) return "lamp";
  if (i === 21) return "bench";
  if (i === 22) return "barrel";
  if (i === 23) return "stall";
  return "grass";
};

const CHAR = {
  crate: "X",
  stump: "t",
  board: "M",
  grass: ".", path: "-", water: "~", sand: "s", tree: "T", rock: "R", fence: "F",
  wall: "#", floor: "_", door: "D", lamp: "L", bench: "b", barrel: "V", stall: "S",
  flower: "f", hedge: "H", bed: "B", stove: "O", soil: "S", crop: "C", board: "*", fountain: "Q"
};

const LEGEND = {
  ".": { kind: "grass", walkable: true, opaque: false, soundproof: false },
  "-": { kind: "path", walkable: true, opaque: false, soundproof: false },
  "~": { kind: "water", walkable: false, opaque: false, soundproof: false },
  "s": { kind: "sand", walkable: true, opaque: false, soundproof: false },
  "T": { kind: "tree", walkable: false, opaque: true, soundproof: true },
  "R": { kind: "rock", walkable: false, opaque: true, soundproof: true },
  "F": { kind: "fence", walkable: false, opaque: false, soundproof: false },
  "#": { kind: "wall", walkable: false, opaque: true, soundproof: true },
  "_": { kind: "floor", walkable: true, opaque: false, soundproof: false },
  "D": { kind: "door", walkable: false, opaque: true, soundproof: true },
  "L": { kind: "lamp", walkable: false, opaque: false, soundproof: false },
  "b": { kind: "bench", walkable: false, opaque: false, soundproof: false },
  "V": { kind: "barrel", walkable: false, opaque: false, soundproof: false },
  "S": { kind: "stall", walkable: false, opaque: true, soundproof: false },
  "B": { kind: "bed", walkable: true, opaque: false, soundproof: false },
  "O": { kind: "stove", walkable: false, opaque: false, soundproof: false },
  "M": { kind: "board", walkable: false, opaque: false, soundproof: false },
  "t": { kind: "stump", walkable: false, opaque: false, soundproof: false },
  "X": { kind: "crate", walkable: false, opaque: false, soundproof: false },
  "S": { kind: "soil", walkable: true, opaque: false, soundproof: false },
  "C": { kind: "crop", walkable: true, opaque: false, soundproof: false },
  "H": { kind: "hedge", walkable: false, opaque: true, soundproof: false },
  "f": { kind: "flower", walkable: true, opaque: false, soundproof: false },
  "Q": { kind: "fountain", walkable: false, opaque: true, soundproof: false }
};

export function loadTiled(path, { spawn = { x: 32, y: 36 } } = {}) {
  const tmj = JSON.parse(fs.readFileSync(path, "utf8"));
  const W = tmj.width, H = tmj.height;
  const groundLayer = tmj.layers.find((l) => l.name === "ground");
  const objLayer = tmj.layers.find((l) => l.name === "objects");
  const rows = [];
  for (let y = 0; y < H; y++) {
    let line = "";
    for (let x = 0; x < W; x++) {
      const g = objLayer ? (objLayer.data[y * W + x] || 0) : 0;
      const gg = groundLayer ? (groundLayer.data[y * W + x] || 0) : 0;
      const kind = g ? GID_KIND(g) : GID_KIND(gg);
      line += CHAR[kind] || ".";
    }
    rows.push(line);
  }
  const heights = [];
  for (let y = 0; y < H; y++) heights.push(new Array(W).fill(0));
  return { width: W, height: H, rows, legend: LEGEND, heights, homes: [], spawn, doors: [] };
}
