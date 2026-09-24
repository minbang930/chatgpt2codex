using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class ComputerUseBenchmarkFixture
{
    private static string statePath = "";
    private static string current = "";
    private static string submitted = null;

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length < 2) return;
        statePath = args[0];
        var title = args[1];
        WriteState();

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new Form {
            Text = title,
            Width = 560,
            Height = 240,
            StartPosition = FormStartPosition.CenterScreen,
            TopMost = false
        };

        var label = new Label {
            Text = "Enter benchmark token",
            Left = 24,
            Top = 24,
            Width = 220
        };

        var text = new TextBox {
            Left = 24,
            Top = 56,
            Width = 480,
            Name = "BenchmarkInput",
            AccessibleName = "BenchmarkInput"
        };

        var button = new Button {
            Left = 24,
            Top = 104,
            Width = 120,
            Height = 34,
            Text = "Submit",
            Name = "BenchmarkSubmit",
            AccessibleName = "BenchmarkSubmit"
        };

        var status = new Label {
            Left = 168,
            Top = 112,
            Width = 336,
            Text = "Waiting"
        };

        text.TextChanged += delegate {
            current = text.Text;
            WriteState();
        };

        button.Click += delegate {
            current = text.Text;
            submitted = current;
            status.Text = "Submitted: " + current;
            WriteState();
            // Keep each benchmark iteration independent. Coordinate typing
            // requires an empty field on the next run, while submitted retains
            // the previous token for independent verification.
            text.Clear();
        };

        form.Controls.AddRange(new Control[] { label, text, button, status });
        Application.Run(form);
    }

    private static string JsonString(string value)
    {
        if (value == null) return "null";
        return "\"" + value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n") + "\"";
    }

    private static void WriteState()
    {
        var json = "{\"current\":" + JsonString(current)
            + ",\"submitted\":" + JsonString(submitted) + "}";
        File.WriteAllText(statePath, json, new UTF8Encoding(false));
    }
}
