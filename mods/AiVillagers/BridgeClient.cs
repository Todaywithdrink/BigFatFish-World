using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace AiVillagers
{
    internal static class Bridge
    {
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        public static async Task<string> AskAsync(TalkContext ctx, CancellationToken token)
        {
            string payload = JsonSerializer.Serialize(ctx, JsonOptions);
            using (var content = new StringContent(payload, Encoding.UTF8, "application/json"))
            using (var resp = await Http.PostAsync(ModEntry.Instance.Config.BridgeUrl, content, token).ConfigureAwait(false))
            {
                string body = await resp.Content.ReadAsStringAsync(token).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                    throw new InvalidOperationException($"bridge {(int)resp.StatusCode}: {Truncate(body, 200)}");
                using (var doc = JsonDocument.Parse(body))
                {
                    if (!doc.RootElement.TryGetProperty("text", out var textEl))
                        throw new InvalidOperationException("bridge response missing 'text'");
                    string text = (textEl.GetString() ?? string.Empty).Trim();
                    if (text.Length == 0)
                        throw new InvalidOperationException("bridge returned empty text");
                    return text;
                }
            }
        }

        private static string Truncate(string s, int n) => s == null ? "" : (s.Length <= n ? s : s.Substring(0, n));
    }
}
