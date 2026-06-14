import type { Metadata } from "next";
import { Inter, Roboto_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/providers/auth-context";
import { I18nProvider } from "@/providers/i18n-context";
import { Toaster } from "react-hot-toast";
import { UploadProvider } from "@/providers/upload/upload-provider";
import { DownloadProvider } from "@/providers/download-context";
import GlobalDropZone from "@/components/global-drop-zone";
import TransferPanel from "@/components/transfer-panel";
import StoreProvider from "@/providers/store-provider";
import { RequestTrackerProvider } from "@/providers/request-tracker";
import NavigationLoader from "@/components/molecules/navigation-loader";
import LoadingOverlay from "@/components/molecules/loading-overlay";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "vietnamese"],
});

const robotoMono = Roboto_Mono({
  variable: "--font-roboto-mono",
  subsets: ["latin", "vietnamese"],
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
      className={`${inter.variable} ${robotoMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <I18nProvider>
          <AuthProvider>
            <StoreProvider>
              <UploadProvider>
                <DownloadProvider>
                  <RequestTrackerProvider>
                    <NavigationLoader>
                      <GlobalDropZone />
                      {children}
                      <TransferPanel />
                      <LoadingOverlay />
                      <Toaster />
                    </NavigationLoader>
                  </RequestTrackerProvider>
                </DownloadProvider>
              </UploadProvider>
            </StoreProvider>
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
