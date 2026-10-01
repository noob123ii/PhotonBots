using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using GtagBotUI.Models;

namespace GtagBotUI.Services;

public class AccountVerifier
{
    private readonly string _workDir;

    public AccountVerifier()
    {
        _workDir = ResolveRootDir();
    }

    private static string ResolveRootDir()
    {
        var candidates = new[]
        {
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..")),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..")),
            Environment.CurrentDirectory,
            Path.GetFullPath(Path.Combine(Environment.CurrentDirectory, "..")),
        };
        foreach (var dir in candidates)
        {
            if (File.Exists(Path.Combine(dir, "node", "index.js")) ||
                File.Exists(Path.Combine(dir, "src", "index.js")))
                return dir;
        }
        return Environment.CurrentDirectory;
    }

    /// <summary>
    /// Sole source of truth: accounts.txt → validtokens.txt + tokens.json.
    /// Prefers accounts.txt next to the .exe (where you edit it), then project root.
    /// Syncs that file into the project root so the Node bot reads the same list.
    /// </summary>
    public (int Total, int Valid, int Expired, int Invalid) LoadAccounts()
    {
        var accPath = ResolveAccountsTxtPath();
        if (accPath is null || !File.Exists(accPath)) return (0, 0, 0, 0);

        // Keep project-root accounts.txt in sync so node/index.js sees the same file
        var rootAcc = Path.Combine(_workDir, "accounts.txt");
        if (!PathsEqual(accPath, rootAcc))
        {
            try { File.Copy(accPath, rootAcc, true); }
            catch { /* best effort */ }
        }

        var lines = File.ReadAllLines(accPath);
        var valid = new List<object>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var total = 0;
        var validCount = 0;
        var expiredCount = 0;
        var invalidCount = 0;

        foreach (var line in lines)
        {
            var l = line.Trim().Replace("\r", "");
            if (string.IsNullOrEmpty(l) || l.StartsWith('#')) continue;
            total++;

            if (TryParseAccount(l, out var account, out _, out var expired))
            {
                if (expired)
                {
                    expiredCount++;
                    continue;
                }

                var userProp = account.GetType().GetProperty("username")?.GetValue(account)?.ToString() ?? "";
                if (string.IsNullOrEmpty(userProp) || !seen.Add(userProp))
                    continue;

                valid.Add(account);
                validCount++;
            }
            else
            {
                invalidCount++;
            }
        }

        WriteTokenFiles(valid);
        return (total, validCount, expiredCount, invalidCount);
    }

    /// <summary>
    /// Prefer accounts.txt beside the running exe (bin/Release/...), else project root.
    /// </summary>
    private string? ResolveAccountsTxtPath()
    {
        var besideExe = Path.Combine(AppContext.BaseDirectory, "accounts.txt");
        var inRoot = Path.Combine(_workDir, "accounts.txt");

        var exeExists = File.Exists(besideExe);
        var rootExists = File.Exists(inRoot);

        if (exeExists && rootExists)
        {
            // Use whichever was edited more recently — that's the one the user set
            var exeTime = File.GetLastWriteTimeUtc(besideExe);
            var rootTime = File.GetLastWriteTimeUtc(inRoot);
            return exeTime >= rootTime ? besideExe : inRoot;
        }
        if (exeExists) return besideExe;
        if (rootExists) return inRoot;
        return null;
    }

    private static bool PathsEqual(string a, string b) =>
        string.Equals(Path.GetFullPath(a).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                      Path.GetFullPath(b).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                      StringComparison.OrdinalIgnoreCase);

    private void WriteTokenFiles(List<object> valid)
    {
        var wrapper = new { accounts = valid };
        var json = JsonSerializer.Serialize(wrapper, new JsonSerializerOptions { WriteIndented = true });

        // Always overwrite both — tokens.json must only contain accounts.txt entries
        File.WriteAllText(Path.Combine(_workDir, "validtokens.txt"), json);
        File.WriteAllText(Path.Combine(_workDir, "tokens.json"), json);
    }

    private static bool TryParseAccount(string line, out object account, out string? jwt, out bool expired)
    {
        account = null!;
        jwt = null;
        expired = false;

        var username = "";
        var password = "";
        var sharedSecret = "";

        // Prefer colon format when ':' appears before any '.' (username:password:...:jwt)
        // Otherwise username.JWT (dots only inside the token)
        var colon = line.IndexOf(':');
        var dot = line.IndexOf('.');
        if (colon > 0 && (dot < 0 || colon < dot))
        {
            var parts = line.Split(':');
            if (parts.Length < 2) return false;

            username = parts[0];
            password = parts[1];
            if (parts.Length >= 3) sharedSecret = parts[2];

            jwt = parts.FirstOrDefault(p => p.StartsWith("eyA", StringComparison.Ordinal) && p.Split('.').Length == 3);
            if (string.IsNullOrEmpty(jwt)) return false;
            if (TryDecodeJwtPayload(jwt, out var expUnix) &&
                expUnix.HasValue &&
                DateTimeOffset.FromUnixTimeSeconds(expUnix.Value) < DateTimeOffset.UtcNow)
            {
                expired = true;
                return false;
            }
        }
        else if (dot > 0)
        {
            username = line[..dot];
            jwt = line[(dot + 1)..];
            if (jwt.Split('.').Length != 3) return false;

            if (TryDecodeJwtPayload(jwt, out var expUnix) &&
                expUnix.HasValue &&
                DateTimeOffset.FromUnixTimeSeconds(expUnix.Value) < DateTimeOffset.UtcNow)
            {
                expired = true;
                return false;
            }
        }
        else
        {
            return false;
        }

        account = new
        {
            username,
            password,
            sharedSecret,
            refreshToken = jwt ?? "",
            nickname = username
        };
        return true;
    }

    private static bool TryDecodeJwtPayload(string jwt, out long? expUnix)
    {
        expUnix = null;
        try
        {
            var payload = jwt.Split('.')[1];
            payload = payload.Replace('-', '+').Replace('_', '/');
            switch (payload.Length % 4)
            {
                case 2: payload += "=="; break;
                case 3: payload += "="; break;
            }
            var bytes = Convert.FromBase64String(payload);
            var json = Encoding.UTF8.GetString(bytes);
            var doc = JsonDocument.Parse(json);

            if (doc.RootElement.TryGetProperty("exp", out var expEl))
            {
                expUnix = expEl.GetInt64();
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    public string GetWorkDir() => _workDir;
    public string GetAccountsFilePath() => ResolveAccountsTxtPath() ?? Path.Combine(_workDir, "accounts.txt");
    public string GetValidTokensFilePath() => Path.Combine(_workDir, "validtokens.txt");
    public string GetTokensFilePath() => Path.Combine(_workDir, "tokens.json");

    /// <summary>
    /// Rebuild tokens.json strictly from accounts.txt before starting the bot.
    /// </summary>
    public bool EnsureTokensFile()
    {
        var (total, valid, _, _) = LoadAccounts();
        return valid > 0 || total == 0;
    }

    public int CountValidTokensFile()
    {
        var tokPath = GetTokensFilePath();
        if (!File.Exists(tokPath)) return 0;
        try
        {
            var json = File.ReadAllText(tokPath);
            var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("accounts", out var arr) ? arr.GetArrayLength() : 0;
        }
        catch { return 0; }
    }
}
