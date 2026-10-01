using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using WpfShape = System.Windows.Shapes.Shape;

namespace GtagBotUI.Controls;

public enum BackgroundEffect
{
    None, Sakura, Leaves, Rain, Snow, Stars, Bubbles, Fireflies, Confetti
}

    public enum ParticleShape
{
    Circle, Line, Diamond, Square
}

public class ParticleOverlay : Canvas
{
    private readonly List<Particle> _particles = new();
    private BackgroundEffect _effect = BackgroundEffect.None;
    private long _frame;
    private bool _attached;

    public new static readonly DependencyProperty EffectProperty =
        DependencyProperty.Register(nameof(Effect), typeof(BackgroundEffect), typeof(ParticleOverlay),
            new PropertyMetadata(BackgroundEffect.None, OnEffectChanged));

    public new BackgroundEffect Effect
    {
        get => (BackgroundEffect)GetValue(EffectProperty);
        set => SetValue(EffectProperty, value);
    }

    private static void OnEffectChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        ((ParticleOverlay)d).ApplyEffect((BackgroundEffect)e.NewValue);
    }

    private void ApplyEffect(BackgroundEffect effect)
    {
        if (_attached) { CompositionTarget.Rendering -= OnRendering; _attached = false; }
        _particles.Clear();
        Children.Clear();
        _effect = effect;
        _frame = 0;

        if (effect == BackgroundEffect.None) return;

        var cfg = GetEffectConfig(effect);
        var r = new Random();
        double w = 0, h = 0;
        Dispatcher.Invoke(() => { w = ActualWidth > 0 ? ActualWidth : 1200; h = ActualHeight > 0 ? ActualHeight : 800; });

        for (int i = 0; i < cfg.Count; i++)
        {
            var x = r.NextDouble() * w;
            var y = r.NextDouble() * h;
            _particles.Add(CreateParticle(cfg, r, x, y));
        }

        CompositionTarget.Rendering += OnRendering;
        _attached = true;
    }

    private record EffectConfig(int Count, double SpeedMin, double SpeedMax, double SizeMin, double SizeMax,
        Color C1, Color C2, bool Rotate, bool Sway, bool Glow, bool Fast, ParticleShape ParticleShape);

    private static EffectConfig GetEffectConfig(BackgroundEffect e) => e switch
    {
        BackgroundEffect.Sakura => new(30, 0.3, 0.7, 6, 10, Color.FromRgb(255, 182, 193), Color.FromRgb(255, 105, 180), true, true, false, false, ParticleShape.Diamond),
        BackgroundEffect.Leaves => new(25, 0.2, 0.6, 7, 12, Color.FromRgb(144, 238, 144), Color.FromRgb(34, 139, 34), true, true, false, false, ParticleShape.Diamond),
        BackgroundEffect.Rain => new(80, 4.0, 8.0, 1, 2, Color.FromRgb(150, 180, 220), Color.FromRgb(200, 220, 255), false, false, false, true, ParticleShape.Line),
        BackgroundEffect.Snow => new(50, 0.3, 1.0, 3, 7, Color.FromRgb(220, 230, 240), Color.FromRgb(255, 255, 255), false, true, true, false, ParticleShape.Circle),
        BackgroundEffect.Stars => new(40, 0.05, 0.2, 1, 3, Color.FromRgb(255, 255, 200), Color.FromRgb(200, 220, 255), false, false, true, false, ParticleShape.Circle),
        BackgroundEffect.Bubbles => new(18, 0.2, 0.5, 10, 22, Color.FromRgb(180, 220, 255), Color.FromRgb(255, 255, 255), false, true, true, false, ParticleShape.Circle),
        BackgroundEffect.Fireflies => new(25, 0.1, 0.3, 3, 6, Color.FromRgb(200, 255, 100), Color.FromRgb(255, 255, 150), false, true, true, false, ParticleShape.Circle),
        BackgroundEffect.Confetti => new(40, 1.0, 2.5, 4, 8, Color.FromRgb(255, 80, 80), Color.FromRgb(80, 200, 255), true, true, false, false, ParticleShape.Square),
        _ => new(0, 0, 0, 0, 0, Colors.Transparent, Colors.Transparent, false, false, false, false, ParticleShape.Circle)
    };

    private sealed class Particle
    {
        public WpfShape Shape = null!;
        public TranslateTransform Pos = new();
        public RotateTransform? Rot;
        public double Vx, Vy, SwayPhase, SwayAmp, MaxLife, Opacity;
        public long Life;
        public double BaseX, BaseY;
    }



    private Particle CreateParticle(EffectConfig cfg, Random r, double x, double y)
    {
        var size = cfg.SizeMin + r.NextDouble() * (cfg.SizeMax - cfg.SizeMin);
        var speed = cfg.SpeedMin + r.NextDouble() * (cfg.SpeedMax - cfg.SpeedMin);
        var t = r.NextDouble();
        var cr = (byte)(cfg.C1.R + (cfg.C2.R - cfg.C1.R) * t);
        var cg = (byte)(cfg.C1.G + (cfg.C2.G - cfg.C1.G) * t);
        var cb = (byte)(cfg.C1.B + (cfg.C2.B - cfg.C1.B) * t);
        var color = Color.FromRgb(cr, cg, cb);
        var brush = new SolidColorBrush(color);

        WpfShape shape = cfg.ParticleShape switch
        {
            ParticleShape.Circle => new Ellipse
            {
                Width = size, Height = size, Fill = brush,
                Opacity = cfg.Glow ? 0.65 : 0.4
            },
            ParticleShape.Line => new Rectangle
            {
                Width = 1.5, Height = size * 5, Fill = brush,
                Opacity = 0.3, RadiusX = 0.5, RadiusY = 0.5
            },
            ParticleShape.Diamond => new Rectangle
            {
                Width = size, Height = size, Fill = brush,
                Opacity = 0.5, RenderTransform = new RotateTransform(45, size / 2, size / 2)
            },
            _ => new Rectangle
            {
                Width = size * 1.2, Height = size * 1.2, Fill = brush,
                Opacity = 0.55, RadiusX = 1, RadiusY = 1
            }
        };

        if (cfg.Glow)
            shape.Effect = new DropShadowEffect { BlurRadius = 8, ShadowDepth = 0, Opacity = 0.5, Color = color };

        var tForm = new TranslateTransform(x, y);
        shape.RenderTransform = tForm;

        RotateTransform? rot = cfg.Rotate ? new RotateTransform(0, size * 0.75, size * 0.6) : null;
        if (rot != null)
        {
            var grp = new TransformGroup();
            grp.Children.Add(tForm);
            grp.Children.Add(rot);
            shape.RenderTransform = grp;
        }

        Children.Add(shape);

        return new Particle
        {
            Shape = shape, Pos = tForm, Rot = rot,
            BaseX = x, BaseY = y,
            Vx = (r.NextDouble() - 0.5) * (cfg.Sway ? 0.4 : 0),
            Vy = speed * (0.5 + r.NextDouble() * 0.5),
            SwayPhase = r.NextDouble() * Math.PI * 2,
            SwayAmp = cfg.Sway ? 0.4 + r.NextDouble() * 0.6 : 0,
            MaxLife = 400 + r.NextDouble() * 300,
            Opacity = cfg.Glow ? 0.65 : 0.4
        };
    }

    private void OnRendering(object? sender, EventArgs e)
    {
        if (_effect == BackgroundEffect.None) return;
        _frame++;

        var cfg = GetEffectConfig(_effect);
        double w = 0, h = 0;
        try { w = ActualWidth > 0 ? ActualWidth : 1200; h = ActualHeight > 0 ? ActualHeight : 800; }
        catch { w = 1200; h = 800; }

        var recycle = new List<Particle>();

        for (int i = 0; i < _particles.Count; i++)
        {
            var p = _particles[i];
            p.Life++;
            p.BaseX += p.Vx + Math.Sin(p.SwayPhase + p.Life * 0.025) * p.SwayAmp;
            p.BaseY += p.Vy * (cfg.Fast ? (_frame % 2 == 0 ? 2.0 : 1.0) : 1.0);
            if (p.Rot != null) p.Rot.Angle += (p.Life * 0.3 + p.SwayPhase) % 6 - 3;

            if (p.BaseY > h + 40 || p.BaseX < -40 || p.BaseX > w + 40 || p.Life > p.MaxLife)
            {
                recycle.Add(p);
                continue;
            }

            p.Pos.X = p.BaseX;
            p.Pos.Y = p.BaseY;

            var fade = p.Life < 25 ? p.Life / 25.0 :
                       p.Life > p.MaxLife - 25 ? (p.MaxLife - p.Life) / 25.0 : 1.0;
            p.Shape.Opacity = fade * p.Opacity;
        }

        if (recycle.Count > 0)
        {
            var r = new Random();
            double rw = 0, rh = 0;
            try { rw = ActualWidth > 0 ? ActualWidth : 1200; rh = ActualHeight > 0 ? ActualHeight : 800; }
            catch { rw = 1200; rh = 800; }

            foreach (var p in recycle)
            {
                Children.Remove(p.Shape);
                _particles.Remove(p);
                var np = CreateParticle(cfg, r, r.NextDouble() * rw, -r.NextDouble() * 40 - 20);
                _particles.Add(np);
            }
        }
    }
}
