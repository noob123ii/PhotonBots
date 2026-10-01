using System.Windows;

namespace GtagBotUI.Services;

public static class ThemeManager
{
    public static string CurrentTheme { get; private set; } = "ThemeDeepBlue";

    public static void ApplyTheme(string themeName)
    {
        var uri = new Uri($"Themes/{themeName}.xaml", UriKind.Relative);
        var dict = new ResourceDictionary { Source = uri };

        var dicts = Application.Current.Resources.MergedDictionaries;

        var old = dicts.FirstOrDefault(d => d.Source is not null &&
            d.Source.OriginalString.StartsWith("Themes/Theme"));
        if (old is not null)
            dicts.Remove(old);

        dicts.Insert(0, dict);
        CurrentTheme = themeName;
    }
}
