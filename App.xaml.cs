using System.Windows;
using GtagBotUI.ViewModels;
using GtagBotUI.Views;

namespace GtagBotUI;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        var vm = new MainViewModel();

        var main = new MainWindow { DataContext = vm };
        main.Show();

        var hud = new HudWindow { DataContext = vm };
        hud.Show();
    }
}
