import type { Metadata } from "next"
import "@/app/globals.css"

export const metadata: Metadata = {
  title: "Agent Valley Dashboard",
  description: "Pixel art office view of AI agent orchestration",
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
