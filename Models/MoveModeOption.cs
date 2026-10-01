using CommunityToolkit.Mvvm.ComponentModel;

namespace GtagBotUI.Models;

public partial class MoveModeOption : ObservableObject
{
    public string Id { get; }
    public string Label { get; }
    public string Description { get; }

    [ObservableProperty] private bool _isSelected;

    public MoveModeOption(string id, string label, string description, bool selected = false)
    {
        Id = id;
        Label = label;
        Description = description;
        _isSelected = selected;
    }
}
