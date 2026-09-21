using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class CuaWindowIdentityFixture
{
    private static string statePath = "";
    private static string commandPath = "";
    private static Form formA;
    private static Form formB;
    private static long hwndA;
    private static long hwndB;
    private static bool bClosed;
    private static string lastCommand = "";

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length < 3) return;
        statePath = args[0];
        commandPath = args[1];
        var titleBase = args[2];

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        formA = BuildForm(titleBase + " A", "IdentityA", 100, 100);
        formB = BuildForm(titleBase + " B", "IdentityB", 700, 100);

        formA.FormClosed += delegate {
            if (!bClosed && formB != null && !formB.IsDisposed) formB.Close();
            Application.ExitThread();
        };
        formB.FormClosed += delegate {
            bClosed = true;
            WriteState();
        };

        formA.Shown += delegate {
            hwndA = formA.Handle.ToInt64();
            WriteState();
        };
        formB.Shown += delegate {
            hwndB = formB.Handle.ToInt64();
            WriteState();
        };

        var timer = new Timer { Interval = 100 };
        timer.Tick += delegate {
            if (!File.Exists(commandPath)) return;
            string command;
            try { command = File.ReadAllText(commandPath).Trim(); }
            catch { return; }
            if (command.Length == 0 || command == lastCommand) return;
            lastCommand = command;

            if (command == "activate-a") {
                formA.WindowState = FormWindowState.Normal;
                formA.Activate();
            } else if (command == "activate-b" && !bClosed) {
                formB.WindowState = FormWindowState.Normal;
                formB.Activate();
            } else if (command == "minimize-b" && !bClosed) {
                formB.WindowState = FormWindowState.Minimized;
            } else if (command == "restore-b" && !bClosed) {
                formB.WindowState = FormWindowState.Normal;
            } else if (command == "close-b" && !bClosed) {
                formB.Close();
            } else if (command == "exit") {
                formA.Close();
            }
            WriteState();
        };
        timer.Start();

        formA.Show();
        formB.Show();
        formA.Activate();
        Application.Run();
    }

    private static Form BuildForm(string title, string accessibleName, int left, int top)
    {
        var form = new Form {
            Text = title,
            Width = 520,
            Height = 220,
            StartPosition = FormStartPosition.Manual,
            Left = left,
            Top = top,
            TopMost = false
        };

        var label = new Label {
            Text = accessibleName,
            AccessibleName = accessibleName,
            Left = 24,
            Top = 24,
            Width = 220
        };
        var text = new TextBox {
            Name = accessibleName + "Input",
            AccessibleName = accessibleName + "Input",
            Left = 24,
            Top = 60,
            Width = 440,
            Text = accessibleName
        };
        form.Controls.Add(label);
        form.Controls.Add(text);
        return form;
    }

    private static void WriteState()
    {
        if (String.IsNullOrEmpty(statePath)) return;
        var json = "{"
            + "\"pid\":" + Process.GetCurrentProcess().Id
            + ",\"hwndA\":" + hwndA
            + ",\"hwndB\":" + hwndB
            + ",\"bMinimized\":" + ((!bClosed && formB != null && formB.WindowState == FormWindowState.Minimized) ? "true" : "false")
            + ",\"bClosed\":" + (bClosed ? "true" : "false")
            + "}";
        File.WriteAllText(statePath, json, new UTF8Encoding(false));
    }
}
