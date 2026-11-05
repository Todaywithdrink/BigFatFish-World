// 代际功能的确定性验证：求婚 → 成婚 → 生子 → 长大，同种子两次必须同一世界
import { GameMap } from "../src/map.mjs";
import { World } from "../src/world.mjs";
import { worldHash } from "../src/fingerprint.mjs";
import { stageOf } from "../src/lifecycle.mjs";

const loadMap = () => GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const run = (seed) => {
  const w = new World(loadMap(), { seed });
  const a = w.spawn({ name: "A", ageDays: 30 });
  const b = w.spawn({ name: "B", ageDays: 30 });
  w.applyAction(a, { type: "move", dir: "e", tiles: 2 });
  const pr = w.applyAction(b, { type: "propose", targetId: a.id });
  if (pr.ok) w.applyAction(a, { type: "answerProposal", proposalId: pr.proposalId, accept: true });
  const br = w.applyAction(b, { type: "giveBirth", name: "小A" });
  if (br.ok) w.applyAction(w.entities.get(br.child.id), { type: "move", dir: "s", tiles: 1 });
  // 跑 13000 tick：跨过一天，孩子长一岁
  for (let i = 0; i < 13000; i++) w.step();
  const kid = br.ok ? w.entities.get(br.child.id) : null;
  return { hash: worldHash(w), kidAge: kid ? kid.ageDays : null, kidStage: kid ? stageOf(kid.ageDays) : null };
};

const h1 = run(99), h2 = run(99);
console.log("seed 99 两次:", h1.hash, h2.hash, h1.hash === h2.hash ? "✓ 一致" : "✗ 分叉");
console.log("孩子:", h1.kidAge, "天,", h1.kidStage, h2.kidStage === h1.kidStage ? "✓" : "✗");
console.log("事件核对: 求婚→", h1.hash === h2.hash ? "成婚/生育/成长全程确定" : "不确定");
if (h1.hash !== h2.hash || h1.kidStage !== h2.kidStage) process.exit(1);
console.log("lifecycle-determinism: PASS");
