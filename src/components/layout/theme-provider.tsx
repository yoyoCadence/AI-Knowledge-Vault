"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type * as React from "react";

export function ThemeProvider({
  children,
  nonce,
}: {
  children: React.ReactNode;
  /** The request's CSP nonce, for the inline script that sets the theme before first paint. */
  nonce?: string;
}) {
  return (
    <NextThemesProvider
      nonce={nonce}
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
