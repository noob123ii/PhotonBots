namespace GtagBotUI.Models;

public class LogEntry
{
    public string Timestamp { get; set; } = "";
    public string Message { get; set; } = "";
    public int Level { get; set; } // 0=info, 1=warn, 2=error
    public int Count { get; set; } = 1;
}
