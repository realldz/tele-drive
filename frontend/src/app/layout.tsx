import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth-context";
import { I18nProvider } from "@/components/i18n-context";
import { Toaster } from "react-hot-toast";
import { UploadProvider } from "@/components/upload-context";
import GlobalDropZone from "@/components/global-drop-zone";
import UploadPanel from "@/components/upload-panel";
import StoreProvider from "@/components/store-provider";
import { RequestTrackerProvider } from "@/lib/request-tracker";
import NavigationLoader from "@/components/navigation-loader";
import LoadingOverlay from "@/components/loading-overlay";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tele-Drive",
  description: "Cloud Storage powered by Telegram",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="vi"
      data-theme="light"
      style={{ colorScheme: 'light' }}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <I18nProvider>
          <AuthProvider>
            <StoreProvider>
              <UploadProvider>
                <RequestTrackerProvider>
                  <NavigationLoader>
                    <GlobalDropZone />
                    {children}
                    <UploadPanel />
                    <LoadingOverlay />
                    <Toaster />
                  </NavigationLoader>
                </RequestTrackerProvider>
              </UploadProvider>
            </StoreProvider>
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
