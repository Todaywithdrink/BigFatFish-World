
const base = "http://127.0.0.1:8090";
const reg = await (await fetch(base + "/api/agents/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "外部AI-2" })
})).json();
console.log("token", reg.token.slice(0, 10), "villager", reg.villager.name);

const obs = await (await fetch(base + "/api/agents/" + reg.token + "/observation")).json();
console.log("obs:", JSON.stringify({ tick: obs.tick, energy: obs.self.needs.energy, hunger: obs.self.needs.hunger, seen: obs.view.entities.length }));

const act = await (await fetch(base + "/api/agents/" + reg.token + "/act", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ actions: [
    { type: "moveTo", x: 32, y: 40 },
    { type: "say", text: "我是外部接进来的AI，正在走去广场。" }
  ] })
})).json();
console.log("act:", JSON.stringify(act.results));

await new Promise((r) => setTimeout(r, 2500));
const w = await (await fetch(base + "/api/world")).json();
console.log("after:", w.entities.map((e) => e.name + "@" + e.x + "," + e.y + " " + e.state + " ext=" + e.external).join(" | "));
console.log("log:", w.log.slice(-4).map((e) => e.type + ":" + (e.text || e.from?.name || "")).join(" | "));
