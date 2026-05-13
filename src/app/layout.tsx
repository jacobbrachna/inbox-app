import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InboxPro — LinkedIn Inbox Manager",
  description: "Unified LinkedIn and Sales Navigator inbox with labels, snooze, and snippets",
};

// Runs before first paint. Reads saved theme (or system preference) and
// stamps `data-theme` on <html> so the right palette is active immediately
// — no flash of the wrong theme on load.
const themeInitScript = `
(function() {
  try {
    var saved = localStorage.getItem('inbox-theme');
    var theme = (saved === 'light' || saved === 'dark')
      ? saved
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    document.documentElement.style.colorScheme = theme;

    // Apply persisted accent before first paint
    var accent = localStorage.getItem('inbox-accent-rgb');
    if (accent) {
      document.documentElement.style.setProperty('--color-accent-rgb', accent);
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="h-full" suppressHydrationWarning>{children}</body>
    </html>
  );
}
