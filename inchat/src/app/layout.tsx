import type { Metadata } from 'next';
import { Geist } from 'next/font/google';

import './globals.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'InChat',
  description: 'Secure real-time messaging for India.',
  manifest: '/manifest.webmanifest'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={sans.variable}>
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Material Symbols is an icon font, which next/font does not ship as a
            component. This is the App Router document head, so the stylesheet
            is loaded once for every page - the Pages-Router rule that warns
            here does not apply. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
