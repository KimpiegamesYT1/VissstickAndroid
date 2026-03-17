import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
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

const PRIMARY_API_URL = 'https://api.florisbroek.nl/api/public/hok/status';
const FALLBACK_API_URL = 'https://beheer.syntaxis.nl/api/ishethokalopen';
const REFRESH_INTERVAL = 30;
const REQUEST_TIMEOUT_MS = 8000;

type HokStatus = 'loading' | 'open' | 'dicht';
type ApiSource = 'primary' | 'fallback';

type NormalizedStatus = {
  status: Exclude<HokStatus, 'loading'>;
  lastUpdated: string | null;
  nextEvent: string | null;
  predictedTime: string | null;
  daysFromNow: number | null;
  source: ApiSource;
};

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

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function formatPredictedText(nextEvent: string | null, predictedTime: string | null, daysFromNow: number | null): string | null {
  if (!nextEvent || !predictedTime) return null;

  const eventLabel = nextEvent.toLowerCase() === 'closes'
    ? 'Sluit'
    : nextEvent.toLowerCase() === 'opens'
      ? 'Opent'
      : nextEvent;

  const dayLabel = daysFromNow === 1
    ? ' morgen'
    : daysFromNow && daysFromNow > 1
      ? ` over ${daysFromNow} dagen`
      : '';

  return `${eventLabel}${dayLabel} om ${predictedTime}`;
}

async function parseJsonResponse(response: Response): Promise<any> {
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function normalizePrimaryResponse(data: any): NormalizedStatus {
  if (!data || typeof data !== 'object' || typeof data.isOpen !== 'boolean') {
    throw new Error('INVALID_PRIMARY_PAYLOAD');
  }

  return {
    status: data.isOpen ? 'open' : 'dicht',
    lastUpdated: typeof data.lastUpdated === 'string' ? data.lastUpdated : null,
    nextEvent: typeof data.nextEvent === 'string' ? data.nextEvent : null,
    predictedTime: typeof data.predictedTime === 'string' ? data.predictedTime : null,
    daysFromNow: typeof data.daysFromNow === 'number' ? data.daysFromNow : null,
    source: 'primary',
  };
}

function normalizeFallbackResponse(data: any): NormalizedStatus {
  if (!data?.success || !data?.payload || typeof data.payload.open !== 'number') {
    throw new Error('INVALID_FALLBACK_PAYLOAD');
  }

  return {
    status: data.payload.open === 1 ? 'open' : 'dicht',
    lastUpdated: typeof data.payload.updated_at === 'string' ? data.payload.updated_at : null,
    nextEvent: null,
    predictedTime: null,
    daysFromNow: null,
    source: 'fallback',
  };
}

async function fetchPrimaryStatus(signal: AbortSignal): Promise<NormalizedStatus> {
  const response = await withTimeout(fetch(PRIMARY_API_URL, { signal }), REQUEST_TIMEOUT_MS);
  const data = await parseJsonResponse(response);
  return normalizePrimaryResponse(data);
}

async function fetchFallbackStatus(signal: AbortSignal): Promise<NormalizedStatus> {
  const response = await withTimeout(fetch(FALLBACK_API_URL, { signal }), REQUEST_TIMEOUT_MS);
  const data = await parseJsonResponse(response);
  return normalizeFallbackResponse(data);
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
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [predictedText, setPredictedText] = useState<string | null>(null);
  const [apiSource, setApiSource] = useState<ApiSource | null>(null);
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

      let normalized: NormalizedStatus;

      try {
        normalized = await fetchPrimaryStatus(controller.signal);
      } catch (primaryError) {
        if (isAbortError(primaryError)) {
          return;
        }

        normalized = await fetchFallbackStatus(controller.signal);
      }

      const newStatus = normalized.status;

      // Vibrate ~5s when status changes from dicht to open
      if (prevStatusRef.current === 'dicht' && newStatus === 'open') {
        Vibration.vibrate(VIBRATE_PATTERN);
      }

      prevStatusRef.current = newStatus;
      setStatus(newStatus);
      setLastUpdated(normalized.lastUpdated);
      setLastChecked(new Date());
      setApiSource(normalized.source);
      setPredictedText(
        formatPredictedText(normalized.nextEvent, normalized.predictedTime, normalized.daysFromNow),
      );
      setError(null);
      setFatalError(null);

      if (manual) showToast();
    } catch (e: unknown) {
      if (!isAbortError(e)) {
        setError('Kan status niet ophalen');
        setFatalError('Kon geen verbinding maken met beide API\'s. Probeer opnieuw.');
        setLastChecked(new Date());
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

  if (fatalError) {
    return (
      <SafeAreaProvider>
        <View style={[styles.container, styles.errorScreen]}>
          <SafeAreaView style={styles.errorContent}>
            <Text style={styles.errorEmoji}>⚠️</Text>
            <Text style={styles.errorTitle}>Status tijdelijk niet beschikbaar</Text>
            <Text style={styles.errorMessage}>{fatalError}</Text>
            {lastChecked && (
              <Text style={styles.errorMeta}>
                Laatste poging: {lastChecked.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </Text>
            )}
            <Pressable style={styles.retryButton} onPress={() => fetchStatus(true)}>
              <Text style={styles.retryButtonText}>Opnieuw proberen</Text>
            </Pressable>
          </SafeAreaView>
          <StatusBar style="light" />
        </View>
      </SafeAreaProvider>
    );
  }

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
              {predictedText && <Text style={styles.predictedText}>{predictedText}</Text>}
              {error && <Text style={styles.errorText}>{error}</Text>}
            </View>

            <View style={styles.footer}>
              {lastUpdated && (
                <Text style={styles.infoText}>
                  {status === 'open' ? 'Hok geopend om' : 'Hok gesloten om'}: {formatTime(lastUpdated)}
                </Text>
              )}
              {apiSource && (
                <Text style={styles.infoText}>
                  Bron: {apiSource === 'primary' ? 'FlorisBroek API' : 'SyntaxisAPI'}
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
  errorScreen: {
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  errorContent: {
    alignItems: 'center',
    gap: 10,
  },
  errorEmoji: {
    fontSize: 54,
    marginBottom: 4,
  },
  errorTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#fff',
    textAlign: 'center',
  },
  errorMessage: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.82)',
    textAlign: 'center',
    lineHeight: 22,
  },
  errorMeta: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.62)',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 14,
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
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
  predictedText: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
    marginTop: 8,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.2)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
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
