/* ============================================================================
 *  吉卜力桌面宠物 · 悬浮层  (PetOverlay)
 * ----------------------------------------------------------------------------
 *  一个真正悬浮在「桌面 + 所有窗口（含浏览器、全屏应用）之上」的透明宠物：
 *    · 无边框、无标题栏、背景完全透明，只看得见宠物本体和台词气泡
 *    · Topmost = true，始终压在所有窗口之上
 *    · 鼠标按住即可拖动；透明区域自动鼠标穿透
 *    · 呼吸浮动动画；说话时轻微点头
 *    · 通过轮询本机 Node 后端的 /api/overlay/poll 接收指令
 *      （念台词 / 换宠物 / 弹气泡 / 退出）
 *    · 用 WPF MediaPlayer 播放 MP3（原声或 TTS 都由后端准备好）
 *
 *  编译：用 .NET Framework 自带的 csc.exe，无需安装任何东西，见 build.ps1
 *  注意：csc 4.x 只支持 C# 5，因此本文件不使用字符串插值、?. 等新语法。
 * ==========================================================================*/

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using System.Web.Script.Serialization;

namespace PetOverlay
{
    public class Program
    {
        /// <summary>诊断日志（与 exe 同目录），winexe 没有控制台，出错只能靠它</summary>
        public static readonly string LogFile = System.IO.Path.Combine(
            AppDomain.CurrentDomain.BaseDirectory, "PetOverlay.log");

        public static void Log(string msg)
        {
            try
            {
                System.IO.File.AppendAllText(
                    LogFile,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + msg + Environment.NewLine);
            }
            catch { /* 日志失败不能影响主流程 */ }
        }

        /* ---------------- 单实例 ---------------- */
        // 桌面宠物只应该有一只。重复启动时不去开第二个窗口，
        // 而是通知已经在跑的那只「归位 + 置顶」，把它唤回你眼前。
        const string MUTEX_NAME = "Local\\GhibliDesktopPet.Singleton";
        const string SUMMON_EVENT = "Local\\GhibliDesktopPet.Summon";
        static Mutex _instanceMutex;
        static EventWaitHandle _summonEvent;

        [STAThread]
        public static void Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
            {
                Log("!! UNHANDLED(AppDomain): " + e.ExceptionObject);
            };

            string baseUrl = "http://127.0.0.1:8787";
            string petId = "";
            double x = double.NaN, y = double.NaN;
            bool noTopmost = false;
            bool allowMultiple = false;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--api" && i + 1 < args.Length) baseUrl = args[++i];
                else if (args[i] == "--pet" && i + 1 < args.Length) petId = args[++i];
                else if (args[i] == "--x" && i + 1 < args.Length) x = double.Parse(args[++i], CultureInfo.InvariantCulture);
                else if (args[i] == "--y" && i + 1 < args.Length) y = double.Parse(args[++i], CultureInfo.InvariantCulture);
                else if (args[i] == "--no-topmost") noTopmost = true;
                else if (args[i] == "--allow-multiple") allowMultiple = true;
            }

            Log("=== 启动 === args=" + string.Join(" ", args) + "  api=" + baseUrl);

            if (!allowMultiple)
            {
                try
                {
                    bool createdNew;
                    _instanceMutex = new Mutex(true, MUTEX_NAME, out createdNew);
                    if (!createdNew)
                    {
                        Log("已有实例在运行 → 通知它归位后退出");
                        try
                        {
                            EventWaitHandle.OpenExisting(SUMMON_EVENT).Set();
                        }
                        catch (Exception ex)
                        {
                            Log("通知已有实例失败（它可能正在启动中）: " + ex.Message);
                        }
                        return;
                    }
                    _summonEvent = new EventWaitHandle(false, EventResetMode.AutoReset, SUMMON_EVENT);
                }
                catch (Exception ex)
                {
                    Log("单实例检查失败，按多实例继续: " + ex.Message);
                }
            }

            var app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            app.DispatcherUnhandledException += delegate(object s, DispatcherUnhandledExceptionEventArgs e)
            {
                Log("!! UNHANDLED(Dispatcher): " + e.Exception);
                e.Handled = true; // 不要让一个小错误把宠物弄没
            };

            OverlayWindow overlay;
            try
            {
                overlay = new OverlayWindow(baseUrl, petId);
                overlay.Topmost = !noTopmost;
            }
            catch (Exception ex)
            {
                Log("!! 创建窗口失败: " + ex);
                return;
            }

            if (!double.IsNaN(x) && !double.IsNaN(y)) overlay.SetStartPosition(x, y);

