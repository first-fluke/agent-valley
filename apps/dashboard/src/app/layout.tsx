import type { Metadata, Viewport } from "next"
import "@/app/globals.css"

export const metadata: Metadata = {
  title: {
    default: "Agent Valley",
    template: "%s | Agent Valley",
  },
  description: "AI agent orchestration dashboard — monitor agents, issues, and real-time status",
  applicationName: "Agent Valley",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
}

export const viewport: Viewport = {
  themeColor: "#6366f1",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-gray-900 text-white antialiased">{children}</body>
    </html>
  )
}
