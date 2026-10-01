using System.Collections.Specialized;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using GtagBotUI.Models;
using GtagBotUI.ViewModels;

namespace GtagBotUI.Views;

public partial class MainWindow : Window
{
    private readonly MainViewModel _vm;

    public MainWindow()
    {
        InitializeComponent();

        Icon = BitmapFrame.Create(
            new Uri("pack://application:,,,/Resources/Isreal.png"),
            BitmapCreateOptions.DelayCreation, BitmapCacheOption.OnLoad);

        _vm = new MainViewModel();
        DataContext = _vm;

        _vm.LogEntries.CollectionChanged += OnLogCollectionChanged;
    }

    private void OnLogCollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.Action == NotifyCollectionChangedAction.Add && LogList.Items.Count > 0)
        {
            LogList.ScrollIntoView(LogList.Items[^1]);
        }
    }

    private void TitleBar_OnMouseLeftButtonDown(object _, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        else
            DragMove();
    }

    private void MinimizeClick(object _, RoutedEventArgs _2) => WindowState = WindowState.Minimized;
    private void CloseClick(object _, RoutedEventArgs _2) => Close();

    protected override void OnClosed(EventArgs e)
    {
        base.OnClosed(e);
        foreach (Window w in Application.Current.Windows)
        {
            if (w != this) w.Close();
        }
    }

    private void IncrementBotCount(object _, RoutedEventArgs _2) => _vm.IncrementBotCount();
    private void DecrementBotCount(object _, RoutedEventArgs _2) => _vm.DecrementBotCount();

    private void BrowseSound(object _, RoutedEventArgs _2)
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Filter = "Audio files (*.mp3;*.mp4;*.wav)|*.mp3;*.mp4;*.wav|All files (*.*)|*.*",
            InitialDirectory = _vm.SoundFolderPath
        };
        if (dlg.ShowDialog() == true)
        {
            _vm.SoundFilePath = dlg.FileName;
        }
    }

    private void PreviewSound(object _, RoutedEventArgs _2)
    {
        _vm.TogglePreview();
    }
}
