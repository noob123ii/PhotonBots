using System.Globalization;
using System.Windows.Data;
using System.Windows.Media;
using GtagBotUI.Models;

namespace GtagBotUI.Converters;

public class SectionToIconConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is AppSection section)
        {
            var data = section switch
            {
                AppSection.Dashboard => "M2,3 L7,3 L7,8 L2,8 Z M9,3 L14,3 L14,8 L9,8 Z M2,10 L7,10 L7,15 L2,15 Z M9,10 L14,10 L14,15 L9,15 Z",
                AppSection.BotControl => "M3,2 L14,9 L3,16 Z",
                AppSection.Log => "M2,13 L6,13 L6,9 L2,9 Z M7,13 L11,13 L11,5 L7,5 Z M12,13 L16,13 L16,2 L12,2 Z",
                AppSection.Settings => "M2,5 L6,5 M4,3 L4,7 M8,9 L12,9 M10,7 L10,11 M14,13 L18,13 M16,11 L16,15",
                _ => ""
            };
            return Geometry.Parse(data);
        }
        return Geometry.Parse("");
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}
