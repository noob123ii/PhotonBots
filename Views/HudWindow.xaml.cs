using System.Windows;
using System.Windows.Interop;

namespace GtagBotUI.Views;

public partial class HudWindow : Window
{
    private const int ScreenWidth = 1920;

    public HudWindow()
    {
        InitializeComponent();

        SourceInitialized += OnSourceInitialized;
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var left = (SystemParameters.PrimaryScreenWidth - Width) / 2;
        Top = 0;
        Left = left;
    }
}
