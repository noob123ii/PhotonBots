namespace GtagBotUI.Models;

public class AccountEntry
{
    public string Username { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public bool IsValid { get; set; }
    public string Status { get; set; } = "Pending";
}