import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "需求工作台 | 出海产品",
  description: "管理产品需求、版本决策与 AI 协作任务。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
