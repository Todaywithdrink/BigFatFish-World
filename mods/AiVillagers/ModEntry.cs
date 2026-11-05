using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace AiVillagers
{
    internal enum HandleKind { NotHandled, Ready, Pending }

    internal sealed class CachedLine
    {
        public string Text;
        public DateTime At;
        public bool IsFresh(TimeSpan age) => DateTime.UtcNow - At < age;
    }

    internal sealed class BridgeReply
    {
        public string NpcName;
        public string Text;
        public string Error;
    }

    public sealed class ModEntry : Mod
    {
        internal static ModEntry Instance { get; private set; }
        internal ModConfig Config { get; private set; }

        /// <summary>语言在 Entry 时还没被游戏设好，所以每次现取。</summary>
        public string LanguageCode
        {
            get
            {
                try { return LocalizedContentManager.CurrentLanguageCode.ToString(); }
                catch { return "en"; }
            }
        }

        private readonly Dictionary<string, CachedLine> cache = new Dictionary<string, CachedLine>(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, byte> probe = new ConcurrentDictionary<string, byte>(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, byte> inFlight = new ConcurrentDictionary<string, byte>(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentQueue<BridgeReply> replies = new ConcurrentQueue<BridgeReply>();
        private string waitingNpc;
        private int tickCounter;

        public override void Entry(IModHelper helper)
        {
            Instance = this;
            Config = helper.ReadConfig<ModConfig>();
            helper.WriteConfig(Config);

            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            helper.Events.GameLoop.SaveLoaded += (s, e) => Reset();
            helper.Events.GameLoop.DayStarted += (s, e) => cache.Clear();
            helper.Events.GameLoop.ReturnedToTitle += (s, e) => Reset();

            var harmony = new Harmony(ModManifest.UniqueID);
            var target = AccessTools.Method(typeof(NPC), nameof(NPC.checkAction), new[] { typeof(Farmer), typeof(GameLocation) });
            if (target == null)
            {
                Monitor.Log("找不到 NPC.checkAction，补丁没有装上。", LogLevel.Error);
                return;
            }
            harmony.Patch(target, prefix: new HarmonyMethod(typeof(VillagerPatch), nameof(VillagerPatch.Prefix)));
            helper.ConsoleCommands.Add("av_test", "测试 AI 桥接： av_test <村民英文名，如 Abigail>", OnTestCommand);
            Monitor.Log("AI 村民已启动；桥接地址 " + Config.BridgeUrl + "（可用 av_test 测试）", LogLevel.Info);
        }

        private void Reset()
        {
            cache.Clear();
            inFlight.Clear();
            waitingNpc = null;
        }

        private string WaitingLine
        {
            get { return LanguageCode != null && LanguageCode.StartsWith("zh") ? "……" : "..."; }
        }

        internal HandleKind TryHandle(NPC npc, Farmer who, out string line)
        {
            line = null;
            if (npc == null) return HandleKind.NotHandled;

            CachedLine cached;
            if (cache.TryGetValue(npc.Name, out cached) && cached.IsFresh(TimeSpan.FromMinutes(2)))
            {
                line = cached.Text;
                return HandleKind.Ready;
            }

            waitingNpc = npc.Name;
            line = WaitingLine;
            if (!inFlight.ContainsKey(npc.Name))
                StartRequest(npc, who);
            return HandleKind.Pending;
        }

        private void StartRequest(NPC npc, Farmer who)
        {
            string key = npc.Name;
            if (!inFlight.TryAdd(key, 1)) return;

            CachedLine prev;
            string last = cache.TryGetValue(key, out prev) ? prev.Text : null;
            TalkContext ctx = TalkContext.Build(npc, who, last);

            var cts = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Max(3, Config.TimeoutSeconds)));
            if (Config.VerboseLog)
                Monitor.Log("[ask] " + key + " (" + ctx.Weather + ", " + ctx.Season + " " + ctx.Day + ", " + ctx.Hearts + "心)", LogLevel.Debug);

            Task.Run(async () =>
            {
                try
                {
                    string text = await Bridge.AskAsync(ctx, cts.Token).ConfigureAwait(false);
                    replies.Enqueue(new BridgeReply { NpcName = key, Text = text });
                }
                catch (Exception ex)
                {
                    replies.Enqueue(new BridgeReply { NpcName = key, Error = ex.Message });
                }
                finally
                {
                    inFlight.TryRemove(key, out _);
                    cts.Dispose();
                }
            });
        }

        private void OnUpdateTicked(object sender, UpdateTickedEventArgs e)
        {
            BridgeReply reply;
            while (replies.TryDequeue(out reply)) Apply(reply);

            tickCounter++;
            if (tickCounter % 30 == 0) Prefetch();
        }

        private void Apply(BridgeReply reply)
        {
            if (!string.IsNullOrEmpty(reply.Error))
            {
                if (Config.VerboseLog) Monitor.Log("[失败] " + reply.NpcName + ": " + reply.Error, LogLevel.Warn);
                if (waitingNpc != null && string.Equals(waitingNpc, reply.NpcName, StringComparison.OrdinalIgnoreCase)
                    && Game1.activeClickableMenu is StardewValley.Menus.DialogueBox)
                {
                    NPC failed = Game1.getCharacterFromName(reply.NpcName);
                    if (failed != null)
                    {
                        Game1.DrawDialogue(failed, LanguageCode.StartsWith("zh") ? "（对方好像没听清你的话。）" : "(They didn't seem to hear you.)");
                        waitingNpc = null;
                    }
                }
                return;
            }

            cache[reply.NpcName] = new CachedLine { Text = DialogueText.Sanitize(reply.Text), At = DateTime.UtcNow };
            if (probe.TryRemove(reply.NpcName, out _))
                Monitor.Log("[av_test] " + reply.NpcName + " → " + reply.Text, LogLevel.Info);
            if (Config.VerboseLog) Monitor.Log("[回答] " + reply.NpcName + ": " + reply.Text, LogLevel.Debug);

            if (waitingNpc != null && string.Equals(waitingNpc, reply.NpcName, StringComparison.OrdinalIgnoreCase)
                && Game1.activeClickableMenu is StardewValley.Menus.DialogueBox)
            {
                NPC npc = Game1.getCharacterFromName(reply.NpcName);
                if (npc != null)
                {
                    string line = DialogueText.Sanitize(reply.Text);
                    if (string.IsNullOrEmpty(line)) line = LanguageCode.StartsWith("zh") ? "……" : "...";
                    Game1.DrawDialogue(npc, line);
                    waitingNpc = null;
                }
            }
        }

        private void OnTestCommand(string command, string[] args)
        {
            if (Game1.player == null)
            {
                Monitor.Log("还没读档，没法测试。", LogLevel.Warn);
                return;
            }
            string name = args != null && args.Length > 0 ? args[0] : "Abigail";
            NPC npc = Game1.getCharacterFromName(name, true, true);
            if (npc == null)
            {
                Monitor.Log("找不到村民：" + name, LogLevel.Warn);
                return;
            }
            probe[npc.Name] = 1;
            StartRequest(npc, Game1.player);
            Monitor.Log("已向桥接服务请求 " + npc.Name + " 的台词……（结果会打在这一行下面）", LogLevel.Info);
        }

        private void Prefetch()
        {
            if (!Config.PrefetchWhenNearby) return;
            if (Game1.player == null || Game1.currentLocation == null) return;
            if (Game1.eventUp || Game1.activeClickableMenu != null) return;

            Vector2 me = Game1.player.Tile;
            float radius = Config.PrefetchRadiusTiles;
            foreach (NPC npc in Game1.currentLocation.characters)
            {
                if (npc == null || !npc.IsVillager || npc.IsInvisible) continue;
                if (Vector2.Distance(npc.Tile, me) > radius) continue;
                if (inFlight.ContainsKey(npc.Name)) continue;

                CachedLine c;
                if (cache.TryGetValue(npc.Name, out c) && c.IsFresh(TimeSpan.FromMinutes(1))) continue;
                StartRequest(npc, Game1.player);
            }
        }
    }
}