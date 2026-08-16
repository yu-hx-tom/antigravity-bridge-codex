using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace AntigravityDesktopClient
{
    public class ModelPickerControl : Border
    {
        private TextBlock txtDisplay;
        private TextBlock arrow;
        private Popup popup;
        private Border popupBorder;
        private StackPanel popupList;
        public string SelectedModelId { get; private set; }
        public event Action<string> ModelSelected;

        private bool isDark = false;
        private System.Windows.Media.Color ColPrimary { get { return isDark ? System.Windows.Media.Color.FromRgb(56, 189, 248) : System.Windows.Media.Color.FromRgb(37, 99, 235); } }
        private System.Windows.Media.Color ColPrimaryLight { get { return isDark ? System.Windows.Media.Color.FromRgb(30, 58, 95) : System.Windows.Media.Color.FromRgb(239, 246, 255); } }
        private System.Windows.Media.Color ColBorder { get { return isDark ? System.Windows.Media.Color.FromRgb(45, 59, 83) : System.Windows.Media.Color.FromRgb(226, 232, 240); } }
        private System.Windows.Media.Color ColBg { get { return isDark ? System.Windows.Media.Color.FromRgb(21, 29, 46) : System.Windows.Media.Color.FromRgb(255, 255, 255); } }
        private System.Windows.Media.Color ColTextMain { get { return isDark ? System.Windows.Media.Color.FromRgb(248, 250, 252) : System.Windows.Media.Color.FromRgb(15, 23, 42); } }

        private List<KeyValuePair<string, string>> cachedModels = new List<KeyValuePair<string, string>>();
        private string cachedModelHash = "";

        public ModelPickerControl()
        {
            ApplyThemeStyles();
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);

            Grid grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            txtDisplay = new TextBlock
            {
                Text = "Gemini 3.7 Flash",
                FontSize = 13,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(ColPrimary),
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(txtDisplay, 0);
            grid.Children.Add(txtDisplay);

            arrow = new TextBlock
            {
                Text = "▾",
                FontSize = 14,
                Foreground = new SolidColorBrush(ColPrimary),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(8, 0, 0, 0)
            };
            Grid.SetColumn(arrow, 1);
            grid.Children.Add(arrow);

            Child = grid;

            popup = new Popup
            {
                PlacementTarget = this,
                Placement = PlacementMode.Bottom,
                StaysOpen = false,
                AllowsTransparency = true
            };

            popupBorder = new Border
            {
                Background = new SolidColorBrush(ColBg),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(6),
                Width = 270,
                Margin = new Thickness(0, 4, 0, 0),
                Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 20, Opacity = 0.2, ShadowDepth = 4 }
            };

            popupList = new StackPanel();
            popupBorder.Child = popupList;
            popup.Child = popupBorder;

            MouseLeftButtonUp += (s, e) =>
            {
                popup.IsOpen = !popup.IsOpen;
            };
        }

        public void SetTheme(bool darkMode)
        {
            isDark = darkMode;
            ApplyThemeStyles();
            cachedModelHash = "";
            if (cachedModels.Count > 0) SetModels(cachedModels, SelectedModelId);
        }

        public void ApplyThemeStyles()
        {
            Background = new SolidColorBrush(ColBg);
            BorderBrush = new SolidColorBrush(ColPrimary);
            BorderThickness = new Thickness(1.5);
            CornerRadius = new CornerRadius(8);
            Padding = new Thickness(14, 8, 14, 8);
            Cursor = Cursors.Hand;
            Width = 270;

            if (txtDisplay != null) txtDisplay.Foreground = new SolidColorBrush(ColPrimary);
            if (arrow != null) arrow.Foreground = new SolidColorBrush(ColPrimary);
            if (popupBorder != null)
            {
                popupBorder.Background = new SolidColorBrush(ColBg);
                popupBorder.BorderBrush = new SolidColorBrush(ColBorder);
            }
        }

        public void SetModels(List<KeyValuePair<string, string>> models, string currentId)
        {
            SelectedModelId = currentId;
            string newHash = currentId + ":" + models.Count;
            if (newHash == cachedModelHash && popupList.Children.Count > 0)
            {
                foreach (var item in models)
                {
                    if (item.Key == currentId)
                    {
                        txtDisplay.Text = item.Value;
                        break;
                    }
                }
                return;
            }

            cachedModels = models;
            cachedModelHash = newHash;
            popupList.Children.Clear();

            foreach (var item in models)
            {
                string id = item.Key;
                string name = item.Value;
                bool isSelected = (id == currentId);

                if (isSelected) txtDisplay.Text = name;

                Border itemBorder = new Border
                {
                    Background = isSelected ? new SolidColorBrush(ColPrimaryLight) : System.Windows.Media.Brushes.Transparent,
                    CornerRadius = new CornerRadius(6),
                    Padding = new Thickness(10, 8, 10, 8),
                    Margin = new Thickness(0, 1, 0, 1),
                    Cursor = Cursors.Hand
                };

                Grid itemGrid = new Grid();
                itemGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                itemGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                TextBlock txtName = new TextBlock
                {
                    Text = name,
                    FontSize = 12.5,
                    FontWeight = isSelected ? FontWeights.Bold : FontWeights.Normal,
                    Foreground = isSelected ? new SolidColorBrush(ColPrimary) : new SolidColorBrush(ColTextMain)
                };
                Grid.SetColumn(txtName, 0);
                itemGrid.Children.Add(txtName);

                if (isSelected)
                {
                    TextBlock txtCheck = new TextBlock
                    {
                        Text = "✓",
                        FontSize = 13,
                        FontWeight = FontWeights.Bold,
                        Foreground = new SolidColorBrush(ColPrimary)
                    };
                    Grid.SetColumn(txtCheck, 1);
                    itemGrid.Children.Add(txtCheck);
                }

                itemBorder.Child = itemGrid;

                itemBorder.MouseEnter += (s, e) =>
                {
                    itemBorder.Background = new SolidColorBrush(ColPrimaryLight);
                };
                itemBorder.MouseLeave += (s, e) =>
                {
                    itemBorder.Background = (id == SelectedModelId) ? new SolidColorBrush(ColPrimaryLight) : System.Windows.Media.Brushes.Transparent;
                };

                itemBorder.MouseLeftButtonUp += (s, e) =>
                {
                    SelectedModelId = id;
                    txtDisplay.Text = name;
                    popup.IsOpen = false;
                    cachedModelHash = "";
                    if (ModelSelected != null) ModelSelected(id);
                    SetModels(cachedModels, id);
                };

                popupList.Children.Add(itemBorder);
            }
        }
    }

    public class FloatingHudWindow : Window
    {
        private Border pillBorder;
        private Canvas circleCanvas;
        private System.Windows.Shapes.Ellipse quotaTrack;
        private System.Windows.Shapes.Path pathQuotaArc;
        private TextBlock txtQuotaPercent;
        private TextBlock txtTps;
        private TextBlock txtTtft;
        private TextBlock dividerBlock;
        private System.Windows.Shapes.Path iconBolt;
        private System.Windows.Shapes.Path iconTimer;
        private bool isDockedLeft = false;
        private bool isDockedRight = false;
        private bool isDragging = false;
        private bool isDarkTheme = false;
        private double lastTps = 0;
        private int lastTtft = 0;
        private int lastQuota5h = -1;
        private System.Windows.Controls.MenuItem miModelsSubmenu;

        public Action OpenMainWindowAction;
        public Action OpenSettingsAction;
        public Action CloseHudAction;
        public Action<string> SelectModelAction;
        public Action<double, double> PositionChangedAction;

        public FloatingHudWindow()
        {
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            Width = 210;
            Height = 40;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            FontFamily = new System.Windows.Media.FontFamily("Microsoft YaHei UI, Segoe UI, sans-serif");

            pillBorder = new Border
            {
                BorderThickness = new Thickness(1.2),
                CornerRadius = new CornerRadius(20),
                Padding = new Thickness(4, 0, 10, 0),
                Cursor = Cursors.SizeAll
            };

            Grid mainGrid = new Grid();
            mainGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(38) });
            mainGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            // 1. Single 5-Hour Quota Circular Ring (Left)
            circleCanvas = new Canvas
            {
                Width = 34,
                Height = 34,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                ToolTip = "当前生效账号的 5 小时短期可用额度百分比"
            };

            quotaTrack = new System.Windows.Shapes.Ellipse
            {
                Width = 28,
                Height = 28,
                StrokeThickness = 2.2
            };
            Canvas.SetLeft(quotaTrack, 3);
            Canvas.SetTop(quotaTrack, 3);
            circleCanvas.Children.Add(quotaTrack);

            pathQuotaArc = new System.Windows.Shapes.Path
            {
                StrokeThickness = 2.5,
                StrokeLineJoin = PenLineJoin.Round,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round
            };
            circleCanvas.Children.Add(pathQuotaArc);

            txtQuotaPercent = new TextBlock
            {
                Text = "--%",
                FontSize = 8.8,
                FontWeight = FontWeights.Bold,
                Width = 34,
                TextAlignment = TextAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            Canvas.SetLeft(txtQuotaPercent, 0);
            Canvas.SetTop(txtQuotaPercent, 10.5);
            circleCanvas.Children.Add(txtQuotaPercent);

            Grid.SetColumn(circleCanvas, 0);
            mainGrid.Children.Add(circleCanvas);

            // 2. Telemetry Section (Right)
            Grid metricsGrid = new Grid { VerticalAlignment = VerticalAlignment.Center };
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            // TPS Column
            StackPanel spTps = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
            
            iconBolt = new System.Windows.Shapes.Path
            {
                Data = Geometry.Parse("M 4.5 0 L 0.5 6.5 L 4 6.5 L 3 11.5 L 8.5 4.5 L 5 4.5 Z"),
                Fill = new SolidColorBrush(System.Windows.Media.Color.FromRgb(251, 191, 36)),
                Width = 8,
                Height = 11,
                Stretch = Stretch.Uniform,
                Margin = new Thickness(0, 0, 4, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            spTps.Children.Add(iconBolt);

            txtTps = new TextBlock
            {
                Text = "-- t/s",
                FontSize = 11,
                FontWeight = FontWeights.Bold,
                VerticalAlignment = VerticalAlignment.Center
            };
            spTps.Children.Add(txtTps);
            Grid.SetColumn(spTps, 0);
            metricsGrid.Children.Add(spTps);

            // Divider
            dividerBlock = new TextBlock
            {
                Text = "|",
                FontSize = 9.5,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(3, 0, 3, 0)
            };
            Grid.SetColumn(dividerBlock, 1);
            metricsGrid.Children.Add(dividerBlock);

            // TTFT Column
            StackPanel spTtft = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
            
            iconTimer = new System.Windows.Shapes.Path
            {
                Data = Geometry.Parse("M 4 0 L 7 0 L 7 1.2 L 4 1.2 Z M 5.5 1.8 C 2.5 1.8 0 4.3 0 7.3 C 0 10.3 2.5 12.8 5.5 12.8 C 8.5 12.8 11 10.3 11 7.3 C 11 4.3 8.5 1.8 5.5 1.8 Z M 5.5 3 C 7.9 3 9.8 4.9 9.8 7.3 C 9.8 9.7 7.9 11.6 5.5 11.6 C 3.1 11.6 1.2 9.7 1.2 7.3 C 1.2 4.9 3.1 3 5.5 3 Z M 4.8 4.2 L 4.8 7.5 L 7.5 8.8 L 8 7.7 L 6 6.7 L 6 4.2 Z"),
                Fill = new SolidColorBrush(System.Windows.Media.Color.FromRgb(52, 211, 153)),
                Width = 9,
                Height = 11,
                Stretch = Stretch.Uniform,
                Margin = new Thickness(0, 0, 4, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            spTtft.Children.Add(iconTimer);

            txtTtft = new TextBlock
            {
                Text = "-- ms",
                FontSize = 11,
                FontWeight = FontWeights.Bold,
                VerticalAlignment = VerticalAlignment.Center
            };
            spTtft.Children.Add(txtTtft);
            Grid.SetColumn(spTtft, 2);
            metricsGrid.Children.Add(spTtft);

            Grid.SetColumn(metricsGrid, 1);
            mainGrid.Children.Add(metricsGrid);

            pillBorder.Child = mainGrid;
            Content = pillBorder;

            ApplyTheme(false);

            // Events
            MouseLeftButtonDown += (s, e) =>
            {
                if (e.ButtonState == MouseButtonState.Pressed)
                {
                    isDragging = true;
                    BeginAnimation(Window.LeftProperty, null);
                    BeginAnimation(Window.OpacityProperty, null);
                    Opacity = 1.0;

                    try
                    {
                        DragMove();
                    }
                    catch { }
                    finally
                    {
                        isDragging = false;
                    }

                    CheckDocking();
                    if (PositionChangedAction != null) PositionChangedAction(Left, Top);
                }
            };

            MouseDoubleClick += (s, e) =>
            {
                if (OpenMainWindowAction != null) OpenMainWindowAction();
            };

            MouseEnter += (s, e) =>
            {
                if (isDragging) return;
                double screenW = SystemParameters.WorkArea.Width;
                double screenLeft = SystemParameters.WorkArea.Left;

                if (isDockedLeft)
                {
                    AnimateLeft(screenLeft);
                    AnimateOpacity(1.0);
                }
                else if (isDockedRight)
                {
                    AnimateLeft(screenLeft + screenW - Width);
                    AnimateOpacity(1.0);
                }
                else
                {
                    AnimateOpacity(1.0);
                }
            };

            MouseLeave += (s, e) =>
            {
                if (isDragging) return;
                double screenW = SystemParameters.WorkArea.Width;
                double screenLeft = SystemParameters.WorkArea.Left;

                if (isDockedLeft)
                {
                    AnimateLeft(screenLeft - (Width - 18));
                    AnimateOpacity(0.55);
                }
                else if (isDockedRight)
                {
                    AnimateLeft(screenLeft + screenW - 18);
                    AnimateOpacity(0.55);
                }
            };

            // Context Menu
            System.Windows.Controls.ContextMenu cm = new System.Windows.Controls.ContextMenu();
            System.Windows.Controls.MenuItem miOpen = new System.Windows.Controls.MenuItem { Header = "🌟 打开主界面" };
            miOpen.Click += (s, e) => { if (OpenMainWindowAction != null) OpenMainWindowAction(); };
            cm.Items.Add(miOpen);

            miModelsSubmenu = new System.Windows.Controls.MenuItem { Header = "🤖 快速切换模型" };
            cm.Items.Add(miModelsSubmenu);

            System.Windows.Controls.MenuItem miSet = new System.Windows.Controls.MenuItem { Header = "⚙️ 偏好设置" };
            miSet.Click += (s, e) => { if (OpenSettingsAction != null) OpenSettingsAction(); };
            cm.Items.Add(miSet);

            cm.Items.Add(new System.Windows.Controls.Separator());

            System.Windows.Controls.MenuItem miClose = new System.Windows.Controls.MenuItem { Header = "✕ 关闭悬浮窗" };
            miClose.Click += (s, e) => { if (CloseHudAction != null) CloseHudAction(); };
            cm.Items.Add(miClose);

            ContextMenu = cm;
        }

        public void UpdateModelsMenu(List<KeyValuePair<string, string>> models, string currentModel)
        {
            Dispatcher.Invoke(new Action(() =>
            {
                if (miModelsSubmenu == null) return;
                miModelsSubmenu.Items.Clear();
                if (models == null || models.Count == 0)
                {
                    miModelsSubmenu.Items.Add(new System.Windows.Controls.MenuItem { Header = "（暂无可切模型）", IsEnabled = false });
                    return;
                }
                foreach (var kvp in models)
                {
                    string mId = kvp.Key;
                    string mName = kvp.Value;
                    bool isSel = string.Equals(mId, currentModel, StringComparison.OrdinalIgnoreCase);
                    var item = new System.Windows.Controls.MenuItem
                    {
                        Header = (isSel ? "✓  " : "    ") + mName,
                        FontWeight = isSel ? FontWeights.Bold : FontWeights.Normal,
                        Tag = mId
                    };
                    item.Click += (s, e) =>
                    {
                        if (SelectModelAction != null) SelectModelAction(mId);
                    };
                    miModelsSubmenu.Items.Add(item);
                }
            }));
        }

        private Geometry CreateArcGeometry(double centerX, double centerY, double radius, double startAngle, double endAngle)
        {
            if (endAngle <= startAngle) return new PathGeometry();
            double startRad = (startAngle - 90) * Math.PI / 180.0;
            double endRad = (endAngle - 90) * Math.PI / 180.0;

            System.Windows.Point startPoint = new System.Windows.Point(centerX + radius * Math.Cos(startRad), centerY + radius * Math.Sin(startRad));
            System.Windows.Point endPoint = new System.Windows.Point(centerX + radius * Math.Cos(endRad), centerY + radius * Math.Sin(endRad));

            bool isLargeArc = (endAngle - startAngle) > 180.0;

            PathFigure figure = new PathFigure { StartPoint = startPoint, IsClosed = false };
            figure.Segments.Add(new ArcSegment(endPoint, new System.Windows.Size(radius, radius), 0, isLargeArc, SweepDirection.Clockwise, true));

            PathGeometry geometry = new PathGeometry();
            geometry.Figures.Add(figure);
            return geometry;
        }

        public void ApplyTheme(bool isDark)
        {
            this.isDarkTheme = isDark;
            Dispatcher.Invoke(new Action(() =>
            {
                if (pillBorder != null)
                {
                    if (isDark)
                    {
                        pillBorder.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(235, 15, 23, 42));
                        pillBorder.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(190, 56, 189, 248));
                        pillBorder.Effect = new DropShadowEffect
                        {
                            Color = System.Windows.Media.Color.FromRgb(0, 0, 0),
                            BlurRadius = 16,
                            Opacity = 0.45,
                            ShadowDepth = 2
                        };
                    }
                    else
                    {
                        pillBorder.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(245, 255, 255, 255));
                        pillBorder.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(220, 203, 213, 225));
                        pillBorder.Effect = new DropShadowEffect
                        {
                            Color = System.Windows.Media.Color.FromRgb(15, 23, 42),
                            BlurRadius = 12,
                            Opacity = 0.12,
                            ShadowDepth = 2
                        };
                    }
                }

                if (quotaTrack != null)
                {
                    quotaTrack.Stroke = new SolidColorBrush(isDark ? System.Windows.Media.Color.FromRgb(51, 65, 85) : System.Windows.Media.Color.FromRgb(226, 232, 240));
                }

                if (txtQuotaPercent != null)
                {
                    txtQuotaPercent.Foreground = new SolidColorBrush(isDark ? System.Windows.Media.Color.FromRgb(248, 250, 252) : System.Windows.Media.Color.FromRgb(15, 23, 42));
                }

                if (dividerBlock != null)
                {
                    dividerBlock.Foreground = new SolidColorBrush(isDark ? System.Windows.Media.Color.FromArgb(120, 71, 85, 105) : System.Windows.Media.Color.FromArgb(140, 203, 213, 225));
                }

                if (iconBolt != null)
                {
                    iconBolt.Fill = new SolidColorBrush(isDark ? System.Windows.Media.Color.FromRgb(251, 191, 36) : System.Windows.Media.Color.FromRgb(217, 119, 6));
                }

                if (iconTimer != null)
                {
                    iconTimer.Fill = new SolidColorBrush(isDark ? System.Windows.Media.Color.FromRgb(52, 211, 153) : System.Windows.Media.Color.FromRgb(5, 150, 105));
                }

                UpdateData(lastTps, lastTtft, lastQuota5h);
            }));
        }

        public void CheckDocking()
        {
            if (isDragging) return;

            double screenW = SystemParameters.WorkArea.Width;
            double screenLeft = SystemParameters.WorkArea.Left;
            double currentLeft = Left;

            if (currentLeft <= screenLeft + 20)
            {
                isDockedLeft = true;
                isDockedRight = false;
                BeginAnimation(Window.LeftProperty, null);
                Left = screenLeft;
            }
            else if (currentLeft + Width >= screenLeft + screenW - 20)
            {
                isDockedLeft = false;
                isDockedRight = true;
                BeginAnimation(Window.LeftProperty, null);
                Left = screenLeft + screenW - Width;
            }
            else
            {
                isDockedLeft = false;
                isDockedRight = false;
                BeginAnimation(Window.LeftProperty, null);
                BeginAnimation(Window.OpacityProperty, null);
                Opacity = 1.0;
            }
        }

        private void AnimateLeft(double targetLeft)
        {
            var anim = new System.Windows.Media.Animation.DoubleAnimation
            {
                From = Left,
                To = targetLeft,
                Duration = TimeSpan.FromMilliseconds(180),
                DecelerationRatio = 0.8,
                FillBehavior = System.Windows.Media.Animation.FillBehavior.Stop
            };
            anim.Completed += (s, e) =>
            {
                BeginAnimation(Window.LeftProperty, null);
                Left = targetLeft;
            };
            BeginAnimation(Window.LeftProperty, anim);
        }

        private void AnimateOpacity(double targetOpacity)
        {
            var anim = new System.Windows.Media.Animation.DoubleAnimation
            {
                From = Opacity,
                To = targetOpacity,
                Duration = TimeSpan.FromMilliseconds(180),
                FillBehavior = System.Windows.Media.Animation.FillBehavior.Stop
            };
            anim.Completed += (s, e) =>
            {
                BeginAnimation(Window.OpacityProperty, null);
                Opacity = targetOpacity;
            };
            BeginAnimation(Window.OpacityProperty, anim);
        }

        public void UpdateTelemetry(double tps, int ttft)
        {
            UpdateData(tps, ttft, lastQuota5h);
        }

        public void UpdateData(double tps, int ttft, int quota5h)
        {
            lastTps = tps;
            lastTtft = ttft;
            lastQuota5h = quota5h;

            Dispatcher.Invoke(new Action(() =>
            {
                if (tps > 0)
                {
                    txtTps.Text = string.Format("{0:0.0} t/s", tps);
                    txtTps.Foreground = new SolidColorBrush(isDarkTheme ? System.Windows.Media.Color.FromRgb(56, 189, 248) : System.Windows.Media.Color.FromRgb(37, 99, 235));
                }
                else
                {
                    txtTps.Text = "-- t/s";
                    txtTps.Foreground = new SolidColorBrush(isDarkTheme ? System.Windows.Media.Color.FromRgb(148, 163, 184) : System.Windows.Media.Color.FromRgb(100, 116, 139));
                }

                if (ttft > 0)
                {
                    txtTtft.Text = string.Format("{0} ms", ttft);
                    txtTtft.Foreground = new SolidColorBrush(isDarkTheme ? System.Windows.Media.Color.FromRgb(52, 211, 153) : System.Windows.Media.Color.FromRgb(5, 150, 105));
                }
                else
                {
                    txtTtft.Text = "-- ms";
                    txtTtft.Foreground = new SolidColorBrush(isDarkTheme ? System.Windows.Media.Color.FromRgb(148, 163, 184) : System.Windows.Media.Color.FromRgb(100, 116, 139));
                }

                // Update 5-Hour Quota Single Ring
                if (quota5h >= 0)
                {
                    double hAngle = Math.Min(quota5h, 100) * 359.9 / 100.0;
                    pathQuotaArc.Data = CreateArcGeometry(17, 17, 14, 0, Math.Max(hAngle, 1.0));
                    pathQuotaArc.Stroke = (quota5h >= 50)
                        ? new SolidColorBrush(System.Windows.Media.Color.FromRgb(6, 182, 212)) // Cyan
                        : ((quota5h >= 20)
                            ? new SolidColorBrush(System.Windows.Media.Color.FromRgb(251, 191, 36)) // Amber
                            : new SolidColorBrush(System.Windows.Media.Color.FromRgb(244, 63, 94))); // Rose

                    txtQuotaPercent.Text = quota5h + "%";
                    txtQuotaPercent.FontSize = (quota5h == 100) ? 7.8 : 8.8;
                }
                else
                {
                    pathQuotaArc.Data = null;
                    txtQuotaPercent.Text = "--%";
                    txtQuotaPercent.FontSize = 8.2;
                }
            }));
        }
    }

    public class MainWindow : Window
    {
        private Process nodeProcess;
        private string appDir;
        private string bridgeKey = "";
        private string apiUrl = "http://127.0.0.1:8787/";
        private DispatcherTimer refreshTimer;
        private System.Windows.Forms.NotifyIcon trayIcon;
        private JavaScriptSerializer jsonSerializer = new JavaScriptSerializer();
        private bool isOAuthPolling = false;
        private bool isCoreRunning = false;
        private bool autoRoundRobin = true;
        private string activeAccountId = "";
        private string lastActiveAccountId = "";
        private int lastAlerted5hQuota = 100;

        // UI Controls
        private TextBlock txtTopStatus;
        private System.Windows.Shapes.Ellipse dotTopStatus;
        private Button btnLaunchCodex;
        private Button btnRestore;
        private Button btnToggleCore;
        private Button btnToggleRoundRobin;
        private Button btnRefreshQuota;
        private Button btnToggleTheme;
        private Button btnOpenSettings;
        private ModelPickerControl modelPicker;
        private StackPanel panelAccounts;
        private TextBlock txtCodexStatus;
        private TextBlock txtMetricCore;
        private TextBlock txtMetricAccounts;
        private TextBlock txtMetricThroughput;
        private TextBlock txtMetricLatency;
        private Border badgeMode;
        private TextBlock txtMode;
        private Border toastContainer;
        private TextBlock txtToastMessage;
        private DispatcherTimer toastTimer;

        // Settings Modal Controls & State
        private Border settingsOverlay;
        private CheckBox chkSettingsAutoStart;
        private CheckBox chkSettingsStartMinimized;
        private CheckBox chkSettingsMinimizeOnLaunch;
        private CheckBox chkSettingsFloatingHud;
        private RadioButton rbSettingsCloseTray;
        private RadioButton rbSettingsCloseExit;
        private TextBox txtSettingsPort;
        private TextBox txtSettingsCodexPath;
        private System.Windows.Forms.ToolStripMenuItem trayModelsMenu;
        private System.Windows.Forms.ToolStripMenuItem trayHudMenu;
        private System.Windows.Forms.ContextMenuStrip trayContextMenu;

        // Floating HUD State
        private FloatingHudWindow floatingHud;
        private bool showFloatingHud = false;
        private double floatingHudX = -1;
        private double floatingHudY = -1;

        private bool autoStartBoot = false;
        private bool startMinimized = false;
        private bool minimizeOnCodexLaunch = true;
        private string closeAction = "tray"; // "tray" or "exit"
        private int proxyPort = 8787;
        private string customCodexPath = "";
        private bool isSilentStart = false;

        // Theme Controls
        private Grid rootGrid;
        private Border topBarBorder;
        private Border footerBorder;
        private ScrollViewer mainScroll;

        // Theme State & Dynamic Slate Palette (C# 5 Compatible)
        private bool isDarkMode = false;
        private System.Windows.Media.Color ColBg { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(11, 15, 25) : System.Windows.Media.Color.FromRgb(248, 250, 252); } }
        private System.Windows.Media.Color ColCard { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(21, 29, 46) : System.Windows.Media.Color.FromRgb(255, 255, 255); } }
        private System.Windows.Media.Color ColCardMuted { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(30, 41, 59) : System.Windows.Media.Color.FromRgb(241, 245, 249); } }
        private System.Windows.Media.Color ColBorder { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(45, 59, 83) : System.Windows.Media.Color.FromRgb(226, 232, 240); } }
        private System.Windows.Media.Color ColPrimary { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(56, 189, 248) : System.Windows.Media.Color.FromRgb(37, 99, 235); } }
        private System.Windows.Media.Color ColPrimaryDark { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(2, 132, 199) : System.Windows.Media.Color.FromRgb(29, 78, 216); } }
        private System.Windows.Media.Color ColPrimaryLight { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(30, 58, 95) : System.Windows.Media.Color.FromRgb(239, 246, 255); } }
        private System.Windows.Media.Color ColTextMain { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(248, 250, 252) : System.Windows.Media.Color.FromRgb(15, 23, 42); } }
        private System.Windows.Media.Color ColTextMuted { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(148, 163, 184) : System.Windows.Media.Color.FromRgb(71, 85, 105); } }
        private System.Windows.Media.Color ColGreen { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(52, 211, 153) : System.Windows.Media.Color.FromRgb(16, 185, 129); } }
        private System.Windows.Media.Color ColAmber { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(251, 191, 36) : System.Windows.Media.Color.FromRgb(245, 158, 11); } }
        private System.Windows.Media.Color ColRed { get { return isDarkMode ? System.Windows.Media.Color.FromRgb(248, 113, 113) : System.Windows.Media.Color.FromRgb(239, 68, 68); } }

        private System.Windows.Media.Color GetQuotaColor(int percent)
        {
            if (percent > 50)
            {
                return isDarkMode
                    ? System.Windows.Media.Color.FromRgb(56, 189, 248)   // Sky Blue 400
                    : System.Windows.Media.Color.FromRgb(2, 132, 199);    // Sky Blue 600
            }
            else if (percent > 20)
            {
                return isDarkMode
                    ? System.Windows.Media.Color.FromRgb(251, 191, 36)   // Amber 400
                    : System.Windows.Media.Color.FromRgb(245, 158, 11);   // Amber 500
            }
            else
            {
                return isDarkMode
                    ? System.Windows.Media.Color.FromRgb(248, 113, 113)  // Red 400
                    : System.Windows.Media.Color.FromRgb(239, 68, 68);    // Red 500
            }
        }

        public MainWindow(bool isSilent = false)
        {
            isSilentStart = isSilent;
            appDir = AppDomain.CurrentDomain.BaseDirectory;
            LoadUiPreferences();
            InitializeComponent();
            InitializeTrayAndIcon();
            StartBackendServer();

            refreshTimer = new DispatcherTimer();
            refreshTimer.Interval = TimeSpan.FromSeconds(2.5);
            refreshTimer.Tick += (s, e) => FetchDashboardData();
            refreshTimer.Start();

            if (showFloatingHud)
            {
                ToggleFloatingHud(true);
            }

            if (isSilentStart)
            {
                WindowState = WindowState.Minimized;
                Hide();
            }
        }

        private Bitmap GenerateBrandBitmap(int size)
        {
            Bitmap bmp = new Bitmap(size, size);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.Clear(System.Drawing.Color.Transparent);

                int pad = size >= 64 ? 4 : (size >= 32 ? 2 : 1);
                int r = (int)(size * 0.23f);
                System.Drawing.Rectangle rect = new System.Drawing.Rectangle(pad, pad, size - pad * 2, size - pad * 2);

                // 1. Superellipse Squircle Path
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddArc(rect.X, rect.Y, r * 2, r * 2, 180, 90);
                    path.AddArc(rect.Right - r * 2, rect.Y, r * 2, r * 2, 270, 90);
                    path.AddArc(rect.Right - r * 2, rect.Bottom - r * 2, r * 2, r * 2, 0, 90);
                    path.AddArc(rect.X, rect.Bottom - r * 2, r * 2, r * 2, 90, 90);
                    path.CloseFigure();

                    // 2. Cosmic Dark Slate / Electric Azure Gradient (Depth & Modernity)
                    using (System.Drawing.Drawing2D.LinearGradientBrush bgBrush = new System.Drawing.Drawing2D.LinearGradientBrush(
                        new System.Drawing.Point(0, 0), new System.Drawing.Point(size, size),
                        System.Drawing.Color.FromArgb(11, 19, 43),    // #0B132B Deep Space Navy
                        System.Drawing.Color.FromArgb(29, 78, 216)))   // #1D4ED8 Electric Blue
                    {
                        g.FillPath(bgBrush, path);
                    }

                    // 3. Ambient Top Glow
                    using (System.Drawing.Drawing2D.LinearGradientBrush topGlow = new System.Drawing.Drawing2D.LinearGradientBrush(
                        new System.Drawing.Point(0, 0), new System.Drawing.Point(0, size),
                        System.Drawing.Color.FromArgb(50, 56, 189, 248),  // Sky Blue #38BDF8
                        System.Drawing.Color.FromArgb(0, 11, 19, 43)))
                    {
                        g.FillPath(topGlow, path);
                    }

                    // 4. Subtle Outer Neon Edge
                    float borderW = size >= 64 ? 1.8f : (size >= 32 ? 1.2f : 0.8f);
                    using (System.Drawing.Drawing2D.LinearGradientBrush borderBrush = new System.Drawing.Drawing2D.LinearGradientBrush(
                        new System.Drawing.Point(0, 0), new System.Drawing.Point(size, size),
                        System.Drawing.Color.FromArgb(190, 56, 189, 248),  // Neon Cyan #38BDF8
                        System.Drawing.Color.FromArgb(90, 168, 85, 247)))   // Neon Violet #A855F7
                    using (System.Drawing.Pen borderPen = new System.Drawing.Pen(borderBrush, borderW))
                    {
                        g.DrawPath(borderPen, path);
                    }
                }

                // 5. Artistic Quantum Synapse Bridge Arc (Overarching gravity beam)
                if (size >= 20)
                {
                    float arcW = size >= 128 ? 6.0f : (size >= 64 ? 3.4f : (size >= 32 ? 2.0f : 1.4f));
                    using (System.Drawing.Drawing2D.LinearGradientBrush arcBrush = new System.Drawing.Drawing2D.LinearGradientBrush(
                        new System.Drawing.Point(0, 0), new System.Drawing.Point(size, size),
                        System.Drawing.Color.FromArgb(255, 56, 189, 248),   // Cyan #38BDF8
                        System.Drawing.Color.FromArgb(255, 192, 132, 252))) // Violet #C084FC
                    using (System.Drawing.Pen bridgePen = new System.Drawing.Pen(arcBrush, arcW))
                    {
                        bridgePen.StartCap = LineCap.Round;
                        bridgePen.EndCap = LineCap.Round;
                        g.DrawArc(bridgePen, (int)(size * 0.16), (int)(size * 0.16), (int)(size * 0.68), (int)(size * 0.50), 185, 170);
                    }

                    // Bridge center glowing pulse node
                    if (size >= 32)
                    {
                        int dotSize = Math.Max(3, (int)(size * 0.055f));
                        int dotX = (int)(size * 0.50f) - dotSize / 2;
                        int dotY = (int)(size * 0.16f) - dotSize / 2;
                        using (SolidBrush dotBrush = new SolidBrush(System.Drawing.Color.FromArgb(255, 255, 255)))
                        {
                            g.FillEllipse(dotBrush, dotX, dotY, dotSize, dotSize);
                        }
                    }
                }

                // 6. Stylized "ABC" Typography with Perfect Vertical & Horizontal Centering
                float fontSize;
                if (size <= 16) fontSize = 7.5f;
                else if (size <= 24) fontSize = 10.0f;
                else if (size <= 32) fontSize = 13.0f;
                else if (size <= 48) fontSize = 19.5f;
                else if (size <= 64) fontSize = 26.0f;
                else if (size <= 128) fontSize = 52.0f;
                else fontSize = 104.0f;

                using (Font font = new Font("Segoe UI", fontSize, System.Drawing.FontStyle.Bold, GraphicsUnit.Pixel))
                {
                    StringFormat sf = new StringFormat
                    {
                        Alignment = StringAlignment.Center,
                        LineAlignment = StringAlignment.Center
                    };

                    float yOffset = size >= 32 ? (size * 0.09f) : (size >= 20 ? (size * 0.05f) : 0f);
                    RectangleF textRect = new RectangleF(0, yOffset, size, size);

                    using (SolidBrush textBrush = new SolidBrush(System.Drawing.Color.FromArgb(255, 255, 255)))
                    {
                        g.DrawString("ABC", font, textBrush, textRect, sf);
                    }
                }
            }
            return bmp;
        }

        private void InitializeTrayAndIcon()
        {
            Bitmap bmp32 = GenerateBrandBitmap(32);
            IntPtr hIcon = bmp32.GetHicon();
            System.Drawing.Icon ico = System.Drawing.Icon.FromHandle(hIcon);

            this.Icon = Imaging.CreateBitmapSourceFromHIcon(hIcon, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());

            trayContextMenu = new System.Windows.Forms.ContextMenuStrip();
            trayContextMenu.ShowImageMargin = false;
            trayContextMenu.ShowCheckMargin = false;
            trayContextMenu.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f, System.Drawing.FontStyle.Regular);
            trayContextMenu.Padding = new System.Windows.Forms.Padding(2, 3, 2, 3);

            var itemOpen = new System.Windows.Forms.ToolStripMenuItem("🌟 打开主界面", null, (s, e) => ShowAndActivate()) { Margin = new System.Windows.Forms.Padding(0, 1, 0, 1) };
            itemOpen.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f, System.Drawing.FontStyle.Bold);
            trayContextMenu.Items.Add(itemOpen);

            trayContextMenu.Items.Add(new System.Windows.Forms.ToolStripMenuItem("🚀 启动 Codex", null, (s, e) => LaunchCodexService()) { Margin = new System.Windows.Forms.Padding(0, 1, 0, 1) });
            trayContextMenu.Items.Add(new System.Windows.Forms.ToolStripMenuItem("🛡️ 恢复官方配置", null, (s, e) => RestoreOfficialConfig()) { Margin = new System.Windows.Forms.Padding(0, 1, 0, 1) });
            
            trayModelsMenu = new System.Windows.Forms.ToolStripMenuItem("🤖 快速切换生效模型") { Margin = new System.Windows.Forms.Padding(0, 1, 0, 1) };
            var dropDownMenu = trayModelsMenu.DropDown as System.Windows.Forms.ToolStripDropDownMenu;
            if (dropDownMenu != null)
            {
                dropDownMenu.ShowImageMargin = false;
                dropDownMenu.ShowCheckMargin = false;
            }
            trayModelsMenu.DropDown.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f, System.Drawing.FontStyle.Regular);
            trayModelsMenu.DropDown.Padding = new System.Windows.Forms.Padding(2, 3, 2, 3);
            trayModelsMenu.DropDownItems.Add(new System.Windows.Forms.ToolStripMenuItem("正在同步模型列表...", null, (s, e) => { }));
            trayContextMenu.Items.Add(trayModelsMenu);

            trayHudMenu = new System.Windows.Forms.ToolStripMenuItem((showFloatingHud ? "✓ " : "    ") + "桌面测速悬浮窗", null, (s, e) => ToggleFloatingHud(!showFloatingHud)) { Margin = new System.Windows.Forms.Padding(0, 1, 0, 1) };
            trayContextMenu.Items.Add(trayHudMenu);

            trayContextMenu.Items.Add(new System.Windows.Forms.ToolStripMenuItem("⚙️ 偏好设置", null, (s, e) => { ShowAndActivate(); OpenSettingsModal(); }) { Margin = new System.Windows.Forms.Padding(0, 1, 0, 1) });
            trayContextMenu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
            trayContextMenu.Items.Add(new System.Windows.Forms.ToolStripMenuItem("🚪 退出程序", null, (s, e) => ExitApplication()) { Margin = new System.Windows.Forms.Padding(0, 1, 0, 1) });

            trayIcon = new System.Windows.Forms.NotifyIcon();
            trayIcon.Text = "Antigravity Bridge Codex (ABC)";
            trayIcon.Icon = ico;
            trayIcon.ContextMenuStrip = trayContextMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += (s, e) => ShowAndActivate();
        }

        private void InitializeComponent()
        {
            Title = "Antigravity Bridge Codex (ABC)";
            Width = 1060;
            Height = 750;
            MinWidth = 960;
            MinHeight = 660;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            FontFamily = new System.Windows.Media.FontFamily("Microsoft YaHei UI, Segoe UI, sans-serif");
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            TextOptions.SetTextHintingMode(this, TextHintingMode.Fixed);
            RenderOptions.SetClearTypeHint(this, ClearTypeHint.Enabled);

            rootGrid = new Grid();
            Content = rootGrid;

            BuildUI();

            StateChanged += MainWindow_StateChanged;
            Closing += MainWindow_Closing;
        }

        private void BuildUI()
        {
            Background = new SolidColorBrush(ColBg);
            Foreground = new SolidColorBrush(ColTextMain);

            rootGrid.Children.Clear();
            rootGrid.RowDefinitions.Clear();
            rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(68) });  // Topbar
            rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // Main Content
            rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(36) });  // Footer

            // 1. TOPBAR
            topBarBorder = new Border
            {
                Background = new SolidColorBrush(ColCard),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(0, 0, 0, 1),
                Padding = new Thickness(28, 0, 28, 0)
            };
            Grid topGrid = new Grid();
            topGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            topGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            topGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            // Brand App Icon Image
            StackPanel brandPanel = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            
            Border logoContainer = new Border
            {
                Width = 40,
                Height = 40,
                CornerRadius = new CornerRadius(10),
                Margin = new Thickness(0, 0, 12, 0),
                Effect = new DropShadowEffect { Color = ColPrimary, BlurRadius = 10, Opacity = 0.25, ShadowDepth = 1 }
            };
            System.Windows.Controls.Image logoImg = new System.Windows.Controls.Image
            {
                Source = GenerateWpfIconSource(64),
                Width = 40,
                Height = 40
            };
            RenderOptions.SetBitmapScalingMode(logoImg, BitmapScalingMode.HighQuality);
            logoContainer.Child = logoImg;
            brandPanel.Children.Add(logoContainer);

            StackPanel titleGroup = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            StackPanel titleLine = new StackPanel { Orientation = Orientation.Horizontal };
            titleLine.Children.Add(new TextBlock { Text = "Antigravity Bridge Codex", FontWeight = FontWeights.Bold, FontSize = 16.5, Foreground = new SolidColorBrush(ColTextMain), Margin = new Thickness(0, 0, 8, 0) });
            
            Border badgeAbc = new Border
            {
                Background = new SolidColorBrush(ColPrimaryLight),
                BorderBrush = new SolidColorBrush(ColPrimary),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(4),
                Padding = new Thickness(5, 1, 5, 1),
                Margin = new Thickness(0, 0, 8, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            badgeAbc.Child = new TextBlock { Text = "ABC", FontSize = 10.5, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColPrimaryDark) };
            titleLine.Children.Add(badgeAbc);

            titleLine.Children.Add(new TextBlock { Text = "v0.2.0", FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColPrimary), VerticalAlignment = VerticalAlignment.Center });
            titleGroup.Children.Add(titleLine);
            titleGroup.Children.Add(new TextBlock { Text = "LOCAL RUNTIME · 127.0.0.1 ONLY · ZERO DB CONTAMINATION", FontSize = 10, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColTextMuted) });
            brandPanel.Children.Add(titleGroup);
            Grid.SetColumn(brandPanel, 0);
            topGrid.Children.Add(brandPanel);

            // Right Status & Actions
            StackPanel rightTop = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            dotTopStatus = new System.Windows.Shapes.Ellipse
            {
                Width = 9,
                Height = 9,
                Fill = new SolidColorBrush(ColGreen),
                Margin = new Thickness(0, 0, 8, 0)
            };
            txtTopStatus = new TextBlock { Text = "核心服务在线 (127.0.0.1:8787)", FontSize = 12.5, Foreground = new SolidColorBrush(ColTextMuted), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 14, 0) };
            
            btnToggleTheme = CreateButton(isDarkMode ? "☀️ 浅色" : "🌙 深色", ColCardMuted, new SolidColorBrush(ColTextMain), 11.5);
            btnToggleTheme.Padding = new Thickness(12, 6, 12, 6);
            btnToggleTheme.Margin = new Thickness(0, 0, 8, 0);
            btnToggleTheme.Click += (s, e) => ToggleTheme();

            btnOpenSettings = CreateButton("⚙️ 设置", ColCardMuted, new SolidColorBrush(ColTextMain), 11.5);
            btnOpenSettings.Padding = new Thickness(12, 6, 12, 6);
            btnOpenSettings.Margin = new Thickness(0, 0, 10, 0);
            btnOpenSettings.Click += (s, e) => OpenSettingsModal();

            btnToggleCore = CreateButton(isCoreRunning ? "停止服务" : "启动核心", ColCardMuted, new SolidColorBrush(ColTextMain), 12);
            btnToggleCore.Padding = new Thickness(14, 6, 14, 6);
            btnToggleCore.Click += (s, e) => ToggleCoreService();

            rightTop.Children.Add(dotTopStatus);
            rightTop.Children.Add(txtTopStatus);
            rightTop.Children.Add(btnToggleTheme);
            rightTop.Children.Add(btnOpenSettings);
            rightTop.Children.Add(btnToggleCore);
            Grid.SetColumn(rightTop, 2);
            topGrid.Children.Add(rightTop);

            topBarBorder.Child = topGrid;
            Grid.SetRow(topBarBorder, 0);
            rootGrid.Children.Add(topBarBorder);

            // 2. MAIN SCROLL BODY
            mainScroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(28, 20, 28, 20) };
            StackPanel body = new StackPanel();

            // Section 0: Metrics Row
            Grid metricsGrid = new Grid { Margin = new Thickness(0, 0, 0, 20) };
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            metricsGrid.Children.Add(CreateMetricCard("CORE", isCoreRunning ? "ON" : "OFF", "CLIProxyAPI 核心", 0, out txtMetricCore));
            metricsGrid.Children.Add(CreateMetricCard("ACCOUNTS", "0", "已挂载凭据", 1, out txtMetricAccounts));
            metricsGrid.Children.Add(CreateMetricCard("THROUGHPUT", "--", "实时吞吐均速", 2, out txtMetricThroughput));
            metricsGrid.Children.Add(CreateMetricCard("LATENCY", "--", "首字延迟 TTFT", 3, out txtMetricLatency));
            body.Children.Add(metricsGrid);

            // Section 1: Hero Launch Card
            Border heroCard = new Border
            {
                Background = new SolidColorBrush(ColCard),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(16),
                Padding = new Thickness(24),
                Margin = new Thickness(0, 0, 0, 20),
                Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 16, Opacity = isDarkMode ? 0.2 : 0.04, ShadowDepth = 2 }
            };
            Grid heroGrid = new Grid();
            heroGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            heroGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(270) });

            StackPanel heroLeft = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            
            // Kicker Badges
            StackPanel badgeRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 10) };
            badgeMode = new Border
            {
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 245, 158, 11)), // Amber
                BorderBrush = new SolidColorBrush(ColAmber),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8, 3, 8, 3),
                Margin = new Thickness(0, 0, 8, 0)
            };
            txtMode = new TextBlock { Text = "🔒 官方原生模式", FontSize = 10.5, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(isDarkMode ? System.Windows.Media.Color.FromRgb(251, 191, 36) : System.Windows.Media.Color.FromRgb(180, 83, 9)) };
            badgeMode.Child = txtMode;
            badgeRow.Children.Add(badgeMode);

            Border autoRestorePill = new Border
            {
                Background = new SolidColorBrush(ColCardMuted),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8, 3, 8, 3)
            };
            autoRestorePill.Child = new TextBlock { Text = "🛡️ 关窗自动还原官方", FontSize = 10.5, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColTextMuted) };
            badgeRow.Children.Add(autoRestorePill);
            heroLeft.Children.Add(badgeRow);

            // Headline
            TextBlock heroTitle = new TextBlock
            {
                Text = "把可用模型，接到本地 Codex。",
                FontSize = 21,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(ColTextMain),
                Margin = new Thickness(0, 0, 0, 6)
            };
            heroLeft.Children.Add(heroTitle);

            txtCodexStatus = new TextBlock
            {
                Text = "保留官方登录与历史会话，点击启动按钮将自动应用 API Service 配置。使用完毕关闭 Codex 桌面端窗口即可自动无感还原。",
                FontSize = 12,
                Foreground = new SolidColorBrush(ColTextMuted),
                TextWrapping = TextWrapping.Wrap,
                LineHeight = 18,
                Margin = new Thickness(0, 0, 0, 14)
            };
            heroLeft.Children.Add(txtCodexStatus);

            // Model Switcher Line
            StackPanel modelRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            modelRow.Children.Add(new TextBlock { Text = "生效模型：", FontSize = 12.5, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColTextMain), VerticalAlignment = VerticalAlignment.Center });
            
            modelPicker = new ModelPickerControl { Margin = new Thickness(0, 0, 12, 0) };
            modelPicker.SetTheme(isDarkMode);
            modelPicker.ModelSelected += (modelId) => OnModelSelected(modelId);
            modelRow.Children.Add(modelPicker);

            heroLeft.Children.Add(modelRow);
            Grid.SetColumn(heroLeft, 0);
            heroGrid.Children.Add(heroLeft);

            // Right Hero Launch Button & Restore Button
            StackPanel heroRight = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Right };
            btnLaunchCodex = new Button
            {
                Width = 240,
                Height = 62,
                Background = new SolidColorBrush(ColPrimary),
                Foreground = System.Windows.Media.Brushes.White,
                BorderThickness = new Thickness(0),
                Cursor = Cursors.Hand,
                Effect = new DropShadowEffect { Color = ColPrimary, BlurRadius = 20, Opacity = 0.35, ShadowDepth = 3 }
            };
            ControlTemplate btnTemplate = new ControlTemplate(typeof(Button));
            FrameworkElementFactory borderFactory = new FrameworkElementFactory(typeof(Border));
            borderFactory.SetValue(Border.CornerRadiusProperty, new CornerRadius(12));
            
            System.Windows.Media.LinearGradientBrush btnGradient = new System.Windows.Media.LinearGradientBrush(
                ColPrimary,
                ColPrimaryDark,
                new System.Windows.Point(0, 0),
                new System.Windows.Point(1, 1)
            );
            borderFactory.SetValue(Border.BackgroundProperty, btnGradient);

            FrameworkElementFactory contentFactory = new FrameworkElementFactory(typeof(ContentPresenter));
            contentFactory.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            contentFactory.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            borderFactory.AppendChild(contentFactory);
            btnTemplate.VisualTree = borderFactory;
            btnLaunchCodex.Template = btnTemplate;

            StackPanel btnContent = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
            TextBlock btnMainText = new TextBlock
            {
                Text = "🚀 启动 Codex",
                FontSize = 16,
                FontWeight = FontWeights.Bold,
                Foreground = System.Windows.Media.Brushes.White,
                HorizontalAlignment = HorizontalAlignment.Center
            };
            TextBlock btnSubText = new TextBlock
            {
                Text = "一键接管 · 关窗即还原",
                FontSize = 10,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromArgb(220, 255, 255, 255)),
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 2, 0, 0)
            };
            btnContent.Children.Add(btnMainText);
            btnContent.Children.Add(btnSubText);
            btnLaunchCodex.Content = btnContent;
            btnLaunchCodex.Click += (s, e) => LaunchCodexService();
            heroRight.Children.Add(btnLaunchCodex);

            btnRestore = CreateButton("🛡️ 恢复官方配置", ColCardMuted, new SolidColorBrush(ColTextMain), 11.5, false);
            btnRestore.Width = 240;
            btnRestore.Height = 32;
            btnRestore.Margin = new Thickness(0, 8, 0, 0);
            btnRestore.Click += (s, e) => RestoreOfficialConfig();
            heroRight.Children.Add(btnRestore);

            Grid.SetColumn(heroRight, 1);
            heroGrid.Children.Add(heroRight);

            heroCard.Child = heroGrid;

            // Section 2: Accounts & Quotas Header (Includes Round-Robin Mode Toggle)
            Grid accHeaderGrid = new Grid { Margin = new Thickness(0, 0, 0, 12) };
            accHeaderGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            accHeaderGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            StackPanel accTitleGroup = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            TextBlock sectionNo = new TextBlock { Text = "02", FontFamily = new System.Windows.Media.FontFamily("Georgia"), FontStyle = FontStyles.Italic, FontSize = 20, Foreground = new SolidColorBrush(ColPrimary), Margin = new Thickness(0, 0, 8, 0) };
            TextBlock accTitle = new TextBlock { Text = "账号与额度", FontSize = 17, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColTextMain), Margin = new Thickness(0, 0, 10, 0) };
            accTitleGroup.Children.Add(sectionNo);
            accTitleGroup.Children.Add(accTitle);
            Grid.SetColumn(accTitleGroup, 0);
            accHeaderGrid.Children.Add(accTitleGroup);

            StackPanel accActions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            
            // Round-Robin Mode Switch Button
            btnToggleRoundRobin = CreateButton(autoRoundRobin ? "🔄 自动轮询: 开启" : "🎯 手动指定: 开启", ColPrimaryLight, new SolidColorBrush(ColPrimaryDark), 11.5, true);
            btnToggleRoundRobin.Padding = new Thickness(12, 5, 12, 5);
            btnToggleRoundRobin.Margin = new Thickness(0, 0, 8, 0);
            btnToggleRoundRobin.Click += (s, e) => ToggleRoundRobinMode();
            accActions.Children.Add(btnToggleRoundRobin);

            btnRefreshQuota = CreateButton("刷新额度", ColCardMuted, new SolidColorBrush(ColTextMain), 11.5);
            btnRefreshQuota.Padding = new Thickness(12, 5, 12, 5);
            btnRefreshQuota.Click += (s, e) => RefreshQuota();
            accActions.Children.Add(btnRefreshQuota);

            Button btnAddAccount = CreateButton("+ 登录 Google 账号", ColPrimary, System.Windows.Media.Brushes.White, 11.5, true);
            btnAddAccount.Padding = new Thickness(14, 5, 14, 5);
            btnAddAccount.Margin = new Thickness(8, 0, 0, 0);
            btnAddAccount.Click += (s, e) => StartOAuthLogin();
            accActions.Children.Add(btnAddAccount);

            Grid.SetColumn(accActions, 1);
            accHeaderGrid.Children.Add(accActions);

            body.Children.Add(heroCard);
            body.Children.Add(accHeaderGrid);
            panelAccounts = new StackPanel();
            body.Children.Add(panelAccounts);

            mainScroll.Content = body;
            Grid.SetRow(mainScroll, 1);
            rootGrid.Children.Add(mainScroll);

            // 3. FOOTER
            footerBorder = new Border
            {
                Background = new SolidColorBrush(ColCard),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(0, 1, 0, 0),
                Padding = new Thickness(28, 0, 28, 0)
            };
            Grid footerGrid = new Grid();
            footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            TextBlock footLeft = new TextBlock { Text = "ANTIGRAVITY CODEX BRIDGE", FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 9.5, Foreground = new SolidColorBrush(ColTextMuted), VerticalAlignment = VerticalAlignment.Center };
            TextBlock footRight = new TextBlock { Text = "LOCAL-FIRST / PRESERVE LOGIN & HISTORY", FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 9.5, Foreground = new SolidColorBrush(ColTextMuted), VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(footLeft, 0);
            Grid.SetColumn(footRight, 2);
            footerGrid.Children.Add(footLeft);
            footerGrid.Children.Add(footRight);
            footerBorder.Child = footerGrid;
            Grid.SetRow(footerBorder, 2);
            rootGrid.Children.Add(footerBorder);

            // 4. IN-APP CENTER FLOATING TOAST / HUD NOTIFICATION
            toastContainer = new Border
            {
                Background = new SolidColorBrush(ColCard),
                BorderBrush = new SolidColorBrush(ColPrimary),
                BorderThickness = new Thickness(1.5),
                CornerRadius = new CornerRadius(16),
                Padding = new Thickness(26, 14, 30, 14),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, -40, 0, 0),
                Visibility = Visibility.Collapsed,
                Opacity = 0,
                Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 32, Opacity = 0.22, ShadowDepth = 6 }
            };
            Grid.SetRowSpan(toastContainer, 3);
            Panel.SetZIndex(toastContainer, 9999);

            StackPanel toastSp = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            Border toastIcon = new Border
            {
                Width = 26,
                Height = 26,
                CornerRadius = new CornerRadius(13),
                Background = new SolidColorBrush(ColPrimaryLight),
                Margin = new Thickness(0, 0, 12, 0)
            };
            toastIcon.Child = new TextBlock
            {
                Text = "✓",
                FontSize = 14,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(ColPrimary),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            toastSp.Children.Add(toastIcon);

            txtToastMessage = new TextBlock
            {
                Text = "账号已切换",
                FontSize = 14,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(ColTextMain),
                VerticalAlignment = VerticalAlignment.Center
            };
            toastSp.Children.Add(txtToastMessage);
            toastContainer.Child = toastSp;
            rootGrid.Children.Add(toastContainer);

            // 5. SETTINGS MODAL OVERLAY
            settingsOverlay = new Border
            {
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(175, 0, 0, 0)),
                Visibility = Visibility.Collapsed,
                Opacity = 0
            };
            Grid.SetRowSpan(settingsOverlay, 3);
            Panel.SetZIndex(settingsOverlay, 9998);

            Border modalCard = new Border
            {
                Width = 560,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Background = new SolidColorBrush(ColCard),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(16),
                Padding = new Thickness(28, 22, 28, 24),
                Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 32, Opacity = isDarkMode ? 0.45 : 0.16, ShadowDepth = 6 }
            };

            StackPanel modalSp = new StackPanel();

            // Modal Header (Title + Subtitle + Close '✕')
            Grid mHead = new Grid { Margin = new Thickness(0, 0, 0, 16) };
            mHead.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            mHead.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            StackPanel mTitleSp = new StackPanel();
            mTitleSp.Children.Add(new TextBlock { Text = "⚙️ 偏好设置", FontWeight = FontWeights.Bold, FontSize = 17, Foreground = new SolidColorBrush(ColTextMain) });
            mTitleSp.Children.Add(new TextBlock { Text = "自定义系统启动、网络端口与 Codex 联动行为", FontSize = 11, Foreground = new SolidColorBrush(ColTextMuted), Margin = new Thickness(0, 2, 0, 0) });
            Grid.SetColumn(mTitleSp, 0);
            mHead.Children.Add(mTitleSp);

            Button btnCloseModal = new Button
            {
                Content = "✕",
                FontSize = 14,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(ColTextMuted),
                Background = System.Windows.Media.Brushes.Transparent,
                BorderThickness = new Thickness(0),
                Cursor = Cursors.Hand,
                Padding = new Thickness(6, 2, 6, 2)
            };
            btnCloseModal.Click += (s, e) => CloseSettingsModal();
            Grid.SetColumn(btnCloseModal, 1);
            mHead.Children.Add(btnCloseModal);
            modalSp.Children.Add(mHead);

            // Group 1: System & Startup
            modalSp.Children.Add(new TextBlock { Text = "🚀 系统与启动行为", FontWeight = FontWeights.Bold, FontSize = 12.5, Foreground = new SolidColorBrush(ColPrimary), Margin = new Thickness(0, 4, 0, 8) });

            chkSettingsAutoStart = new CheckBox
            {
                Content = " 开机自启动 (Windows 登录时自动在后台启动)",
                IsChecked = autoStartBoot,
                FontSize = 12,
                Foreground = new SolidColorBrush(ColTextMain),
                Margin = new Thickness(4, 0, 0, 6),
                Cursor = Cursors.Hand
            };
            chkSettingsAutoStart.Checked += (s, e) => { if (chkSettingsStartMinimized != null) chkSettingsStartMinimized.IsEnabled = true; };
            chkSettingsAutoStart.Unchecked += (s, e) => { if (chkSettingsStartMinimized != null) chkSettingsStartMinimized.IsEnabled = false; };
            modalSp.Children.Add(chkSettingsAutoStart);

            chkSettingsStartMinimized = new CheckBox
            {
                Content = " 开机静默启动至系统托盘 (不弹出大窗口打扰)",
                IsChecked = startMinimized,
                IsEnabled = autoStartBoot,
                FontSize = 12,
                Foreground = new SolidColorBrush(ColTextMain),
                Margin = new Thickness(24, 0, 0, 10),
                Cursor = Cursors.Hand
            };
            modalSp.Children.Add(chkSettingsStartMinimized);

            modalSp.Children.Add(new TextBlock { Text = "关闭窗口时的行为：", FontSize = 11.5, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColTextMain), Margin = new Thickness(4, 2, 0, 6) });
            StackPanel rbSp = new StackPanel { Margin = new Thickness(20, 0, 0, 12) };
            rbSettingsCloseTray = new RadioButton
            {
                GroupName = "closeAction",
                Content = " 最小化到系统托盘后台运行 (推荐)",
                IsChecked = (closeAction != "exit"),
                FontSize = 11.5,
                Foreground = new SolidColorBrush(ColTextMain),
                Margin = new Thickness(0, 0, 0, 4),
                Cursor = Cursors.Hand
            };
            rbSettingsCloseExit = new RadioButton
            {
                GroupName = "closeAction",
                Content = " 彻底退出程序并自动还原 Codex 官方配置",
                IsChecked = (closeAction == "exit"),
                FontSize = 11.5,
                Foreground = new SolidColorBrush(ColTextMain),
                Cursor = Cursors.Hand
            };
            rbSp.Children.Add(rbSettingsCloseTray);
            rbSp.Children.Add(rbSettingsCloseExit);
            modalSp.Children.Add(rbSp);

            chkSettingsFloatingHud = new CheckBox
            {
                Content = " 开启桌面实时测速悬浮窗 (实时监测 Token/s 与首字延迟)",
                IsChecked = showFloatingHud,
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(ColTextMain),
                Margin = new Thickness(4, 0, 0, 8),
                Cursor = Cursors.Hand
            };
            modalSp.Children.Add(chkSettingsFloatingHud);

            chkSettingsMinimizeOnLaunch = new CheckBox
            {
                Content = " 启动 Codex 后自动最小化主界面到系统托盘",
                IsChecked = minimizeOnCodexLaunch,
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(ColTextMain),
                Margin = new Thickness(4, 0, 0, 14),
                Cursor = Cursors.Hand
            };
            modalSp.Children.Add(chkSettingsMinimizeOnLaunch);

            // Group 2: Network & Proxy Port
            modalSp.Children.Add(new TextBlock { Text = "🌐 网络与端口", FontWeight = FontWeights.Bold, FontSize = 12.5, Foreground = new SolidColorBrush(ColPrimary), Margin = new Thickness(0, 6, 0, 8) });
            Grid portGrid = new Grid { Margin = new Thickness(4, 0, 0, 12) };
            portGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) });
            portGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(100) });
            portGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            TextBlock lblPort = new TextBlock { Text = "本地代理端口：", FontSize = 12, Foreground = new SolidColorBrush(ColTextMain), VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(lblPort, 0);
            portGrid.Children.Add(lblPort);

            txtSettingsPort = new TextBox
            {
                Text = proxyPort.ToString(),
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Padding = new Thickness(8, 4, 8, 4),
                Background = new SolidColorBrush(ColCardMuted),
                Foreground = new SolidColorBrush(ColTextMain),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(txtSettingsPort, 1);
            portGrid.Children.Add(txtSettingsPort);

            TextBlock lblPortHint = new TextBlock { Text = " (默认 8787)", FontSize = 11, Foreground = new SolidColorBrush(ColTextMuted), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 0, 0) };
            Grid.SetColumn(lblPortHint, 2);
            portGrid.Children.Add(lblPortHint);
            modalSp.Children.Add(portGrid);

            // Group 3: Custom Codex Path
            modalSp.Children.Add(new TextBlock { Text = "🛡️ Codex 目录配置", FontWeight = FontWeights.Bold, FontSize = 12.5, Foreground = new SolidColorBrush(ColPrimary), Margin = new Thickness(0, 4, 0, 6) });
            modalSp.Children.Add(new TextBlock { Text = "Codex 安装与数据路径（留空则自动检测）：", FontSize = 11, Foreground = new SolidColorBrush(ColTextMuted), Margin = new Thickness(4, 0, 0, 4) });

            Grid pathGrid = new Grid { Margin = new Thickness(4, 0, 0, 18) };
            pathGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            pathGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) });

            txtSettingsCodexPath = new TextBox
            {
                Text = customCodexPath,
                FontSize = 11.5,
                Padding = new Thickness(8, 5, 8, 5),
                Background = new SolidColorBrush(ColCardMuted),
                Foreground = new SolidColorBrush(ColTextMain),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(txtSettingsCodexPath, 0);
            pathGrid.Children.Add(txtSettingsCodexPath);

            Button btnBrowse = CreateButton("📁 浏览", ColCardMuted, new SolidColorBrush(ColTextMain), 11.5);
            btnBrowse.Padding = new Thickness(8, 4, 8, 4);
            btnBrowse.Margin = new Thickness(8, 0, 0, 0);
            btnBrowse.Click += (s, e) =>
            {
                var dlg = new System.Windows.Forms.FolderBrowserDialog();
                dlg.Description = "选择 Codex 安装或数据目录";
                if (dlg.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                {
                    txtSettingsCodexPath.Text = dlg.SelectedPath;
                }
            };
            Grid.SetColumn(btnBrowse, 1);
            pathGrid.Children.Add(btnBrowse);
            modalSp.Children.Add(pathGrid);

            // Modal Actions (Check Updates, Cancel, Save)
            Grid mActionGrid = new Grid { Margin = new Thickness(0, 4, 0, 0) };
            mActionGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            mActionGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            mActionGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            Button btnCheckUpdate = CreateButton("🔄 检查更新", ColCardMuted, new SolidColorBrush(ColPrimary), 11.5);
            btnCheckUpdate.Padding = new Thickness(12, 6, 12, 6);
            btnCheckUpdate.Click += (s, e) => CheckForUpdates(false);
            Grid.SetColumn(btnCheckUpdate, 0);
            mActionGrid.Children.Add(btnCheckUpdate);

            StackPanel mRightButtons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            Button btnCancel = CreateButton("取消", ColCardMuted, new SolidColorBrush(ColTextMain), 12);
            btnCancel.Padding = new Thickness(16, 6, 16, 6);
            btnCancel.Margin = new Thickness(0, 0, 10, 0);
            btnCancel.Click += (s, e) => CloseSettingsModal();
            mRightButtons.Children.Add(btnCancel);

            Button btnSave = CreateButton("💾 保存设置", ColPrimary, System.Windows.Media.Brushes.White, 12, true);
            btnSave.Padding = new Thickness(20, 6, 20, 6);
            btnSave.Click += (s, e) => SaveSettingsFromModal();
            mRightButtons.Children.Add(btnSave);

            Grid.SetColumn(mRightButtons, 2);
            mActionGrid.Children.Add(mRightButtons);

            modalSp.Children.Add(mActionGrid);
            modalCard.Child = modalSp;
            settingsOverlay.Child = modalCard;
            rootGrid.Children.Add(settingsOverlay);
        }

        private void ShowToast(string message)
        {
            Dispatcher.Invoke(() =>
            {
                txtToastMessage.Text = message;
                toastContainer.Visibility = Visibility.Visible;
                toastContainer.Opacity = 0;

                var fadeIn = new System.Windows.Media.Animation.DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180));
                toastContainer.BeginAnimation(UIElement.OpacityProperty, fadeIn);

                if (toastTimer != null) toastTimer.Stop();
                toastTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1900) };
                toastTimer.Tick += (s, e) =>
                {
                    toastTimer.Stop();
                    var fadeOut = new System.Windows.Media.Animation.DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(220));
                    fadeOut.Completed += (s2, e2) => { toastContainer.Visibility = Visibility.Collapsed; };
                    toastContainer.BeginAnimation(UIElement.OpacityProperty, fadeOut);
                };
                toastTimer.Start();
            });
        }

        private ImageSource GenerateWpfIconSource(int size)
        {
            Bitmap bmp = GenerateBrandBitmap(size);
            IntPtr hIcon = bmp.GetHicon();
            return Imaging.CreateBitmapSourceFromHIcon(hIcon, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
        }

        private Border CreateMetricCard(string label, string value, string subtext, int column, out TextBlock valBlock)
        {
            Border card = new Border
            {
                Background = new SolidColorBrush(ColCard),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(18, 14, 18, 14),
                Margin = new Thickness(column == 0 ? 0 : 6, 0, column == 3 ? 0 : 6, 0),
                Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 10, Opacity = 0.03, ShadowDepth = 1 }
            };
            StackPanel sp = new StackPanel();
            TextBlock lbl = new TextBlock { Text = label, FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 10, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColTextMuted), Margin = new Thickness(0, 0, 0, 4) };
            valBlock = new TextBlock { Text = value, FontSize = 22, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColTextMain), Margin = new Thickness(0, 0, 0, 2) };
            TextBlock sub = new TextBlock { Text = subtext, FontSize = 11, Foreground = new SolidColorBrush(ColTextMuted) };
            sp.Children.Add(lbl);
            sp.Children.Add(valBlock);
            sp.Children.Add(sub);
            card.Child = sp;
            Grid.SetColumn(card, column);
            return card;
        }

        private Button CreateButton(string text, System.Windows.Media.Color bg, System.Windows.Media.Brush fg, double fontSize = 12, bool bold = false)
        {
            Button btn = new Button
            {
                Content = text,
                Background = new SolidColorBrush(bg),
                Foreground = fg,
                FontSize = fontSize,
                FontWeight = bold ? FontWeights.Bold : FontWeights.Normal,
                Cursor = Cursors.Hand,
                BorderThickness = new Thickness(0)
            };
            ControlTemplate template = new ControlTemplate(typeof(Button));
            FrameworkElementFactory border = new FrameworkElementFactory(typeof(Border));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(8));
            border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Button.BackgroundProperty));
            border.SetValue(Border.PaddingProperty, new TemplateBindingExtension(Button.PaddingProperty));
            FrameworkElementFactory presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(presenter);
            template.VisualTree = border;
            btn.Template = template;
            return btn;
        }

        private const string RUN_REG_KEY = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string APP_REG_NAME = "AntigravityCodexBridge";

        private bool CheckRegistryAutoStart(out bool isSilent)
        {
            isSilent = false;
            try
            {
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RUN_REG_KEY, false))
                {
                    if (key != null)
                    {
                        object val = key.GetValue(APP_REG_NAME);
                        if (val != null)
                        {
                            string cmd = val.ToString();
                            isSilent = cmd.IndexOf("--silent", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                       cmd.IndexOf("--minimized", StringComparison.OrdinalIgnoreCase) >= 0;
                            return true;
                        }
                    }
                }
            }
            catch { }
            return false;
        }

        private void SetRegistryAutoStart(bool enable, bool silent)
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RUN_REG_KEY, true))
                {
                    if (key != null)
                    {
                        if (enable)
                        {
                            string exePath = Process.GetCurrentProcess().MainModule.FileName;
                            string val = "\"" + exePath + "\"" + (silent ? " --silent" : "");
                            key.SetValue(APP_REG_NAME, val);
                        }
                        else
                        {
                            key.DeleteValue(APP_REG_NAME, false);
                        }
                    }
                }
            }
            catch { }
        }

        private string GetUiPreferencePath()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string dir = System.IO.Path.Combine(localAppData, "AntigravityCodexBridge");
            if (!Directory.Exists(dir))
            {
                try { Directory.CreateDirectory(dir); } catch { }
            }
            return System.IO.Path.Combine(dir, "ui_preference.json");
        }

        private void LoadUiPreferences()
        {
            try
            {
                string path = GetUiPreferencePath();
                if (File.Exists(path))
                {
                    string content = File.ReadAllText(path);
                    var dict = jsonSerializer.Deserialize<Dictionary<string, object>>(content);
                    if (dict != null)
                    {
                        if (dict.ContainsKey("theme"))
                        {
                            string theme = dict["theme"].ToString().ToLower();
                            isDarkMode = (theme == "dark");
                        }
                        if (dict.ContainsKey("closeAction"))
                        {
                            closeAction = dict["closeAction"].ToString().ToLower();
                        }
                        if (dict.ContainsKey("proxyPort"))
                        {
                            int p;
                            if (int.TryParse(dict["proxyPort"].ToString(), out p) && p > 0 && p <= 65535) proxyPort = p;
                        }
                        if (dict.ContainsKey("customCodexPath"))
                        {
                            customCodexPath = dict["customCodexPath"].ToString();
                        }
                        if (dict.ContainsKey("startMinimized"))
                        {
                            startMinimized = Convert.ToBoolean(dict["startMinimized"]);
                        }
                        if (dict.ContainsKey("minimizeOnCodexLaunch"))
                        {
                            minimizeOnCodexLaunch = Convert.ToBoolean(dict["minimizeOnCodexLaunch"]);
                        }
                        if (dict.ContainsKey("showFloatingHud"))
                        {
                            showFloatingHud = Convert.ToBoolean(dict["showFloatingHud"]);
                        }
                        if (dict.ContainsKey("floatingHudX"))
                        {
                            double.TryParse(dict["floatingHudX"].ToString(), out floatingHudX);
                        }
                        if (dict.ContainsKey("floatingHudY"))
                        {
                            double.TryParse(dict["floatingHudY"].ToString(), out floatingHudY);
                        }
                    }
                }
            }
            catch { }

            // Sync with actual registry state
            bool isSilent;
            autoStartBoot = CheckRegistryAutoStart(out isSilent);
            if (autoStartBoot) startMinimized = isSilent;
        }

        private void SaveUiPreferences()
        {
            try
            {
                string path = GetUiPreferencePath();
                Dictionary<string, object> dict = new Dictionary<string, object>();
                dict["theme"] = isDarkMode ? "dark" : "light";
                dict["autoStartBoot"] = autoStartBoot;
                dict["startMinimized"] = startMinimized;
                dict["minimizeOnCodexLaunch"] = minimizeOnCodexLaunch;
                dict["closeAction"] = closeAction;
                dict["proxyPort"] = proxyPort;
                dict["customCodexPath"] = customCodexPath;
                dict["showFloatingHud"] = showFloatingHud;
                dict["floatingHudX"] = (floatingHud != null) ? floatingHud.Left : floatingHudX;
                dict["floatingHudY"] = (floatingHud != null) ? floatingHud.Top : floatingHudY;
                dict["savedAt"] = DateTime.UtcNow.ToString("o");
                string json = jsonSerializer.Serialize(dict);
                File.WriteAllText(path, json, Encoding.UTF8);
            }
            catch { }
        }

        private void ToggleTheme()
        {
            isDarkMode = !isDarkMode;
            SaveUiPreferences();
            BuildUI();
            FetchDashboardData();
            if (floatingHud != null)
            {
                floatingHud.ApplyTheme(isDarkMode);
            }
            ShowToast(isDarkMode ? "🌙 已切换为 Slate 深色模式" : "☀️ 已切换为极简浅色模式");
        }

        private void OpenSettingsModal()
        {
            if (chkSettingsAutoStart != null) chkSettingsAutoStart.IsChecked = autoStartBoot;
            if (chkSettingsStartMinimized != null)
            {
                chkSettingsStartMinimized.IsChecked = startMinimized;
                chkSettingsStartMinimized.IsEnabled = autoStartBoot;
            }
            if (chkSettingsMinimizeOnLaunch != null) chkSettingsMinimizeOnLaunch.IsChecked = minimizeOnCodexLaunch;
            if (chkSettingsFloatingHud != null) chkSettingsFloatingHud.IsChecked = showFloatingHud;
            if (rbSettingsCloseTray != null) rbSettingsCloseTray.IsChecked = (closeAction != "exit");
            if (rbSettingsCloseExit != null) rbSettingsCloseExit.IsChecked = (closeAction == "exit");
            if (txtSettingsPort != null) txtSettingsPort.Text = proxyPort.ToString();
            if (txtSettingsCodexPath != null) txtSettingsCodexPath.Text = customCodexPath;

            if (settingsOverlay != null)
            {
                settingsOverlay.Visibility = Visibility.Visible;
                var fadeIn = new System.Windows.Media.Animation.DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200));
                settingsOverlay.BeginAnimation(UIElement.OpacityProperty, fadeIn);
            }
        }

        private void CloseSettingsModal()
        {
            if (settingsOverlay != null)
            {
                var fadeOut = new System.Windows.Media.Animation.DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(150));
                fadeOut.Completed += (s, e) => { settingsOverlay.Visibility = Visibility.Collapsed; };
                settingsOverlay.BeginAnimation(UIElement.OpacityProperty, fadeOut);
            }
        }

        private void SaveSettingsFromModal()
        {
            autoStartBoot = chkSettingsAutoStart != null && chkSettingsAutoStart.IsChecked == true;
            startMinimized = chkSettingsStartMinimized != null && chkSettingsStartMinimized.IsChecked == true;
            minimizeOnCodexLaunch = chkSettingsMinimizeOnLaunch == null || chkSettingsMinimizeOnLaunch.IsChecked == true;
            closeAction = (rbSettingsCloseExit != null && rbSettingsCloseExit.IsChecked == true) ? "exit" : "tray";

            bool newFloatingHud = chkSettingsFloatingHud != null && chkSettingsFloatingHud.IsChecked == true;
            if (newFloatingHud != showFloatingHud)
            {
                ToggleFloatingHud(newFloatingHud);
            }

            if (txtSettingsPort != null)
            {
                int p;
                if (int.TryParse(txtSettingsPort.Text.Trim(), out p) && p > 0 && p <= 65535)
                {
                    proxyPort = p;
                }
            }

            if (txtSettingsCodexPath != null)
            {
                customCodexPath = txtSettingsCodexPath.Text.Trim();
            }

            SetRegistryAutoStart(autoStartBoot, startMinimized);
            SaveUiPreferences();

            if (isCoreRunning && !string.IsNullOrEmpty(customCodexPath))
            {
                ThreadPool.QueueUserWorkItem((state) =>
                {
                    try
                    {
                        var body = new Dictionary<string, object>();
                        body["codexHome"] = customCodexPath;
                        string json = jsonSerializer.Serialize(body);
                        SendApiPost("api/settings", json);
                    }
                    catch { }
                });
            }

            CloseSettingsModal();
            ShowToast("⚙️ 偏好设置已成功保存");
        }

        private void CheckForUpdates(bool silentIfLatest = false)
        {
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    string json = SendApiGet("api/version/check");
                    var data = jsonSerializer.Deserialize<Dictionary<string, object>>(json);
                    if (data == null) return;

                    string curVer = data.ContainsKey("currentVersion") ? data["currentVersion"].ToString() : "0.2.0";
                    string latVer = data.ContainsKey("latestVersion") ? data["latestVersion"].ToString() : curVer;
                    bool hasUpdate = data.ContainsKey("hasUpdate") && Convert.ToBoolean(data["hasUpdate"]);
                    string releaseUrl = data.ContainsKey("releaseUrl") ? data["releaseUrl"].ToString() : "https://github.com/yu-hx-tom/antigravity-bridge-codex/releases";
                    string releaseNotes = data.ContainsKey("releaseNotes") ? data["releaseNotes"].ToString() : "";

                    Dispatcher.Invoke(() =>
                    {
                        if (hasUpdate)
                        {
                            string msg = string.Format("🎉 发现新版本 v{0}（当前版本 v{1}）！\n\n更新说明:\n{2}\n\n是否立即前往 GitHub 查看与下载？", latVer, curVer, string.IsNullOrEmpty(releaseNotes) ? "包含功能优化与性能提升" : releaseNotes);
                            var res = MessageBox.Show(msg, "ABC 发现新版本", MessageBoxButton.YesNo, MessageBoxImage.Information);
                            if (res == MessageBoxResult.Yes)
                            {
                                try
                                {
                                    Process.Start(new ProcessStartInfo(releaseUrl) { UseShellExecute = true });
                                }
                                catch { }
                            }
                        }
                        else
                        {
                            if (!silentIfLatest)
                            {
                                ShowToast("✨ 当前已是最新版本 (v" + curVer + ")");
                            }
                        }
                    });
                }
                catch (Exception ex)
                {
                    if (!silentIfLatest)
                    {
                        Dispatcher.Invoke(() => ShowToast("检查更新失败: " + ex.Message));
                    }
                }
            });
        }

        private void ToggleFloatingHud(bool show)
        {
            showFloatingHud = show;
            if (showFloatingHud)
            {
                if (floatingHud == null)
                {
                    floatingHud = new FloatingHudWindow();
                    floatingHud.OpenMainWindowAction = () => ShowAndActivate();
                    floatingHud.OpenSettingsAction = () => { ShowAndActivate(); OpenSettingsModal(); };
                    floatingHud.CloseHudAction = () => ToggleFloatingHud(false);
                    floatingHud.SelectModelAction = (mId) => OnModelSelected(mId);
                    floatingHud.PositionChangedAction = (x, y) =>
                    {
                        floatingHudX = x;
                        floatingHudY = y;
                        SaveUiPreferences();
                    };

                    if (floatingHudX >= 0 && floatingHudY >= 0)
                    {
                        floatingHud.Left = floatingHudX;
                        floatingHud.Top = floatingHudY;
                    }
                    else
                    {
                        // Default position: Top center of desktop
                        floatingHud.Left = SystemParameters.WorkArea.Left + (SystemParameters.WorkArea.Width - floatingHud.Width) / 2;
                        floatingHud.Top = SystemParameters.WorkArea.Top + 80;
                    }
                }
                floatingHud.ApplyTheme(isDarkMode);
                floatingHud.Show();
                floatingHud.CheckDocking();
            }
            else
            {
                if (floatingHud != null)
                {
                    floatingHud.Hide();
                }
            }

            if (chkSettingsFloatingHud != null) chkSettingsFloatingHud.IsChecked = showFloatingHud;
            if (trayHudMenu != null) trayHudMenu.Text = (showFloatingHud ? "✓ " : "    ") + "桌面测速悬浮窗";
            SaveUiPreferences();
        }

        private void UpdateTrayModelsMenu(List<KeyValuePair<string, string>> models, string currentModel)
        {
            if (trayModelsMenu == null || models == null || models.Count == 0) return;
            try
            {
                trayModelsMenu.DropDownItems.Clear();
                foreach (var item in models)
                {
                    string mId = item.Key;
                    string mName = item.Value;
                    bool isChecked = (mId == currentModel);
                    string menuText = (isChecked ? "✓ " : "    ") + mName;
                    
                    System.Windows.Forms.ToolStripMenuItem mItem = new System.Windows.Forms.ToolStripMenuItem(menuText);
                    mItem.Margin = new System.Windows.Forms.Padding(0, 1, 0, 1);
                    if (isChecked)
                    {
                        mItem.Font = new System.Drawing.Font("Microsoft YaHei UI", 9f, System.Drawing.FontStyle.Bold);
                    }
                    mItem.Click += (s, e) =>
                    {
                        OnModelSelected(mId);
                        trayIcon.ShowBalloonTip(1200, "生效模型已切换", "当前模型: " + mName, System.Windows.Forms.ToolTipIcon.Info);
                    };
                    trayModelsMenu.DropDownItems.Add(mItem);
                }
            }
            catch { }
        }

        private string GetFriendlyModelName(string modelId)
        {
            switch (modelId)
            {
                case "gemini-3.7-flash-high": return "Gemini 3.7 Flash";
                case "gemini-3.6-flash-high": return "Gemini 3.6 Flash";
                case "claude-sonnet-4-6": return "Claude Sonnet 4.6 (Thinking)";
                case "claude-opus-4-6-thinking": return "Claude Opus 4.6 (Thinking)";
                case "gemini-pro-agent": return "Gemini 3.1 Pro (High)";
                case "gemini-3-flash": return "Gemini 3 Flash";
                case "gemini-3-flash-agent": return "Gemini 3.5 Flash (High)";
                case "gemini-3.1-flash-lite": return "Gemini 3.1 Flash Lite";
                case "gemini-3.1-flash-image": return "Gemini 3.1 Flash Image";
                case "gemini-3.1-pro-low": return "Gemini 3.1 Pro (Low)";
                case "gemini-3.5-flash-low": return "Gemini 3.5 Flash (Medium)";
                case "gemini-3.5-flash-extra-low": return "Gemini 3.5 Flash (Low)";
                case "gpt-oss-120b-medium": return "GPT-OSS 120B (Medium)";
                default: return modelId;
            }
        }

        private void ShowAndActivate()
        {
            Show();
            if (WindowState == WindowState.Minimized)
            {
                WindowState = WindowState.Normal;
            }
            Activate();
            Topmost = true;
            Topmost = false;
            Focus();
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            HwndSource source = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
            if (source != null)
            {
                source.AddHook(WndProc);
            }
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == (int)WM_SHOWME && WM_SHOWME != 0)
            {
                ShowAndActivate();
                handled = true;
            }
            return IntPtr.Zero;
        }

        private string GetStateFilePath()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string appDir = System.IO.Path.Combine(localAppData, "AntigravityCodexBridge");
            if (!Directory.Exists(appDir)) Directory.CreateDirectory(appDir);
            return System.IO.Path.Combine(appDir, "tray_state.flag");
        }

        private bool CheckHasShownTrayTipPersisted()
        {
            try
            {
                string path = GetStateFilePath();
                return File.Exists(path);
            }
            catch { return false; }
        }

        private void MarkTrayTipShownPersisted()
        {
            try
            {
                string path = GetStateFilePath();
                File.WriteAllText(path, "shown");
            }
            catch { }
        }

        private void MainWindow_StateChanged(object sender, EventArgs e)
        {
            if (WindowState == WindowState.Minimized)
            {
                Hide();
                if (!CheckHasShownTrayTipPersisted())
                {
                    MarkTrayTipShownPersisted();
                    trayIcon.ShowBalloonTip(1500, "AntigravityCodexBridge", "程序仍在后台运行，双击托盘图标可重新打开", System.Windows.Forms.ToolTipIcon.Info);
                }
            }
        }

        private void MainWindow_Closing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (closeAction == "exit")
            {
                ExitApplication();
                return;
            }

            e.Cancel = true;
            Hide();
            if (!CheckHasShownTrayTipPersisted())
            {
                MarkTrayTipShownPersisted();
                trayIcon.ShowBalloonTip(1500, "AntigravityCodexBridge", "程序仍在后台运行，双击托盘图标可重新打开", System.Windows.Forms.ToolTipIcon.Info);
            }
        }

        private void ExitApplication()
        {
            trayIcon.Visible = false;
            try
            {
                if (floatingHud != null)
                {
                    floatingHud.Close();
                }
            }
            catch { }

            try
            {
                SendApiPost("api/codex/restore", "{}");
                Thread.Sleep(300);
            }
            catch { }

            try
            {
                if (nodeProcess != null && !nodeProcess.HasExited)
                {
                    nodeProcess.Kill();
                }
            }
            catch { }

            System.Windows.Application.Current.Shutdown();
        }

        private void CleanupStaleBackendProcesses()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -Command \"Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } ; Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*server.mjs*' } | Stop-Process -Force -ErrorAction SilentlyContinue\"",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(1500);
                }
            }
            catch { }
        }

        private string FindNodeExecutablePath()
        {
            string[] candidates = new string[]
            {
                "D:\\WeGameApps\\node\\node.exe",
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Program Files (x86)\\nodejs\\node.exe",
                System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "node", "node.exe")
            };

            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }

            return "node.exe";
        }

        private void StartBackendServer()
        {
            try
            {
                CleanupStaleBackendProcesses();
                Thread.Sleep(200);

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = FindNodeExecutablePath();
                psi.Arguments = "server.mjs";
                psi.WorkingDirectory = appDir;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.EnvironmentVariables["BRIDGE_NO_OPEN"] = "1";

                nodeProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                txtTopStatus.Text = "启动服务失败: " + ex.Message;
            }
        }

        private void LoadBridgeKey()
        {
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string settingsPath = System.IO.Path.Combine(localAppData, "AntigravityCodexBridge", "settings.json");
                if (File.Exists(settingsPath))
                {
                    string content = File.ReadAllText(settingsPath);
                    var dict = jsonSerializer.Deserialize<Dictionary<string, object>>(content);
                    if (dict != null && dict.ContainsKey("uiKey"))
                    {
                        bridgeKey = dict["uiKey"].ToString();
                    }
                }
            }
            catch { }
        }

        private string SendApiGet(string endpoint)
        {
            if (string.IsNullOrEmpty(bridgeKey)) LoadBridgeKey();
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(apiUrl + endpoint.TrimStart('/'));
            req.Method = "GET";
            req.Timeout = 3500;
            if (!string.IsNullOrEmpty(bridgeKey)) req.Headers["X-Bridge-Key"] = bridgeKey;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private string SendApiPost(string endpoint, string jsonBody = "{}", int timeoutMs = 12000)
        {
            if (string.IsNullOrEmpty(bridgeKey)) LoadBridgeKey();
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(apiUrl + endpoint.TrimStart('/'));
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            if (!string.IsNullOrEmpty(bridgeKey)) req.Headers["X-Bridge-Key"] = bridgeKey;
            byte[] bytes = Encoding.UTF8.GetBytes(jsonBody);
            req.ContentLength = bytes.Length;
            using (Stream os = req.GetRequestStream())
            {
                os.Write(bytes, 0, bytes.Length);
            }
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private void FetchDashboardData()
        {
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    string json = SendApiGet("api/dashboard");
                    var data = jsonSerializer.Deserialize<Dictionary<string, object>>(json);
                    Dispatcher.Invoke(() => UpdateUiFromData(data));
                }
                catch
                {
                    Dispatcher.Invoke(() =>
                    {
                        dotTopStatus.Fill = new SolidColorBrush(ColRed);
                        txtTopStatus.Text = "等待本地服务连接...";
                    });
                }
            });
        }

        private void UpdateUiFromData(Dictionary<string, object> data)
        {
            if (data == null) return;

            // Proxy State
            var proxy = data.ContainsKey("proxy") ? data["proxy"] as Dictionary<string, object> : null;
            bool isOnline = proxy != null && proxy.ContainsKey("running") && Convert.ToBoolean(proxy["running"]);
            isCoreRunning = isOnline;

            dotTopStatus.Fill = isOnline ? new SolidColorBrush(ColGreen) : new SolidColorBrush(ColRed);
            txtTopStatus.Text = isOnline ? "核心服务在线 (127.0.0.1:8787)" : "核心服务离线";
            btnToggleCore.Content = isOnline ? "停止服务" : "启动服务";
            txtMetricCore.Text = isOnline ? "ON" : "OFF";
            txtMetricCore.Foreground = isOnline ? new SolidColorBrush(ColGreen) : new SolidColorBrush(ColRed);

            // Codex Takeover
            var codex = data.ContainsKey("codex") ? data["codex"] as Dictionary<string, object> : null;
            bool isCodexActive = codex != null && codex.ContainsKey("active") && Convert.ToBoolean(codex["active"]);
            refreshTimer.Interval = isCodexActive ? TimeSpan.FromMilliseconds(1000) : TimeSpan.FromMilliseconds(2500);
            if (isCodexActive)
            {
                badgeMode.Background = new SolidColorBrush(ColPrimaryLight);
                badgeMode.BorderBrush = new SolidColorBrush(ColPrimary);
                txtMode.Text = "⚡ Antigravity 接管中";
                txtMode.Foreground = new SolidColorBrush(ColPrimary);
            }
            else
            {
                badgeMode.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 245, 158, 11));
                badgeMode.BorderBrush = new SolidColorBrush(ColAmber);
                txtMode.Text = "🔒 官方原生模式";
                txtMode.Foreground = new SolidColorBrush(isDarkMode ? ColAmber : System.Windows.Media.Color.FromRgb(180, 83, 9));
            }

            // Real-time Session Telemetry (Throughput & Latency)
            var telemetry = data.ContainsKey("telemetry") ? data["telemetry"] as Dictionary<string, object> : null;
            double avgTps = 0;
            int avgTtft = 0;
            double lastTps = 0;
            int lastTtft = 0;

            if (telemetry != null)
            {
                if (telemetry.ContainsKey("avgTokensPerSec") && telemetry["avgTokensPerSec"] != null)
                {
                    double.TryParse(telemetry["avgTokensPerSec"].ToString(), out avgTps);
                }
                if (telemetry.ContainsKey("avgTtftMs") && telemetry["avgTtftMs"] != null)
                {
                    int.TryParse(telemetry["avgTtftMs"].ToString(), out avgTtft);
                }
                if (telemetry.ContainsKey("lastTokensPerSec") && telemetry["lastTokensPerSec"] != null)
                {
                    double.TryParse(telemetry["lastTokensPerSec"].ToString(), out lastTps);
                }
                if (telemetry.ContainsKey("lastTtftMs") && telemetry["lastTtftMs"] != null)
                {
                    int.TryParse(telemetry["lastTtftMs"].ToString(), out lastTtft);
                }
            }

            if (avgTps > 0)
            {
                txtMetricThroughput.Text = avgTps.ToString("0.0") + " t/s";
                txtMetricThroughput.Foreground = new SolidColorBrush(ColPrimary);
                txtMetricThroughput.ToolTip = string.Format("会话全局加权均速: {0:0.0} t/s (最近单次: {1:0.0} t/s)", avgTps, lastTps);

                txtMetricLatency.Text = avgTtft.ToString() + " ms";
                txtMetricLatency.Foreground = new SolidColorBrush(ColGreen);
                txtMetricLatency.ToolTip = string.Format("会话平均首字延迟: {0} ms (最近单次: {1} ms)", avgTtft, lastTtft);
            }
            else
            {
                txtMetricThroughput.Text = "-- t/s";
                txtMetricThroughput.Foreground = new SolidColorBrush(ColTextMuted);
                txtMetricThroughput.ToolTip = "暂无活跃生成测速数据";

                txtMetricLatency.Text = "-- ms";
                txtMetricLatency.Foreground = new SolidColorBrush(ColTextMuted);
                txtMetricLatency.ToolTip = "暂无活跃生成延迟数据";
            }

            // Settings & Round-Robin Mode
            var settings = data.ContainsKey("settings") ? data["settings"] as Dictionary<string, object> : null;
            string currentModel = settings != null && settings.ContainsKey("defaultModel") ? settings["defaultModel"].ToString() : "gemini-3.7-flash-high";

            if (settings != null)
            {
                if (settings.ContainsKey("autoRoundRobin"))
                {
                    autoRoundRobin = Convert.ToBoolean(settings["autoRoundRobin"]);
                }
                if (settings.ContainsKey("activeAccountId") && settings["activeAccountId"] != null)
                {
                    activeAccountId = settings["activeAccountId"].ToString();
                }
            }
            UpdateRoundRobinButtonUI();

            // Accounts List & Quota for Floating HUD
            var accounts = data.ContainsKey("accounts") ? data["accounts"] as ArrayList : null;
            txtMetricAccounts.Text = accounts != null ? accounts.Count.ToString() : "0";

            int hud5h = -1;
            int hudWeekly = -1;
            if (accounts != null && accounts.Count > 0)
            {
                for (int i = 0; i < accounts.Count; i++)
                {
                    var acc = accounts[i] as Dictionary<string, object>;
                    if (acc == null) continue;
                    string email = acc.ContainsKey("email") ? acc["email"].ToString() : "";
                    string accId = acc.ContainsKey("id") ? acc["id"].ToString() : email;
                    bool isActive = (accId == activeAccountId || email == activeAccountId || (string.IsNullOrEmpty(activeAccountId) && i == 0));
                    if (isActive)
                    {
                        var quota = acc.ContainsKey("quota") ? acc["quota"] as Dictionary<string, object> : null;
                        var summary = quota != null && quota.ContainsKey("summary") ? quota["summary"] as Dictionary<string, object>
                            : (quota != null && quota.ContainsKey("quota_summary") ? quota["quota_summary"] as Dictionary<string, object>
                            : (quota != null && quota.ContainsKey("quotaSummary") ? quota["quotaSummary"] as Dictionary<string, object> : null));
                        var qGroups = summary != null && summary.ContainsKey("groups") ? summary["groups"] as IEnumerable : null;
                        if (qGroups != null)
                        {
                            foreach (var gObj in qGroups)
                            {
                                var g = gObj as Dictionary<string, object>;
                                if (g == null) continue;
                                string gName = g.ContainsKey("displayName") ? g["displayName"].ToString() : "";
                                var buckets = g.ContainsKey("buckets") ? g["buckets"] as IEnumerable : null;
                                if (buckets != null && (gName.IndexOf("Gemini", StringComparison.OrdinalIgnoreCase) >= 0 || hud5h < 0))
                                {
                                    foreach (var bObj in buckets)
                                    {
                                        var b = bObj as Dictionary<string, object>;
                                        if (b == null) continue;
                                        string w = b.ContainsKey("window") ? b["window"].ToString() : (b.ContainsKey("bucketId") ? b["bucketId"].ToString() : "");
                                        double frac = 1.0;
                                        if (b.ContainsKey("remainingFraction") && b["remainingFraction"] != null)
                                        {
                                            double.TryParse(b["remainingFraction"].ToString(), out frac);
                                        }
                                        if (w.Contains("5h") || w.Contains("five")) hud5h = (int)Math.Round(frac * 100);
                                        else if (w.Contains("week")) hudWeekly = (int)Math.Round(frac * 100);
                                    }
                                }
                            }
                        }
                        break;
                    }
                }
            }

            // Low Quota Alert & Failover Toast Notifications
            if (hud5h >= 0 && hud5h <= 15 && lastAlerted5hQuota > 15)
            {
                if (trayIcon != null)
                {
                    trayIcon.ShowBalloonTip(3500, "ABC 额度紧张预警", string.Format("当前生效账号的 5 小时可用额度仅剩 {0}%，建议切换备用账号或稍作休息。", hud5h), System.Windows.Forms.ToolTipIcon.Warning);
                }
                lastAlerted5hQuota = hud5h;
            }
            else if (hud5h > 25)
            {
                lastAlerted5hQuota = 100;
            }

            if (!string.IsNullOrEmpty(lastActiveAccountId) && !string.IsNullOrEmpty(activeAccountId) && lastActiveAccountId != activeAccountId && autoRoundRobin)
            {
                if (trayIcon != null)
                {
                    trayIcon.ShowBalloonTip(2500, "ABC 自动轮询调度", "已自动故障转移切换至账号: " + activeAccountId, System.Windows.Forms.ToolTipIcon.Info);
                }
            }
            lastActiveAccountId = activeAccountId;

            double hudTps = lastTps > 0 ? lastTps : avgTps;
            int hudTtft = lastTtft > 0 ? lastTtft : avgTtft;

            if (floatingHud != null && floatingHud.IsVisible)
            {
                floatingHud.UpdateData(hudTps, hudTtft, hud5h);
            }

            // Models
            var models = data.ContainsKey("models") ? data["models"] as ArrayList : null;

            if (models != null && models.Count > 0)
            {
                List<KeyValuePair<string, string>> modelList = new List<KeyValuePair<string, string>>();
                foreach (var mObj in models)
                {
                    var mDict = mObj as Dictionary<string, object>;
                    if (mDict == null) continue;
                    string id = mDict.ContainsKey("id") ? mDict["id"].ToString() : "";
                    string displayName = GetFriendlyModelName(id);
                    modelList.Add(new KeyValuePair<string, string>(id, displayName));
                }
                modelPicker.SetModels(modelList, currentModel);
                UpdateTrayModelsMenu(modelList, currentModel);
                if (floatingHud != null)
                {
                    floatingHud.UpdateModelsMenu(modelList, currentModel);
                }
            }

            RenderAccountsList(accounts);
        }

        private void UpdateRoundRobinButtonUI()
        {
            if (btnToggleRoundRobin == null) return;
            if (autoRoundRobin)
            {
                btnToggleRoundRobin.Background = new SolidColorBrush(ColPrimaryLight);
                btnToggleRoundRobin.Foreground = new SolidColorBrush(ColPrimaryDark);
                btnToggleRoundRobin.Content = "🔄 自动轮询: 开启";
                btnToggleRoundRobin.ToolTip = "多账号自动轮询与 429 智能故障转移已启用。点击可切换为手动指定账号模式。";
            }
            else
            {
                btnToggleRoundRobin.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 245, 158, 11));
                btnToggleRoundRobin.Foreground = new SolidColorBrush(isDarkMode ? ColAmber : System.Windows.Media.Color.FromRgb(180, 83, 9));
                btnToggleRoundRobin.Content = "🎯 手动指定: 开启";
                btnToggleRoundRobin.ToolTip = "当前为手动指定账号模式，仅选中的单账号处理请求。点击可切换回自动轮询。";
            }
        }

        private void ToggleRoundRobinMode()
        {
            btnToggleRoundRobin.IsEnabled = false;
            bool nextMode = !autoRoundRobin;
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    SendApiPost("api/accounts/mode", "{\"autoRoundRobin\":" + (nextMode ? "true" : "false") + "}");
                    Dispatcher.Invoke(() =>
                    {
                        btnToggleRoundRobin.IsEnabled = true;
                        FetchDashboardData();
                        ShowToast(nextMode ? "🔄 已开启多账号自动轮询调度" : "🎯 已切换为手动指定单账号模式");
                    });
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() =>
                    {
                        btnToggleRoundRobin.IsEnabled = true;
                        MessageBox.Show("切换调度模式失败: " + ex.Message, "AntigravityCodexBridge");
                    });
                }
            });
        }

        private void SelectActiveAccount(string accountId, string email)
        {
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    SendApiPost("api/accounts/select", "{\"accountId\":\"" + accountId + "\"}");
                    Dispatcher.Invoke(() =>
                    {
                        FetchDashboardData();
                        ShowToast("✓ 账号已切换为: " + email);
                    });
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() => MessageBox.Show("切换指定生效账号失败: " + ex.Message, "AntigravityCodexBridge"));
                }
            });
        }

        private void DeleteAccount(string name, string email)
        {
            MessageBoxResult result = MessageBox.Show(
                "确定要从本地移除账号 [" + email + "] 吗？\n\n移除后该凭据文件将被删除，不再参与轮询与额度展示。",
                "移除账号确认",
                MessageBoxButton.YesNo,
                MessageBoxImage.Question
            );
            if (result != MessageBoxResult.Yes) return;

            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    SendApiPost("api/account/delete", "{\"name\":\"" + name + "\"}");
                    Dispatcher.Invoke(() =>
                    {
                        ShowToast("✓ 账号已从本地成功移除: " + email);
                        FetchDashboardData();
                    });
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() =>
                    {
                        ShowToast("⚠️ 移除账号失败: " + ex.Message);
                    });
                }
            });
        }

        private void RenderAccountsList(ArrayList accounts)
        {
            panelAccounts.Children.Clear();

            if (accounts == null || accounts.Count == 0)
            {
                Border emptyCard = new Border
                {
                    Background = new SolidColorBrush(ColCard),
                    BorderBrush = new SolidColorBrush(ColBorder),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(12),
                    Padding = new Thickness(24),
                    Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 10, Opacity = 0.03, ShadowDepth = 1 }
                };
                emptyCard.Child = new TextBlock
                {
                    Text = "尚未登录 Google 账号，点击右上角【+ 登录 Google 账号】完成授权后即可开始使用。",
                    Foreground = new SolidColorBrush(ColTextMuted),
                    FontSize = 12.5,
                    HorizontalAlignment = HorizontalAlignment.Center
                };
                panelAccounts.Children.Add(emptyCard);
                return;
            }

            bool isTwoColumns = accounts.Count > 1;
            Grid accGrid = new Grid();
            if (isTwoColumns)
            {
                accGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                accGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            }
            else
            {
                accGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            }

            for (int i = 0; i < accounts.Count; i++)
            {
                var acc = accounts[i] as Dictionary<string, object>;
                if (acc == null) continue;

                string email = acc.ContainsKey("email") ? acc["email"].ToString() : (acc.ContainsKey("name") ? acc["name"].ToString() : "Google User");
                string accId = acc.ContainsKey("id") ? acc["id"].ToString() : (acc.ContainsKey("name") ? acc["name"].ToString() : email);

                bool isThisAccountActive = (accId == activeAccountId || email == activeAccountId || (string.IsNullOrEmpty(activeAccountId) && i == 0));
                Border card = BuildAccountCard(acc, accId, email, i, isThisAccountActive, autoRoundRobin);

                if (isTwoColumns)
                {
                    int col = i % 2;
                    int row = i / 2;
                    while (accGrid.RowDefinitions.Count <= row)
                    {
                        accGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                    }
                    card.Margin = new Thickness(col == 0 ? 0 : 4, 0, col == 1 ? 0 : 4, 8);
                    Grid.SetColumn(card, col);
                    Grid.SetRow(card, row);
                    accGrid.Children.Add(card);
                }
                else
                {
                    card.Margin = new Thickness(0, 0, 0, 8);
                    Grid.SetColumn(card, 0);
                    accGrid.Children.Add(card);
                }
            }

            panelAccounts.Children.Add(accGrid);
        }

        private Border BuildAccountCard(Dictionary<string, object> acc, string accId, string email, int index, bool isThisAccountActive, bool autoRoundRobin)
        {
            string capturedId = accId;
            string capturedEmail = email;
            bool isClickable = (!isThisAccountActive || autoRoundRobin);

            Border card = new Border
            {
                Background = new SolidColorBrush(ColCard),
                BorderBrush = (!autoRoundRobin && isThisAccountActive) ? new SolidColorBrush(ColPrimary) : new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness((!autoRoundRobin && isThisAccountActive) ? 1.8 : 1),
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(12, 10, 12, 10),
                Effect = new DropShadowEffect { Color = (!autoRoundRobin && isThisAccountActive) ? ColPrimary : System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = (!autoRoundRobin && isThisAccountActive) ? 10 : 8, Opacity = (!autoRoundRobin && isThisAccountActive) ? 0.14 : 0.03, ShadowDepth = 1.5 }
            };

            if (isClickable)
            {
                card.Cursor = Cursors.Hand;
                card.MouseEnter += (s, e) =>
                {
                    card.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(147, 197, 253));
                    card.Background = new SolidColorBrush(isDarkMode ? System.Windows.Media.Color.FromRgb(26, 36, 56) : System.Windows.Media.Color.FromRgb(248, 250, 252));
                };
                card.MouseLeave += (s, e) =>
                {
                    card.BorderBrush = (!autoRoundRobin && isThisAccountActive) ? new SolidColorBrush(ColPrimary) : new SolidColorBrush(ColBorder);
                    card.Background = new SolidColorBrush(ColCard);
                };
                card.MouseLeftButtonUp += (s, e) =>
                {
                    SelectActiveAccount(capturedId, capturedEmail);
                };
            }

            StackPanel cardStack = new StackPanel();

            string status = acc.ContainsKey("status") ? acc["status"].ToString() : "";
            string statusMessage = acc.ContainsKey("statusMessage") ? acc["statusMessage"].ToString() : "";
            string health = acc.ContainsKey("health") ? acc["health"].ToString() : status;
            bool isReauthNeeded = health == "reauth" || status == "reauth";

            // 1. Top Header Row (Avatar, Email, Status Dot, Active Pill, Delete Button)
            Grid headerGrid = new Grid { Margin = new Thickness(0, 0, 0, 8) };
            headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            StackPanel userLeft = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            
            Border avatar = new Border
            {
                Width = 24,
                Height = 24,
                CornerRadius = new CornerRadius(12),
                Background = isReauthNeeded ? new SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 239, 68, 68)) : new SolidColorBrush(ColPrimaryLight),
                BorderBrush = isReauthNeeded ? new SolidColorBrush(ColRed) : new SolidColorBrush(ColPrimary),
                BorderThickness = new Thickness(1),
                Margin = new Thickness(0, 0, 6, 0)
            };
            avatar.Child = new TextBlock
            {
                Text = (string.IsNullOrEmpty(email) ? "G" : email.Substring(0, 1).ToUpper()),
                FontWeight = FontWeights.Bold,
                FontSize = 11.5,
                Foreground = isReauthNeeded ? new SolidColorBrush(ColRed) : new SolidColorBrush(ColPrimary),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            userLeft.Children.Add(avatar);

            TextBlock txtEmail = new TextBlock
            {
                Text = email,
                FontWeight = FontWeights.Bold,
                FontSize = 12,
                Foreground = new SolidColorBrush(ColTextMain),
                MaxWidth = 175,
                TextTrimming = TextTrimming.CharacterEllipsis,
                VerticalAlignment = VerticalAlignment.Center
            };
            userLeft.Children.Add(txtEmail);

            TextBlock statusTxt = new TextBlock
            {
                Text = isReauthNeeded ? "● 需重登" : (health == "cooldown" ? "● 429冷却" : (health == "disabled" ? "● 停用" : "● 就绪")),
                FontSize = 9.5,
                FontWeight = FontWeights.SemiBold,
                Foreground = isReauthNeeded ? new SolidColorBrush(ColRed) : (health == "cooldown" ? new SolidColorBrush(ColAmber) : (health == "disabled" ? new SolidColorBrush(ColTextMuted) : new SolidColorBrush(ColGreen))),
                Margin = new Thickness(6, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            userLeft.Children.Add(statusTxt);
            Grid.SetColumn(userLeft, 0);
            headerGrid.Children.Add(userLeft);

            // Right actions in Header
            StackPanel userRight = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };

            if (autoRoundRobin)
            {
                Border pillAuto = new Border
                {
                    Background = isReauthNeeded ? new SolidColorBrush(System.Windows.Media.Color.FromArgb(20, 239, 68, 68)) : new SolidColorBrush(ColPrimaryLight),
                    CornerRadius = new CornerRadius(5),
                    Padding = new Thickness(6, 2, 6, 2)
                };
                pillAuto.Child = new TextBlock
                {
                    Text = isReauthNeeded ? "⚠️ 跳过轮询" : "🔄 自动轮询",
                    FontSize = 9.5,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = isReauthNeeded ? new SolidColorBrush(ColRed) : new SolidColorBrush(ColPrimary)
                };
                userRight.Children.Add(pillAuto);
            }
            else
            {
                if (isThisAccountActive)
                {
                    Border pillActive = new Border
                    {
                        Background = new SolidColorBrush(ColPrimaryLight),
                        BorderBrush = new SolidColorBrush(ColPrimary),
                        BorderThickness = new Thickness(1),
                        CornerRadius = new CornerRadius(5),
                        Padding = new Thickness(6, 2, 6, 2)
                    };
                    pillActive.Child = new TextBlock { Text = "⭐ 生效中", FontSize = 9.5, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColPrimaryDark) };
                    userRight.Children.Add(pillActive);
                }
                else
                {
                    Border pillIdle = new Border
                    {
                        Background = new SolidColorBrush(ColCardMuted),
                        BorderBrush = new SolidColorBrush(ColBorder),
                        BorderThickness = new Thickness(1),
                        CornerRadius = new CornerRadius(5),
                        Padding = new Thickness(6, 2, 6, 2)
                    };
                    pillIdle.Child = new TextBlock { Text = "👉 指定", FontSize = 9.5, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColTextMuted) };
                    userRight.Children.Add(pillIdle);
                }
            }

            Button btnDeleteAcc = new Button
            {
                Content = "🗑️",
                FontSize = 10.5,
                Foreground = new SolidColorBrush(ColTextMuted),
                Background = System.Windows.Media.Brushes.Transparent,
                BorderThickness = new Thickness(0),
                Cursor = Cursors.Hand,
                Margin = new Thickness(6, 0, 0, 0),
                Padding = new Thickness(3, 1, 3, 1),
                VerticalAlignment = VerticalAlignment.Center,
                ToolTip = "移除此账号凭据"
            };
            btnDeleteAcc.MouseEnter += (s, e) => { btnDeleteAcc.Foreground = new SolidColorBrush(ColRed); };
            btnDeleteAcc.MouseLeave += (s, e) => { btnDeleteAcc.Foreground = new SolidColorBrush(ColTextMuted); };
            btnDeleteAcc.Click += (s, e) =>
            {
                e.Handled = true;
                DeleteAccount(capturedId, capturedEmail);
            };
            userRight.Children.Add(btnDeleteAcc);
            Grid.SetColumn(userRight, 1);
            headerGrid.Children.Add(userRight);

            cardStack.Children.Add(headerGrid);

            // 2. Bottom Quota Section
            if (isReauthNeeded)
            {
                Border reauthBox = new Border
                {
                    Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(20, 239, 68, 68)),
                    BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(80, 239, 68, 68)),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(8),
                    Padding = new Thickness(12, 8, 12, 8)
                };
                Grid rGrid = new Grid();
                rGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                rGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                TextBlock rTitle = new TextBlock
                {
                    Text = "⚠️ 凭据已失效，请点击右侧重新授权",
                    FontSize = 11,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = new SolidColorBrush(ColRed),
                    VerticalAlignment = VerticalAlignment.Center
                };
                Grid.SetColumn(rTitle, 0);
                rGrid.Children.Add(rTitle);

                Button btnReauth = CreateButton("🔑 重登", ColRed, System.Windows.Media.Brushes.White, 11, true);
                btnReauth.Padding = new Thickness(10, 4, 10, 4);
                btnReauth.Click += (s, e) => StartOAuthLogin();
                Grid.SetColumn(btnReauth, 1);
                rGrid.Children.Add(btnReauth);

                reauthBox.Child = rGrid;
                cardStack.Children.Add(reauthBox);
            }
            else
            {
                var quota = acc.ContainsKey("quota") ? acc["quota"] as Dictionary<string, object> : null;
                var summary = quota != null && quota.ContainsKey("summary") ? quota["summary"] as Dictionary<string, object>
                    : (quota != null && quota.ContainsKey("quota_summary") ? quota["quota_summary"] as Dictionary<string, object>
                    : (quota != null && quota.ContainsKey("quotaSummary") ? quota["quotaSummary"] as Dictionary<string, object> : null));
                var qGroups = summary != null && summary.ContainsKey("groups") ? summary["groups"] as IEnumerable : null;
                var qModels = quota != null && quota.ContainsKey("models") ? quota["models"] as IEnumerable : null;

                int geminiFiveHour = 100;
                string geminiFiveHourReset = "5小时周期重置";
                int geminiWeekly = 100;
                string geminiWeeklyReset = "周度周期重置";

                int claudeFiveHour = 100;
                string claudeFiveHourReset = "5小时周期重置";
                int claudeWeekly = 100;
                string claudeWeeklyReset = "周度周期重置";

                bool parsedFromSummary = false;
                if (qGroups != null)
                {
                    foreach (var gObj in qGroups)
                    {
                        var g = gObj as Dictionary<string, object>;
                        if (g == null) continue;
                        string gName = g.ContainsKey("displayName") ? g["displayName"].ToString() : "";
                        var buckets = g.ContainsKey("buckets") ? g["buckets"] as IEnumerable : null;
                        if (buckets == null) continue;

                        parsedFromSummary = true;
                        bool isGeminiGroup = gName.IndexOf("Gemini", StringComparison.OrdinalIgnoreCase) >= 0;
                        bool isClaudeGroup = gName.IndexOf("Claude", StringComparison.OrdinalIgnoreCase) >= 0 || gName.IndexOf("3p", StringComparison.OrdinalIgnoreCase) >= 0;

                        foreach (var bObj in buckets)
                        {
                            var b = bObj as Dictionary<string, object>;
                            if (b == null) continue;
                            string w = b.ContainsKey("window") ? b["window"].ToString() : (b.ContainsKey("bucketId") ? b["bucketId"].ToString() : "");
                            double frac = 1.0;
                            if (b.ContainsKey("remainingFraction") && b["remainingFraction"] != null)
                            {
                                double.TryParse(b["remainingFraction"].ToString(), out frac);
                            }
                            string rawReset = b.ContainsKey("resetTime") && b["resetTime"] != null ? b["resetTime"].ToString() : "";
                            string formattedReset = !string.IsNullOrEmpty(rawReset) ? FormatResetTime(rawReset) : "";

                            if (isGeminiGroup)
                            {
                                if (w.Contains("5h") || w.Contains("five"))
                                {
                                    geminiFiveHour = (int)Math.Round(frac * 100);
                                    if (!string.IsNullOrEmpty(formattedReset)) geminiFiveHourReset = formattedReset;
                                }
                                else if (w.Contains("week"))
                                {
                                    geminiWeekly = (int)Math.Round(frac * 100);
                                    if (!string.IsNullOrEmpty(formattedReset)) geminiWeeklyReset = formattedReset;
                                }
                            }
                            else if (isClaudeGroup)
                            {
                                if (w.Contains("5h") || w.Contains("five"))
                                {
                                    claudeFiveHour = (int)Math.Round(frac * 100);
                                    if (!string.IsNullOrEmpty(formattedReset)) claudeFiveHourReset = formattedReset;
                                }
                                else if (w.Contains("week"))
                                {
                                    claudeWeekly = (int)Math.Round(frac * 100);
                                    if (!string.IsNullOrEmpty(formattedReset)) claudeWeeklyReset = formattedReset;
                                }
                            }
                        }
                    }
                }

                if (!parsedFromSummary && qModels != null)
                {
                    double minGeminiFiveHour = 1.0;
                    double minGeminiWeekly = 1.0;
                    bool hasGeminiFiveHourReset = false;
                    bool hasGeminiWeeklyReset = false;

                    double minClaudeFiveHour = 1.0;
                    double minClaudeWeekly = 1.0;
                    bool hasClaudeFiveHourReset = false;
                    bool hasClaudeWeeklyReset = false;

                    foreach (var mObj in qModels)
                    {
                        var m = mObj as Dictionary<string, object>;
                        if (m == null) continue;
                        string mId = m.ContainsKey("id") ? m["id"].ToString() : "";
                        double frac = 1.0;
                        if (m.ContainsKey("remainingFraction") && m["remainingFraction"] != null)
                        {
                            double.TryParse(m["remainingFraction"].ToString(), out frac);
                        }
                        string rawReset = m.ContainsKey("resetTime") && m["resetTime"] != null ? m["resetTime"].ToString() : "";

                        bool isWeekly = false;
                        double spanHours = 0.0;
                        if (!string.IsNullOrEmpty(rawReset))
                        {
                            DateTime utc;
                            if (DateTime.TryParse(rawReset, null, DateTimeStyles.AdjustToUniversal, out utc))
                            {
                                TimeSpan span = utc - DateTime.UtcNow;
                                spanHours = span.TotalHours;
                                if (spanHours > 6.0) isWeekly = true;
                            }
                        }
                        if (mId.Contains("tiered") || mId.Contains("pro") || mId.Contains("weekly")) isWeekly = true;

                        if (mId.StartsWith("gemini-"))
                        {
                            if (isWeekly)
                            {
                                if (frac < minGeminiWeekly) minGeminiWeekly = frac;
                                if (!hasGeminiWeeklyReset && !string.IsNullOrEmpty(rawReset) && spanHours > 6.0)
                                {
                                    geminiWeeklyReset = FormatResetTime(rawReset);
                                    hasGeminiWeeklyReset = true;
                                }
                            }
                            else
                            {
                                if (frac < minGeminiFiveHour) minGeminiFiveHour = frac;
                                if (!hasGeminiFiveHourReset && !string.IsNullOrEmpty(rawReset))
                                {
                                    geminiFiveHourReset = FormatResetTime(rawReset);
                                    hasGeminiFiveHourReset = true;
                                }
                            }
                        }
                        else if (mId.StartsWith("claude-") || mId.StartsWith("gpt-"))
                        {
                            if (isWeekly)
                            {
                                if (frac < minClaudeWeekly) minClaudeWeekly = frac;
                                if (!hasClaudeWeeklyReset && !string.IsNullOrEmpty(rawReset) && spanHours > 6.0)
                                {
                                    claudeWeeklyReset = FormatResetTime(rawReset);
                                    hasClaudeWeeklyReset = true;
                                }
                            }
                            else
                            {
                                if (frac < minClaudeFiveHour) minClaudeFiveHour = frac;
                                if (!hasClaudeFiveHourReset && !string.IsNullOrEmpty(rawReset))
                                {
                                    claudeFiveHourReset = FormatResetTime(rawReset);
                                    hasClaudeFiveHourReset = true;
                                }
                            }
                        }
                    }

                    geminiFiveHour = (int)Math.Round(minGeminiFiveHour * 100);
                    geminiWeekly = (int)Math.Round(minGeminiWeekly * 100);
                    claudeFiveHour = (int)Math.Round(minClaudeFiveHour * 100);
                    claudeWeekly = (int)Math.Round(minClaudeWeekly * 100);
                }

                Grid groupsGrid = new Grid();
                groupsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                groupsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

                UIElement geminiGroupCard = CreateUnifiedQuotaGroupCard("🔮 Gemini 模型", "5小时/周度限额", geminiFiveHour, geminiFiveHourReset, geminiWeekly, geminiWeeklyReset, false);
                Grid.SetColumn((FrameworkElement)geminiGroupCard, 0);
                groupsGrid.Children.Add(geminiGroupCard);

                UIElement claudeGroupCard = CreateUnifiedQuotaGroupCard("⚡ Claude & GPT", "3P模型独立池", claudeFiveHour, claudeFiveHourReset, claudeWeekly, claudeWeeklyReset, true);
                Grid.SetColumn((FrameworkElement)claudeGroupCard, 1);
                groupsGrid.Children.Add(claudeGroupCard);

                cardStack.Children.Add(groupsGrid);
            }

            card.Child = cardStack;
            return card;
        }

        private string FormatResetTime(string rawUtc)
        {
            try
            {
                DateTime utc;
                if (DateTime.TryParse(rawUtc, null, DateTimeStyles.AdjustToUniversal, out utc))
                {
                    DateTime local = utc.ToLocalTime();
                    TimeSpan span = utc - DateTime.UtcNow;
                    string countdown = "已重置";
                    if (span.TotalMinutes > 0)
                    {
                        if (span.TotalDays >= 1)
                        {
                            countdown = ((int)Math.Ceiling(span.TotalDays)).ToString() + "天后刷新";
                            return local.ToString("M月d日 HH:mm") + " (" + countdown + ")";
                        }
                        else if (span.Hours > 0)
                        {
                            countdown = span.Hours.ToString() + "小时" + span.Minutes.ToString() + "分后刷新";
                            return local.ToString("HH:mm") + " (" + countdown + ")";
                        }
                        else
                        {
                            countdown = span.Minutes.ToString() + "分后刷新";
                            return local.ToString("HH:mm") + " (" + countdown + ")";
                        }
                    }
                    return local.ToString("HH:mm") + " (" + countdown + ")";
                }
            }
            catch { }
            return rawUtc;
        }

        private UIElement CreateUnifiedQuotaGroupCard(string title, string subtitle, int fiveHourPercent, string fiveHourReset, int weeklyPercent, string weeklyReset, bool isRight = false)
        {
            Border groupBorder = new Border
            {
                Background = new SolidColorBrush(ColCardMuted),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(8, 6, 8, 6),
                Margin = new Thickness(isRight ? 3 : 0, 0, isRight ? 0 : 3, 0)
            };
            StackPanel sp = new StackPanel();

            // Header
            StackPanel header = new StackPanel { Margin = new Thickness(0, 0, 0, 5) };
            header.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.Bold, FontSize = 11, Foreground = new SolidColorBrush(ColTextMain) });
            header.Children.Add(new TextBlock { Text = subtitle, FontSize = 8.5, Foreground = new SolidColorBrush(ColTextMuted), Margin = new Thickness(0, 1, 0, 0) });
            sp.Children.Add(header);

            // Row 1: 5-Hour Limit
            sp.Children.Add(CreateQuotaMeterRow("5小时剩余", fiveHourPercent, fiveHourReset));

            // Row 2: Weekly Limit
            sp.Children.Add(CreateQuotaMeterRow("周剩余", weeklyPercent, weeklyReset, true));

            groupBorder.Child = sp;
            return groupBorder;
        }

        private UIElement CreateQuotaMeterRow(string label, int percent, string resetInfo, bool isWeekly = false)
        {
            Border row = new Border
            {
                Background = new SolidColorBrush(ColCard),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(6, 3, 6, 3),
                Margin = new Thickness(0, 0, 0, isWeekly ? 0 : 3)
            };
            Grid grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(24) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            // Circular Ring
            Grid circleGrid = new Grid { Width = 20, Height = 20, VerticalAlignment = VerticalAlignment.Center };
            System.Windows.Shapes.Ellipse bgCircle = new System.Windows.Shapes.Ellipse
            {
                Width = 20,
                Height = 20,
                Stroke = new SolidColorBrush(ColBorder),
                StrokeThickness = 2.2
            };
            circleGrid.Children.Add(bgCircle);

            System.Windows.Media.Color ringColor = GetQuotaColor(percent);

            System.Windows.Shapes.Path progressPath = new System.Windows.Shapes.Path
            {
                Stroke = new SolidColorBrush(ringColor),
                StrokeThickness = 2.2,
                StrokeEndLineCap = PenLineCap.Round,
                Data = CreateArcGeometry(10, 10, 8.5, 0, (percent / 100.0) * 359.9)
            };
            circleGrid.Children.Add(progressPath);
            Grid.SetColumn(circleGrid, 0);
            grid.Children.Add(circleGrid);

            // Center Text Info
            StackPanel textGroup = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(5, 0, 0, 0) };
            textGroup.Children.Add(new TextBlock { Text = label, FontSize = 10, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColTextMain) });
            textGroup.Children.Add(new TextBlock { Text = resetInfo, FontSize = 8.5, Foreground = new SolidColorBrush(ColTextMuted), Margin = new Thickness(0, 1, 0, 0) });
            Grid.SetColumn(textGroup, 1);
            grid.Children.Add(textGroup);

            // Right Percent Number
            TextBlock txtPercent = new TextBlock
            {
                Text = percent + "%",
                FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                FontSize = 11.5,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(ringColor),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(4, 0, 2, 0)
            };
            Grid.SetColumn(txtPercent, 2);
            grid.Children.Add(txtPercent);

            row.Child = grid;
            return row;
        }

        private Geometry CreateArcGeometry(double centerX, double centerY, double radius, double startAngle, double endAngle)
        {
            if (endAngle <= startAngle) return new PathGeometry();
            double startRad = (startAngle - 90) * Math.PI / 180.0;
            double endRad = (endAngle - 90) * Math.PI / 180.0;

            System.Windows.Point startPoint = new System.Windows.Point(centerX + radius * Math.Cos(startRad), centerY + radius * Math.Sin(startRad));
            System.Windows.Point endPoint = new System.Windows.Point(centerX + radius * Math.Cos(endRad), centerY + radius * Math.Sin(endRad));

            bool isLargeArc = (endAngle - startAngle) > 180.0;

            PathFigure figure = new PathFigure { StartPoint = startPoint, IsClosed = false };
            figure.Segments.Add(new ArcSegment(endPoint, new System.Windows.Size(radius, radius), 0, isLargeArc, SweepDirection.Clockwise, true));

            PathGeometry geometry = new PathGeometry();
            geometry.Figures.Add(figure);
            return geometry;
        }

        private void LaunchCodexService()
        {
            btnLaunchCodex.IsEnabled = false;
            txtCodexStatus.Text = "正在准备 API Service 环境并唤起 Codex 桌面端...";
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    string selModel = modelPicker.SelectedModelId;
                    if (string.IsNullOrEmpty(selModel)) selModel = "gemini-3.7-flash-high";

                    SendApiPost("api/codex/launch", "{\"model\":\"" + selModel + "\"}");
                    Dispatcher.Invoke(new Action(() =>
                    {
                        txtCodexStatus.Text = "Codex 桌面端已启动！关闭 Codex 窗口后将自动无感恢复官方配置。";
                        btnLaunchCodex.IsEnabled = true;

                        if (minimizeOnCodexLaunch)
                        {
                            WindowState = WindowState.Minimized;
                            Hide();
                            if (!CheckHasShownTrayTipPersisted())
                            {
                                trayIcon.ShowBalloonTip(2000, "Antigravity Bridge Codex", "Codex 已启动接管，ABC 主界面已自动最小化至系统托盘后台运行。", System.Windows.Forms.ToolTipIcon.Info);
                                MarkTrayTipShownPersisted();
                            }
                        }
                    }));
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(new Action(() =>
                    {
                        txtCodexStatus.Text = "启动失败: " + ex.Message;
                        btnLaunchCodex.IsEnabled = true;
                    }));
                }
            });
        }

        private void RestoreOfficialConfig()
        {
            btnRestore.IsEnabled = false;
            txtCodexStatus.Text = "正在执行官方配置还原与历史记录净化...";
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    SendApiPost("api/codex/restore", "{}");
                    Dispatcher.Invoke(() =>
                    {
                        txtCodexStatus.Text = "已成功确认并恢复官方 OpenAI 默认配置与纯净历史记录。";
                        btnRestore.IsEnabled = true;
                        FetchDashboardData();
                    });
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() =>
                    {
                        txtCodexStatus.Text = "恢复失败: " + ex.Message;
                        btnRestore.IsEnabled = true;
                    });
                }
            });
        }

        private void ToggleCoreService()
        {
            btnToggleCore.IsEnabled = false;
            string endpoint = isCoreRunning ? "api/proxy/stop" : "api/proxy/start";
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    SendApiPost(endpoint, "{}");
                    Dispatcher.Invoke(() =>
                    {
                        btnToggleCore.IsEnabled = true;
                        FetchDashboardData();
                    });
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() =>
                    {
                        btnToggleCore.IsEnabled = true;
                        MessageBox.Show("服务操作失败: " + ex.Message, "AntigravityCodexBridge");
                    });
                }
            });
        }

        private void OnModelSelected(string modelId)
        {
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    SendApiPost("api/codex/model", "{\"model\":\"" + modelId + "\"}");
                }
                catch { }
            });
        }



        private void StartOAuthLogin()
        {
            if (isOAuthPolling) return;
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    string res = SendApiPost("api/oauth/start", "{}");
                    var dict = jsonSerializer.Deserialize<Dictionary<string, object>>(res);
                    if (dict != null && dict.ContainsKey("url"))
                    {
                        string oauthUrl = dict["url"].ToString();
                        string oauthState = dict.ContainsKey("state") ? dict["state"].ToString() : "";
                        Process.Start(new ProcessStartInfo(oauthUrl) { UseShellExecute = true });

                        if (!string.IsNullOrEmpty(oauthState))
                        {
                            PollOAuthStatus(oauthState);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() => MessageBox.Show("发起 OAuth 登录失败: " + ex.Message));
                }
            });
        }

        private void PollOAuthStatus(string oauthState)
        {
            isOAuthPolling = true;
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    DateTime deadline = DateTime.Now.AddMinutes(10);
                    while (DateTime.Now < deadline)
                    {
                        Thread.Sleep(1500);
                        string res = SendApiGet("api/oauth/status?state=" + Uri.EscapeDataString(oauthState));
                        var dict = jsonSerializer.Deserialize<Dictionary<string, object>>(res);
                        if (dict != null && dict.ContainsKey("status"))
                        {
                            string st = dict["status"].ToString();
                            if (st == "ok")
                            {
                                try { SendApiPost("api/quota/refresh", "{}"); } catch { }
                                Dispatcher.Invoke(() =>
                                {
                                    FetchDashboardData();
                                    ShowToast("🎉 Google 账号登录成功，额度已同步");
                                });
                                break;
                            }
                            else if (st == "error")
                            {
                                break;
                            }
                        }
                    }
                }
                catch { }
                finally
                {
                    isOAuthPolling = false;
                }
            });
        }

        private void RefreshQuota()
        {
            if (btnRefreshQuota != null)
            {
                btnRefreshQuota.IsEnabled = false;
                btnRefreshQuota.Content = "🔄 刷新中...";
            }

            if (panelAccounts != null)
            {
                var fadeOut = new System.Windows.Media.Animation.DoubleAnimation(1.0, 0.4, TimeSpan.FromMilliseconds(200));
                panelAccounts.BeginAnimation(UIElement.OpacityProperty, fadeOut);
            }

            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    SendApiPost("api/quota/refresh", "{}", 20000);
                    Dispatcher.Invoke(() =>
                    {
                        FetchDashboardData();
                        if (panelAccounts != null)
                        {
                            var fadeIn = new System.Windows.Media.Animation.DoubleAnimation(0.4, 1.0, TimeSpan.FromMilliseconds(300));
                            panelAccounts.BeginAnimation(UIElement.OpacityProperty, fadeIn);
                        }
                        if (btnRefreshQuota != null)
                        {
                            btnRefreshQuota.IsEnabled = true;
                            btnRefreshQuota.Content = "刷新额度";
                        }
                        ShowToast("✓ 账号额度已成功刷新同步");
                    });
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() =>
                    {
                        if (panelAccounts != null)
                        {
                            var fadeIn = new System.Windows.Media.Animation.DoubleAnimation(0.4, 1.0, TimeSpan.FromMilliseconds(200));
                            panelAccounts.BeginAnimation(UIElement.OpacityProperty, fadeIn);
                        }
                        if (btnRefreshQuota != null)
                        {
                            btnRefreshQuota.IsEnabled = true;
                            btnRefreshQuota.Content = "刷新额度";
                        }
                        ShowToast("⚠️ 刷新额度失败: " + ex.Message);
                    });
                }
            });
        }

        private const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern uint RegisterWindowMessage(string lpString);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        private static readonly uint WM_SHOWME = RegisterWindowMessage("ANTIGRAVITY_CODEX_BRIDGE_ACTIVATE_WINDOW");
        private static Mutex singleInstanceMutex = null;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDPIAware();

        [DllImport("Shcore.dll", SetLastError = true)]
        private static extern int SetProcessDpiAwareness(int PROCESS_DPI_AWARENESS);

        private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        private static void EnableHighDpiAwareness()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
                    return;
            }
            catch { }

            try
            {
                SetProcessDpiAwareness(1);
                return;
            }
            catch { }

            try
            {
                SetProcessDPIAware();
            }
            catch { }
        }

        [STAThread]
        public static void Main(string[] args)
        {
            EnableHighDpiAwareness();

            bool isSilent = false;
            if (args != null)
            {
                foreach (string a in args)
                {
                    if (a.Equals("--silent", StringComparison.OrdinalIgnoreCase) ||
                        a.Equals("--minimized", StringComparison.OrdinalIgnoreCase))
                    {
                        isSilent = true;
                        break;
                    }
                }
            }

            bool createdNew;
            singleInstanceMutex = new Mutex(true, "Global\\AntigravityBridgeCodex_ABC_Mutex", out createdNew);

            if (!createdNew)
            {
                PostMessage((IntPtr)0xFFFF, WM_SHOWME, IntPtr.Zero, IntPtr.Zero);
                IntPtr hWnd = FindWindow(null, "Antigravity Bridge Codex (ABC)");
                if (hWnd == IntPtr.Zero) hWnd = FindWindow(null, "AntigravityCodexBridge");
                if (hWnd != IntPtr.Zero)
                {
                    ShowWindow(hWnd, SW_RESTORE);
                    SetForegroundWindow(hWnd);
                }
                return;
            }

            System.Windows.Application app = new System.Windows.Application();
            app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            app.Run(new MainWindow(isSilent));

            GC.KeepAlive(singleInstanceMutex);
        }
    }
}
