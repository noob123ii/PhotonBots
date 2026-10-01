using System.Collections.ObjectModel;
using System.IO;
using System.Timers;
using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GtagBotUI.Controls;
using GtagBotUI.Models;
using GtagBotUI.Services;
using Timer = System.Timers.Timer;
using MediaPlayer = System.Windows.Media.MediaPlayer;

namespace GtagBotUI.ViewModels;

public partial class MainViewModel : ObservableObject
{
    private readonly BotHostService _bot = new();
    private readonly AccountVerifier _accounts = new();

    [ObservableProperty] private AppSection _selectedSection = AppSection.Dashboard;
    [ObservableProperty] private bool _isRunning;
    [ObservableProperty] private bool _isScanRunning;
    [ObservableProperty] private string _statusText = "Idle";
    [ObservableProperty] private string _roomName = "";
    [ObservableProperty] private string _nickname = "Sigma";
    [ObservableProperty] private int _botCount = 1;
    [ObservableProperty] private string _followTarget = "";
    [ObservableProperty] private bool _canStart = true;
    [ObservableProperty] private int _logCount;
    [ObservableProperty] private int _activeBotCount;
    [ObservableProperty] private string _sessionTime = "00:00:00";
    [ObservableProperty] private bool _autoConnect;

    // Dashboard metrics
    [ObservableProperty] private int _totalAccounts;
    [ObservableProperty] private int _validAccounts;
    [ObservableProperty] private string _dashboardStatus = "Idle";
    [ObservableProperty] private string _dashboardRoom = "\u2014";

    // Bot control extended
    [ObservableProperty] private string _selectedRegion = "EU";
    [ObservableProperty] private bool _playSound;
    [ObservableProperty] private string _soundFileName = "";
    [ObservableProperty] private string _soundFilePath = "";
    [ObservableProperty] private string _selectedSound = "";
    [ObservableProperty] private string _soundFolderPath = "";
    [ObservableProperty] private double _soundVolume = 0.8;
    [ObservableProperty] private bool _isPreviewPlaying;
    [ObservableProperty] private bool _enableFollow;
    [ObservableProperty] private bool _enableOrbit = true;
    [ObservableProperty] private string _selectedMoveMode = "Orbit";
    [ObservableProperty] private string _moveModeDescription = "Tap chips to stack movement modes (averaged). Some combos get wild.";
    [ObservableProperty] private bool _enableCustomEvent;
    [ObservableProperty] private string _customEventCode = "";
    [ObservableProperty] private bool _joinRandomPublic;
    [ObservableProperty] private string _botCountText = "1";

    // Theme
    [ObservableProperty] private string _selectedTheme = "Slate";

    // Settings
    [ObservableProperty] private string _webhookUrl = "";
    [ObservableProperty] private string _minDelayText = "1000";
    [ObservableProperty] private string _maxDelayText = "3000";

    // Background effects
    [ObservableProperty] private string _selectedBackgroundEffectName = "None";
    [ObservableProperty] private BackgroundEffect _selectedBackgroundEffect;

    partial void OnSelectedBackgroundEffectNameChanged(string value)
    {
        SelectedBackgroundEffect = value switch
        {
            "Sakura Petals" => BackgroundEffect.Sakura,
            "Leaves" => BackgroundEffect.Leaves,
            "Rain" => BackgroundEffect.Rain,
            "Snow" => BackgroundEffect.Snow,
            "Stars" => BackgroundEffect.Stars,
            "Bubbles" => BackgroundEffect.Bubbles,
            "Fireflies" => BackgroundEffect.Fireflies,
            "Confetti" => BackgroundEffect.Confetti,
            _ => BackgroundEffect.None
        };
    }

    // Tracking
    [ObservableProperty] private int _totalTracks;
    [ObservableProperty] private string _hudBotsText = "0";
    [ObservableProperty] private string _hudTracksText = "0";

    // Proxy
    [ObservableProperty] private int _proxyCount;

    // Ban checking
    [ObservableProperty] private bool _isCheckRunning;
    [ObservableProperty] private bool _hasCheckedResults;
    [ObservableProperty] private int _banCheckProgress;
    [ObservableProperty] private int _banCheckProgressMax = 1;
    [ObservableProperty] private int _unbannedAccounts;
    [ObservableProperty] private int _bannedAccounts;
    [ObservableProperty] private int _invalidAccounts;
    [ObservableProperty] private int _failedAccounts;
    [ObservableProperty] private string _checkCurrent = "";
    [ObservableProperty] private double _checkPercent;
    [ObservableProperty] private int _checkProxyAlive;
    [ObservableProperty] private int _checkProxyTotal;


