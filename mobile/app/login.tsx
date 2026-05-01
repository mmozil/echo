import { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { router } from 'expo-router';
import { login } from '@/lib/api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    if (!email || !password) return;
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace('/');
    } catch (e: any) {
      Alert.alert('Erro', e?.response?.data?.detail || 'Email ou senha incorretos');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: '#0F0F12' }}
    >
      <View style={{ flex: 1, justifyContent: 'center', padding: 28 }}>
        {/* Logo */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 48, gap: 8 }}>
          <View style={{ width: 28, height: 28, position: 'relative' }}>
            <View style={{ position: 'absolute', width: 8, height: 8, backgroundColor: '#001a4d', top: 0, left: 0 }} />
            <View style={{ position: 'absolute', width: 8, height: 8, backgroundColor: '#003083', top: 8, left: 8 }} />
            <View style={{ position: 'absolute', width: 8, height: 8, backgroundColor: '#0050D5', top: 16, left: 16 }} />
          </View>
          <Text style={{ color: 'white', fontSize: 28, fontWeight: '800', letterSpacing: -1 }}>echo.</Text>
        </View>

        <Text style={{ color: 'white', fontSize: 22, fontWeight: '700', marginBottom: 24 }}>Entrar</Text>

        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 6 }}>Email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          placeholder="seu@email.com"
          placeholderTextColor="rgba(255,255,255,0.3)"
          style={{
            backgroundColor: 'rgba(255,255,255,0.06)',
            color: 'white',
            paddingHorizontal: 14, paddingVertical: 14,
            borderRadius: 12, fontSize: 15,
            marginBottom: 16,
            borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
          }}
        />

        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 6 }}>Senha</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          placeholder="••••••••"
          placeholderTextColor="rgba(255,255,255,0.3)"
          style={{
            backgroundColor: 'rgba(255,255,255,0.06)',
            color: 'white',
            paddingHorizontal: 14, paddingVertical: 14,
            borderRadius: 12, fontSize: 15,
            marginBottom: 24,
            borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
          }}
          onSubmitEditing={onSubmit}
        />

        <Pressable
          onPress={onSubmit}
          disabled={loading}
          style={({ pressed }) => ({
            backgroundColor: '#ABB3FE',
            paddingVertical: 14,
            borderRadius: 12,
            alignItems: 'center',
            opacity: pressed || loading ? 0.85 : 1,
          })}
        >
          {loading ? <ActivityIndicator color="#0F0F12" /> : (
            <Text style={{ color: '#0F0F12', fontWeight: '700', fontSize: 15 }}>Continuar</Text>
          )}
        </Pressable>

        <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, textAlign: 'center', marginTop: 28 }}>
          Sua biblioteca persiste entre web e celular
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}