            // 监听「再来一只」的信号：把已有窗口唤回右下角并置顶
            if (_summonEvent != null)
            {
                var waiter = new Thread(delegate()
                {
                    while (true)
                    {
                        try
                        {
                            if (!_summonEvent.WaitOne()) continue;
                            overlay.Dispatcher.BeginInvoke(DispatcherPriority.Normal, new Action(delegate
                            {
                                try
                                {
                                    if (!overlay.IsVisible) overlay.Show();
                                    overlay.SnapToCorner();
                                    overlay.Topmost = false;
                                    overlay.Topmost = true;
                                    overlay.Activate();
                                    overlay.ShowBubble(null, "我在这儿～");
                                    Log("收到唤回信号，已归位到右下角");
                                }
                                catch (Exception ex) { Log("唤回失败: " + ex.Message); }
                            }));
                        }
                        catch { /* 忽略 */ }
                    }
                });
                waiter.IsBackground = true;
                waiter.Start();
            }

            try
            {
                app.Run(overlay);
                Log("=== 正常退出 ===");
            }
            catch (Exception ex)
            {
                Log("!! app.Run 异常: " + ex);
            }
        }
    }

    /// <summary>宠物悬浮窗</summary>
    public class OverlayWindow : Window
    {
        const double PET_SIZE = 128;
        const double PET_MARGIN = 6;

        readonly string _baseUrl;
        readonly DispatcherTimer _pollTimer;
        long _cursor = 0;
        string _petId = "";
        string _currentAudio = "";

        readonly Image _petImage;
        readonly Border _bubble;
        readonly TextBlock _bubbleJa;
        readonly TextBlock _bubbleZh;
        readonly TranslateTransform _bob;
        readonly ScaleTransform _nod;
        readonly DispatcherTimer _bubbleTimer;

        double _lastX = double.NaN, _lastY = double.NaN;
        int _pollErrors = 0;
        Grid _petHost;
        Border _offlineBadge;
        bool _online = true;

        public OverlayWindow(string baseUrl, string petId)
        {
            _baseUrl = baseUrl.TrimEnd('/');
            _petId = petId;

            Title = "吉卜力桌面宠物";
            // 窗口比宠物大：留出气泡的位置。宠物贴在窗口的右下角，
            // 窗口左上方那块空白区域通过 WM_NCHITTEST 返回 HTTRANSPARENT 实现鼠标穿透，
            // 不会挡住底下的窗口。
            Width = PET_SIZE + 180;
            Height = PET_SIZE + 168;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            // 注意：分层窗口（AllowsTransparency=true）必须给一个画刷，
            // 设成 null 会导致整个窗口什么都渲染不出来（实测窗口 IsVisible=True 但桌面上看不到）。
            // 用全透明画刷即可：透明区域依然看得见桌面，只是这一块矩形会吃掉鼠标事件。
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.NoResize;
            SnapsToDevicePixels = true;

            // ---------------- 布局 ----------------
            var root = new Grid();
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });      // 气泡
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // 宠物
            root.Margin = new Thickness(4);

            // 气泡
            _bubbleJa = new TextBlock
            {
                FontSize = 14,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Color.FromRgb(0x1C, 0x4A, 0x56)),
                TextWrapping = TextWrapping.Wrap,
                MaxWidth = 250,
                Visibility = Visibility.Collapsed
            };
            _bubbleZh = new TextBlock
            {
                FontSize = 11.5,
                Foreground = new SolidColorBrush(Color.FromRgb(0x4D, 0x62, 0x73)),
                TextWrapping = TextWrapping.Wrap,
                MaxWidth = 250,
                Margin = new Thickness(0, 4, 0, 0),
                Visibility = Visibility.Collapsed
            };

            var bubbleStack = new StackPanel();
            bubbleStack.Children.Add(_bubbleJa);
            bubbleStack.Children.Add(_bubbleZh);

            _bubble = new Border
            {
                Background = new SolidColorBrush(Color.FromArgb(0xF2, 0xFF, 0xFF, 0xFF)),
                BorderBrush = new SolidColorBrush(Color.FromArgb(0x33, 0x24, 0x33, 0x3F)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(14),
                Padding = new Thickness(12, 9, 12, 9),
                Margin = new Thickness(0, 0, 6, 8),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
                Visibility = Visibility.Collapsed,
                Child = bubbleStack,
                Effect = new DropShadowEffect
                {
                    Color = Color.FromRgb(0x18, 0x2C, 0x3A),
                    BlurRadius = 18,
                    ShadowDepth = 3,
                    Opacity = 0.28
                }
            };
            Grid.SetRow(_bubble, 0);
            root.Children.Add(_bubble);

            // 宠物本体
            var petHost = new Grid
            {
                Width = PET_SIZE,
                Height = PET_SIZE,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
                Cursor = Cursors.SizeAll,
                Background = Brushes.Transparent
            };
            _petHost = petHost;

            var shadow = new Ellipse
            {
                Width = PET_SIZE * 0.62,
                Height = PET_SIZE * 0.13,
                Fill = new SolidColorBrush(Color.FromArgb(0x4D, 0x18, 0x2C, 0x3A)),
                VerticalAlignment = VerticalAlignment.Bottom,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 0, 0, 2),
                Effect = new BlurEffect { Radius = 8 }
            };

            _petImage = new Image
            {
                Width = PET_SIZE - 10,
                Height = PET_SIZE - 10,
                Stretch = Stretch.UniformToFill,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            _petImage.Clip = new EllipseGeometry(
                new Point((PET_SIZE - 10) / 2, (PET_SIZE - 10) / 2),
                (PET_SIZE - 10) / 2, (PET_SIZE - 10) / 2);

            var ring = new Ellipse
            {
                Width = PET_SIZE - 8,
                Height = PET_SIZE - 8,
                Stroke = new SolidColorBrush(Color.FromArgb(0xF0, 0xFF, 0xFF, 0xFF)),
                StrokeThickness = 3.5,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Effect = new DropShadowEffect
                {
                    Color = Color.FromRgb(0x18, 0x2C, 0x3A),
                    BlurRadius = 16,
                    ShadowDepth = 4,
                    Opacity = 0.35
                }
            };

            petHost.Children.Add(shadow);
            petHost.Children.Add(_petImage);
            petHost.Children.Add(ring);

            // 离线小角标：后端连不上时显示，让用户一眼看出「宠物还在，只是没连上后端」
            _offlineBadge = new Border
            {
                Background = new SolidColorBrush(Color.FromArgb(0xE0, 0x6B, 0x77, 0x80)),
                CornerRadius = new CornerRadius(9),
                Padding = new Thickness(8, 2, 8, 2),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(0, 0, 0, 4),
                Visibility = Visibility.Collapsed,
                Child = new TextBlock
                {
                    Text = "离线",
                    FontSize = 11,
                    FontWeight = FontWeights.Bold,
                    Foreground = Brushes.White,
                },
            };
            petHost.Children.Add(_offlineBadge);

            _bob = new TranslateTransform(0, 0);
            _nod = new ScaleTransform(1, 1);
            var group = new TransformGroup();
            group.Children.Add(_nod);
            group.Children.Add(_bob);
            petHost.RenderTransform = group;
            petHost.RenderTransformOrigin = new Point(0.5, 0.5);

            Grid.SetRow(petHost, 1);
            root.Children.Add(petHost);

            Content = root;

            // ---------------- 交互 ----------------
            petHost.MouseLeftButtonDown += OnPetMouseDown;
            petHost.MouseRightButtonUp += OnPetRightClick;
            _bubble.MouseLeftButtonDown += OnPetMouseDown;

            var menu = new ContextMenu();
            menu.Items.Add(MenuItem("回到右下角", delegate { SnapToCorner(); }));
            menu.Items.Add(MenuItem("让它说一句", delegate { RequestSpeak(); }));
            menu.Items.Add(new Separator());
            menu.Items.Add(MenuItem("退出桌面宠物", delegate { Application.Current.Shutdown(); }));
            ContextMenu = menu;

            // ---------------- 动画 ----------------
            var bobAnim = new DoubleAnimation(0, -7, TimeSpan.FromSeconds(1.9));
            bobAnim.AutoReverse = true;
            bobAnim.RepeatBehavior = RepeatBehavior.Forever;
            bobAnim.EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut };
            _bob.BeginAnimation(TranslateTransform.YProperty, bobAnim);

            // ---------------- 气泡自动隐藏 ----------------
            _bubbleTimer = new DispatcherTimer();
            _bubbleTimer.Interval = TimeSpan.FromSeconds(8);
            _bubbleTimer.Tick += delegate { _bubbleTimer.Stop(); HideBubble(); };

            // ---------------- 轮询后端 ----------------
            _pollTimer = new DispatcherTimer();
            _pollTimer.Interval = TimeSpan.FromMilliseconds(1200);
            _pollTimer.Tick += delegate { Poll(); };
            _pollTimer.Start();

            Loaded += delegate
            {
                Program.Log("Loaded: IsVisible=" + IsVisible + " Left=" + Left + " Top=" + Top +
                            " ActualW=" + ActualWidth + " ActualH=" + ActualHeight +
                            " Topmost=" + Topmost + " AllowsTransparency=" + AllowsTransparency);
                if (double.IsNaN(_lastX)) SnapToCorner();
                Program.Log("定位后: Left=" + Left + " Top=" + Top +
                            " 工作区=" + SystemParameters.WorkArea);
                Poll();
            };
            Closed += delegate
            {
                Program.Log("Closed");
                _pollTimer.Stop();
                _bubbleTimer.Stop();
                StopAudio();
            };
        }

        static MenuItem MenuItem(string header, RoutedEventHandler handler)
        {
            var mi = new MenuItem();
            mi.Header = header;
            mi.Click += handler;
            return mi;
        }

        /* ------------------------ 鼠标穿透 ------------------------ */

        const int WM_NCHITTEST = 0x0084;
        const int HTTRANSPARENT = -1;

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var helper = new System.Windows.Interop.WindowInteropHelper(this);
            var src = System.Windows.Interop.HwndSource.FromHwnd(helper.Handle);
            if (src != null) src.AddHook(WndProc);
        }

        /// <summary>
        /// 窗口为了容纳气泡而比宠物大，左上方那块空白必须让鼠标穿透，
        /// 否则会挡住底下窗口的点击。做法：未落在宠物/气泡上的命中测试返回 HTTRANSPARENT。
        /// </summary>
        IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg != WM_NCHITTEST) return IntPtr.Zero;
            try
            {
                long lp = lParam.ToInt64();
                int sx = (short)(lp & 0xFFFF);
                int sy = (short)((lp >> 16) & 0xFFFF);

                if (!HitElement(_petHost, sx, sy) && !(_bubble.Visibility == Visibility.Visible && HitElement(_bubble, sx, sy)))
                {
                    handled = true;
                    return (IntPtr)HTTRANSPARENT;
                }
            }
            catch { /* 命中测试失败时按默认处理 */ }
            return IntPtr.Zero;
        }

        /// <summary>屏幕坐标是否落在某个元素的矩形内</summary>
        static bool HitElement(FrameworkElement el, int screenX, int screenY)
        {
            if (el == null || !el.IsVisible) return false;
            try
            {
                Point tl = el.PointToScreen(new Point(0, 0));
                Point br = el.PointToScreen(new Point(el.ActualWidth, el.ActualHeight));
                return screenX >= tl.X && screenX <= br.X && screenY >= tl.Y && screenY <= br.Y;
            }
            catch
            {
                return false;
            }
        }

        /* ------------------------ 位置 ------------------------ */

        public void SetStartPosition(double x, double y)
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = x;
            Top = y;
            _lastX = x;
            _lastY = y;
        }

        public void SnapToCorner()
        {
            var wa = SystemParameters.WorkArea;
            Left = wa.Right - Width - 24;
            Top = wa.Bottom - Height - 12;
            _lastX = Left;
            _lastY = Top;
        }

        void OnPetMouseDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState == MouseButtonState.Pressed)
            {
                try { DragMove(); }
                catch (InvalidOperationException) { /* 偶发：鼠标已释放 */ }
                _lastX = Left;
                _lastY = Top;
            }
        }

        void OnPetRightClick(object sender, MouseButtonEventArgs e)
        {
            if (ContextMenu != null)
            {
                ContextMenu.PlacementTarget = this;
                ContextMenu.IsOpen = true;
            }
        }

        /* ------------------------ 气泡 ------------------------ */

        public void ShowBubble(string ja, string zh)
        {
            _bubbleJa.Text = ja == null ? "" : ja;
            _bubbleZh.Text = zh == null ? "" : zh;
            _bubbleJa.Visibility = string.IsNullOrEmpty(_bubbleJa.Text) ? Visibility.Collapsed : Visibility.Visible;
            _bubbleZh.Visibility = string.IsNullOrEmpty(_bubbleZh.Text) ? Visibility.Collapsed : Visibility.Visible;

            if (_bubbleJa.Visibility == Visibility.Collapsed && _bubbleZh.Visibility == Visibility.Collapsed)
            {
                HideBubble();
                return;
            }

            _bubble.Visibility = Visibility.Visible;
            _bubble.Opacity = 0;
            var fade = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(220));
            _bubble.BeginAnimation(OpacityProperty, fade);

            _bubbleTimer.Stop();
            _bubbleTimer.Interval = TimeSpan.FromMilliseconds(Math.Max(4000, (ja ?? "").Length * 220 + (zh ?? "").Length * 140 + 3000));
            _bubbleTimer.Start();

            // 布局是异步的，等一帧之后再量尺寸，方便排查「气泡被窗口裁掉」这类问题
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(delegate
            {
                try
                {
                    Point bubbleTl = _bubble.TranslatePoint(new Point(0, 0), this);
                    Point petTl = _petHost.TranslatePoint(new Point(0, 0), this);
                    Program.Log(string.Format(
                        "布局: 窗口={0}x{1}  气泡={2}x{3}@({4},{5})  宠物={6}x{7}@({8},{9})",
                        (int)ActualWidth, (int)ActualHeight,
                        (int)_bubble.ActualWidth, (int)_bubble.ActualHeight, (int)bubbleTl.X, (int)bubbleTl.Y,
                        (int)_petHost.ActualWidth, (int)_petHost.ActualHeight, (int)petTl.X, (int)petTl.Y));
                }
                catch (Exception ex) { Program.Log("布局日志失败: " + ex.Message); }
            }));
        }

        void HideBubble()
        {
            var fade = new DoubleAnimation(_bubble.Opacity, 0, TimeSpan.FromMilliseconds(260));
            fade.Completed += delegate { _bubble.Visibility = Visibility.Collapsed; };
            _bubble.BeginAnimation(OpacityProperty, fade);
        }

        /* ------------------------ 播放 ------------------------ */

        [System.Runtime.InteropServices.DllImport("winmm.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        static extern int mciSendString(string command, System.Text.StringBuilder ret, int retLen, IntPtr hwnd);

        static string Mci(string cmd)
        {
            var sb = new System.Text.StringBuilder(256);
            int rc = mciSendString(cmd, sb, sb.Capacity, IntPtr.Zero);
            return rc == 0 ? sb.ToString() : null;   // null 表示失败
        }

        /// <summary>当前正在播放的 SoundPlayer（必须保引用，否则会被 GC 掉导致声音中断）</summary>
        System.Media.SoundPlayer _soundPlayer;
        const string MCI_ALIAS = "petoverlayaudio";

        void StopAudio()
        {
            try { Mci("close " + MCI_ALIAS); } catch { /* ignore */ }
            if (_soundPlayer != null)
            {
                try { _soundPlayer.Stop(); _soundPlayer.Dispose(); } catch { /* ignore */ }
                _soundPlayer = null;
            }
        }

        /// <summary>下载音频到本地临时文件，返回本地路径</summary>
        string DownloadToTemp(string url)
        {
            string dir = ResolveAudioDir();

            string ext = System.IO.Path.GetExtension(new Uri(url).AbsolutePath);
            if (string.IsNullOrEmpty(ext)) ext = ".bin";

            int hash = url.GetHashCode();
            string local = System.IO.Path.Combine(dir, "a" + hash.ToString("x8") + ext);

            if (File.Exists(local) && new FileInfo(local).Length > 512) return local;

            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 15000;
            req.ReadWriteTimeout = 15000;
            req.Proxy = null;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var stream = resp.GetResponseStream())
            using (var fs = File.Create(local))
            {
                stream.CopyTo(fs);
            }
            return local;
        }

        /// <summary>
        /// 选一个**确实能写**的目录来放临时音频。
        ///
        /// 为什么不能直接用 %TEMP%：
        ///   MCI 播放 MP3 需要真实文件路径，所以必须落盘。但 %TEMP% 不一定可写 ——
        ///   实测就踩到过「对路径 …\Temp\pet-overlay-audio 的访问被拒绝」，
        ///   结果右键说话完全没声音。所以这里逐个候选目录**真的建一下、写一个测试文件**，
        ///   第一个成功的就用，并把结果写进日志。
        /// </summary>
        string ResolveAudioDir()
        {
            if (_audioDir != null) return _audioDir;

            var candidates = new List<string>();
            // 1) 程序自己的目录（项目目录，一般都可写，最可靠）
            candidates.Add(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "audio-cache"));
            // 2) 用户本地应用数据
            string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!string.IsNullOrEmpty(localApp)) candidates.Add(System.IO.Path.Combine(localApp, "GhibliDesktopPet", "audio"));
            // 3) 系统临时目录（首选子目录，再退到根）
            candidates.Add(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "pet-overlay-audio"));
            candidates.Add(System.IO.Path.GetTempPath());

            var errors = new List<string>();
            foreach (string dir in candidates)
            {
                if (string.IsNullOrEmpty(dir)) continue;
                try
                {
                    Directory.CreateDirectory(dir);
                    string probe = System.IO.Path.Combine(dir, "write-probe.tmp");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    _audioDir = dir;
                    Program.Log("音频临时目录: " + dir);
                    return _audioDir;
                }
                catch (Exception ex)
                {
                    errors.Add(dir + " -> " + ex.Message);
                }
            }

            // 全都写不进去：记下来，播放时会被上层提示，不再静默
            Program.Log("!! 找不到可写的音频临时目录：");
            foreach (string e in errors) Program.Log("     " + e);
            _audioDir = System.IO.Path.GetTempPath();  // 兜底，失败时会有明确报错
            return _audioDir;
        }

        string _audioDir;

        /// <summary>
        /// 播放音频。
        ///
        /// 本机是精简版 Windows（wmplayer.exe 已被移除），实测：
        ///   · WPF MediaPlayer 播放 **HTTP 流** 会失败（HRESULT 0xC00D1198）甚至带崩进程
        ///     —— 因此音频一律先下载到本地再播
        ///   · Edge TTS 的在线服务也已不再支持 PCM/WAV 输出（配置被接受但随后断流），
        ///     只能拿到 MP3
        ///   · **MCI（winmm 的 mciSendString）可以正常播放本地 MP3**，实测
        ///     open type mpegvideo → rc=0，status mode → playing，且不依赖 Windows Media Player
        ///
        /// 所以：MP3 走 MCI，WAV 走 SoundPlayer，两者都是 WinMM 层，不需要额外编解码器。
        /// </summary>
        void Play(string url)
        {
            if (string.IsNullOrEmpty(url))
            {
                // 不该再走到这里了（上层会先把「没有音频」的情况提示出来），留个日志兜底
                Program.Log("!! Play() 收到空音频地址，跳过播放");
                return;
            }
            _currentAudio = url;

            string local;
            try
            {
                local = DownloadToTemp(url);
            }
            catch (Exception ex)
            {
                Program.Log("!! 下载音频失败: " + ex.Message + "  url=" + url);
                // 不再静默：告诉用户出了什么事，以及去哪里看细节
                ShowBubble(null, "音频下载失败，放不出声…（细节见 desktop\\PetOverlay.log）");
                return;
            }

            string ext = System.IO.Path.GetExtension(local).ToLowerInvariant();
            Program.Log("准备播放: " + local + "  (" + new FileInfo(local).Length + "B, " + ext + ")");

            StopAudio();

            bool ok = ext == ".wav" ? (PlayWav(local) || PlayMci(local)) : (PlayMci(local) || PlayWav(local));
            if (!ok)
            {
                Program.Log("!! 播放失败（MCI 与 SoundPlayer 都没成功）: " + local);
                ShowBubble(null, "系统播放不了这段音频…（细节见 desktop\\PetOverlay.log）");
            }

            // 说话时点头
            var nod = new DoubleAnimation(1.0, 1.06, TimeSpan.FromMilliseconds(220));
            nod.AutoReverse = true;
            nod.RepeatBehavior = new RepeatBehavior(3);
            _nod.BeginAnimation(ScaleTransform.ScaleXProperty, nod);
            var nodY = new DoubleAnimation(1.0, 0.95, TimeSpan.FromMilliseconds(220));
            nodY.AutoReverse = true;
            nodY.RepeatBehavior = new RepeatBehavior(3);
            _nod.BeginAnimation(ScaleTransform.ScaleYProperty, nodY);
        }

        /// <summary>用 MCI 播放（MP3/WAV/M4A 等，走 Windows 自带的 MCI 设备，不需要 WMP）</summary>
        bool PlayMci(string file)
        {
            try
            {
                Mci("close " + MCI_ALIAS);
                string opened = Mci("open \"" + file + "\" alias " + MCI_ALIAS);
                if (opened == null)
                {
                    // 再试一次，显式指定设备类型
                    opened = Mci("open \"" + file + "\" type mpegvideo alias " + MCI_ALIAS);
                }
                if (opened == null)
                {
                    Program.Log("MCI open 失败: " + file);
                    return false;
                }
                string len = Mci("status " + MCI_ALIAS + " length");
                if (Mci("play " + MCI_ALIAS) == null)
                {
                    Program.Log("MCI play 失败: " + file);
                    return false;
                }
                Program.Log("MCI 播放中（时长 " + (len ?? "?") + "ms）");
                return true;
            }
            catch (Exception ex)
            {
                Program.Log("MCI 异常: " + ex.Message);
                return false;
            }
        }

        /// <summary>用 SoundPlayer 播放 WAV（纯 PCM，无需编解码器）</summary>
        bool PlayWav(string file)
        {
            if (!file.ToLowerInvariant().EndsWith(".wav")) return false;
            try
            {
                var sp = new System.Media.SoundPlayer(file);
                sp.Load();               // 先加载，格式不对会在这里抛异常
                sp.Play();               // 异步播放
                _soundPlayer = sp;       // 保引用
                Program.Log("SoundPlayer 播放成功");
                return true;
            }
            catch (Exception ex)
            {
                Program.Log("SoundPlayer 失败: " + ex.Message);
                return false;
            }
        }

        void SetPetImage(string url)
        {
            if (string.IsNullOrEmpty(url)) return;
            try
            {
                // 必须自己下载：WPF 的 BitmapImage 传 HTTP URI 时走 WinINET，
                // 在这台精简版 Windows 上会直接失败（HRESULT 0x80072EE4 = ERROR_INTERNET_INTERNAL_ERROR）。
                byte[] bytes = HttpGetBytes(url);
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.StreamSource = new MemoryStream(bytes);
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.EndInit();
                bmp.Freeze();
                _petImage.Source = bmp;
                Program.Log("图片已加载: " + url + "  (" + bmp.PixelWidth + "x" + bmp.PixelHeight + ", " + bytes.Length + "B)");
            }
            catch (Exception ex)
            {
                Program.Log("!! 加载图片失败: " + ex.Message + "  url=" + url);
            }
        }

        /// <summary>用 HttpWebRequest 下载（不要用 WebClient/WinINET 上层封装）</summary>
        static byte[] HttpGetBytes(string url)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 10000;
            req.ReadWriteTimeout = 10000;
            req.Proxy = null;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var stream = resp.GetResponseStream())
            using (var ms = new MemoryStream())
            {
                stream.CopyTo(ms);
                return ms.ToArray();
            }
        }

        /* ------------------------ 轮询 ------------------------ */

        void Poll()
        {
            string body;
            try
            {
                body = HttpGet(_baseUrl + "/api/overlay/poll?since=" + _cursor + "&pet=" + Uri.EscapeDataString(_petId == null ? "" : _petId));
            }
            catch (Exception ex)
            {
                _pollErrors++;
                if (_pollErrors == 1 || _pollErrors % 30 == 0)
                    Program.Log("轮询失败(#" + _pollErrors + "): " + ex.Message);
                // 连续失败几次就显示离线角标（后端没起来时不再静默）
                if (_pollErrors >= 3) SetOnline(false);
                return; // 后端没起来就静默重试，不打扰用户
            }
            _pollErrors = 0;
            SetOnline(true);

            Dictionary<string, object> payload;
            try
            {
                payload = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
            }
            catch (Exception ex)
            {
                Program.Log("!! JSON 解析失败: " + ex.Message);
                return;
            }
            if (payload == null) return;

            object cursorObj;
            if (payload.TryGetValue("cursor", out cursorObj) && cursorObj != null)
            {
                long c;
                if (long.TryParse(Convert.ToString(cursorObj), out c)) _cursor = c;
            }

            object cmdsObj;
            if (!payload.TryGetValue("commands", out cmdsObj)) return;
            var cmds = cmdsObj as System.Collections.IEnumerable;
            if (cmds == null) return;

            foreach (object item in cmds)
            {
                var cmd = item as Dictionary<string, object>;
                if (cmd == null) continue;
                string type = Str(cmd, "type");
                Program.Log("收到指令: " + type + " pet=" + Str(cmd, "petId") + " audio=" + Str(cmd, "audioUrl"));
                try
                {
                    HandleCommand(cmd);
                }
                catch (Exception ex)
                {
                    Program.Log("!! 处理指令失败(" + type + "): " + ex);
                }
            }
        }

        void HandleCommand(Dictionary<string, object> cmd)
        {
            string type = Str(cmd, "type");

            if (type == "pet")
            {
                string id = Str(cmd, "petId");
                if (!string.IsNullOrEmpty(id)) _petId = id;
                SetPetImage(Absolute(Str(cmd, "imageUrl")));
            }
            else if (type == "speak")
            {
                string pid = Str(cmd, "petId");
                if (!string.IsNullOrEmpty(pid)) _petId = pid;
                string img = Str(cmd, "imageUrl");
                if (!string.IsNullOrEmpty(img)) SetPetImage(Absolute(img));

                string ja = Str(cmd, "ja");
                string zh = Str(cmd, "zh");
                string audioUrl = Str(cmd, "audioUrl");

                if (string.IsNullOrEmpty(audioUrl))
                {
                    // 这里以前是「静默什么都不做」—— 用户右键让它说话，看到气泡闪一下就没了声音，
                    // 只会以为程序坏了。现在明确告诉他为什么、该怎么办。
                    string why = Str(cmd, "voiceSource") == "none"
                        ? "还没有这句话的离线音频，而且当前无法联网合成"
                        : "这句话的音频没有准备好";
                    ShowBubble(ja, (string.IsNullOrEmpty(zh) ? "" : zh + "  ") + "（" + why + "）");
                    Program.Log("!! speak 指令没有 audioUrl，只显示文字。voiceSource=" + Str(cmd, "voiceSource"));
                    return;
                }

                ShowBubble(ja, zh);
                Play(Absolute(audioUrl));
            }
            else if (type == "bubble")
            {
                ShowBubble(Str(cmd, "ja"), Str(cmd, "zh"));
            }
            else if (type == "quit")
            {
                Application.Current.Shutdown();
            }
        }

        /// <summary>切换在线状态：离线时显示角标并把宠物调暗一点</summary>
        void SetOnline(bool online)
        {
            if (_online == online) return;
            _online = online;
            try
            {
                _offlineBadge.Visibility = online ? Visibility.Collapsed : Visibility.Visible;
                _petImage.Opacity = online ? 1.0 : 0.55;
                Program.Log(online ? "已连上后端" : "后端离线（宠物仍在，会持续重试）");
            }
            catch { /* ignore */ }
        }

        static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            if (d.TryGetValue(key, out v) && v != null) return Convert.ToString(v);
            return "";
        }

        string Absolute(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            if (path.StartsWith("http://") || path.StartsWith("https://")) return path;
            return _baseUrl + path;
        }

        static string HttpGet(string url)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 5000;
            req.ReadWriteTimeout = 5000;
            req.Proxy = null;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        /// <summary>
        /// 右键菜单「让它说一句」。
        ///
        /// 两个曾经的坑，这里都修掉了：
        ///  1. 以前是在 UI 线程上同步发请求 —— 后端要先合成语音（1~3 秒），
        ///     期间整个悬浮层是卡住的（动画停、轮询停）。现在丢到后台线程。
        ///  2. 以前失败只写 Console.Error（winexe 根本没有控制台），完全静默。
        ///     现在失败会弹气泡明确说明，同时写进 PetOverlay.log。
        /// </summary>
        void RequestSpeak()
        {
            ShowBubble(null, "让我想想说什么…");

            string url = _baseUrl + "/api/overlay/say?pet=" +
                         Uri.EscapeDataString(_petId == null ? "" : _petId);

            var worker = new Thread(delegate()
            {
                string body = null;
                string error = null;
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "POST";
                    req.ContentLength = 0;
                    req.Proxy = null;
                    req.Timeout = 10000;
                    req.ReadWriteTimeout = 10000;
                    using (var resp = (HttpWebResponse)req.GetResponse())
                    using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    {
                        body = reader.ReadToEnd();
                    }
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                }

                Dispatcher.BeginInvoke(DispatcherPriority.Normal, new Action(delegate
                {
                    if (error != null)
                    {
                        Program.Log("!! RequestSpeak 失败: " + error + "  url=" + url);
                        ShowBubble(null, "连不上后端，说不了话… 请确认 npm start 正在运行");
                        return;
                    }
                    Program.Log("RequestSpeak -> " + body);
                    try
                    {
                        var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                        bool ok = false;
                        string audio = "";
                        object o;
                        if (d != null && d.TryGetValue("ok", out o) && o != null) ok = Convert.ToBoolean(o);
                        if (d != null && d.TryGetValue("audio", out o) && o != null) audio = Convert.ToString(o);

                        if (!ok || string.IsNullOrEmpty(audio))
                        {
                            ShowBubble(null, "这句话暂时没有可播放的音频（离线语音包里没有它，也无法联网合成）");
                        }
                        // 有音频时不用在这里播：下一条轮询指令会带着它，由 HandleCommand 统一播放
                    }
                    catch (Exception ex)
                    {
                        Program.Log("!! RequestSpeak 响应解析失败: " + ex.Message);
                    }
                }));
            });
            worker.IsBackground = true;
            worker.Start();
        }
    }
}
