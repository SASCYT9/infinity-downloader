import './globals.css';

export const metadata = {
  title: 'Infinity Downloader — Download from YouTube, TikTok & More',
  description: 'Free high-quality video & audio downloader. YouTube 8K, TikTok, Instagram, Twitter and 1000+ platforms. No ads, no tracking.',
  keywords: 'video downloader, youtube downloader, tiktok downloader, mp3 converter, audio extractor',
  openGraph: {
    title: 'Infinity Downloader',
    description: 'Download videos & music in maximum quality from any platform',
    type: 'website',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {/* Animated background blobs */}
        <div className="bg-animation" aria-hidden="true">
          <div className="blob blob--purple" />
          <div className="blob blob--pink" />
          <div className="blob blob--blue" />
        </div>

        {children}
      </body>
    </html>
  );
}
