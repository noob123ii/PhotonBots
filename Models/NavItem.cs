namespace GtagBotUI.Models;

public enum AppSection { Dashboard, BotControl, Log, Settings }

public record NavItem(AppSection Section, string Title, string Glyph);
