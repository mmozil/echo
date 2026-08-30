import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { colors } from '@/lib/theme';
import { initAuthToken } from '@/lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

export default function RootLayout() {
  // Carrega o token para a memoria logo no boot: capa, pagina e audio mandam
  // esse Bearer por header (no mobile nao ha cookie de sessao).
  useEffect(() => { initAuthToken().catch(() => {}); }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.snow },
            animation: 'slide_from_right',
          }}
        />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
