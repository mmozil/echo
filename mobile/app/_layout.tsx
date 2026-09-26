import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { useTema } from '@/lib/theme';
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

  const c = useTema();
  const escuro = useColorScheme() === 'dark';

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        {/* 🚨 Estava `style="dark"` fixo: letra escura sobre fundo preto e' letra
            invisivel. A barra de estado acompanha o tema, nao o contrario. */}
        <StatusBar style={escuro ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerShown: false,
            // 🚨 Estava `colors.snow`, a paleta CLARA, fixa. Era o chao de TODA
            //    tela: no modo escuro ficava branco por baixo, e cada troca de
            //    tela dava um lampejo branco. Achado revendo o fluxo, nao o
            //    arquivo — ninguem olha o `_layout` procurando cor.
            contentStyle: { backgroundColor: c.snow },
            animation: 'slide_from_right',
            // O gesto de arrastar da borda para voltar. Com `headerShown: false`
            // ele continua valendo, mas declarar deixa a intencao no codigo —
            // e «voltar» foi exatamente a queixa do dono.
            gestureEnabled: true,
            fullScreenGestureEnabled: true,
          }}
        />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
