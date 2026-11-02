import type { Metadata } from "next";
import "./globals.css";
import { profile } from "@/content/profile";
import {
  LanguageProvider,
  PortfolioProvider,
  WalletProvider
} from "@/features/dashboard-shell";
import { NearWalletProvider } from "@/features/wallet";
import { LoginWalletProvider } from "@/features/login-wallet";
import { RealAllocateProvider } from "@/features/vault/context/real-allocate-context";
import { AllocateRecordHygiene } from "@/features/vault/components/allocate-record-hygiene";
import { Providers } from "./providers";

export const metadata: Metadata = {
  // Resolves relative metadata URLs (the generated og/twitter image) against the canonical
  // domain instead of whatever host the build ran on (D-473).
  metadataBase: new URL(profile.siteUrl),
  title: {
    default: `${profile.productName} | ${profile.productBadge}`,
    template: `%s | ${profile.productName}`
  },
  description: profile.description,
  openGraph: {
    title: `${profile.productName} | ${profile.productBadge}`,
    description: profile.description,
    type: "website",
    url: profile.siteUrl
  },
  twitter: {
    card: "summary_large_image",
    title: `${profile.productName} | ${profile.productBadge}`,
    description: profile.description
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <NearWalletProvider>
            <LoginWalletProvider>
              <LanguageProvider>
                <WalletProvider>
                  {/* Supplies the NEAR signer for the live-vault Allocate. Inert unless
                      NEXT_PUBLIC_VAULT_ROUNDTRIP is on (007.plan Phase 1). */}
                  <RealAllocateProvider>
                    {/* Flips rescue records the credit poll gave up on, once per load, when
                        their seal is on chain. Renders nothing; inert unless
                        NEXT_PUBLIC_VAULT_ROUNDTRIP is on (009.plan FE #4). */}
                    <AllocateRecordHygiene />
                    <PortfolioProvider>{children}</PortfolioProvider>
                  </RealAllocateProvider>
                </WalletProvider>
              </LanguageProvider>
            </LoginWalletProvider>
          </NearWalletProvider>
        </Providers>
      </body>
    </html>
  );
}
