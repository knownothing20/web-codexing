using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

// Build-time artwork matching public/icon.svg; no runtime image generation.
internal static class IconBuilder
{
    private static void Main(string[] args)
    {
        var sizes = new int[] { 16, 20, 24, 32, 48, 64, 128, 256 };
        var images = new List<byte[]>();
        foreach (var size in sizes)
        {
            using (var large = new Bitmap(size * 4, size * 4, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(large))
            using (var background = new SolidBrush(Color.FromArgb(66, 107, 81)))
            using (var pen = new Pen(Color.FromArgb(243, 246, 236), 9F))
            using (var outline = new GraphicsPath())
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.ScaleTransform(size * 4 / 128F, size * 4 / 128F);
                outline.AddArc(0, 0, 60, 60, 180, 90);
                outline.AddArc(68, 0, 60, 60, 270, 90);
                outline.AddArc(68, 68, 60, 60, 0, 90);
                outline.AddArc(0, 68, 60, 60, 90, 90);
                outline.CloseFigure();
                g.FillPath(background, outline);
                pen.StartCap = pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                g.DrawLines(pen, new Point[] { new Point(49, 42), new Point(29, 64), new Point(49, 86) });
                g.DrawLines(pen, new Point[] { new Point(79, 42), new Point(99, 64), new Point(79, 86) });
                g.DrawLine(pen, 72, 32, 56, 96);
                using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
                using (var output = Graphics.FromImage(bitmap))
                using (var stream = new MemoryStream())
                {
                    output.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    output.CompositingMode = CompositingMode.SourceCopy;
                    output.DrawImage(large, 0, 0, size, size);
                    bitmap.Save(stream, ImageFormat.Png);
                    images.Add(stream.ToArray());
                }
            }
        }
        using (var writer = new BinaryWriter(File.Create(args[0])))
        {
            writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)sizes.Length);
            var offset = 6 + 16 * sizes.Length;
            for (var i = 0; i < sizes.Length; i++)
            {
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)0); writer.Write((byte)0);
                writer.Write((ushort)1); writer.Write((ushort)32);
                writer.Write(images[i].Length); writer.Write(offset);
                offset += images[i].Length;
            }
            foreach (var bytes in images) writer.Write(bytes);
        }
    }
}
