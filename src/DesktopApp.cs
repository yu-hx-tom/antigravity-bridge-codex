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
        private Popup popup;
        private StackPanel popupList;
        public string SelectedModelId { get; private set; }
        public event Action<string> ModelSelected;

        private readonly System.Windows.Media.Color ColPrimary = System.Windows.Media.Color.FromRgb(37, 99, 235);   // #2563EB
        private readonly System.Windows.Media.Color ColPrimaryLight = System.Windows.Media.Color.FromRgb(239, 246, 255); // #EFF6FF
        private readonly System.Windows.Media.Color ColBorder = System.Windows.Media.Color.FromRgb(226, 232, 240); // #E2E8F0
        private readonly System.Windows.Media.Color ColTextMain = System.Windows.Media.Color.FromRgb(15, 23, 42);  // #0F172A

        private List<KeyValuePair<string, string>> cachedModels = new List<KeyValuePair<string, string>>();
        private string cachedModelHash = "";

        public ModelPickerControl()
        {
            Background = System.Windows.Media.Brushes.White;
            BorderBrush = new SolidColorBrush(ColPrimary);
            BorderThickness = new Thickness(1.5);
            CornerRadius = new CornerRadius(8);
            Padding = new Thickness(14, 8, 14, 8);
            Cursor = Cursors.Hand;
            Width = 270;
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

            TextBlock arrow = new TextBlock
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

            Border popupBorder = new Border
            {
                Background = System.Windows.Media.Brushes.White,
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(6),
                Width = 270,
                Margin = new Thickness(0, 4, 0, 0),
                Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 20, Opacity = 0.12, ShadowDepth = 4 }
            };

            popupList = new StackPanel();
            popupBorder.Child = popupList;
            popup.Child = popupBorder;

            MouseLeftButtonUp += (s, e) =>
            {
                popup.IsOpen = !popup.IsOpen;
            };
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

        // UI Controls
        private TextBlock txtTopStatus;
        private System.Windows.Shapes.Ellipse dotTopStatus;
        private Button btnLaunchCodex;
        private Button btnRestore;
        private Button btnToggleCore;
        private Button btnToggleRoundRobin;
        private Button btnRefreshQuota;
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

        // Blue-White Clean Palette Tokens
        private readonly System.Windows.Media.Color ColBg = System.Windows.Media.Color.FromRgb(248, 250, 252);        // #F8FAFC Slate 50
        private readonly System.Windows.Media.Color ColCard = System.Windows.Media.Color.FromRgb(255, 255, 255);      // #FFFFFF Pure White
        private readonly System.Windows.Media.Color ColCardMuted = System.Windows.Media.Color.FromRgb(241, 245, 249); // #F1F5F9 Slate 100
        private readonly System.Windows.Media.Color ColBorder = System.Windows.Media.Color.FromRgb(226, 232, 240);    // #E2E8F0 Slate 200
        private readonly System.Windows.Media.Color ColPrimary = System.Windows.Media.Color.FromRgb(37, 99, 235);      // #2563EB Royal Blue
        private readonly System.Windows.Media.Color ColPrimaryDark = System.Windows.Media.Color.FromRgb(29, 78, 216);  // #1D4ED8 Dark Blue
        private readonly System.Windows.Media.Color ColPrimaryLight = System.Windows.Media.Color.FromRgb(239, 246, 255);// #EFF6FF Ice Blue
        private readonly System.Windows.Media.Color ColTextMain = System.Windows.Media.Color.FromRgb(15, 23, 42);     // #0F172A Navy Slate
        private readonly System.Windows.Media.Color ColTextMuted = System.Windows.Media.Color.FromRgb(71, 85, 105);   // #475569 Crisp Slate 600
        private readonly System.Windows.Media.Color ColGreen = System.Windows.Media.Color.FromRgb(16, 185, 129);       // #10B981 Emerald
        private readonly System.Windows.Media.Color ColAmber = System.Windows.Media.Color.FromRgb(245, 158, 11);       // #F59E0B Amber
        private readonly System.Windows.Media.Color ColRed = System.Windows.Media.Color.FromRgb(239, 68, 68);          // #EF4444 Red

        public MainWindow()
        {
            appDir = AppDomain.CurrentDomain.BaseDirectory;
            InitializeComponent();
            InitializeTrayAndIcon();
            StartBackendServer();

            refreshTimer = new DispatcherTimer();
            refreshTimer.Interval = TimeSpan.FromSeconds(2.5);
            refreshTimer.Tick += (s, e) => FetchDashboardData();
            refreshTimer.Start();
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

                int pad = size >= 32 ? 2 : 1;
                int r = size >= 32 ? (size / 4) : 3;
                System.Drawing.Rectangle rect = new System.Drawing.Rectangle(pad, pad, size - pad * 2, size - pad * 2);

                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddArc(rect.X, rect.Y, r * 2, r * 2, 180, 90);
                    path.AddArc(rect.Right - r * 2, rect.Y, r * 2, r * 2, 270, 90);
                    path.AddArc(rect.Right - r * 2, rect.Bottom - r * 2, r * 2, r * 2, 0, 90);
                    path.AddArc(rect.X, rect.Bottom - r * 2, r * 2, r * 2, 90, 90);
                    path.CloseFigure();

                    using (System.Drawing.Drawing2D.LinearGradientBrush bgBrush = new System.Drawing.Drawing2D.LinearGradientBrush(
                        new System.Drawing.Point(0, 0), new System.Drawing.Point(size, size),
                        System.Drawing.Color.FromArgb(29, 78, 216),    // #1D4ED8
                        System.Drawing.Color.FromArgb(37, 99, 235)))   // #2563EB
                    {
                        g.FillPath(bgBrush, path);
                    }
                }

                if (size >= 32)
                {
                    using (System.Drawing.Pen bridgePen = new System.Drawing.Pen(System.Drawing.Color.FromArgb(224, 242, 254), size >= 64 ? 3.5f : 2.0f))
                    {
                        bridgePen.StartCap = LineCap.Round;
                        bridgePen.EndCap = LineCap.Round;
                        g.DrawArc(bridgePen, (int)(size * 0.20), (int)(size * 0.44), (int)(size * 0.60), (int)(size * 0.42), 180, 180);
                    }
                }

                float fontSize = 96.0f;
                if (size <= 16) fontSize = 8.5f;
                else if (size <= 24) fontSize = 11.5f;
                else if (size <= 32) fontSize = 14.5f;
                else if (size <= 48) fontSize = 21.0f;
                else if (size <= 64) fontSize = 28.0f;

                using (Font font = new Font("Segoe UI", fontSize, System.Drawing.FontStyle.Bold, GraphicsUnit.Pixel))
                using (SolidBrush textBrush = new SolidBrush(System.Drawing.Color.White))
                {
                    StringFormat sf = new StringFormat
                    {
                        Alignment = StringAlignment.Center,
                        LineAlignment = StringAlignment.Center
                    };
                    float yOffset = size >= 32 ? (size * 0.05f) : 0f;
                    g.DrawString("AG", font, textBrush, new RectangleF(0, yOffset, size, size), sf);
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

            System.Windows.Forms.ContextMenu menu = new System.Windows.Forms.ContextMenu();
            menu.MenuItems.Add(new System.Windows.Forms.MenuItem("🌟 打开 AntigravityCodexBridge", (s, e) => ShowAndActivate()));
            menu.MenuItems.Add(new System.Windows.Forms.MenuItem("🚀 启动 Codex", (s, e) => LaunchCodexService()));
            menu.MenuItems.Add(new System.Windows.Forms.MenuItem("🛡️ 恢复官方配置", (s, e) => RestoreOfficialConfig()));
            menu.MenuItems.Add(new System.Windows.Forms.MenuItem("-"));
            menu.MenuItems.Add(new System.Windows.Forms.MenuItem("🚪 退出程序", (s, e) => ExitApplication()));

            trayIcon = new System.Windows.Forms.NotifyIcon();
            trayIcon.Text = "AntigravityCodexBridge";
            trayIcon.Icon = ico;
            trayIcon.ContextMenu = menu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += (s, e) => ShowAndActivate();
        }

        private void InitializeComponent()
        {
            Title = "AntigravityCodexBridge";
            Width = 1060;
            Height = 750;
            MinWidth = 960;
            MinHeight = 660;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Background = new SolidColorBrush(ColBg);
            Foreground = new SolidColorBrush(ColTextMain);
            FontFamily = new System.Windows.Media.FontFamily("Microsoft YaHei UI, Segoe UI, sans-serif");
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            TextOptions.SetTextHintingMode(this, TextHintingMode.Fixed);
            RenderOptions.SetClearTypeHint(this, ClearTypeHint.Enabled);

            Grid rootGrid = new Grid();
            rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(68) });  // Topbar
            rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // Main Content
            rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(36) });  // Footer

            // 1. TOPBAR
            Border topBar = new Border
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
            titleLine.Children.Add(new TextBlock { Text = "AntigravityCodexBridge", FontWeight = FontWeights.Bold, FontSize = 16.5, Foreground = new SolidColorBrush(ColTextMain), Margin = new Thickness(0, 0, 8, 0) });
            titleLine.Children.Add(new TextBlock { Text = "v0.2.0", FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColPrimary), VerticalAlignment = VerticalAlignment.Center });
            titleGroup.Children.Add(titleLine);
            titleGroup.Children.Add(new TextBlock { Text = "LOCAL RUNTIME · 127.0.0.1 ONLY · ZERO DB CONTAMINATION", FontSize = 10, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColTextMuted) });
            brandPanel.Children.Add(titleGroup);
            Grid.SetColumn(brandPanel, 0);
            topGrid.Children.Add(brandPanel);

            // Right Status
            StackPanel rightTop = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            dotTopStatus = new System.Windows.Shapes.Ellipse
            {
                Width = 9,
                Height = 9,
                Fill = new SolidColorBrush(ColGreen),
                Margin = new Thickness(0, 0, 8, 0)
            };
            txtTopStatus = new TextBlock { Text = "核心服务在线 (127.0.0.1:8787)", FontSize = 12.5, Foreground = new SolidColorBrush(ColTextMuted), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 16, 0) };
            
            btnToggleCore = CreateButton("停止服务", ColCardMuted, new SolidColorBrush(ColTextMain), 12);
            btnToggleCore.Padding = new Thickness(14, 6, 14, 6);
            btnToggleCore.Click += (s, e) => ToggleCoreService();

            rightTop.Children.Add(dotTopStatus);
            rightTop.Children.Add(txtTopStatus);
            rightTop.Children.Add(btnToggleCore);
            Grid.SetColumn(rightTop, 2);
            topGrid.Children.Add(rightTop);

            topBar.Child = topGrid;
            Grid.SetRow(topBar, 0);
            rootGrid.Children.Add(topBar);

            // 2. MAIN SCROLL BODY
            ScrollViewer scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(32, 24, 32, 24) };
            StackPanel body = new StackPanel();

            // Section 0: Metrics Row
            Grid metricsGrid = new Grid { Margin = new Thickness(0, 0, 0, 24) };
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            metricsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            metricsGrid.Children.Add(CreateMetricCard("CORE", "ON", "CLIProxyAPI 核心", 0, out txtMetricCore));
            metricsGrid.Children.Add(CreateMetricCard("ACCOUNTS", "1", "已挂载凭据", 1, out txtMetricAccounts));
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
                Padding = new Thickness(28),
                Margin = new Thickness(0, 0, 0, 26),
                Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 16, Opacity = 0.04, ShadowDepth = 2 }
            };
            Grid heroGrid = new Grid();
            heroGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            heroGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(280) });

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
            txtMode = new TextBlock { Text = "🔒 官方原生模式", FontSize = 10.5, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 83, 9)) };
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
            autoRestorePill.Child = new TextBlock { Text = "🛡️ 关闭 Codex 窗口自动还原官方", FontSize = 10.5, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColTextMuted) };
            badgeRow.Children.Add(autoRestorePill);
            heroLeft.Children.Add(badgeRow);

            // Headline
            TextBlock heroTitle = new TextBlock
            {
                Text = "把可用模型，接到本地 Codex。",
                FontSize = 23,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(ColTextMain),
                Margin = new Thickness(0, 0, 0, 8)
            };
            heroLeft.Children.Add(heroTitle);

            txtCodexStatus = new TextBlock
            {
                Text = "保留官方登录与历史会话，点击启动按钮将自动应用 API Service 配置。使用完毕关闭 Codex 桌面端窗口即可自动无感还原。",
                FontSize = 12.5,
                Foreground = new SolidColorBrush(ColTextMuted),
                TextWrapping = TextWrapping.Wrap,
                LineHeight = 19,
                Margin = new Thickness(0, 0, 0, 18)
            };
            heroLeft.Children.Add(txtCodexStatus);

            // Model Switcher Line
            StackPanel modelRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            modelRow.Children.Add(new TextBlock { Text = "生效模型：", FontSize = 13, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColTextMain), VerticalAlignment = VerticalAlignment.Center });
            
            modelPicker = new ModelPickerControl { Margin = new Thickness(0, 0, 12, 0) };
            modelPicker.ModelSelected += (modelId) => OnModelSelected(modelId);
            modelRow.Children.Add(modelPicker);

            heroLeft.Children.Add(modelRow);
            Grid.SetColumn(heroLeft, 0);
            heroGrid.Children.Add(heroLeft);

            // Right Hero Launch Button & Restore Button
            StackPanel heroRight = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Right };
            btnLaunchCodex = new Button
            {
                Width = 250,
                Height = 68,
                Background = new SolidColorBrush(ColPrimary),
                Foreground = System.Windows.Media.Brushes.White,
                BorderThickness = new Thickness(0),
                Cursor = Cursors.Hand,
                Effect = new DropShadowEffect { Color = ColPrimary, BlurRadius = 22, Opacity = 0.35, ShadowDepth = 3 }
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
                FontSize = 17,
                FontWeight = FontWeights.Bold,
                Foreground = System.Windows.Media.Brushes.White,
                HorizontalAlignment = HorizontalAlignment.Center
            };
            TextBlock btnSubText = new TextBlock
            {
                Text = "一键接管 · 关窗即还原",
                FontSize = 10.5,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromArgb(220, 255, 255, 255)),
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 3, 0, 0)
            };
            btnContent.Children.Add(btnMainText);
            btnContent.Children.Add(btnSubText);
            btnLaunchCodex.Content = btnContent;
            btnLaunchCodex.Click += (s, e) => LaunchCodexService();
            heroRight.Children.Add(btnLaunchCodex);

            btnRestore = CreateButton("🛡️ 恢复官方配置", ColCardMuted, new SolidColorBrush(ColTextMain), 11.5, false);
            btnRestore.Width = 250;
            btnRestore.Height = 32;
            btnRestore.Margin = new Thickness(0, 8, 0, 0);
            btnRestore.Click += (s, e) => RestoreOfficialConfig();
            heroRight.Children.Add(btnRestore);

            Grid.SetColumn(heroRight, 1);
            heroGrid.Children.Add(heroRight);

            heroCard.Child = heroGrid;
            body.Children.Add(heroCard);

            // Section 2: Accounts & Quotas Header (Includes Round-Robin Mode Toggle)
            Grid accHeaderGrid = new Grid { Margin = new Thickness(0, 0, 0, 14) };
            accHeaderGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            accHeaderGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            StackPanel accTitleGroup = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            TextBlock sectionNo = new TextBlock { Text = "02", FontFamily = new System.Windows.Media.FontFamily("Georgia"), FontStyle = FontStyles.Italic, FontSize = 22, Foreground = new SolidColorBrush(ColPrimary), Margin = new Thickness(0, 0, 8, 0) };
            TextBlock accTitle = new TextBlock { Text = "账号与额度", FontSize = 18, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColTextMain), Margin = new Thickness(0, 0, 10, 0) };
            accTitleGroup.Children.Add(sectionNo);
            accTitleGroup.Children.Add(accTitle);
            Grid.SetColumn(accTitleGroup, 0);
            accHeaderGrid.Children.Add(accTitleGroup);

            StackPanel accActions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            
            // Round-Robin Mode Switch Button
            btnToggleRoundRobin = CreateButton("🔄 自动轮询: 开启", ColPrimaryLight, new SolidColorBrush(ColPrimaryDark), 11.5, true);
            btnToggleRoundRobin.Padding = new Thickness(14, 6, 14, 6);
            btnToggleRoundRobin.Margin = new Thickness(0, 0, 10, 0);
            btnToggleRoundRobin.Click += (s, e) => ToggleRoundRobinMode();
            accActions.Children.Add(btnToggleRoundRobin);

            btnRefreshQuota = CreateButton("刷新额度", ColCardMuted, new SolidColorBrush(ColTextMain), 11.5);
            btnRefreshQuota.Padding = new Thickness(14, 6, 14, 6);
            btnRefreshQuota.Click += (s, e) => RefreshQuota();
            accActions.Children.Add(btnRefreshQuota);

            Button btnAddAccount = CreateButton("+ 登录 Google 账号", ColPrimary, System.Windows.Media.Brushes.White, 12, true);
            btnAddAccount.Padding = new Thickness(16, 6, 16, 6);
            btnAddAccount.Margin = new Thickness(10, 0, 0, 0);
            btnAddAccount.Click += (s, e) => StartOAuthLogin();
            accActions.Children.Add(btnAddAccount);

            Grid.SetColumn(accActions, 1);
            accHeaderGrid.Children.Add(accActions);
            body.Children.Add(accHeaderGrid);

            panelAccounts = new StackPanel();
            body.Children.Add(panelAccounts);

            scroll.Content = body;
            Grid.SetRow(scroll, 1);
            rootGrid.Children.Add(scroll);

            // 3. FOOTER
            Border footer = new Border
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
            footer.Child = footerGrid;
            Grid.SetRow(footer, 2);
            rootGrid.Children.Add(footer);

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

            Content = rootGrid;

            StateChanged += MainWindow_StateChanged;
            Closing += MainWindow_Closing;
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
                    FileName = "cmd.exe",
                    Arguments = "/c wmic process where \"name='node.exe' and commandline like '%server.mjs%'\" call terminate",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(1000);
                }
            }
            catch { }
        }

        private void StartBackendServer()
        {
            try
            {
                CleanupStaleBackendProcesses();
                Thread.Sleep(200);

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "node.exe";
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
                txtMode.Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 83, 9));
            }

            // Real-time Session Telemetry (Throughput & Latency)
            var telemetry = data.ContainsKey("telemetry") ? data["telemetry"] as Dictionary<string, object> : null;
            if (telemetry != null && telemetry.ContainsKey("avgTokensPerSec") && Convert.ToDouble(telemetry["avgTokensPerSec"]) > 0)
            {
                double avgTps = Convert.ToDouble(telemetry["avgTokensPerSec"]);
                int avgTtft = telemetry.ContainsKey("avgTtftMs") ? Convert.ToInt32(telemetry["avgTtftMs"]) : 0;

                txtMetricThroughput.Text = avgTps.ToString("0.0") + " t/s";
                txtMetricThroughput.Foreground = new SolidColorBrush(ColPrimary);

                txtMetricLatency.Text = avgTtft.ToString() + " ms";
                txtMetricLatency.Foreground = new SolidColorBrush(ColGreen);
            }
            else
            {
                txtMetricThroughput.Text = "-- t/s";
                txtMetricThroughput.Foreground = new SolidColorBrush(ColTextMuted);

                txtMetricLatency.Text = "-- ms";
                txtMetricLatency.Foreground = new SolidColorBrush(ColTextMuted);
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
            }

            // Accounts List
            var accounts = data.ContainsKey("accounts") ? data["accounts"] as ArrayList : null;
            txtMetricAccounts.Text = accounts != null ? accounts.Count.ToString() : "0";
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
                btnToggleRoundRobin.Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 83, 9));
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
                    CornerRadius = new CornerRadius(14),
                    Padding = new Thickness(28),
                    Effect = new DropShadowEffect { Color = System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = 10, Opacity = 0.03, ShadowDepth = 1 }
                };
                emptyCard.Child = new TextBlock
                {
                    Text = "尚未登录 Google 账号，点击右上角【+ 登录 Google 账号】完成授权后即可开始使用。",
                    Foreground = new SolidColorBrush(ColTextMuted),
                    FontSize = 13,
                    HorizontalAlignment = HorizontalAlignment.Center
                };
                panelAccounts.Children.Add(emptyCard);
                return;
            }

            for (int i = 0; i < accounts.Count; i++)
            {
                var acc = accounts[i] as Dictionary<string, object>;
                if (acc == null) continue;

                string email = acc.ContainsKey("email") ? acc["email"].ToString() : (acc.ContainsKey("name") ? acc["name"].ToString() : "Google User");
                string accId = acc.ContainsKey("id") ? acc["id"].ToString() : (acc.ContainsKey("name") ? acc["name"].ToString() : email);

                bool isThisAccountActive = (accId == activeAccountId || email == activeAccountId || (string.IsNullOrEmpty(activeAccountId) && i == 0));

                string capturedId = accId;
                string capturedEmail = email;
                bool isClickable = (!isThisAccountActive || autoRoundRobin);

                Border card = new Border
                {
                    Background = new SolidColorBrush(ColCard),
                    BorderBrush = (!autoRoundRobin && isThisAccountActive) ? new SolidColorBrush(ColPrimary) : new SolidColorBrush(ColBorder),
                    BorderThickness = new Thickness((!autoRoundRobin && isThisAccountActive) ? 2 : 1),
                    CornerRadius = new CornerRadius(16),
                    Padding = new Thickness(24, 20, 24, 20),
                    Margin = new Thickness(0, 0, 0, 16),
                    Effect = new DropShadowEffect { Color = (!autoRoundRobin && isThisAccountActive) ? ColPrimary : System.Windows.Media.Color.FromRgb(15, 23, 42), BlurRadius = (!autoRoundRobin && isThisAccountActive) ? 14 : 12, Opacity = (!autoRoundRobin && isThisAccountActive) ? 0.16 : 0.04, ShadowDepth = 2 }
                };

                if (isClickable)
                {
                    card.Cursor = Cursors.Hand;
                    card.MouseEnter += (s, e) =>
                    {
                        card.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(147, 197, 253));
                        card.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(248, 250, 252));
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

                Grid cardGrid = new Grid();
                cardGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(220) });
                cardGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

                string status = acc.ContainsKey("status") ? acc["status"].ToString() : "";
                string statusMessage = acc.ContainsKey("statusMessage") ? acc["statusMessage"].ToString() : "";
                string health = acc.ContainsKey("health") ? acc["health"].ToString() : status;
                bool isReauthNeeded = health == "reauth" || status == "reauth";

                // Left: Avatar, Email, & Routing Status / Selection Badge
                StackPanel userLeft = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
                StackPanel userHeader = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
                
                Border avatar = new Border
                {
                    Width = 44,
                    Height = 44,
                    CornerRadius = new CornerRadius(22),
                    Background = isReauthNeeded ? new SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 239, 68, 68)) : new SolidColorBrush(ColPrimaryLight),
                    BorderBrush = isReauthNeeded ? new SolidColorBrush(ColRed) : new SolidColorBrush(ColPrimary),
                    BorderThickness = new Thickness(1.5),
                    Margin = new Thickness(0, 0, 12, 0)
                };
                avatar.Child = new TextBlock
                {
                    Text = (string.IsNullOrEmpty(email) ? "G" : email.Substring(0, 1).ToUpper()),
                    FontWeight = FontWeights.Bold,
                    FontSize = 19,
                    Foreground = isReauthNeeded ? new SolidColorBrush(ColRed) : new SolidColorBrush(ColPrimary),
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center
                };
                userHeader.Children.Add(avatar);

                StackPanel emailGroup = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
                emailGroup.Children.Add(new TextBlock { Text = email, FontWeight = FontWeights.Bold, FontSize = 13.5, Foreground = new SolidColorBrush(ColTextMain), MaxWidth = 150, TextTrimming = TextTrimming.CharacterEllipsis });
                
                if (isReauthNeeded)
                {
                    emailGroup.Children.Add(new TextBlock { Text = "● 凭据已失效 (需重登)", FontSize = 10.5, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColRed), Margin = new Thickness(0, 3, 0, 0) });
                }
                else if (health == "cooldown")
                {
                    emailGroup.Children.Add(new TextBlock { Text = "● 429 频控冷却中", FontSize = 10.5, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColAmber), Margin = new Thickness(0, 3, 0, 0) });
                }
                else if (health == "disabled")
                {
                    emailGroup.Children.Add(new TextBlock { Text = "● 账号已停用", FontSize = 10.5, Foreground = new SolidColorBrush(ColTextMuted), Margin = new Thickness(0, 3, 0, 0) });
                }
                else
                {
                    emailGroup.Children.Add(new TextBlock { Text = "● Google OAuth 就绪", FontSize = 10.5, Foreground = new SolidColorBrush(ColGreen), Margin = new Thickness(0, 3, 0, 0) });
                }
                
                userHeader.Children.Add(emailGroup);
                userLeft.Children.Add(userHeader);

                // Routing Badges & Delete Button Row
                StackPanel badgeRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 10, 0, 0) };

                if (autoRoundRobin)
                {
                    Border pillAuto = new Border
                    {
                        Background = isReauthNeeded ? new SolidColorBrush(System.Windows.Media.Color.FromArgb(20, 239, 68, 68)) : new SolidColorBrush(ColPrimaryLight),
                        CornerRadius = new CornerRadius(6),
                        Padding = new Thickness(8, 3, 8, 3),
                        HorizontalAlignment = HorizontalAlignment.Left
                    };
                    pillAuto.Child = new TextBlock
                    {
                        Text = isReauthNeeded ? "⚠️ 凭据已跳过轮询" : "● 自动轮询中 (点击指定此账号)",
                        FontSize = 10,
                        FontWeight = FontWeights.SemiBold,
                        Foreground = isReauthNeeded ? new SolidColorBrush(ColRed) : new SolidColorBrush(ColPrimary)
                    };
                    badgeRow.Children.Add(pillAuto);
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
                            CornerRadius = new CornerRadius(6),
                            Padding = new Thickness(8, 3, 8, 3),
                            HorizontalAlignment = HorizontalAlignment.Left
                        };
                        pillActive.Child = new TextBlock { Text = "⭐ 当前生效账号", FontSize = 10.5, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(ColPrimaryDark) };
                        badgeRow.Children.Add(pillActive);
                    }
                    else
                    {
                        Border pillIdle = new Border
                        {
                            Background = new SolidColorBrush(ColCardMuted),
                            BorderBrush = new SolidColorBrush(ColBorder),
                            BorderThickness = new Thickness(1),
                            CornerRadius = new CornerRadius(6),
                            Padding = new Thickness(8, 3, 8, 3),
                            HorizontalAlignment = HorizontalAlignment.Left
                        };
                        pillIdle.Child = new TextBlock { Text = "👉 点击切换为此账号", FontSize = 10, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColTextMuted) };
                        badgeRow.Children.Add(pillIdle);
                    }
                }

                Button btnDeleteAcc = new Button
                {
                    Content = "🗑️ 移除",
                    FontSize = 10,
                    Foreground = new SolidColorBrush(ColTextMuted),
                    Background = System.Windows.Media.Brushes.Transparent,
                    BorderThickness = new Thickness(0),
                    Cursor = Cursors.Hand,
                    Margin = new Thickness(8, 0, 0, 0),
                    Padding = new Thickness(4, 2, 4, 2),
                    VerticalAlignment = VerticalAlignment.Center,
                    ToolTip = "从本地移除此账号凭据"
                };
                btnDeleteAcc.MouseEnter += (s, e) => { btnDeleteAcc.Foreground = new SolidColorBrush(ColRed); };
                btnDeleteAcc.MouseLeave += (s, e) => { btnDeleteAcc.Foreground = new SolidColorBrush(ColTextMuted); };
                btnDeleteAcc.Click += (s, e) =>
                {
                    e.Handled = true;
                    DeleteAccount(capturedId, capturedEmail);
                };
                badgeRow.Children.Add(btnDeleteAcc);

                userLeft.Children.Add(badgeRow);

                Grid.SetColumn(userLeft, 0);
                cardGrid.Children.Add(userLeft);

                // Right Area: If reauth is needed, show prompt; else show Quotas
                if (isReauthNeeded)
                {
                    Border reauthBox = new Border
                    {
                        Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(20, 239, 68, 68)),
                        BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(80, 239, 68, 68)),
                        BorderThickness = new Thickness(1),
                        CornerRadius = new CornerRadius(12),
                        Padding = new Thickness(20, 14, 20, 14),
                        Margin = new Thickness(12, 0, 0, 0)
                    };
                    Grid rGrid = new Grid();
                    rGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    rGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                    StackPanel rTextGroup = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
                    TextBlock rTitle = new TextBlock
                    {
                        Text = "⚠️ Google OAuth 授权已失效或被撤销",
                        FontSize = 13,
                        FontWeight = FontWeights.Bold,
                        Foreground = new SolidColorBrush(ColRed),
                        Margin = new Thickness(0, 0, 0, 4)
                    };
                    TextBlock rSub = new TextBlock
                    {
                        Text = "上游服务返回 503 auth_unavailable。请点击右侧按钮重新登录此 Google 账号以刷新授权凭据并恢复正常调用。",
                        FontSize = 11.5,
                        Foreground = new SolidColorBrush(ColTextMuted),
                        TextWrapping = TextWrapping.Wrap
                    };
                    rTextGroup.Children.Add(rTitle);
                    rTextGroup.Children.Add(rSub);
                    Grid.SetColumn(rTextGroup, 0);
                    rGrid.Children.Add(rTextGroup);

                    Button btnReauth = CreateButton("🔑 重新登录授权", ColRed, System.Windows.Media.Brushes.White, 12, true);
                    btnReauth.Padding = new Thickness(16, 8, 16, 8);
                    btnReauth.Margin = new Thickness(16, 0, 0, 0);
                    btnReauth.Click += (s, e) => StartOAuthLogin();
                    Grid.SetColumn(btnReauth, 1);
                    rGrid.Children.Add(btnReauth);

                    reauthBox.Child = rGrid;
                    Grid.SetColumn(reauthBox, 1);
                    cardGrid.Children.Add(reauthBox);
                }
                else
                {
                    // Right: Unified Quota Groups with separate 5-Hour and Weekly metrics
                    var quota = acc.ContainsKey("quota") ? acc["quota"] as Dictionary<string, object> : null;
                    var summary = quota != null && quota.ContainsKey("summary") ? quota["summary"] as Dictionary<string, object>
                        : (quota != null && quota.ContainsKey("quota_summary") ? quota["quota_summary"] as Dictionary<string, object>
                        : (quota != null && quota.ContainsKey("quotaSummary") ? quota["quotaSummary"] as Dictionary<string, object> : null));
                    var qGroups = summary != null && summary.ContainsKey("groups") ? summary["groups"] as ArrayList : null;
                    var qModels = quota != null && quota.ContainsKey("models") ? quota["models"] as ArrayList : null;

                    int geminiFiveHour = 100;
                    string geminiFiveHourReset = "5小时周期重置";
                    int geminiWeekly = 100;
                    string geminiWeeklyReset = "周度周期重置";

                    int claudeFiveHour = 100;
                    string claudeFiveHourReset = "5小时周期重置";
                    int claudeWeekly = 100;
                    string claudeWeeklyReset = "周度周期重置";

                    if (qGroups != null && qGroups.Count > 0)
                    {
                        foreach (var gObj in qGroups)
                        {
                            var g = gObj as Dictionary<string, object>;
                            if (g == null) continue;
                            string gName = g.ContainsKey("displayName") ? g["displayName"].ToString() : "";
                            var buckets = g.ContainsKey("buckets") ? g["buckets"] as ArrayList : null;
                            if (buckets == null) continue;

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
                    else if (qModels != null)
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
                                    if (spanHours > 6.0)
                                    {
                                        isWeekly = true;
                                    }
                                }
                            }
                            if (mId.Contains("tiered") || mId.Contains("pro") || mId.Contains("weekly"))
                            {
                                isWeekly = true;
                            }

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

                    Grid groupsGrid = new Grid { Margin = new Thickness(8, 0, 0, 0) };
                    groupsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    groupsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

                    UIElement geminiGroupCard = CreateUnifiedQuotaGroupCard("🔮 Gemini 模型系列", "统一共享 5小时与周度限额", geminiFiveHour, geminiFiveHourReset, geminiWeekly, geminiWeeklyReset);
                    Grid.SetColumn((FrameworkElement)geminiGroupCard, 0);
                    groupsGrid.Children.Add(geminiGroupCard);

                    UIElement claudeGroupCard = CreateUnifiedQuotaGroupCard("⚡ Claude & GPT 模型系列", "统一共享 5小时与周度限额", claudeFiveHour, claudeFiveHourReset, claudeWeekly, claudeWeeklyReset);
                    Grid.SetColumn((FrameworkElement)claudeGroupCard, 1);
                    groupsGrid.Children.Add(claudeGroupCard);

                    Grid.SetColumn(groupsGrid, 1);
                    cardGrid.Children.Add(groupsGrid);
                }

                card.Child = cardGrid;
                panelAccounts.Children.Add(card);
            }
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

        private UIElement CreateUnifiedQuotaGroupCard(string title, string subtitle, int fiveHourPercent, string fiveHourReset, int weeklyPercent, string weeklyReset)
        {
            Border groupBorder = new Border
            {
                Background = new SolidColorBrush(ColCardMuted),
                BorderBrush = new SolidColorBrush(ColBorder),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(14, 12, 14, 12),
                Margin = new Thickness(6, 0, 6, 0)
            };
            StackPanel sp = new StackPanel();

            // Header
            StackPanel header = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };
            header.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.Bold, FontSize = 12.5, Foreground = new SolidColorBrush(ColTextMain) });
            header.Children.Add(new TextBlock { Text = subtitle, FontSize = 9.5, Foreground = new SolidColorBrush(ColTextMuted), Margin = new Thickness(0, 1, 0, 0) });
            sp.Children.Add(header);

            // Row 1: 5-Hour Limit
            sp.Children.Add(CreateQuotaMeterRow("5小时额度剩余", fiveHourPercent, fiveHourReset));

            // Row 2: Weekly Limit
            sp.Children.Add(CreateQuotaMeterRow("周度额度剩余", weeklyPercent, weeklyReset, true));

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
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(10, 6, 10, 6),
                Margin = new Thickness(0, 0, 0, isWeekly ? 0 : 6)
            };
            Grid grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(32) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            // Circular Ring
            Grid circleGrid = new Grid { Width = 26, Height = 26 };
            System.Windows.Shapes.Ellipse bgCircle = new System.Windows.Shapes.Ellipse
            {
                Width = 26,
                Height = 26,
                Stroke = new SolidColorBrush(ColBorder),
                StrokeThickness = 3.0
            };
            circleGrid.Children.Add(bgCircle);

            System.Windows.Media.Color ringColor = percent > 50
                ? ColPrimary
                : (percent > 20 ? ColAmber : ColRed);

            System.Windows.Shapes.Path progressPath = new System.Windows.Shapes.Path
            {
                Stroke = new SolidColorBrush(ringColor),
                StrokeThickness = 3.0,
                StrokeEndLineCap = PenLineCap.Round,
                Data = CreateArcGeometry(13, 13, 11, 0, (percent / 100.0) * 359.9)
            };
            circleGrid.Children.Add(progressPath);
            Grid.SetColumn(circleGrid, 0);
            grid.Children.Add(circleGrid);

            // Center Text Info
            StackPanel textGroup = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 0, 0) };
            textGroup.Children.Add(new TextBlock { Text = label, FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(ColTextMain) });
            textGroup.Children.Add(new TextBlock { Text = resetInfo, FontSize = 9.5, Foreground = new SolidColorBrush(ColTextMuted), Margin = new Thickness(0, 1, 0, 0) });
            Grid.SetColumn(textGroup, 1);
            grid.Children.Add(textGroup);

            // Right Percent Number
            TextBlock txtPercent = new TextBlock
            {
                Text = percent + "%",
                FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                FontSize = 13,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(ringColor),
                VerticalAlignment = VerticalAlignment.Center
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
                    Dispatcher.Invoke(() =>
                    {
                        txtCodexStatus.Text = "Codex 桌面端已启动！关闭 Codex 窗口后将自动无感恢复官方配置。";
                        btnLaunchCodex.IsEnabled = true;
                    });
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() =>
                    {
                        txtCodexStatus.Text = "启动失败: " + ex.Message;
                        btnLaunchCodex.IsEnabled = true;
                    });
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
        public static void Main()
        {
            EnableHighDpiAwareness();

            bool createdNew;
            singleInstanceMutex = new Mutex(true, "Global\\AntigravityCodexBridge_SingleInstance_Mutex", out createdNew);

            if (!createdNew)
            {
                PostMessage((IntPtr)0xFFFF, WM_SHOWME, IntPtr.Zero, IntPtr.Zero);
                IntPtr hWnd = FindWindow(null, "AntigravityCodexBridge");
                if (hWnd != IntPtr.Zero)
                {
                    ShowWindow(hWnd, SW_RESTORE);
                    SetForegroundWindow(hWnd);
                }
                return;
            }

            System.Windows.Application app = new System.Windows.Application();
            app.Run(new MainWindow());

            GC.KeepAlive(singleInstanceMutex);
        }
    }
}
