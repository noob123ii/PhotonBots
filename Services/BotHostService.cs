using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using GtagBotUI.Models;

namespace GtagBotUI.Services;

public partial class BotHostService : IDisposable
{
    private Process? _process;
    private Process? _scanProcess;
    private Process? _checkProcess;
    private readonly string _nodePath;
    private readonly string _scriptPath;
    private readonly string _workDir;

    public event Action<LogEntry>? OnLogEntry;
    public event Action<bool>? OnStatusChanged;
    public event Action<TrackedPlayer>? OnTrackedPlayer;
    public event Action<int, int>? OnBanCheckProgress;
    public event Action<int, int>? OnBanCheckCompleted;
    public event Action<string, int, int, int, int, int, int, int, int>? OnBanCheckLive; // (currentAcc, done, total, unbanned, banned, failed, proxyAlive, proxyTotal, rate)

    public bool IsRunning => _process is { HasExited: false };
    public bool IsScanRunning => _scanProcess is { HasExited: false };
    public bool IsCheckRunning => _checkProcess is { HasExited: false };

    public BotHostService()
    {
        _workDir = ResolveRootDir();
        _nodePath = FindNode();
        _scriptPath = Path.Combine(_workDir, "node", "index.js");

        EmitLog("info", $"WorkDir: {_workDir}");
        EmitLog("info", $"Node: {_nodePath}");
        EmitLog("info", $"Script: {_scriptPath}");
        EmitLog("info", $"Script exists: {File.Exists(_scriptPath)}");
        var pkg = Path.Combine(_workDir, "package.json");
        EmitLog("info", $"package.json exists: {File.Exists(pkg)}");
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
            if (File.Exists(Path.Combine(dir, "node", "index.js")))
                return dir;
        }
        return Environment.CurrentDirectory;
    }

    private static string FindNode()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var p = Process.Start(psi);
            if (p != null)
            {
                var ver = p.StandardOutput.ReadToEnd().Trim();
                if (ver.StartsWith('v'))
                    return "node";
            }
        }
        catch { }

        var commonPaths = new[]
        {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "fnm", "node-versions", "latest", "node.exe"),
        };
        foreach (var p in commonPaths.Where(File.Exists))
            return p;
        return "node";
    }

    public async Task StartAsync(string roomName, string nickname, int botCount,
        string followTarget = "", string region = "eu/*", string soundFile = "",
        string customEvent = "", double soundVolume = 0.7, bool orbitFollow = true,
        string moveMode = "orbit")
    {
        if (IsRunning)
        {
            EmitLog("warn", "Bot is already running");
            return;
        }

        // Previous GUI sessions / crashes leave node bots holding Photon UserIds
        var orphans = KillOrphanBotProcesses(exceptPid: null);
        if (orphans > 0)
            EmitLog("warn", $"Killed {orphans} leftover bot process(es) before start");

        if (!File.Exists(_scriptPath))
        {
            EmitLog("error", $"Script not found: {_scriptPath}");
            EmitLog("error", "Make sure node/index.js exists in the GtagBotUI directory");
            return;
        }

        if (!await CheckNode()) return;

        try
        {
            var vol = Math.Clamp(soundVolume, 0.05, 2.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
            var mode = string.IsNullOrWhiteSpace(moveMode) ? (orbitFollow ? "orbit" : "stick") : moveMode.Trim().ToLowerInvariant();
            var args = $"\"{_scriptPath}\" --room \"{roomName}\" --nick \"{nickname}\" --count {botCount}";
            args += $" --region \"{region}\"";
            args += $" --volume {vol}";
            args += $" --move {mode}";
            if (!string.IsNullOrEmpty(followTarget))
                args += $" --follow \"{followTarget}\"";
            if (!string.IsNullOrEmpty(soundFile))
                args += $" --sound \"{soundFile}\"";
            if (!string.IsNullOrEmpty(customEvent))
                args += $" --event \"{customEvent}\"";

            var psi = new ProcessStartInfo(_nodePath, args)
            {
                WorkingDirectory = _workDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
            };

            _process = Process.Start(psi);
            if (_process == null)
            {
                EmitLog("error", "Failed to start bot process");
                return;
            }

            _process.EnableRaisingEvents = true;
            _process.OutputDataReceived += (_, e) => OnOutput(e.Data);
            _process.ErrorDataReceived += (_, e) => { if (e.Data != null) EmitLog("error", e.Data); };
            _process.Exited += (_, _) =>
            {
                EmitLog("warn", $"Bot process exited (code: {_process?.ExitCode})");
                _process = null;
                OnStatusChanged?.Invoke(false);
            };

            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
            OnStatusChanged?.Invoke(true);
            EmitLog("info", $"Bot started (move={mode})");
        }
        catch (Exception ex)
        {
            EmitLog("error", $"Failed to start bot: {ex.Message}");
            _process = null;
        }
    }

    /// <summary>Send a live JSON command to the running bot (move/follow/enable).</summary>
    public bool SendCommand(object payload)
    {
        if (_process is not { HasExited: false }) return false;
        try
        {
            var json = System.Text.Json.JsonSerializer.Serialize(payload);
            _process.StandardInput.WriteLine(json);
            _process.StandardInput.Flush();
            return true;
        }
        catch (Exception ex)
        {
            EmitLog("warn", $"Live command failed: {ex.Message}");
            return false;
        }
    }

    public bool SendMoveMode(string mode) =>
        SendCommand(new { cmd = "move", mode });

    public bool SendFollowTarget(string target) =>
        SendCommand(new { cmd = "follow", target });

    public bool SendMoveEnabled(bool enabled) =>
        SendCommand(new { cmd = "enable", enabled });

    public bool SendSound(string path, double volume = 0.8) =>
        SendCommand(new { cmd = "sound", path, volume });

    public bool SendSoundStop() =>
        SendCommand(new { cmd = "sound", stop = true });

    public bool SendSoundVolume(double volume) =>
        SendCommand(new { cmd = "volume", volume });

    public async Task StartTrackAsync(string region = "eu/*", string nickname = "Tracker", string followTarget = "")
    {
        if (IsScanRunning)
        {
            EmitLog("warn", "Scanner is already running");
            return;
        }

        try
        {
            var args = $"\"{_scriptPath}\" --track --region \"{region}\" --nick \"{nickname}\"";
            if (!string.IsNullOrEmpty(followTarget))
                args += $" --follow \"{followTarget}\"";

            var psi = new ProcessStartInfo(_nodePath, args)
            {
                WorkingDirectory = _workDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
            };

            _scanProcess = Process.Start(psi);
            if (_scanProcess == null)
            {
                EmitLog("error", "Failed to start tracker");
                return;
            }

            _scanProcess.OutputDataReceived += (_, e) => OnOutput(e.Data);
            _scanProcess.ErrorDataReceived += (_, e) => { if (e.Data != null) EmitLog("error", "[TRACK] " + e.Data); };
            _scanProcess.Exited += (_, _) =>
            {
                EmitLog("warn", $"Tracker exited (code: {_scanProcess?.ExitCode})");
                _scanProcess = null;
            };

            _scanProcess.BeginOutputReadLine();
            _scanProcess.BeginErrorReadLine();
            EmitLog("info", "Tracker started (1 bot scanning public rooms for cosmetics)");
        }
        catch (Exception ex)
        {
            EmitLog("error", $"Failed to start tracker: {ex.Message}");
            _scanProcess = null;
        }
    }

    public void StartScan(string region = "eu/*", string nickname = "Scanner", string followTarget = "")
    {
        if (IsScanRunning)
        {
            EmitLog("warn", "Scanner is already running");
            return;
        }

        try
        {
            var args = $"\"{_scriptPath}\" --scan --region \"{region}\" --nick \"{nickname}\"";
            if (!string.IsNullOrEmpty(followTarget))
                args += $" --follow \"{followTarget}\"";

            var psi = new ProcessStartInfo(_nodePath, args)
            {
                WorkingDirectory = _workDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
            };

            _scanProcess = Process.Start(psi);
            if (_scanProcess == null)
            {
                EmitLog("error", "Failed to start scanner");
                return;
            }

            _scanProcess.OutputDataReceived += (_, e) => OnOutput(e.Data);
            _scanProcess.ErrorDataReceived += (_, e) => { if (e.Data != null) EmitLog("error", "[SCAN] " + e.Data); };
            _scanProcess.Exited += (_, _) =>
            {
                EmitLog("warn", $"Scanner exited (code: {_scanProcess?.ExitCode})");
                _scanProcess = null;
            };

            _scanProcess.BeginOutputReadLine();
            _scanProcess.BeginErrorReadLine();
            EmitLog("info", "Scanner started (1 bot joining random public room)");
        }
        catch (Exception ex)
        {
            EmitLog("error", $"Failed to start scanner: {ex.Message}");
            _scanProcess = null;
        }
    }

    private void OnOutput(string? data)
    {
        if (data == null) return;

        if (ParseTrackLine(data, out var tracked))
        {
            EmitLog("track", $"[TRACK] {tracked.PlayerName} — {string.Join(", ", tracked.Cosmetics)} in \"{tracked.Room}\" ({tracked.Region})");
            OnTrackedPlayer?.Invoke(tracked);
            return;
        }

        if (data.Contains("[SCAN]") || data.Contains("[TRACK]") || data.Contains("[SCANNER]"))
        {
            EmitLog("info", data);
        }
        else
        {
            EmitLog("info", data);
        }
    }

    private static readonly Regex TrackPattern = TrackRegex();

    [GeneratedRegex(@"\[TRACK\]\s*player:\s*(.+?)\s*\|\s*room:\s*(.+?)\s*\|\s*region:\s*(.+?)\s*\|\s*cosmetics:\s*(.+)", RegexOptions.IgnoreCase)]
    private static partial Regex TrackRegex();

    private static bool ParseTrackLine(string line, out TrackedPlayer player)
    {
        player = null!;
        var m = TrackPattern.Match(line);
        if (!m.Success) return false;

        player = new TrackedPlayer
        {
            PlayerName = m.Groups[1].Value.Trim(),
            Room = m.Groups[2].Value.Trim(),
            Region = m.Groups[3].Value.Trim(),
            Cosmetics = m.Groups[4].Value.Split(',').Select(s => s.Trim()).ToList(),
            TrackedAt = DateTime.Now
        };
        return true;
    }

    public void Stop()
    {
        if (_process is { HasExited: false })
        {
            // Ask bot to Leave Photon rooms cleanly first (avoids ghost UserIds)
            try
            {
                _process.StandardInput.WriteLine("{\"cmd\":\"quit\"}");
                _process.StandardInput.Flush();
                if (_process.WaitForExit(2500))
                {
                    _process = null;
                    KillOrphanBotProcesses(exceptPid: null);
                    OnStatusChanged?.Invoke(false);
                    EmitLog("info", "Bot stopped");
                    StopScan();
                    StopCheck();
                    return;
                }
            }
            catch { }

            try
            {
                var proc = _process;
                if (proc is { HasExited: false })
                {
                    try { proc.Kill(entireProcessTree: true); } catch { try { proc.Kill(); } catch { } }
                    try { proc.WaitForExit(2000); } catch { }
                }
            }
            catch { }
            _process = null;
        }

        var orphans = KillOrphanBotProcesses(exceptPid: null);
        if (orphans > 0)
            EmitLog("warn", $"Killed {orphans} leftover bot process(es)");

        if (_scanProcess is { HasExited: false })
        {
            try { _scanProcess.Kill(entireProcessTree: true); } catch { try { _scanProcess.Kill(); } catch { } }
            _scanProcess = null;
        }

        StopCheck();

        OnStatusChanged?.Invoke(false);
        EmitLog("info", "Bot stopped");
    }

    /// <summary>
    /// Kill any node processes still running this project's index.js (orphans from
    /// previous GUI sessions that still hold Photon seats).
    /// </summary>
    private int KillOrphanBotProcesses(int? exceptPid)
    {
        var killed = 0;
        try
        {
            var needle = Path.GetFullPath(_scriptPath).Replace('/', '\\');
            var escaped = needle.Replace("'", "''");
            var psi = new ProcessStartInfo("powershell",
                "-NoProfile -Command \"" +
                "$n='" + escaped + "'; " +
                "Get-CimInstance Win32_Process -Filter \\\"Name = 'node.exe'\\\" | " +
                "Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/','\\\\') -like ('*'+$n+'*') } | " +
                "ForEach-Object { " +
                (exceptPid is int keep ? $"if ($_.ProcessId -eq {keep}) {{ return }}; " : "") +
                "try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output $_.ProcessId } catch {} }\"")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            if (p == null) return 0;
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            killed = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Length;
        }
        catch { }
        return killed;
    }

    public void StopScan()
    {
        if (_scanProcess is { HasExited: false })
        {
            try { _scanProcess.Kill(); } catch { }
            _scanProcess = null;
            EmitLog("info", "Scanner stopped");
        }
    }

    public async Task StartCheckBansAsync()
    {
        if (IsCheckRunning)
        {
            EmitLog("warn", "Ban check is already running");
            return;
        }

        if (!File.Exists(_scriptPath))
        {
            EmitLog("error", $"Script not found: {_scriptPath}");
            return;
        }

        if (!await CheckNode()) return;

        try
        {
            var args = $"\"{_scriptPath}\" --check-bans";
            var psi = new ProcessStartInfo(_nodePath, args)
            {
                WorkingDirectory = _workDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
            };

            _checkProcess = Process.Start(psi);
            if (_checkProcess == null)
            {
                EmitLog("error", "Failed to start ban check process");
                return;
            }

            _checkProcess.OutputDataReceived += (_, e) => OnCheckOutput(e.Data);
            _checkProcess.ErrorDataReceived += (_, e) => { if (e.Data != null) EmitLog("error", "[CHECK] " + e.Data); };
            _checkProcess.Exited += (_, _) =>
            {
                EmitLog("info", $"Ban check exited (code: {_checkProcess?.ExitCode})");
                _checkProcess = null;
                ParseCheckResult();
            };

            _checkProcess.BeginOutputReadLine();
            _checkProcess.BeginErrorReadLine();
            EmitLog("info", "Ban check started — verifying accounts with Mothership auth...");
        }
        catch (Exception ex)
        {
            EmitLog("error", $"Failed to start ban check: {ex.Message}");
            _checkProcess = null;
        }
    }

    public void StopCheck()
    {
        if (_checkProcess is { HasExited: false })
        {
            try { _checkProcess.Kill(); } catch { }
            _checkProcess = null;
            EmitLog("info", "Ban check stopped");
        }
    }

    private async Task<bool> CheckNode()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var p = Process.Start(psi);
            if (p == null)
            {
                EmitLog("error", "Node.js is not installed or not in PATH");
                return false;
            }
            var ver = await p.StandardOutput.ReadToEndAsync();
            if (!ver.StartsWith('v'))
            {
                EmitLog("error", $"Node.js check failed: '{ver}'");
                return false;
            }
            EmitLog("info", $"Node.js version: {ver.Trim()}");
            return true;
        }
        catch (Exception ex)
        {
            EmitLog("error", $"Node.js check failed: {ex.Message}");
            return false;
        }
    }

    private static readonly Regex CheckProgressPattern = CheckProgressRegex();
    private static readonly Regex CheckCompletePattern = CheckCompleteRegex();
    private static readonly Regex CheckIgnoredPattern = CheckIgnoredRegex();
    private static readonly Regex CheckModePattern = CheckModeRegex();
    private static readonly Regex CheckStatusPattern = CheckStatusRegex();
    private static readonly Regex CheckProxyPattern = CheckProxyRegex();

    private int _checkDone, _checkTotal, _checkUnbanned, _checkBanned, _checkFailed, _checkInvalid;
    private int _checkProxyAlive, _checkProxyTotal;
    private string _checkCurrent = "";

    [GeneratedRegex(@"\[CHECK\]\s*(.+?):\s*(OK|BANNED|FAILED|INVALID)\s*\((\d+)/(\d+)\)", RegexOptions.IgnoreCase)]
    private static partial Regex CheckProgressRegex();

    [GeneratedRegex(@"CHECK-BANS COMPLETE:\s*(\d+)\s*unbanned,\s*(\d+)\s*banned,\s*(\d+)\s*failed", RegexOptions.IgnoreCase)]
    private static partial Regex CheckCompleteRegex();

    [GeneratedRegex(@"IGNORED:\s*(.+)", RegexOptions.IgnoreCase)]
    private static partial Regex CheckIgnoredRegex();

    [GeneratedRegex(@"CHECK-BANS MODE:\s*(\d+)\s*unique accounts,\s*(\d+)/(\d+)\s*proxies", RegexOptions.IgnoreCase)]
    private static partial Regex CheckModeRegex();

    [GeneratedRegex(@"\[CHECK\]\s*status:\s*(\d+)/(\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex CheckStatusRegex();

    [GeneratedRegex(@"proxies:\s*(\d+)/(\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex CheckProxyRegex();

    private void OnCheckOutput(string? data)
    {
        if (data == null) return;

        // Track total and proxies from mode header
        var modeM = CheckModePattern.Match(data);
        if (modeM.Success)
        {
            _checkTotal = int.Parse(modeM.Groups[1].Value);
            _checkProxyAlive = int.Parse(modeM.Groups[2].Value);
            _checkProxyTotal = int.Parse(modeM.Groups[3].Value);
        }

        // Track progress per account
        var m = CheckProgressPattern.Match(data);
        if (m.Success)
        {
            _checkDone = int.Parse(m.Groups[3].Value);
            _checkTotal = int.Parse(m.Groups[4].Value);
            _checkCurrent = m.Groups[1].Value;
            var status = m.Groups[2].Value;
            if (status == "OK") _checkUnbanned++;
            else if (status == "BANNED") _checkBanned++;
            else _checkFailed++;
            OnBanCheckProgress?.Invoke(_checkDone, _checkTotal);
        }

        // Update proxy counts from any line containing proxy info
        var pm = CheckProxyPattern.Match(data);
        if (pm.Success)
        {
            _checkProxyAlive = int.Parse(pm.Groups[1].Value);
            _checkProxyTotal = int.Parse(pm.Groups[2].Value);
        }

        // Parse complete line with failed count
        var cm = CheckCompletePattern.Match(data);
        if (cm.Success)
        {
            _checkUnbanned = int.Parse(cm.Groups[1].Value);
            _checkBanned = int.Parse(cm.Groups[2].Value);
            _checkFailed = int.Parse(cm.Groups[3].Value);
        }

        // Track ignored/invalid
        var ig = CheckIgnoredPattern.Match(data);
        if (ig.Success)
        {
            _checkDone++;
            _checkInvalid++;
            OnBanCheckProgress?.Invoke(_checkDone, _checkTotal);
        }

        // Fire live status
        OnBanCheckLive?.Invoke(_checkCurrent, _checkDone, _checkTotal, _checkUnbanned, _checkBanned, _checkFailed, _checkProxyAlive, _checkProxyTotal, 0);

        EmitLog("info", data);
    }

    private void ParseCheckResult()
    {
        var unbannedPath = Path.Combine(_workDir, "unbanned.json");
        var bannedPath = Path.Combine(_workDir, "banned.json");

        var unbanned = 0;
        var banned = 0;
        if (File.Exists(unbannedPath))
        {
            try
            {
                var json = File.ReadAllText(unbannedPath);
                var doc = System.Text.Json.JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("accounts", out var arr))
                    unbanned = arr.GetArrayLength();
            }
            catch { }
        }
        if (File.Exists(bannedPath))
        {
            try
            {
                var json = File.ReadAllText(bannedPath);
                var doc = System.Text.Json.JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("accounts", out var arr))
                    banned = arr.GetArrayLength();
            }
            catch { }
        }

        _checkUnbanned = unbanned;
        _checkBanned = banned;
        OnBanCheckCompleted?.Invoke(unbanned, banned);
    }

    private void EmitLog(string level, string msg)
    {
        OnLogEntry?.Invoke(new LogEntry
        {
            Timestamp = DateTime.Now.ToString("HH:mm:ss.fff"),
            Message = msg,
            Level = level switch { "error" => 2, "warn" => 1, _ => 0 }
        });
    }

    public void Dispose()
    {
        Stop();
        _process?.Dispose();
        _scanProcess?.Dispose();
        _checkProcess?.Dispose();
    }
}
