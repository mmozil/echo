// Ajustes — conta, voz e o que mais precisa ter uma casa.
//
// A voz vive na CONTA (`users.voice`), nao no aparelho: por isso o app e a web
// mostram a mesma. Trocar aqui vale nos dois. E' `PUT /api/voices/selected`,
// que ja' existia e so' era alcancavel de dentro do player.
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import Svg, { Path } from 'react-native-svg';
import { getMe, getVoices, saveVoice, logout, type Voz } from '@/lib/api';
import { tipo, espaco, raio, perigo, useTema, useAcento, type Paleta } from '@/lib/theme';
import { Toque } from '@/components/Toque';

export default function Ajustes() {
  const c = useTema();
  const ac = useAcento();
  const estilos = useMemo(() => criarEstilos(c), [c]);

  const [eu, setEu] = useState<{ name?: string; email?: string } | null>(null);
  const [vozes, setVozes] = useState<Voz[]>([]);
  const [vozAtual, setVozAtual] = useState('');
  const [salvando, setSalvando] = useState('');

  useEffect(() => {
    getMe().then(setEu).catch(() => {});
    getVoices().then(({ voices, selected }) => { setVozes(voices); setVozAtual(selected); }).catch(() => {});
  }, []);

  async function trocarVoz(v: Voz) {
    if (v.name === vozAtual) return;
    const antes = vozAtual;
    setVozAtual(v.name);       // responde na hora; volta atras se falhar
    setSalvando(v.name);
    try {
      await saveVoice(v.name);
    } catch {
      setVozAtual(antes);
      Alert.alert('Não consegui salvar', 'A voz continua a anterior. Tente de novo.');
    } finally {
      setSalvando('');
    }
  }

  function sair() {
    Alert.alert('Sair da conta?', 'Você vai precisar entrar de novo com e-mail e senha.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sair', style: 'destructive',
        onPress: async () => { await logout(); router.replace('/login'); } },
    ]);
  }

  const versao = Constants.expoConfig?.version ?? '—';

  return (
    <SafeAreaView style={estilos.tela} edges={['top', 'left', 'right']}>
      <View style={estilos.topo}>
        <Toque rotulo="Voltar" onPress={() => router.back()} style={estilos.voltar}>
          <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={c.ink}
            strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M15 5l-7 7 7 7" />
          </Svg>
        </Toque>
        <Text style={estilos.titulo} accessibilityRole="header">Ajustes</Text>
        <View style={estilos.voltar} />
      </View>

      <ScrollView contentContainerStyle={estilos.corpo} showsVerticalScrollIndicator={false}>
        {/* ── Conta ─────────────────────────────────────────────────────── */}
        <Text style={estilos.secao}>CONTA</Text>
        <View style={estilos.cartao}>
          <Text style={estilos.nome}>{eu?.name || '—'}</Text>
          <Text style={estilos.email}>{eu?.email || '—'}</Text>
        </View>

        {/* ── Voz ───────────────────────────────────────────────────────── */}
        <Text style={estilos.secao}>VOZ DA LEITURA</Text>
        <Text style={estilos.explica}>
          Fica salva na conta — vale também no site.
        </Text>
        <View style={estilos.cartao}>
          {!vozes.length ? (
            <View style={estilos.carregando}><ActivityIndicator color={c.mist} /></View>
          ) : vozes.map((v, i) => {
            const ativa = v.name === vozAtual;
            return (
              <Toque
                key={v.name}
                rotulo={`Voz ${v.label}${ativa ? ', em uso' : ''}`}
                onPress={() => trocarVoz(v)}
                escala={0.99}
                alvoMinimo={false}
                style={[estilos.linha, i > 0 && estilos.linhaSeparada]}
              >
                <View style={estilos.linhaTexto}>
                  <Text style={[estilos.linhaRotulo, ativa && { color: ac, fontWeight: '700' }]}>
                    {v.label}
                  </Text>
                  {(v as any).aviso ? <Text style={estilos.aviso}>{(v as any).aviso}</Text> : null}
                </View>
                {salvando === v.name ? <ActivityIndicator size="small" color={ac} />
                  : ativa ? (
                    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={ac}
                      strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                      <Path d="M5 13l4 4L19 7" />
                    </Svg>
                  ) : null}
              </Toque>
            );
          })}
        </View>

        {/* ── Aparencia ─────────────────────────────────────────────────── */}
        <Text style={estilos.secao}>APARÊNCIA</Text>
        <View style={estilos.cartao}>
          <View style={estilos.linha}>
            <View style={estilos.linhaTexto}>
              <Text style={estilos.linhaRotulo}>Acompanha o sistema</Text>
              {/* 🚨 Dito aqui porque é limitação REAL, e quem não sabe acha
                  que é defeito: a página do PDF é imagem gerada no servidor,
                  não tela — não dá para escurecer sem estragar o livro. */}
              <Text style={estilos.aviso}>
                No escuro, a página do PDF continua clara. A visão de Texto escurece.
              </Text>
            </View>
          </View>
        </View>

        {/* ── Sair ──────────────────────────────────────────────────────── */}
        <Toque rotulo="Sair da conta" dica="Pede confirmação" onPress={sair}
          alvoMinimo={false} style={estilos.sair}>
          <Text style={estilos.sairTexto}>Sair da conta</Text>
        </Toque>

        <Text style={estilos.versao}>Discoo {versao}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const criarEstilos = (c: Paleta) => StyleSheet.create({
  tela: { flex: 1, backgroundColor: c.snow },
  topo: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: espaco.pequeno, paddingVertical: espaco.micro,
  },
  voltar: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titulo: { ...tipo.destaque, flex: 1, textAlign: 'center', color: c.ink },

  corpo: { paddingHorizontal: espaco.padrao, paddingBottom: espaco.heroi },
  secao: {
    ...tipo.legenda, fontWeight: '700', color: c.slate,
    letterSpacing: 0.4, marginTop: espaco.ar, marginBottom: espaco.pequeno,
  },
  explica: { ...tipo.nota, color: c.mist, marginTop: -espaco.micro, marginBottom: espaco.pequeno },

  cartao: { backgroundColor: c.white, borderRadius: raio.grande, overflow: 'hidden' },
  nome: { ...tipo.destaque, color: c.ink, paddingHorizontal: espaco.padrao, paddingTop: espaco.medio },
  email: { ...tipo.nota, color: c.slate, paddingHorizontal: espaco.padrao, paddingBottom: espaco.medio, paddingTop: 2 },

  carregando: { paddingVertical: espaco.ar, alignItems: 'center' },
  linha: {
    minHeight: 56, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: espaco.padrao, gap: espaco.medio,
  },
  linhaSeparada: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  linhaTexto: { flex: 1, minWidth: 0 },
  linhaRotulo: { ...tipo.corpo, color: c.ink },
  aviso: { ...tipo.legenda, color: c.slate, marginTop: 2 },

  sair: {
    marginTop: espaco.secao, minHeight: 52, borderRadius: raio.grande,
    alignItems: 'center', justifyContent: 'center', backgroundColor: c.white,
  },
  sairTexto: { ...tipo.corpo, fontWeight: '600', color: perigo },
  versao: { ...tipo.legenda2, color: c.mist, textAlign: 'center', marginTop: espaco.ar },
});
