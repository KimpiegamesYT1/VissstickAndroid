import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { ReactNode } from 'react';

SplashScreen.preventAutoHideAsync();

export default function RootLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <>
      {children}
      <StatusBar style="light" />
    </>
  );
}
