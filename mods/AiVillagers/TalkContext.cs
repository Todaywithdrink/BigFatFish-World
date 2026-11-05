using StardewValley;

namespace AiVillagers
{
    /// <summary>发给桥接服务的上下文：只放游戏状态，不放提示词。</summary>
    public sealed class TalkContext
    {
        public string NpcName { get; set; }
        public string NpcDisplayName { get; set; }
        public bool NpcIsFemale { get; set; }
        public int NpcAge { get; set; }
        public int NpcManners { get; set; }
        public int NpcSocialAnxiety { get; set; }
        public int NpcOptimism { get; set; }

        public string PlayerName { get; set; }
        public string PlayerDisplayName { get; set; }

        public string Season { get; set; }
        public int Day { get; set; }
        public int TimeOfDay { get; set; }
        public string Weather { get; set; }
        public string Location { get; set; }
        public string Language { get; set; }

        public int Hearts { get; set; }
        public int Points { get; set; }
        public string FriendshipStatus { get; set; }
        public bool GiftedToday { get; set; }
        public bool TalkedToday { get; set; }

        public string LastLine { get; set; }
        public int MaxChars { get; set; }

        public static TalkContext Build(NPC npc, Farmer who, string lastLine)
        {
            var ctx = new TalkContext
            {
                NpcName = npc.Name,
                NpcDisplayName = npc.displayName,
                NpcIsFemale = npc.Gender == Gender.Female,
                NpcAge = npc.Age,
                NpcManners = npc.Manners,
                NpcSocialAnxiety = npc.SocialAnxiety,
                NpcOptimism = npc.Optimism,
                PlayerName = who.Name,
                PlayerDisplayName = who.displayName,
                Season = Game1.currentSeason,
                Day = Game1.dayOfMonth,
                TimeOfDay = Game1.timeOfDay,
                Weather = Game1.isLightning ? "storm" : Game1.isRaining ? "rain" : Game1.isSnowing ? "snow" : "clear",
                Location = Game1.currentLocation != null ? Game1.currentLocation.Name : null,
                Language = AiVillagers.ModEntry.Instance != null ? AiVillagers.ModEntry.Instance.LanguageCode : "en",
                LastLine = lastLine,
                MaxChars = AiVillagers.ModEntry.Instance != null ? AiVillagers.ModEntry.Instance.Config.MaxChars : 120
            };

            if (who.friendshipData != null && who.friendshipData.TryGetValue(npc.Name, out var f) && f != null)
            {
                ctx.Points = f.Points;
                ctx.Hearts = f.Points / 250;
                ctx.FriendshipStatus = f.Status.ToString();
                ctx.GiftedToday = f.GiftsToday > 0;
                ctx.TalkedToday = f.TalkedToToday;
            }
            return ctx;
        }
    }
}
