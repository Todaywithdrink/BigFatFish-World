using StardewModdingAPI;

namespace AiVillagers
{
    public sealed class ModConfig
    {
        /// <summary>总开关。</summary>
        public bool Enabled { get; set; } = true;

        /// <summary>本地 AI 桥接服务的地址。</summary>
        public string BridgeUrl { get; set; } = "http://127.0.0.1:8787/v1/talk";

        /// <summary>一次请求最多等多久（秒）。超时就退回原版对话。</summary>
        public int TimeoutSeconds { get; set; } = 20;

        /// <summary>单句台词最多多少字。</summary>
        public int MaxChars { get; set; } = 120;

        /// <summary>走到村民身边时提前生成台词（这样按对话键时已经准备好）。</summary>
        public bool PrefetchWhenNearby { get; set; } = true;

        /// <summary>提前生成的距离（格）。</summary>
        public float PrefetchRadiusTiles { get; set; } = 3f;

        /// <summary>把请求和结果写进 SMAPI 控制台。</summary>
        public bool VerboseLog { get; set; } = true;
    }
}
