using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AntigravityCodexBridge
{
    public class TrayApplication : ApplicationContext
    {
        private NotifyIcon trayIcon;
        private ContextMenu trayMenu;
        private Process nodeProcess;
        private string appDir;
        private string uiUrl = "http://127.0.0.1:8787/";
        private string bridgeKey = "";

        public TrayApplication()
        {
            appDir = AppDomain.CurrentDomain.BaseDirectory;
            LoadBridgeKey();
            InitializeTray();
            StartBackend();
        }

        private void LoadBridgeKey()
        {
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string settingsPath = Path.Combine(localAppData, "AntigravityCodexBridge", "settings.json");
                if (File.Exists(settingsPath))
                {
                    string content = File.ReadAllText(settingsPath);
                    int idx = content.IndexOf("\"uiKey\":");
                    if (idx != -1)
                    {
                        int start = content.IndexOf("\"", idx + 8) + 1;
                        int end = content.IndexOf("\"", start);
                        if (start > 0 && end > start)
                        {
                            bridgeKey = content.Substring(start, end - start);
                        }
                    }
                }
            }
            catch { }
        }

        private void InitializeTray()
        {
            trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add(new MenuItem("🌟 打开控制面板 (Dashboard)", OnOpenDashboard));
            trayMenu.MenuItems.Add(new MenuItem("-"));
            trayMenu.MenuItems.Add(new MenuItem("🚀 一键启动 Codex", OnLaunchCodex));
            
            MenuItem modelMenu = new MenuItem("🔄 快速切换模型");
            modelMenu.MenuItems.Add(new MenuItem("Gemini 3.7 Flash", (s, e) => SwitchModel("gemini-3.7-flash-high")));
            modelMenu.MenuItems.Add(new MenuItem("Gemini 3.6 Flash", (s, e) => SwitchModel("gemini-3.6-flash-high")));
            modelMenu.MenuItems.Add(new MenuItem("Claude Sonnet 4.6 (Thinking)", (s, e) => SwitchModel("claude-sonnet-4-6")));
            modelMenu.MenuItems.Add(new MenuItem("Claude Opus 4.6 (Thinking)", (s, e) => SwitchModel("claude-opus-4-6-thinking")));
            trayMenu.MenuItems.Add(modelMenu);

            trayMenu.MenuItems.Add(new MenuItem("-"));
            trayMenu.MenuItems.Add(new MenuItem("🛡️ 恢复官方配置", OnRestoreCodex));
            trayMenu.MenuItems.Add(new MenuItem("-"));
            trayMenu.MenuItems.Add(new MenuItem("🚪 退出程序", OnExit));

            // Generate an elegant dynamic icon
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.FillEllipse(new SolidBrush(Color.FromArgb(23, 52, 47)), 2, 2, 28, 28);
                g.DrawEllipse(new Pen(Color.FromArgb(204, 255, 0), 2), 2, 2, 28, 28);
                using (Font font = new Font("Arial", 11, FontStyle.Bold, GraphicsUnit.Pixel))
                {
                    g.DrawString("AG", font, new SolidBrush(Color.FromArgb(204, 255, 0)), 6, 9);
                }
            }

            trayIcon = new NotifyIcon();
            trayIcon.Text = "Antigravity Codex Bridge (运行中)";
            trayIcon.Icon = Icon.FromHandle(bmp.GetHicon());
            trayIcon.ContextMenu = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += OnOpenDashboard;
        }

        private void StartBackend()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "node.exe";
                psi.Arguments = "server.mjs";
                psi.WorkingDirectory = appDir;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                nodeProcess = Process.Start(psi);
                
                // Show balloon notification on first launch
                trayIcon.ShowBalloonTip(3000, "Antigravity Codex Bridge", "服务已在后台运行 (127.0.0.1:8787)\n双击图标打开控制面板", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动后台服务失败: " + ex.Message, "Antigravity Codex Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void SendApi(string endpoint, string jsonBody = "{}")
        {
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    if (string.IsNullOrEmpty(bridgeKey)) LoadBridgeKey();
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(uiUrl + endpoint.TrimStart('/'));
                    request.Method = "POST";
                    request.ContentType = "application/json";
                    if (!string.IsNullOrEmpty(bridgeKey))
                    {
                        request.Headers["X-Bridge-Key"] = bridgeKey;
                    }
                    byte[] bytes = Encoding.UTF8.GetBytes(jsonBody);
                    request.ContentLength = bytes.Length;
                    using (Stream os = request.GetRequestStream())
                    {
                        os.Write(bytes, 0, bytes.Length);
                    }
                    using (HttpWebResponse resp = (HttpWebResponse)request.GetResponse())
                    {
                        // Success
                    }
                }
                catch (Exception ex)
                {
                    trayIcon.ShowBalloonTip(2500, "操作失败", ex.Message, ToolTipIcon.Warning);
                }
            });
        }

        private void SwitchModel(string modelId)
        {
            SendApi("api/codex/model", "{\"model\":\"" + modelId + "\"}");
            trayIcon.ShowBalloonTip(2000, "模型切换", "已切换为: " + modelId, ToolTipIcon.Info);
        }

        private void OnOpenDashboard(object sender, EventArgs e)
        {
            try
            {
                Process.Start(new ProcessStartInfo(uiUrl) { UseShellExecute = true });
            }
            catch { }
        }

        private void OnLaunchCodex(object sender, EventArgs e)
        {
            SendApi("api/codex/launch", "{}");
            trayIcon.ShowBalloonTip(2500, "Codex API Service", "正在启动并接管 Codex 桌面端...", ToolTipIcon.Info);
        }

        private void OnRestoreCodex(object sender, EventArgs e)
        {
            SendApi("api/codex/restore", "{}");
            trayIcon.ShowBalloonTip(2500, "恢复配置", "已恢复官方默认配置与纯净历史", ToolTipIcon.Info);
        }

        private void OnExit(object sender, EventArgs e)
        {
            trayIcon.Visible = false;
            try
            {
                SendApi("api/codex/restore", "{}");
                Thread.Sleep(500);
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

            Application.Exit();
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApplication());
        }
    }
}
