import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';

const API_URL = 'https://beheer.syntaxis.nl/api/ishethokalopen';
const REFRESH_INTERVAL = 30;

type HokStatus = 'loading' | 'open' | 'dicht';

const COLORS: Record<HokStatus, string> = {
  loading: '#9ca3af',
  open: '#16a34a',
  dicht: '#dc2626',
};

const STATUS_TEXT: Record<HokStatus, string> = {
  loading: 'Status laden...',
  open: 'Hok is open',
  dicht: 'Hok is dicht',
};

function formatTime(dateStr: string): string {
  const d = new Date(dateStr.replace(' ', 'T') + '+01:00');
  return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ~5s vibration: 10x [vibrate 300ms, pause 200ms]
const VIBRATE_PATTERN = [
  0, 300, 200, 300, 200, 300, 200, 300, 200, 300,
  200, 300, 200, 300, 200, 300, 200, 300, 200, 300,
];

SplashScreen.preventAutoHideAsync();

export default function App() {
  const [status, setStatus] = useState<HokStatus>('loading');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const prevStatusRef = useRef<HokStatus>('loading');
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const splashHidden = useRef(false);

  const showToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    Animated.timing(toastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    toastTimer.current = setTimeout(() => {
      Animated.timing(toastOpacity, { toValue: 0, duration: 400, useNativeDriver: true }).start();
    }, 1500);
  }, [toastOpacity]);

  const fetchStatus = useCallback(async (manual = false) => {
    try {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(API_URL, { signal: controller.signal });
      const data = await res.json();

      if (data.success && data.payload) {
        const newStatus: HokStatus = data.payload.open === 1 ? 'open' : 'dicht';

        // Vibrate ~5s when status changes from dicht to open
        if (prevStatusRef.current === 'dicht' && newStatus === 'open') {
          Vibration.vibrate(VIBRATE_PATTERN);
        }

        prevStatusRef.current = newStatus;
        setStatus(newStatus);
        setLastUpdated(data.payload.updated_at);
        setLastChecked(new Date());
        setError(null);

        if (manual) showToast();
      } else {
        setError('Ongeldig API antwoord');
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setError('Kan status niet ophalen');
      }
    }

    // Hide splash after first fetch
    if (!splashHidden.current) {
      splashHidden.current = true;
      SplashScreen.hideAsync();
    }

    setCountdown(REFRESH_INTERVAL);
  }, [showToast]);

  // Initial fetch + interval
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => fetchStatus(false), REFRESH_INTERVAL * 1000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [fetchStatus]);

  // Countdown timer
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL : c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStatus(true);
    setRefreshing(false);
  }, [fetchStatus]);

  const bg = COLORS[status];

  return (
    <SafeAreaProvider>
      <View style={[styles.container, { backgroundColor: bg }]}>
        {/* Toast bubble */}
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]} pointerEvents="none">
          <SafeAreaView edges={['top']}>
            <View style={styles.toastInner}>
              <Text style={styles.toastText}>Status vernieuwd ✓</Text>
            </View>
          </SafeAreaView>
        </Animated.View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#fff"
              colors={['#fff']}
              progressBackgroundColor={bg}
            />
          }
        >
          <SafeAreaView style={styles.content}>
            <View style={styles.main}>
              <Text style={styles.emoji}>
                {status === 'loading' ? '⏳' : status === 'open' ? '🐔' : '🔒'}
              </Text>
              <Text style={styles.statusText}>{STATUS_TEXT[status]}</Text>
              {error && <Text style={styles.errorText}>{error}</Text>}
            </View>

            <View style={styles.footer}>
              {lastUpdated && (
                <Text style={styles.infoText}>
                  {status === 'open' ? 'Hok geopend om' : 'Hok gesloten om'}: {formatTime(lastUpdated)}
                </Text>
              )}
              {lastChecked && (
                <Text style={styles.infoText}>
                  Gecheckt: {lastChecked.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </Text>
              )}
              <Text style={styles.countdownText}>
                Vernieuwen over {countdown}s
              </Text>
            </View>
          </SafeAreaView>
        </ScrollView>

        <StatusBar style="light" />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  toast: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    alignItems: 'center',
  },
  toastInner: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    marginTop: 8,
  },
  toastText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  scroll: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 40,
  },
  main: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emoji: {
    fontSize: 80,
    marginBottom: 20,
  },
  statusText: {
    fontSize: 36,
    fontWeight: '800',
    color: '#fff',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  errorText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 12,
  },
  footer: {
    alignItems: 'center',
    gap: 4,
  },
  infoText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
  },
  countdownText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
  },
});
