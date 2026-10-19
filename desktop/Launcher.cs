using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--exit") { Signal("Stop"); return 0; }
        if (args.Length > 0 && args[0] == "--create-shortcut")
        {
            try { DesktopShortcut.Create(args.Length > 1 ? args[1] : null); return 0; }
            catch (Exception e) { Console.Error.WriteLine("Shortcut creation failed: " + e.Message); return 1; }
        }
        bool created;
        using (var mutex = new Mutex(true, @"Local\LeonRemoteCodingPrototype", out created))
        {
            if (!created) { Signal("Show"); return 0; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ControlPanel());
        }
        return 0;
    }
    private static void Signal(string name)
    {
        try { using (var e = EventWaitHandle.OpenExisting(@"Local\LeonRemoteCoding" + name)) e.Set(); } catch { }
    }
}

internal static class DesktopShortcut
{
    public static string Create(string directory)
    {
        if (directory == null) directory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (String.IsNullOrEmpty(directory) || !Directory.Exists(directory)) throw new IOException("找不到桌面目录，请确认桌面文件夹可用。");
        var path = Path.Combine(Path.GetFullPath(directory), "Remote Coding.lnk");
        var executable = Application.ExecutablePath;
        object shell = null, shortcut = null;
        try
        {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
            shortcut = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
            if (File.Exists(path))
            {
                var target = Convert.ToString(shortcut.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, shortcut, null));
                if (!String.Equals(target, executable, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("桌面已有同名快捷方式，指向其他位置。请先重命名或移走它，再重试。");
            }
            Set(shortcut, "TargetPath", executable);
            Set(shortcut, "WorkingDirectory", AppDomain.CurrentDomain.BaseDirectory);
            Set(shortcut, "Arguments", "");
            Set(shortcut, "IconLocation", executable + ",0");
            Set(shortcut, "Description", "Remote Coding · 电脑上的 Codex，手机上接着聊");
            shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            SHChangeNotify(0x2000, 0x0005, executable, IntPtr.Zero);
            SHChangeNotify(0x2000, 0x0005, path, IntPtr.Zero);
            return path;
        }
        finally
        {
            if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }
    private static void Set(object shortcut, string name, string value)
    { shortcut.GetType().InvokeMember(name, BindingFlags.SetProperty, null, shortcut, new object[] { value }); }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(uint eventId, uint flags, string item, IntPtr other);
}

internal sealed class ControlPanel : Form
{
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly Label status = new Label();
    private readonly Label stats = new Label();
    private readonly Label pair = new Label();
    private readonly PictureBox qr = new PictureBox();
    private readonly ComboBox addresses = new ComboBox();
    private readonly Label error = new Label();
    private readonly CheckBox lanMode = new CheckBox();
    private bool updatingMode;
    private Process bridge;
    private Dictionary<string, object> runtime;
    private bool exiting;
    private int waiting;
    private Icon customIcon;
    private readonly EventWaitHandle showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\LeonRemoteCodingShow");
    private readonly EventWaitHandle stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\LeonRemoteCodingStop");
    private RegisteredWaitHandle showWait;
    private RegisteredWaitHandle stopWait;

    public ControlPanel()
    {
        Text = "Remote Coding · 手机连接";
        ClientSize = new Size(460, 660);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        BackColor = Color.FromArgb(247, 248, 245);
        Font = new Font("Microsoft YaHei UI", 9F);
        customIcon = CreateIcon(); Icon = customIcon;

        var title = new Label { Text = "Remote Coding", Font = new Font("Segoe UI", 22F, FontStyle.Bold), Location = new Point(32, 26), Size = new Size(395, 38) };
        var subtitle = new Label { Text = "电脑上的 Codex，手机上接着聊。", ForeColor = Color.FromArgb(120, 133, 113), Location = new Point(35, 76), Size = new Size(400, 25) };
        status.Location = new Point(35, 113); status.Size = new Size(400, 22); status.Text = "正在启动桥接服务…";
        qr.Location = new Point(105, 149); qr.Size = new Size(250, 250); qr.SizeMode = PictureBoxSizeMode.Zoom; qr.BackColor = Color.White;
        var hint = new Label { Text = "手机连接同一 Wi-Fi，扫码配对", Location = new Point(35, 413), Size = new Size(390, 23), TextAlign = ContentAlignment.MiddleCenter };
        pair.Location = new Point(35, 443); pair.Size = new Size(390, 28); pair.TextAlign = ContentAlignment.MiddleCenter; pair.Font = new Font("Segoe UI", 15F, FontStyle.Bold);
        addresses.Location = new Point(35, 483); addresses.Size = new Size(310, 28); addresses.DropDownStyle = ComboBoxStyle.DropDownList;
        addresses.SelectedIndexChanged += delegate { LoadQr(); };
        var copy = new Button { Text = "复制地址", Location = new Point(353, 482), Size = new Size(73, 29), FlatStyle = FlatStyle.Flat };
        copy.Click += delegate { if (addresses.SelectedItem != null) Clipboard.SetText(addresses.SelectedItem.ToString()); };
        lanMode.Text = "局域网免配对（同网设备都可访问）"; lanMode.Location = new Point(35, 527); lanMode.Size = new Size(390, 25); lanMode.Enabled = false;
        lanMode.CheckedChanged += delegate { ChangeMode(); };
        stats.Location = new Point(35, 563); stats.Size = new Size(390, 20); stats.ForeColor = Color.FromArgb(126, 138, 116); stats.Font = new Font("Microsoft YaHei UI", 8F);
        error.Location = new Point(35, 593); error.Size = new Size(390, 27); error.ForeColor = Color.FromArgb(149, 104, 61); error.Font = new Font("Microsoft YaHei UI", 8F); error.Text = "关闭此窗口后继续在托盘运行；右键托盘可退出。";
        var revoke = new LinkLabel { Text = "撤销已记住的手机", Location = new Point(35, 626), Size = new Size(230, 24), LinkColor = Color.FromArgb(91, 111, 77) };
        revoke.LinkClicked += delegate {
            if (runtime == null || MessageBox.Show("所有已配对手机将需要重新配对。继续？", "撤销手机配对", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            try { LocalPost("/api/local/revoke-devices", "{}"); ReloadRuntime(); } catch (Exception e) { MessageBox.Show(e.Message, "撤销失败"); }
        };
        var shortcut = new LinkLabel { Text = "创建桌面快捷方式", Location = new Point(285, 626), Size = new Size(140, 24), LinkColor = Color.FromArgb(91, 111, 77) };
        shortcut.LinkClicked += delegate { CreateDesktopShortcut(); };
        Controls.AddRange(new Control[] { title, subtitle, status, qr, hint, pair, addresses, copy, lanMode, stats, error, revoke, shortcut });

        var menu = new ContextMenuStrip();
        menu.Items.Add("显示连接面板", null, delegate { ShowPanel(); });
        menu.Items.Add("创建桌面快捷方式", null, delegate { CreateDesktopShortcut(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出 Remote Coding", null, delegate { ExitApp(); });
        tray.Icon = customIcon; tray.Text = "Remote Coding · 正在启动"; tray.ContextMenuStrip = menu; tray.Visible = true;
        tray.DoubleClick += delegate { ShowPanel(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!exiting) { e.Cancel = true; Hide(); } };
        Shown += delegate { StartBridge(); };
        showWait = ThreadPool.RegisterWaitForSingleObject(showEvent, delegate { if (IsHandleCreated) BeginInvoke(new Action(ShowPanel)); }, null, -1, false);
        stopWait = ThreadPool.RegisterWaitForSingleObject(stopEvent, delegate { if (IsHandleCreated) BeginInvoke(new Action(ExitApp)); }, null, -1, false);
        timer.Interval = 1500; timer.Tick += delegate { UpdateStatus(); }; timer.Start();
    }
    private static Icon CreateIcon()
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("RemoteCoding.Icon"))
        using (var icon = new Icon(stream, new Size(32, 32))) return (Icon)icon.Clone();
    }
    private void CreateDesktopShortcut()
    {
        try
        {
            DesktopShortcut.Create(null);
            MessageBox.Show(this, "已创建桌面快捷方式，下次双击桌面的 Remote Coding 即可启动。\n\n请保留原程序文件夹，快捷方式会从这里启动。", "桌面快捷方式已创建", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception e) { MessageBox.Show(this, e.Message, "快捷方式创建失败", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }
    private void StartBridge()
    {
        try
        {
            Directory.CreateDirectory(Path.Combine(root, ".local"));
            var start = new ProcessStartInfo("node.exe", "--disable-warning=ExperimentalWarning \"" + Path.Combine(root, "src", "server.mjs") + "\"");
            start.WorkingDirectory = root; start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            bridge = new Process(); bridge.StartInfo = start;
            bridge.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
            bridge.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
            bridge.Start(); bridge.BeginOutputReadLine(); bridge.BeginErrorReadLine();
        }
        catch (Exception e)
        {
            status.Text = "桥接服务未能启动"; error.Text = "需要安装 Node.js 24 或更新版本。"; Log(e.Message);
            MessageBox.Show("启动失败：" + e.Message + "\n\n请安装 Node.js 24 或更新版本，再运行程序。", "Remote Coding");
        }
    }
    private readonly object logLock = new object();
    private void Log(string line)
    {
        if (line == null) return;
        try { lock (logLock) File.AppendAllText(Path.Combine(root, ".local", "launcher.log"), DateTime.Now.ToString("s") + " " + line + Environment.NewLine, Encoding.UTF8); } catch { }
    }
    private void UpdateStatus()
    {
        if (bridge == null) return;
        if (bridge.HasExited)
        {
            status.Text = "桥接服务已停止"; tray.Text = "Remote Coding · 已停止";
            error.Text = "请查看 .local\\launcher.log；退出后重新启动。"; timer.Stop(); return;
        }
        try
        {
            if (runtime == null)
            {
                var path = Path.Combine(root, ".local", "runtime.json");
                if (!File.Exists(path)) { if (++waiting > 20) error.Text = "启动时间较长，请检查 .local\\launcher.log。"; return; }
                var info = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                if (Convert.ToInt32(info["pid"]) != bridge.Id) return;
                runtime = info;
                pair.Text = "配对码  " + info["pairCode"].ToString();
                foreach (var url in (System.Collections.IEnumerable)info["urls"]) addresses.Items.Add(url.ToString());
                if (addresses.Items.Count > 0) addresses.SelectedIndex = 0;
                Log("Desktop panel ready; bridge PID=" + bridge.Id + "; addresses=" + addresses.Items.Count + "; QR loaded=" + (qr.Image != null));
            }
            using (var client = Client())
            {
                var data = json.Deserialize<Dictionary<string, object>>(client.DownloadString(LocalUrl("/api/local/status")));
                var connected = Convert.ToBoolean(data["connected"]);
                status.Text = connected ? "● Codex 桌面已连接" : "○ 等待电脑上的 Codex 打开";
                status.ForeColor = connected ? Color.FromArgb(66, 107, 81) : Color.FromArgb(157, 122, 54);
                tray.Text = connected ? "Remote Coding · Codex 已连接" : "Remote Coding · 等待 Codex";
                stats.Text = "桥接内存 " + data["memoryMb"] + " MB    在线 " + data["streams"] + "    已记住 " + data["remembered"] + " 台";
                updatingMode = true; lanMode.Checked = data["authMode"].ToString() == "lan"; lanMode.Enabled = true; updatingMode = false;
                pair.Text = lanMode.Checked ? "局域网免配对已开启" : "配对码  " + runtime["pairCode"].ToString();
            }
            if (addresses.SelectedItem != null && addresses.SelectedItem.ToString().Contains("127.0.0.1")) error.Text = "未发现局域网地址，请连接 Wi-Fi 或网线后重启程序。";
        }
        catch (Exception e) { Log(e.Message); }
    }
    private WebClient Client()
    {
        var client = new WebClient(); client.Encoding = Encoding.UTF8;
        client.Headers.Add("X-Local-Key", runtime["localKey"].ToString()); return client;
    }
    private string LocalUrl(string path) { return runtime["protocol"].ToString() + "://127.0.0.1:" + runtime["port"].ToString() + path; }
    private void LocalPost(string path, string body)
    {
        using (var client = Client()) { client.Headers.Add("Content-Type", "application/json"); client.UploadString(LocalUrl(path), "POST", body); }
    }
    private void ReloadRuntime() { runtime = null; addresses.Items.Clear(); UpdateStatus(); }
    private void ChangeMode()
    {
        if (updatingMode || runtime == null) return;
        if (lanMode.Checked && MessageBox.Show("开启后，同一局域网里能访问此地址的设备都可以查看 Codex 会话、发送消息和操作任务。\n\n是否开启局域网免配对？", "局域网访问范围", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
        { updatingMode = true; lanMode.Checked = false; updatingMode = false; return; }
        try { LocalPost("/api/local/auth-mode", lanMode.Checked ? "{\"mode\":\"lan\"}" : "{\"mode\":\"paired\"}"); ReloadRuntime(); }
        catch (Exception e) { MessageBox.Show(e.Message, "连接模式未更改"); UpdateStatus(); }
    }
    private void LoadQr()
    {
        if (runtime == null || addresses.SelectedItem == null) return;
        try
        {
            using (var client = Client())
            using (var stream = new MemoryStream(client.DownloadData(LocalUrl("/api/local/qr?url=" + Uri.EscapeDataString(addresses.SelectedItem.ToString())))))
            using (var img = Image.FromStream(stream))
            {
                var old = qr.Image; qr.Image = new Bitmap(img); if (old != null) old.Dispose();
            }
        }
        catch (Exception e) { error.Text = "二维码加载失败，可手动输入地址与配对码。"; Log(e.Message); }
    }
    private void ShowPanel() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    private void ExitApp()
    {
        if (exiting) return; exiting = true; timer.Stop();
        try
        {
            if (runtime != null)
                using (var client = Client()) { client.Headers.Add("Content-Type", "application/json"); client.UploadString(LocalUrl("/api/local/exit"), "POST", "{}"); }
            if (bridge != null && !bridge.HasExited && !bridge.WaitForExit(1500)) bridge.Kill();
        }
        catch { if (bridge != null && !bridge.HasExited) bridge.Kill(); }
        tray.Visible = false; tray.Dispose(); if (qr.Image != null) qr.Image.Dispose();
        showWait.Unregister(null); stopWait.Unregister(null); showEvent.Dispose(); stopEvent.Dispose(); customIcon.Dispose();
        if (bridge != null) bridge.Dispose(); Close(); Application.Exit();
    }
}
