using System;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

internal static class ComputerUseBenchmarkWpfFixture
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

        var app = new Application();
        var window = new Window {
            Title = title,
            Width = 560,
            Height = 240,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Topmost = false,
            ResizeMode = ResizeMode.CanResize
        };

        var canvas = new Canvas();

        var label = new Label {
            Content = "Enter benchmark token",
            Width = 220,
            Height = 28
        };
        Canvas.SetLeft(label, 24);
        Canvas.SetTop(label, 18);

        var text = new TextBox {
            Name = "BenchmarkInput",
            Width = 480,
            Height = 28
        };
        AutomationProperties.SetName(text, "BenchmarkInput");
        Canvas.SetLeft(text, 24);
        Canvas.SetTop(text, 56);

        var button = new Button {
            Name = "BenchmarkSubmit",
            Content = "Submit",
            Width = 120,
            Height = 34
        };
        AutomationProperties.SetName(button, "BenchmarkSubmit");
        Canvas.SetLeft(button, 24);
        Canvas.SetTop(button, 104);

        var status = new Label {
            Content = "Waiting",
            Width = 336,
            Height = 30
        };
        Canvas.SetLeft(status, 168);
        Canvas.SetTop(status, 108);

        text.TextChanged += delegate {
            current = text.Text;
            WriteState();
        };

        button.Click += delegate {
            current = text.Text;
            submitted = current;
            status.Content = "Submitted: " + current;
            WriteState();
            text.Clear();
        };

        canvas.Children.Add(label);
        canvas.Children.Add(text);
        canvas.Children.Add(button);
        canvas.Children.Add(status);
        window.Content = canvas;

        app.Run(window);
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