    // Session timer
    private readonly Timer _sessionTimer = new(1000);
    private DateTime _sessionStart;

    // Region display for HUD
    [ObservableProperty] private string _hudRegionText = "—";

    private readonly MediaPlayer _previewPlayer = new();

    public ObservableCollection<string> AvailableSounds { get; } = new();

    partial void OnSelectedSoundChanged(string value)
    {
        SoundFileName = value;
        if (string.IsNullOrEmpty(value))
        {
            SoundFilePath = "";
            return;
        }
        var path = Path.Combine(SoundFolderPath, value);
        if (File.Exists(path))
        {
            SoundFilePath = path;
            if (IsRunning && PlaySound) PushLiveSound();
        }
    }

    partial void OnPlaySoundChanged(bool value)
    {
        if (!value) StopPreview();
        if (IsRunning) PushLiveSound();
    }

    public void RefreshSounds()
    {
        AvailableSounds.Clear();
        if (string.IsNullOrEmpty(SoundFolderPath) || !Directory.Exists(SoundFolderPath)) return;
        foreach (var f in Directory.GetFiles(SoundFolderPath, "*.*")
                     .Where(f => f.EndsWith(".mp3", StringComparison.OrdinalIgnoreCase)
                              || f.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)
                              || f.EndsWith(".wav", StringComparison.OrdinalIgnoreCase)))
        {
            AvailableSounds.Add(Path.GetFileName(f));
        }
    }

    partial void OnSoundFilePathChanged(string value)
    {
        if (!string.IsNullOrEmpty(value) && File.Exists(value) && string.IsNullOrEmpty(SelectedSound))
            SelectedSound = Path.GetFileName(value);
    }

    public void TogglePreview()
    {
        if (IsPreviewPlaying) { StopPreview(); return; }
        PlayPreview();
    }

    private void PlayPreview()
    {
        if (string.IsNullOrEmpty(SoundFilePath) || !File.Exists(SoundFilePath)) return;
        try
        {
            _previewPlayer.Open(new Uri(SoundFilePath));
            _previewPlayer.Volume = SoundVolume;
            _previewPlayer.MediaEnded += (_, _) => { IsPreviewPlaying = false; };
            _previewPlayer.Play();
            IsPreviewPlaying = true;
        }
        catch { }
    }

    private void StopPreview()
    {
        try { _previewPlayer.Stop(); _previewPlayer.Close(); } catch { }
        IsPreviewPlaying = false;
    }

    partial void OnSoundVolumeChanged(double value)
    {
        _previewPlayer.Volume = value;
        if (IsRunning && PlaySound && !string.IsNullOrEmpty(SoundFilePath) && File.Exists(SoundFilePath))
            _bot.SendSound(SoundFilePath, value);
    }

    public ObservableCollection<NavItem> NavItems { get; } = new()
    {
        new(AppSection.Dashboard, "Dashboard", "\uE80F"),
        new(AppSection.BotControl, "Bot Control", "\uE768"),
        new(AppSection.Log, "Activity", "\uE77B"),
        new(AppSection.Settings, "Settings", "\uE713"),
    };

    public ObservableCollection<string> Regions { get; } = new()
    {
        "EU", "US East", "US West", "US", "Asia"
    };

    public ObservableCollection<string> ThemeNames { get; } = new()
    {
        "Deep Blue", "Midnight", "Slate"
    };

    public ObservableCollection<string> BackgroundEffectNames { get; } = new()
    {
        "None", "Sakura Petals", "Leaves", "Rain", "Snow", "Stars", "Bubbles", "Fireflies", "Confetti"
    };

    public ObservableCollection<MoveModeOption> MoveModeOptions { get; } = new()
    {
        new("orbit", "Orbit", "Even circle around the target.", true),
        new("hover", "Hover", "Line in front with shared up/down bob."),
        new("cycle", "Cycle", "Rotate focus through other players."),
        new("scar", "Scar", "Dash into face, then yank away."),
        new("stick", "Stick", "Static ring glued beside target."),
        new("swarm", "Swarm", "Tight swirling cluster."),
        new("figure8", "Figure-8", "Figure-8 path around target."),
        new("spiral", "Spiral", "Circle with pulsing radius."),
        new("train", "Train", "Line stacked behind target."),
        new("mirror", "Mirror", "Opposite-side mirror fan."),
        new("cock", "Cock", "Low & close in front: balls, shaft forward, head at tip."),
        new("bounce", "Bounce", "Orbit with hopping height."),
        new("zigzag", "Zigzag", "Weave left-right while circling."),
        new("halo", "Halo", "High circle above the head."),
        new("wave", "Wave", "Front line with rolling sine height."),
        new("box", "Box", "March around a square path."),
        new("tornado", "Tornado", "Rising tight spiral."),
        new("pendulum", "Pendulum", "Swing side-to-side in front."),
        new("helix", "Helix", "Vertical helix around target."),
        new("scatter", "Scatter", "Jittery ring around target."),
        new("kiss", "Kiss", "One bot: front → ease in to touch → pull back; faces player (own pose)."),
        new("cage", "Cage", "Box corners/edges around player."),
        new("flower", "Flower", "Petals expand and contract."),
        new("bob", "Bob", "Stick ring with vertical bob only."),
    };

    // Kept for any legacy bindings
    public ObservableCollection<string> MoveModes { get; } = new()
    {
        "Orbit", "Hover", "Cycle Players", "Scar", "Stick", "Swarm", "Figure-8", "Spiral", "Train", "Mirror", "Cock"
    };

    public ObservableCollection<LogEntry> LogEntries { get; } = new();

    public MainViewModel()
    {
        SoundFolderPath = Path.Combine(_accounts.GetWorkDir(), "voice", "soundboard");
        RefreshSounds();

        LoadAccounts();
        LoadProxies();
        HookMoveModeOptions();
        RefreshMoveModeDescription();

        _sessionTimer.Elapsed += (_, _) =>
        {
            if (!IsRunning) return;
            var elapsed = DateTime.Now - _sessionStart;
            System.Windows.Application.Current.Dispatcher.Invoke(() =>
                SessionTime = elapsed.ToString(@"hh\:mm\:ss"));
        };

        _bot.OnLogEntry += entry =>
        {
            System.Windows.Application.Current.Dispatcher.Invoke(() =>
            {
                var last = LogEntries.LastOrDefault();
                if (last != null && last.Message == entry.Message && last.Level == entry.Level)
                {
                    last.Count++;
                    last.Timestamp = entry.Timestamp;
                }
                else
                {
                    LogEntries.Add(entry);
                    if (LogEntries.Count > 2000) LogEntries.RemoveAt(0);
                }
                LogCount = LogEntries.Count;
            });
        };
        _bot.OnStatusChanged += running =>
        {
            System.Windows.Application.Current.Dispatcher.Invoke(() =>
            {
                IsRunning = running;
                StatusText = running ? "Running" : "Idle";
                DashboardStatus = running ? "Running" : "Idle";
                CanStart = !running;
                HudBotsText = running ? BotCount.ToString() : "0";
                if (!running) SessionTime = "00:00:00";
            });
        };
        _bot.OnTrackedPlayer += player =>
        {
            System.Windows.Application.Current.Dispatcher.Invoke(() =>
            {
                TotalTracks++;
                HudTracksText = TotalTracks.ToString();
            });
        };
        _bot.OnBanCheckProgress += (done, total) =>
        {
            System.Windows.Application.Current.Dispatcher.Invoke(() =>
            {
                BanCheckProgress = done;
                BanCheckProgressMax = total;
            });
        };
        _bot.OnBanCheckLive += (acc, done, total, unbanned, banned, failed, proxyAlive, proxyTotal, rate) =>
        {
            System.Windows.Application.Current.Dispatcher.Invoke(() =>
            {
                CheckCurrent = acc;
                BanCheckProgress = done;
                BanCheckProgressMax = total;
                UnbannedAccounts = unbanned;
                BannedAccounts = banned;
                FailedAccounts = failed;
                CheckProxyAlive = proxyAlive;
                CheckProxyTotal = proxyTotal;
                CheckPercent = total > 0 ? Math.Round((double)done / total * 100, 1) : 0;
            });
        };

        _bot.OnBanCheckCompleted += (unbanned, banned) =>
        {
            System.Windows.Application.Current.Dispatcher.Invoke(() =>
            {
                IsCheckRunning = false;
                HasCheckedResults = true;
                UnbannedAccounts = unbanned;
                BannedAccounts = banned;
                CheckPercent = 100;
                StatusText = $"Bans checked: {unbanned} unbanned, {banned} banned, {FailedAccounts} failed";
                EmitLog("info", $"Ban check complete: {unbanned} unbanned, {banned} banned, {FailedAccounts} failed");
            });
        };
    }

    partial void OnSelectedThemeChanged(string value)
    {
        var name = value switch
        {
            "Midnight" => "ThemeMidnight",
            "Deep Blue" => "ThemeDeepBlue",
            _ => "ThemeSlate"
        };
        ThemeManager.ApplyTheme(name);
    }

    partial void OnBotCountChanged(int value)
    {
        HudBotsText = IsRunning ? value.ToString() : "0";
    }

    private void LoadAccounts()
    {
        var (total, valid, expired, invalid) = _accounts.LoadAccounts();
        TotalAccounts = total;
        ValidAccounts = valid;
    }

    public void RefreshAccounts()
    {
        LoadAccounts();
    }

    private void LoadProxies()
    {
        var proxyPath = Path.Combine(_accounts.GetWorkDir(), "src", "proxies.js");
        if (File.Exists(proxyPath))
        {
            try
            {
                var content = File.ReadAllText(proxyPath);
                // Count lines that look like proxy entries (start with http://, https://, socks5://)
                var matches = System.Text.RegularExpressions.Regex.Matches(content, @"https?://|socks5://");
                ProxyCount = matches.Count;
            }
            catch { ProxyCount = 0; }
        }
        else
        {
            ProxyCount = 0;
        }
    }

    [RelayCommand]
    private void VerifyAccounts()
    {
        var (total, valid, expired, invalid) = _accounts.LoadAccounts();
        TotalAccounts = total;
        ValidAccounts = valid;
        StatusText = $"Verified: {valid} valid / {total} total → tokens.json";
        EmitLog("info", $"accounts.txt → tokens.json: {valid} working ({expired} expired, {invalid} invalid of {total})");
    }

    [RelayCommand]
    private async Task CheckBans()
    {
        if (IsCheckRunning) return;

        // Ensure tokens.json is fresh from the latest verification
        var (total, valid, expired, invalid) = _accounts.LoadAccounts();
        TotalAccounts = total;
        ValidAccounts = valid;
        _accounts.EnsureTokensFile();
        EmitLog("info", $"Accounts verified: {valid} valid / {total} total");

        IsCheckRunning = true;
        HasCheckedResults = false;
        BanCheckProgress = 0;
        BanCheckProgressMax = ValidAccounts > 0 ? ValidAccounts : TotalAccounts;
        UnbannedAccounts = 0;
        BannedAccounts = 0;
        InvalidAccounts = 0;
        CheckCurrent = "";
        CheckPercent = 0;
        EmitLog("info", "Starting ban check (Steam + Mothership auth for each account)...");
        await _bot.StartCheckBansAsync();
    }

    [RelayCommand]
    private void StopCheckBans()
    {
        _bot.StopCheck();
        IsCheckRunning = false;
        HasCheckedResults = true;
        EmitLog("info", "Ban check stopped by user");
    }

    [RelayCommand]
    private async Task StartBot()
    {
        if (IsRunning) return;

        if (!int.TryParse(BotCountText, out var count) || count < 1) count = 1;
        BotCount = count;

        // Rebuild tokens.json strictly from accounts.txt (no extras)
        _accounts.EnsureTokensFile();
        ValidAccounts = _accounts.CountValidTokensFile();
        TotalAccounts = ValidAccounts;
        if (ValidAccounts < 1)
        {
            EmitLog("error", "No working accounts in accounts.txt — add username.JWT lines first");
            StatusText = "No accounts";
            return;
        }
        EmitLog("info", $"Using {ValidAccounts} account(s) from accounts.txt → tokens.json");

        var region = SelectedRegion switch
        {
            "US East" => "us/*",
            "US West" => "usw/*",
            "US" => "us/*",
            "Asia" => "asia/*",
            _ => "eu/*"
        };

        var sound = PlaySound ? SoundFilePath : "";
        // Always pass follow text if set; movement starts whenever EnableFollow (or Cycle)
        var follow = (FollowTarget ?? "").Trim();
        var customEvent = EnableCustomEvent ? CustomEventCode : "";
        var moveMode = BuildMoveModeString();
        if (!EnableFollow && !moveMode.Contains("cycle"))
            moveMode = "none";

        await _bot.StartAsync(RoomName, Nickname, count, follow, region, sound, customEvent, SoundVolume, EnableOrbit, moveMode);
        ActiveBotCount = count;
        DashboardRoom = RoomName;
        _sessionStart = DateTime.Now;
        _sessionTimer.Start();
    }

    private void HookMoveModeOptions()
    {
        foreach (var opt in MoveModeOptions)
            opt.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName != nameof(MoveModeOption.IsSelected)) return;
                // Allow clearing all modes → freeze in place
                RefreshMoveModeDescription();
                PushLiveMove();
            };
    }

    private string BuildMoveModeString()
    {
        var ids = MoveModeOptions.Where(m => m.IsSelected).Select(m => m.Id).ToList();
        if (ids.Count == 0)
        {
            SelectedMoveMode = "(Frozen)";
            return "none";
        }
        SelectedMoveMode = string.Join(" + ", MoveModeOptions.Where(m => m.IsSelected).Select(m => m.Label));
        return string.Join("+", ids);
    }

    private void RefreshMoveModeDescription()
    {
        var selected = MoveModeOptions.Where(m => m.IsSelected).ToList();
        if (selected.Count == 0)
        {
            MoveModeDescription = "No modes selected — bots freeze in place. Tap a chip to move again.";
            return;
        }
        if (selected.Count == 1)
        {
            MoveModeDescription = selected[0].Description;
            return;
        }
        MoveModeDescription = $"Blending {selected.Count} modes ({string.Join(" + ", selected.Select(s => s.Label))}). Positions are averaged — wild combos welcome.";
    }

    private void PushLiveMove()
    {
        if (!IsRunning) return;
        var mode = BuildMoveModeString();
        if (!EnableFollow)
        {
            _bot.SendMoveEnabled(false);
            EmitLog("info", "Live: movement paused");
            return;
        }
        _bot.SendMoveEnabled(true);
        _bot.SendMoveMode(mode);
        _bot.SendFollowTarget((FollowTarget ?? "").Trim());
        EmitLog("info", mode == "none"
            ? "Live: frozen (no modes)"
            : $"Live: mode={mode} follow={(string.IsNullOrWhiteSpace(FollowTarget) ? "(auto)" : FollowTarget)}");
    }

    private void PushLiveSound()
    {
        if (!IsRunning) return;
        if (!PlaySound)
        {
            _bot.SendSoundStop();
            EmitLog("info", "Live: sound stopped");
            return;
        }
        if (string.IsNullOrEmpty(SoundFilePath) || !File.Exists(SoundFilePath))
        {
            EmitLog("warn", "Live: no sound file selected");
            return;
        }
        _bot.SendSound(SoundFilePath, SoundVolume);
        EmitLog("info", $"Live: sound → {Path.GetFileName(SoundFilePath)}");
    }

    partial void OnFollowTargetChanged(string value) => PushLiveMove();
    partial void OnEnableFollowChanged(bool value) => PushLiveMove();

    [RelayCommand]
    private void StopBot()
    {
        _bot.Stop();
        ActiveBotCount = 0;
        DashboardRoom = "\u2014";
    }

    [RelayCommand]
    private void StartScan()
    {
        if (IsScanRunning)
        {
            _bot.StopScan();
            IsScanRunning = false;
            return;
        }

        var region = SelectedRegion switch
        {
            "US East" => "us/*",
            "US West" => "usw/*",
            "US" => "us/*",
            "Asia" => "asia/*",
            _ => "eu/*"
        };

        _ = _bot.StartTrackAsync(region, Nickname, EnableFollow ? FollowTarget : "");
        IsScanRunning = true;
    }

    [RelayCommand]
    private void ClearLog()
    {
        LogEntries.Clear();
        LogCount = 0;
    }

    [RelayCommand]
    private void CopyLog()
    {
        var text = string.Join(Environment.NewLine, LogEntries
            .OrderBy(e => e.Timestamp)
            .Select(e => $"[{e.Timestamp}] {e.Message}"));
        if (string.IsNullOrEmpty(text))
        {
            EmitLog("info", "Nothing to copy");
            return;
        }
        try
        {
            System.Windows.Clipboard.SetText(text);
            EmitLog("info", $"Copied {LogCount} log entries to clipboard");
        }
        catch (Exception ex)
        {
            EmitLog("error", $"Failed to copy: {ex.Message}");
        }
    }

    public void IncrementBotCount()
    {
        if (int.TryParse(BotCountText, out var c)) BotCountText = (c + 1).ToString();
        else BotCountText = "1";
    }

    public void DecrementBotCount()
    {
        if (int.TryParse(BotCountText, out var c) && c > 1) BotCountText = (c - 1).ToString();
        else BotCountText = "1";
    }

    private void EmitLog(string level, string msg)
    {
        System.Windows.Application.Current.Dispatcher.Invoke(() =>
        {
            var last = LogEntries.LastOrDefault();
            var lvl = level switch { "error" => 2, "warn" => 1, _ => 0 };
            if (last != null && last.Message == msg && last.Level == lvl)
            {
                last.Count++;
                last.Timestamp = DateTime.Now.ToString("HH:mm:ss.fff");
            }
            else
            {
                LogEntries.Add(new LogEntry
                {
                    Timestamp = DateTime.Now.ToString("HH:mm:ss.fff"),
                    Message = msg,
                    Level = lvl
                });
                if (LogEntries.Count > 2000) LogEntries.RemoveAt(0);
            }
            LogCount = LogEntries.Count;
        });
    }
}
