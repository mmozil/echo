// Logo do Echo — 3 círculos com borda preta + ponto sólido no meio
import { View, Text, StyleSheet } from 'react-native';
import { useTema } from '@/lib/theme';

export function EchoLogo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  // 🚨 Era #1A1A1A fixo: no modo escuro a marca sumiria no fundo.
  const c = useTema();
  const dim = size === 'sm' ? 24 : size === 'md' ? 28 : 36;
  const txt = size === 'sm' ? 18 : size === 'md' ? 22 : 30;
  const r = dim / 3;
  return (
    <View style={styles.row}>
      <View style={{ width: dim, height: dim, position: 'relative' }}>
        {/* círculo grande externo */}
        <View style={[styles.ring, { width: dim, height: dim, borderRadius: dim / 2, borderColor: c.ink }]} />
        {/* círculo médio */}
        <View style={[styles.ring, {
          width: dim * 0.65, height: dim * 0.65, borderRadius: dim * 0.325,
          top: (dim - dim * 0.65) / 2, left: (dim - dim * 0.65) / 2, borderColor: c.ink,
        }]} />
        {/* ponto sólido central */}
        <View style={[styles.dot, {
          width: r * 0.85, height: r * 0.85, borderRadius: (r * 0.85) / 2,
          top: (dim - r * 0.85) / 2, left: (dim - r * 0.85) / 2, backgroundColor: c.ink,
        }]} />
      </View>
      <Text style={[styles.text, { fontSize: txt, lineHeight: Math.round(txt * 1.15), color: c.ink }]}>echo.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ring: {
    position: 'absolute',
    borderWidth: 2,
    
  },
  dot: {
    position: 'absolute',
    
  },
  text: {
    
    fontWeight: '700',
    letterSpacing: -0.5,
    fontFamily: 'System',
  },
});
