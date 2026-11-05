// 插件示例：给世界加一个自定义动作
// 任何村民（外部 AI 或本地 NPC）都能调用 world.applyAction(v, {type:"...", ...})
// 宿主只要把文件丢进 sim/plugins/ 就会在启动时加载。
export function register(world) {
  world.defineAction(
    "shout",
    {
      desc: "朝整个广场喊一句话（比 say 传得远，但所有人都会注意你）",
      params: { text: "string<=80" }
    },
    (w, v, a) => {
      const text = String(a.text || "").trim().slice(0, 80);
      if (!text) return { ok: false, reason: "empty" };
      if (v.cooldowns.shout > w.tickCount) return { ok: false, reason: "cooldown" };
      v.cooldowns.shout = w.tickCount + 300;
      for (const o of w.entities.values()) {
        if (o === v) continue;
        if (Math.hypot(o.x - v.x, o.y - v.y) > 20) continue;
        w.emit(o, { type: "heard_shout", fromId: v.id, fromName: v.name, text });
      }
      v.bubble = { text, until: w.tickCount + 60, private: false };
      w.emit(v, { type: "shouted", text });
      return { ok: true, text };
    }
  );
}
