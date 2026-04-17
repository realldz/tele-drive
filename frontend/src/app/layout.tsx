import type { Metadata } from "next";
import { Inter, Roboto_Mono } from "next/font/google";
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
