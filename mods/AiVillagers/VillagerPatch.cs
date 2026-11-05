using HarmonyLib;
using StardewValley;

namespace AiVillagers
{
    internal static class VillagerPatch
    {
        /// <summary>拦下原版对话，改由 AI 生成。返回 false 表示不执行原方法。</summary>
        internal static bool Prefix(NPC __instance, Farmer who, ref bool __result)
        {
            var mod = ModEntry.Instance;
            if (mod == null || !mod.Config.Enabled) return true;
            if (__instance == null || !__instance.IsVillager) return true;
            if (who == null || who.ActiveObject != null) return true;
            if (Game1.eventUp || Game1.activeClickableMenu != null) return true;

            string line;
            var kind = mod.TryHandle(__instance, who, out line);
            if (kind == HandleKind.NotHandled) return true;

            Game1.DrawDialogue(__instance, line);
            __result = true;
            return false;
        }
    }
}
