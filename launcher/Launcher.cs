// Desktop launcher for Chess Review. Starts the local server hidden (if it isn't already
// running), shows a small splash while it boots, then opens the app in its own window.
// Build: see launcher/build.ps1
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    const string Url = "http://localhost:3000";

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main()
    {
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            if (!IsUp())
            {
                var splash = new Splash(dir);
                splash.Show();
                Application.DoEvents();
                EnsureOllama();
                Process server = StartServer(dir);
                var sw = Stopwatch.StartNew();
                while (!IsUp())
                {
                    if (server.HasExited || sw.Elapsed.TotalSeconds > 60)
                    {
                        splash.Close();
                        MessageBox.Show("Chess Review could not start.\n\nDetails are in server.log in:\n" + dir,
                            "Chess Review", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                    Application.DoEvents();
                    Thread.Sleep(120);
                }
                splash.Close();
            }
            OpenWindow();
        }
        catch (Exception e)
        {
            MessageBox.Show(e.Message, "Chess Review", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static bool Get(string url, string mustContain)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 3000;
            req.Proxy = null;
            using (var res = req.GetResponse())
            using (var sr = new StreamReader(res.GetResponseStream()))
                return sr.ReadToEnd().Contains(mustContain);
        }
        catch { return false; }
    }

    static bool IsUp() { return Get(Url + "/api/status", "chess-review"); }

    // The coach needs Ollama; start its tray app if it isn't running.
    static void EnsureOllama()
    {
        if (Get("http://127.0.0.1:11434/api/version", "version")) return;
        string app = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Ollama\ollama app.exe");
        if (File.Exists(app)) Process.Start(new ProcessStartInfo(app) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden });
    }

    static string FindOnPath(string exe, params string[] fallbacks)
    {
        foreach (string p in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                string full = Path.Combine(p.Trim().Trim('"'), exe);
                if (File.Exists(full)) return full;
            }
            catch { }
        }
        foreach (string f in fallbacks)
        {
            string full = Environment.ExpandEnvironmentVariables(f);
            if (File.Exists(full)) return full;
        }
        return null;
    }

    static Process StartServer(string dir)
    {
        // Release builds ship their own Node.js in .\runtime; source checkouts use the installed one.
        string bundled = Path.Combine(dir, @"runtime\node.exe");
        string node = File.Exists(bundled) ? bundled
            : FindOnPath("node.exe", @"%ProgramFiles%\nodejs\node.exe", @"%LOCALAPPDATA%\Programs\nodejs\node.exe");
        if (node == null) throw new Exception("Node.js was not found. Install it from nodejs.org and try again.");
        // cmd stays as the parent so the server's output can go to server.log.
        var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + node + "\" server.js > server.log 2>&1\"")
        {
            WorkingDirectory = dir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        psi.EnvironmentVariables["CHESS_REVIEW_AUTOSTOP"] = "1";
        return Process.Start(psi);
    }

    // Open as a standalone app window (no tabs or address bar) using Edge or Chrome.
    static void OpenWindow()
    {
        string browser = FindOnPath("msedge.exe",
            @"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
            @"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
            @"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
            @"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
            @"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe");
        if (browser == null)
        {
            Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
            return;
        }
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"ChessReview\window");
        string args = "--app=" + Url + " --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check --start-maximized";
        Process.Start(new ProcessStartInfo(browser, args) { UseShellExecute = false });
    }
}

class Splash : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public Splash(string dir)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = true;
        TopMost = true;
        Text = "Chess Review";
        BackColor = Color.FromArgb(38, 36, 33);
        float s = DeviceDpi / 96f;
        ClientSize = new Size((int)(380 * s), (int)(124 * s));
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var pic = new PictureBox
        {
            SizeMode = PictureBoxSizeMode.Zoom,
            Bounds = new Rectangle((int)(24 * s), (int)(26 * s), (int)(72 * s), (int)(72 * s)),
        };
        try { pic.Image = Image.FromFile(Path.Combine(dir, @"public\icon.png")); } catch { }
        Controls.Add(pic);

        Controls.Add(new Label
        {
            Text = "Chess Review",
            ForeColor = Color.FromArgb(241, 238, 233),
            Font = new Font("Segoe UI Semibold", 15f),
            AutoSize = true,
            Location = new Point((int)(112 * s), (int)(34 * s)),
        });
        Controls.Add(new Label
        {
            Text = "Starting the engine and coach…",
            ForeColor = Color.FromArgb(167, 162, 154),
            Font = new Font("Segoe UI", 10f),
            AutoSize = true,
            Location = new Point((int)(114 * s), (int)(68 * s)),
        });
        var bar = new ProgressBar
        {
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 25,
            Bounds = new Rectangle((int)(116 * s), (int)(96 * s), (int)(236 * s), (int)(6 * s)),
        };
        Controls.Add(bar);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int round = 2; // DWMWCP_ROUND: rounded corners on Windows 11
        try { DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int)); } catch { }
    }
}
