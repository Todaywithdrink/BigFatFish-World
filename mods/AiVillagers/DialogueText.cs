using System.Text;

namespace AiVillagers
{
    internal static class DialogueText
    {
        /// <summary>一句话最多这么长，超过就在标点处断开。</summary>
        private const int MaxChars = 180;

        /// <summary>
        /// 模型输出不能直接喂给星露谷的对话解析器：
        /// $ % # @ { } ^ ~ | \ 都是控制符（立绘/性别切换/变量插值/分段），
        /// 换行会被当成多段对话。这里只留"一个人当面说的一句话"。
        /// </summary>
        internal static string Sanitize(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return "";

            var sb = new StringBuilder(raw.Length);
            foreach (char c in raw)
            {
                if (c == '\r' || c == '\n' || c == '\t') { sb.Append(' '); continue; }
                if (char.IsControl(c)) continue;
                if (c == '$' || c == '%' || c == '#' || c == '@'
                    || c == '{' || c == '}' || c == '^' || c == '~'
                    || c == '\\' || c == '|') continue;
                sb.Append(c);
            }

            string t = sb.ToString();
            while (t.Contains("  ")) t = t.Replace("  ", " ");
            t = t.Trim().Trim('"', '\'', '“', '”', '「', '」', '『', '』').Trim();

            if (t.Length > MaxChars)
            {
                t = t.Substring(0, MaxChars);
                int cut = t.LastIndexOfAny(new[] { '。', '！', '？', '.', '!', '?', '，', ',' });
                if (cut > MaxChars / 2) t = t.Substring(0, cut + 1);
            }
            return t;
        }
    }
}
