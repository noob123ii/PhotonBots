using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace GtagBotUI.Converters;

public class IntGreaterThanZeroToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is int i)
        {
            var min = 0;
            if (parameter is string s && int.TryParse(s, out var p))
                min = p;
            return i > min ? Visibility.Visible : Visibility.Collapsed;
        }
        return Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) =>
        throw new NotImplementedException();
}
