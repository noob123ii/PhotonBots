using System.Globalization;
using System.Windows;
using System.Windows.Data;
using GtagBotUI.Models;

namespace GtagBotUI.Converters;

public class SectionToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is AppSection current && parameter is string sectStr &&
            Enum.TryParse<AppSection>(sectStr, out var target))
            return current == target ? Visibility.Visible : Visibility.Collapsed;
        return Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) =>
        throw new NotImplementedException();
}