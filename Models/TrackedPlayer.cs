namespace GtagBotUI.Models;

public class TrackedPlayer
{
    public string PlayerName { get; init; } = "";
    public string Room { get; init; } = "";
    public string Region { get; init; } = "";
    public List<string> Cosmetics { get; init; } = new();
    public DateTime TrackedAt { get; init; } = DateTime.Now;
}
